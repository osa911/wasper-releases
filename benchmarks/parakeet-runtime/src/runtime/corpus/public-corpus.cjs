'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const { ownedRuntimeStorage } = require('../owned-runtime-storage.cjs');
const { publicAuditPythonExecutable } = require('../../public-audit.cjs');
const {
  NORMALIZED_AUDIO_TRANSFORM,
  inspectAudio,
  sha256File,
} = require('../../asr-quality/audio-cache.cjs');
const {
  deriveMtedxReference,
  deriveRoyalSrtReference,
  deriveWhiteHouseReference,
  deriveWolneLekturyReference,
  timedTextBlocks,
} = require('../../asr-quality/long-corpus-preparation.cjs');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const SCHEMA = 'wasper.public-corpus-sources.v1';
const REFERENCE_LIMIT = 8 * 1024 ** 2;
const SOURCE_LIMIT = 2 * 1024 ** 3;
const NORMALIZED_WAV_BYTES_PER_SECOND = 16_000 * 2;
const NORMALIZED_WAV_CONTAINER_ALLOWANCE_BYTES = 4096;
const ARCHIVE_MEMBER_READER = path.join(__dirname, 'read-archive-member.py');
const NORMALIZED_AUDIO_RUNNER = path.join(__dirname, 'run-normalized-audio.py');
const NORMALIZED_AUDIO_OUTPUT_MARKER = '__WASPER_NORMALIZED_WAV_DESCRIPTOR__';
const MAX_SOURCE_REDIRECTS = 5;
const TRUSTED_PYTHON_ENV = Object.freeze({
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin',
  PYTHONHASHSEED: '0',
});
const sourceSchema = require('../../../schema/public-corpus.schema.json');
const validateFixture = new Ajv({ allErrors: true }).compile(sourceSchema.definitions.fixture);

function sourceError(fixture, message, cause) {
  return new Error(`${fixture.fixtureId} (${fixture.sourceUrl}): ${message}`, { cause });
}

function trustedPython() {
  const executable = publicAuditPythonExecutable();
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) {
    throw new Error('public corpus requires an absolute system Python executable');
  }
  return executable;
}

function loopbackHttpHost(hostname) {
  return hostname === '127.0.0.1' || hostname === '[::1]';
}

