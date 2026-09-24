'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const Ajv = require('ajv');
const { resolveLayout, writeOwnershipMarker, OWNER_FILE } = require('../../config.cjs');
const {
  NORMALIZED_AUDIO_TRANSFORM,
  inspectAudio,
  sha256File,
} = require('../../asr-quality/audio-cache.cjs');
const {
  deriveMtedxReference,
  deriveWolneLekturyReference,
  timedTextBlocks,
} = require('../../asr-quality/long-corpus-preparation.cjs');

const execute = promisify(execFile);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const SCHEMA = 'wasper.public-corpus-sources.v1';
const REFERENCE_LIMIT = 8 * 1024 ** 2;
const SOURCE_LIMIT = 2 * 1024 ** 3;
const sourceSchema = require('../../../schema/public-corpus.schema.json');
const validateFixture = new Ajv({ allErrors: true }).compile(sourceSchema.definitions.fixture);

function sourceError(fixture, message, cause) {
  return new Error(`${fixture.fixtureId} (${fixture.sourceUrl}): ${message}`, { cause });
}

function validateUrl(value, label) {
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
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
  ) {
    throw new Error(
      `${label} must use HTTPS without credentials, or loopback HTTP for fixtures`
    );
  }
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

// Hold identities across asynchronous network/process work. Never reuse, overwrite,
// or remove a partial file owned by a different attempt.
function ownedStorage(supplied) {
  const layout = resolveLayout({
    cacheDir: supplied.cacheRoot,
    homeDirectory: supplied.homeDirectory,
    outputDir: supplied.outputRoot,
  });
  if (layout.cacheRoot !== supplied.cacheRoot || layout.corpusRoot !== supplied.corpusRoot)
    throw new Error('corpus layout changed or is forged');
  if (
    fs.existsSync(layout.cacheRoot) &&
    !fs.existsSync(path.join(layout.cacheRoot, OWNER_FILE)) &&
    fs.readdirSync(layout.cacheRoot).length
  ) {
    throw new Error('refusing an unmarked nonempty benchmark cache');
  }
  writeOwnershipMarker(layout);
  const directories = new Map();
  const files = new Map();
  const identity = info => `${info.dev}:${info.ino}`;
  const rememberDirectory = directory => {
    const info = fs.lstatSync(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      fs.realpathSync.native(directory) !== directory
    )
      throw new Error('corpus cache directory must not be a symlink');
    directories.set(directory, identity(info));
  };
  rememberDirectory(layout.cacheRoot);
  const check = () => {
    for (const [directory, expected] of directories) {
      const info = fs.lstatSync(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        identity(info) !== expected ||
        fs.realpathSync.native(directory) !== directory
      )
        throw new Error('corpus cache directory changed during acquisition');
    }
    const marker = path.join(layout.cacheRoot, OWNER_FILE);
    const info = fs.lstatSync(marker);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      fs.readFileSync(marker, 'utf8') !== markerText
    )
      throw new Error('corpus ownership marker changed during acquisition');
  };
  const markerText = fs.readFileSync(path.join(layout.cacheRoot, OWNER_FILE), 'utf8');
  const directory = relative => {
    check();
    const target = path.join(layout.cacheRoot, relative);
    try {
      fs.mkdirSync(target, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    rememberDirectory(target);
    return target;
  };
  directory('corpus');
  const downloads = directory('corpus/downloads');
  const fixtures = directory('corpus/fixtures');
  const archives = new Map();
  const regular = target => {
    check();
    const info = fs.lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error('corpus cache file must be a regular, unshared file');
    return info;
  };
  const create = target => {
    check();
    const fd = fs.openSync(
      target,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600
    );
    files.set(target, identity(fs.fstatSync(fd)));
    return fd;
  };
  const move = (from, to) => {
    check();
    if (
      fs.existsSync(to) ||
      (() => {
        try {
          fs.lstatSync(to);
          return true;
        } catch (error) {
          if (error.code === 'ENOENT') return false;
          throw error;
        }
      })()
    )
      throw new Error('corpus promotion destination already exists');
    if (files.get(from) !== identity(regular(from)))
      throw new Error('partial download changed before promotion');
    fs.renameSync(from, to);
    files.delete(from);
    files.set(to, identity(fs.lstatSync(to)));
  };
  const remove = target => {
    check();
    if (!files.has(target)) return;
    if (identity(regular(target)) !== files.get(target))
      throw new Error('partial file changed before cleanup');
    fs.unlinkSync(target);
    files.delete(target);
  };
  return {
    layout,
    downloads,
    fixtures,
    archives,
    check,
    regular,
    create,
    move,
    remove,
    files,
    directories,
    rememberDirectory,
    identity,
  };
}

async function download(storage, url, target, expectedHash, limit, label) {
  const fd = storage.create(target);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(60 * 60_000) });
    storage.check();
    validateUrl(response.url, 'redirect URL');
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`${label} HTTP ${response.status} at ${url}`);
    }
    let bytes = 0;
    const digest = crypto.createHash('sha256');
    for await (const chunk of response.body) {
      storage.check();
      bytes += chunk.length;
      if (bytes > limit) throw new Error(`${label} exceeds download byte limit`);
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length)
        offset += fs.writeSync(fd, chunk, offset, chunk.length - offset);
    }
    if (digest.digest('hex') !== expectedHash)
      throw new Error(`${label} SHA-256 mismatch at ${url}`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
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
      storage.move(part, archivePath);
      // A verified archive is reusable even if a selected member later fails.
      storage.files.delete(archivePath);
    }
    storage.archives.set(acquisition.archiveSha256, archivePath);
  }
  storage.regular(archivePath);
  const fd = storage.create(part);
  try {
    // The helper streams directly into this attempt's exclusively created file.
    // It never materializes an archive path, link, or an entire member in memory.
    await new Promise((resolve, reject) => {
      const child = spawn(
        'python3',
        [
          path.join(__dirname, 'read-archive-member.py'),
          archivePath,
          acquisition.member,
          String(limit),
        ],
        {
          stdio: ['ignore', fd, 'pipe'],
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
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
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

async function prepareFixture(storage, fixture) {
  const part = path.join(storage.downloads, `${fixture.fixtureId}.part`);
  let stage;
  let wavPath;
  let failure;
  let published = false;
  try {
    storage.check();
    stage = fs.mkdtempSync(path.join(storage.downloads, `${fixture.fixtureId}-`));
    storage.rememberDirectory(stage);
    const sourcePath = path.join(stage, 'source');
    await acquire(
      storage,
      fixture.sourceUrl,
      fixture.acquisition.audio,
      part,
      fixture.sourceSha256,
      SOURCE_LIMIT,
      'source'
    );
    storage.move(part, sourcePath);
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
    storage.move(referencePart, path.join(stage, 'reference-source'));
    const text = deriveReference(
      fs.readFileSync(path.join(stage, 'reference-source'), 'utf8'),
      fixture.acquisition.reference,
      fixture
    );
    if (hash(text) !== fixture.referenceSha256)
      throw new Error('derived reference SHA-256 mismatch');
    const referencePath = path.join(stage, 'reference.txt');
    const fd = storage.create(referencePath);
    try {
      fs.writeFileSync(fd, text);
    } finally {
      fs.closeSync(fd);
    }
    wavPath = path.join(stage, 'normalized.wav');
    storage.check();
    await execute(
      NORMALIZED_AUDIO_TRANSFORM.tool,
      NORMALIZED_AUDIO_TRANSFORM.arguments.map(argument => {
        if (argument === '{sourcePath}') return sourcePath;
        if (argument === '{temporaryWavPath}') return wavPath;
        return argument;
      }),
      { timeout: 60 * 60_000, maxBuffer: 64 * 1024 }
    );
    storage.check();
    storage.files.set(wavPath, storage.identity(storage.regular(wavPath)));
    const audio = await verifyWav(storage, wavPath, fixture);
    const destination = path.join(storage.fixtures, path.basename(stage));
    storage.check();
    fs.renameSync(stage, destination);
    storage.directories.delete(stage);
    published = true;
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
            storage.files.set(wavPath, storage.identity(storage.regular(wavPath)));
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
        for (const target of [...storage.files.keys()]) storage.remove(target);
        if (stage) {
          fs.rmdirSync(stage);
          storage.directories.delete(stage);
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
        if (target.startsWith(`${stage}/`)) storage.files.delete(target);
    }
  }
}

async function preparePublicCorpus(
  { layout, acceptSourceTerms = false, cohort = 'all' },
  { sourceManifests } = {}
) {
  const manifests = sourceManifests ?? [
    require('../../../corpus/short-fleurs.json'),
    require('../../../corpus/long-sources.json'),
  ];
  const fixtures = selectFixtures(manifests, cohort, acceptSourceTerms);
  const storage = ownedStorage(layout);
  const entries = [];
  for (const fixture of fixtures) {
    try {
      entries.push(await prepareFixture(storage, fixture));
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
  const fd = storage.create(temporary);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  storage.move(temporary, manifestPath);
  return { manifest, manifestPath };
}

module.exports = { preparePublicCorpus };