function privateHost(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some(octet => !Number.isInteger(octet))) return false;
  const [first, second] = octets;
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function validateUrl(value, label, { allowLoopbackHttp = true } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a public source URL`);
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol === 'https:' && privateHost(url.hostname)) ||
    (url.protocol !== 'https:' && !(allowLoopbackHttp && url.protocol === 'http:' && loopbackHttpHost(url.hostname)))
  ) {
    throw new Error(
      `${label} must use public HTTPS without credentials, or loopback HTTP for fixtures`
    );
  }
  return url;
}

function selectFixtures(manifests, cohort, acceptSourceTerms) {
  if (!['short', 'long', 'all'].includes(cohort))
    throw new Error('cohort must be short, long, or all');
  const fixtures = [];
  const seen = new Set();
  for (const manifest of manifests) {
    if (manifest.schema !== SCHEMA || !Array.isArray(manifest.fixtures))
      throw new Error('invalid public source manifest');
    for (const fixture of manifest.fixtures) {
      if (cohort !== 'all' && fixture.cohort !== cohort) continue;
      try {
        if (!validateFixture(fixture))
          throw new Error(
            `invalid public source metadata: ${JSON.stringify(validateFixture.errors)}`
          );
        const conflict = fixture.acquisition.integrityConflict;
        if (
          conflict &&
          (conflict.frozenSourceSha256 !== fixture.sourceSha256 ||
            conflict.registrySourceSha256 === conflict.frozenSourceSha256)
        ) {
          throw new Error(
            'invalid public source metadata: integrity conflict must bind the frozen source hash and a different registry hash'
          );
        }
        if (
          !/^[a-z]{2}-(short|long)-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fixture.fixtureId) ||
          !fixture.fixtureId.startsWith(`${fixture.language}-${fixture.cohort}-`) ||
          seen.has(fixture.fixtureId)
        ) {
          throw new Error('invalid or duplicate fixtureId');
        }
        for (const key of ['sourceUrl', 'referenceUrl', 'licenseUrl']) {
          if (
            key === 'referenceUrl' &&
            fixture[key] === null &&
            fixture.acquisition?.state === 'manual-authorized-input-required'
          )
            continue;
          validateUrl(fixture[key], key);
        }
        for (const key of ['sourceSha256', 'normalizedWavSha256', 'referenceSha256']) {
          if (!/^[a-f0-9]{64}$/.test(fixture[key])) throw new Error(`invalid ${key}`);
        }
        if (
          !(fixture.durationSeconds > 0) ||
          !Number.isFinite(fixture.durationSeconds) ||
          typeof fixture.attribution !== 'string' ||
          !fixture.attribution.trim()
        )
          throw new Error('duration and attribution are required');
        seen.add(fixture.fixtureId);
        fixtures.push(fixture);
      } catch (error) {
        throw sourceError(fixture, error.message);
      }
    }
  }
  if (fixtures.length === 0)
    throw new Error(`no ${cohort} fixtures in the public source manifests`);
  const long = fixtures.filter(fixture => fixture.cohort === 'long');
  if (long.length && acceptSourceTerms !== true) {
    throw sourceError(
      long[0],
      '--accept-source-terms is required to accept the listed attribution and source terms for the long cohort'
    );
  }
  const blocked = fixtures.filter(
    fixture => fixture.acquisition?.state === 'manual-authorized-input-required'
  );
  if (blocked.length)
    throw new Error(
      blocked
        .map(fixture => {
          const conflict = fixture.acquisition.integrityConflict;
          const integrity = conflict
            ? `; integrity-conflict: ${conflict.reason} Frozen source SHA-256: ${conflict.frozenSourceSha256}; registry source SHA-256: ${conflict.registrySourceSha256}; source locator: ${conflict.sourceLocatorStatus}`
            : '';
          return sourceError(
            fixture,
            `manual-authorized-input-required: ${fixture.acquisition.reason}${integrity}`
          ).message;
        })
        .join('\n')
    );
  return fixtures;
}

// Create corpus paths through the shared descriptor-relative ownership boundary.
function ownedStorage(supplied) {
  const storage = ownedRuntimeStorage(supplied);
  const corpus = storage.directory(storage.layout.corpusRoot);
  return Object.assign(storage, {
    archives: new Map(),
    downloads: storage.directory(path.join(corpus, 'downloads')),
    fixtures: storage.directory(path.join(corpus, 'fixtures')),
  });
}

async function fetchSource(url) {
  let destination = validateUrl(url, 'source URL');
  for (let redirectCount = 0; redirectCount <= MAX_SOURCE_REDIRECTS; redirectCount += 1) {
    const response = await fetch(destination.href, {
      signal: AbortSignal.timeout(60 * 60_000),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get('location');
      await response.body?.cancel?.();
      if (typeof location !== 'string' || location === '') {
        throw new Error(`redirect URL has no destination: ${destination.href}`);
      }
      destination = validateUrl(new URL(location, destination).href, 'redirect URL', {
        allowLoopbackHttp: false,
      });
      continue;
    }
    return { destination, response };
  }
  throw new Error(`source redirect limit exceeded: ${url}`);
}

async function download(storage, url, target, expectedHash, limit, label) {
  try {
    storage.regular(target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (fs.existsSync(target)) {
    throw new Error(`${label} EEXIST at ${url}`);
  }
  const { destination, response } = await fetchSource(url);
  try {
    storage.check();
  } catch (error) {
    if (/symlink|changed/u.test(error.message)) {
      throw new Error('corpus cache directory changed during acquisition', { cause: error });
    }
    throw error;
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`${label} HTTP ${response.status} at ${destination.href}`);
  }
  try {
    await storage.download(target, response.body, expectedHash, limit);
  } catch (error) {
    if (/File exists/u.test(error.message)) {
      throw new Error(`${label} EEXIST at ${url}`, { cause: error });
    }
    if (/SHA-256|size mismatch/u.test(error.message)) {
      throw new Error(`${label} SHA-256 mismatch at ${url}`, { cause: error });
    }
    throw error;
  }
}

async function acquire(storage, url, acquisition, part, expectedHash, limit, label) {
  if (acquisition.kind !== 'tar-member')
    return download(storage, url, part, expectedHash, limit, label);
  const archivePath = path.join(storage.downloads, `${acquisition.archiveSha256}.archive`);
  if (!storage.archives.has(acquisition.archiveSha256)) {
    if (fs.existsSync(archivePath)) {
      storage.regular(archivePath);
      if (sha256File(archivePath) !== acquisition.archiveSha256)
        throw new Error(`archive SHA-256 mismatch at ${url}`);
    } else {
      await download(storage, url, part, acquisition.archiveSha256, 128 * 1024 ** 3, 'archive');
      storage.promote(part, archivePath);
      // A verified archive is reusable even if a selected member later fails.
      storage.files.delete(archivePath);
    }
    storage.archives.set(acquisition.archiveSha256, archivePath);
  }
  storage.regular(archivePath);
  const fd = storage.openDirectory(path.dirname(part));
  try {
    await new Promise((resolve, reject) => {
      const child = childProcess.spawn(
        trustedPython(),
        [
          '-I',
          '-S',
          '-B',
          ARCHIVE_MEMBER_READER,
          archivePath,
          acquisition.member,
          String(limit),
          path.basename(part),
        ],
        {
          cwd: '/',
          env: TRUSTED_PYTHON_ENV,
          stdio: ['ignore', 'ignore', 'pipe', fd],
          timeout: 60 * 60_000,
          killSignal: 'SIGKILL',
        }
      );
      let stderr = '';
      child.stderr.on('data', chunk => {
        stderr = (stderr + chunk.toString()).slice(-65536);
      });
      child.once('error', reject);
      child.once('close', code =>
        code === 0
          ? resolve()
          : reject(
              new Error(`archive member extraction failed: ${stderr.trim() || String(code)}`)
            )
      );
    });
    storage.check();
  } finally {
    fs.closeSync(fd);
  }
  storage.track(part);
  storage.regular(part);
  if (sha256File(part) !== expectedHash)
    throw new Error(`${label} member SHA-256 mismatch at ${url}`);
}

function deriveReference(source, acquisition, fixture) {
  switch (acquisition.adapter) {
    case 'text-v1':
      return source;
    case 'fleurs-tsv-v1': {
      const rows = source
        .replace(/\r\n?/g, '\n')
        .split('\n')
        .filter(line => line !== '')
        .map(line => line.split('\t'));
      if (rows.some(row => row.length !== 7))
        throw new Error('FLEURS metadata must contain seven TSV fields per row');
      const matches = rows.filter(row => row[1] === acquisition.itemId);
      if (matches.length !== 1)
        throw new Error('FLEURS reference item is missing or duplicated');
      if (Number(matches[0][5]) !== Math.round(fixture.durationSeconds * 16000))
        throw new Error('FLEURS sample count does not match fixture duration');
      return matches[0][2];
    }
    case 'mtedx-vtt-v1': {
      const cues = timedTextBlocks(source, 'mTEDx');
      const exclusions = acquisition.excludedCues.map(entry => {
        const text = cues.find(cue => hash(cue) === entry.sha256);
        if (text === undefined) throw new Error('mTEDx excluded cue hash is missing');
        return { text, occurrences: entry.occurrences };
      });
      return deriveMtedxReference(source, exclusions);
    }
    case 'wolne-lektury-txt-v1':
      return deriveWolneLekturyReference(source);
    case 'white-house-html-v1':
      return deriveWhiteHouseReference(source);
    case 'royal-srt-v1':
      return deriveRoyalSrtReference(source);
    default:
      throw new Error('unsupported reference adapter');
  }
}

async function verifyWav(storage, wavPath, fixture) {
  storage.regular(wavPath);
  if (sha256File(wavPath) !== fixture.normalizedWavSha256)
    throw new Error('normalized WAV SHA-256 mismatch');
  const audio = await inspectAudio(wavPath);
  storage.check();
  if (audio.sampleRateHz !== 16000 || audio.channels !== 1 || audio.codec !== 'pcm_s16le')
    throw new Error('normalized WAV must be 16 kHz mono PCM s16le');
  if (Math.abs(audio.durationSeconds - fixture.durationSeconds) > 1 / 16000)
    throw new Error('normalized WAV duration mismatch');
  return audio;
}

function normalizedWavOutputLimit(fixture) {
  if (!Number.isFinite(fixture.durationSeconds) || fixture.durationSeconds <= 0) {
    throw new Error('normalized WAV duration must be positive');
  }
  return (
    Math.ceil(fixture.durationSeconds * NORMALIZED_WAV_BYTES_PER_SECOND) +
    NORMALIZED_WAV_CONTAINER_ALLOWANCE_BYTES
  );
}

function runNormalizedAudioTransform(storage, stage, sourcePath, wavPath, maximumOutputBytes) {
  const stageDescriptor = storage.openDirectory(stage);
  const arguments_ = NORMALIZED_AUDIO_TRANSFORM.arguments.map(argument => {
    if (argument === '{sourcePath}') return sourcePath;
    if (argument === '{temporaryWavPath}') return NORMALIZED_AUDIO_OUTPUT_MARKER;
    return argument;
  });
  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      fs.closeSync(stageDescriptor);
      if (error) reject(error);
      else resolve();
    };
    try {
      child = childProcess.spawn(
        trustedPython(),
        [
          '-I',
          '-S',
          '-B',
          NORMALIZED_AUDIO_RUNNER,
          path.basename(wavPath),
          String(maximumOutputBytes),
          ...arguments_,
        ],
        {
          cwd: '/',
          stdio: ['ignore', 'ignore', 'pipe', stageDescriptor],
          timeout: 60 * 60_000,
          killSignal: 'SIGKILL',
        }
      );
    } catch (error) {
      finish(error);
      return;
    }
    let stderr = '';
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-65536);
    });
    child.once('error', error => {
      finish(error);
    });
    child.once('close', code => {
      if (code === 0) {
        finish();
        return;
      }
      finish(new Error(`ffmpeg failed: ${stderr.trim() || String(code)}`));
    });
  });
}

function localAudioSource(audioDir, fixture) {
  if (audioDir === undefined) return null;
  const directory = path.join(audioDir, fixture.fixtureId);
  try {
    const info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`local audio fixture directory is unsafe: ${directory}`);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const source = path.join(directory, 'source');
  try {
    const info = fs.lstatSync(source);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error(`local audio source is unsafe: ${source}`);
    if (info.size > SOURCE_LIMIT)
      throw new Error(`local audio source exceeds size limit: ${source}`);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (sha256File(source) !== fixture.sourceSha256)
    throw new Error(`local audio source SHA-256 mismatch: ${source}`);
  return source;
}

async function cachedFixture(storage, fixture, destination) {
  try {
    storage.directory(destination, false);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const sourcePath = path.join(destination, 'source');
  const wavPath = path.join(destination, 'normalized.wav');
  const referencePath = path.join(destination, 'reference.txt');
  if (storage.hashFile(sourcePath).sha256 !== fixture.sourceSha256)
    throw new Error('cached source SHA-256 mismatch');
  if (storage.hashFile(referencePath).sha256 !== fixture.referenceSha256)
    throw new Error('cached reference SHA-256 mismatch');
  const audio = await verifyWav(storage, wavPath, fixture);
  return fixtureEntry(storage, fixture, destination, audio);
}

function fixtureEntry(storage, fixture, destination, audio) {
  const prefix = path.relative(storage.layout.corpusRoot, destination);
  return {
    fixtureId: fixture.fixtureId,
    language: fixture.language,
    cohort: fixture.cohort,
    source: {
      url: fixture.sourceUrl,
      sha256: fixture.sourceSha256,
      path: `${prefix}/source`,
    },
    normalizedAudio: {
      ...audio,
      sha256: fixture.normalizedWavSha256,
      path: `${prefix}/normalized.wav`,
    },
    reference: {
      url: fixture.referenceUrl,
      sha256: fixture.referenceSha256,
      path: `${prefix}/reference.txt`,
    },
    licenseUrl: fixture.licenseUrl,
    attribution: fixture.attribution,
  };
}

async function prepareFixture(storage, fixture, audioDir) {
  const destination = path.join(storage.fixtures, fixture.fixtureId);
  const cached = await cachedFixture(storage, fixture, destination);
  if (cached) return cached;
  for (const name of fs.readdirSync(storage.fixtures).sort()) {
    if (
      !name.startsWith(`${fixture.fixtureId}-`) ||
      !/^[a-f0-9]{32}$/u.test(name.slice(fixture.fixtureId.length + 1))
    ) continue;
    const older = await cachedFixture(storage, fixture, path.join(storage.fixtures, name));
    if (older) return older;
  }
  const part = path.join(storage.downloads, `${fixture.fixtureId}.part`);
  let stage;
  let wavPath;
  let failure;
  let published = false;
  let publishedDirectory;
  try {
    storage.check();
    stage = storage.createTempDirectory(storage.downloads, `${fixture.fixtureId}-`);
    const sourcePath = path.join(stage, 'source');
    const localSource = localAudioSource(audioDir, fixture);
    if (localSource) {
      await storage.download(
        part,
        fs.createReadStream(localSource),
        fixture.sourceSha256,
        SOURCE_LIMIT
      );
    } else {
      await acquire(
        storage,
        fixture.sourceUrl,
        fixture.acquisition.audio,
        part,
        fixture.sourceSha256,
        SOURCE_LIMIT,
        'source'
      );
    }
    storage.promote(part, sourcePath);
    const referencePart = path.join(storage.downloads, `${fixture.fixtureId}.reference.part`);
    await acquire(
      storage,
      fixture.referenceUrl,
      fixture.acquisition.reference,
      referencePart,
      fixture.acquisition.reference.sha256,
      REFERENCE_LIMIT,
      'reference source'
    );
    storage.promote(referencePart, path.join(stage, 'reference-source'));
    const text = deriveReference(
      fs.readFileSync(path.join(stage, 'reference-source'), 'utf8'),
      fixture.acquisition.reference,
      fixture
    );
    if (hash(text) !== fixture.referenceSha256)
      throw new Error('derived reference SHA-256 mismatch');
    const referencePath = path.join(stage, 'reference.txt');
    storage.writeExclusive(referencePath, text);
    wavPath = path.join(stage, 'normalized.wav');
    storage.check();
    await runNormalizedAudioTransform(
      storage,
      stage,
      sourcePath,
      wavPath,
      normalizedWavOutputLimit(fixture)
    );
    storage.check();
    storage.track(wavPath);
    const audio = await verifyWav(storage, wavPath, fixture);
    storage.check();
    storage.moveDirectory(stage, destination);
    publishedDirectory = destination;
    published = true;
    return fixtureEntry(storage, fixture, destination, audio);
  } catch (error) {
    failure = sourceError(fixture, error.message, error);
    throw failure;
  } finally {
    if (!published) {
      try {
        storage.check();
        // FFmpeg can create its output before returning a failure. Adopt only
        // a regular, unshared file in this still-verified attempt directory.
        if (wavPath && !storage.files.has(wavPath)) {
          try {
            storage.track(wavPath);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        for (const target of [...storage.files.keys()]) storage.remove(target);
        if (stage) {
          storage.removeDirectory(stage);
        }
      } catch (cleanupError) {
        if (!failure) throw sourceError(fixture, cleanupError.message, cleanupError);
        // Keep the original failure as the primary diagnostic even if a cache
        // replacement or unsafe output prevents cleanup.
        failure.cleanupError = cleanupError;
        failure.message += `; cleanup refused: ${cleanupError.message}`;
      }
    } else {
      for (const target of [...storage.files.keys()])
        if (target.startsWith(`${publishedDirectory}/`)) storage.files.delete(target);
    }
  }
}

async function preparePublicCorpus(
  { layout, acceptSourceTerms = false, cohort = 'all', audioDir },
  { sourceManifests } = {}
) {
  const manifests = sourceManifests ?? [
    require('../../../corpus/short-fleurs.json'),
    require('../../../corpus/long-sources.json'),
  ];
  const fixtures = selectFixtures(manifests, cohort, acceptSourceTerms);
  if (audioDir !== undefined) {
    const info = fs.statSync(audioDir);
    if (!info.isDirectory())
      throw new Error(`local audio directory is not a directory: ${audioDir}`);
    audioDir = fs.realpathSync.native(audioDir);
  }
  const storage = ownedStorage(layout);
  const entries = [];
  for (const fixture of fixtures) {
    try {
      entries.push(await prepareFixture(storage, fixture, audioDir));
    } catch (error) {
      if (error.message.startsWith(`${fixture.fixtureId} (`)) throw error;
      throw sourceError(fixture, error.message);
    }
  }
  const manifest = { schema: 'wasper.public-run-corpus.v1', cohort, fixtures: entries };
  const manifestPath = path.join(
    storage.layout.corpusRoot,
    `verified-${cohort}-${crypto.randomUUID()}.json`
  );
  const temporary = `${manifestPath}.part`;
  storage.writeExclusive(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
  storage.promote(temporary, manifestPath);
  return { manifest, manifestPath };
}

module.exports = { preparePublicCorpus };
