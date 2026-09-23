'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { NORMALIZED_AUDIO_TRANSFORM, sha256File } = require('../asr-quality/audio-cache.cjs');
const {
  BALANCED_SHORT_DURATION_CENTISECONDS,
  BALANCED_SHORT_PROFILE,
  validateBalancedShortSelection,
  validateSourceRegistry,
} = require('../asr-quality/corpus-builder.cjs');
const { validateShortSelectionDocument } = require('../asr-quality/internal-corpus.cjs');
const { characterUnits } = require('../asr-quality/normalization.cjs');
const { parsePcm16MonoWav } = require('../asr-quality/prepared-long-corpus.cjs');
const { main: corpusCliMain } = require('../prepare-corpus.cjs');
const { CACHE_PATHS, LANGUAGES } = require('./constants.cjs');
const {
  createCorpusIdentityReport,
  createRecoveredCorpusManifest,
  extractExactV1Selection,
  sha256Canonical,
  validatePreparedLongDocument,
  validateRecoveredCorpusManifest,
} = require('./corpus-manifest.cjs');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SOURCE_REGISTRY_PATH = path.join(
  REPOSITORY_ROOT,
  'docs',
  'benchmarks',
  'asr-quality-v1',
  'sources.json'
);
const DEFAULT_PUBLIC_PROJECTION_PATH = path.join(
  REPOSITORY_ROOT,
  'website',
  'src',
  'data',
  'asr-benchmark-public.json'
);
const DEFAULT_LONG_SOURCE_ROOT = '/Volumes/shared_NAS_Folder/1_code/wasper/open_slr';
const REQUIRED_LONG_PREPARED_PATH =
  '/Volumes/shared_NAS_Folder/1_code/wasper/open_slr/prepared/asr-quality-internal-v3-final/long-prepared.json';
const EXPECTED_LONG_SOURCE_REGISTRY_SHA256 =
  'df5dea81f8b4c2351eaed4f10371a901634b5884ec1186299601e5e53e39d213';
const LONG_DURATION_TOLERANCE_SECONDS = 0.25;
const SHORT_DURATION_TOLERANCE_SECONDS = 1e-9;

function fail(message) {
  throw new Error(message);
}

function readJson(filePath, label) {
  let info;
  try {
    info = fs.lstatSync(filePath);
  } catch {
    fail(`${label} is missing: ${filePath}`);
  }
  if (info.isSymbolicLink() || !info.isFile()) fail(`${label} must be a non-symlink regular file`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
}

function safeRelativePath(value, label) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    path.posix.isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some(part => part === '' || part === '.' || part === '..')
  ) {
    fail(`${label} is not a safe relative path`);
  }
  return value;
}

function resolveContained(root, relativePath, label) {
  safeRelativePath(relativePath, label);
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split('/'));
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail(`${label} escapes its root`);
  }
  return resolved;
}

function regularFile(filePath, label, expectedBytes) {
  let info;
  try {
    info = fs.lstatSync(filePath);
  } catch {
    fail(`${label} is missing: ${filePath}`);
  }
  if (info.isSymbolicLink() || !info.isFile()) fail(`${label} must be a non-symlink regular file`);
  if (expectedBytes !== undefined && info.size !== expectedBytes) {
    fail(`${label} byte length drifted`);
  }
  return info;
}

function writeJsonAtomic(filePath, value) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = path.join(
    parent,
    `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`
  );
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      flag: 'wx',
      mode: 0o600,
    });
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
      fail(`output must not replace a symlink: ${filePath}`);
    }
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function deriveShortFixtureId(candidate) {
  if (
    candidate === null ||
    typeof candidate !== 'object' ||
    typeof candidate.language !== 'string' ||
    typeof candidate.sourceId !== 'string' ||
    typeof candidate.sourceItemId !== 'string'
  ) {
    throw new TypeError('short candidate identity is invalid');
  }
  const suffix = crypto
    .createHash('sha256')
    .update(`${candidate.sourceId}\0${candidate.sourceItemId}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `${candidate.language}-short-${suffix}`;
}

function matchExactShortCandidates(publicSelection, indexRows, { languages = LANGUAGES } = {}) {
  if (!Array.isArray(publicSelection) || !Array.isArray(indexRows)) {
    throw new TypeError('publicSelection and indexRows must be arrays');
  }
  const selectedIds = new Set(publicSelection.map(recording => recording.fixtureId));
  if (selectedIds.size !== publicSelection.length)
    fail('exact v1 short selection contains duplicates');
  const candidatesByFixtureId = new Map();
  for (const candidate of indexRows) {
    if (!languages.includes(candidate?.language)) continue;
    const fixtureId = deriveShortFixtureId(candidate);
    if (!selectedIds.has(fixtureId)) continue;
    const matches = candidatesByFixtureId.get(fixtureId) ?? [];
    matches.push(candidate);
    candidatesByFixtureId.set(fixtureId, matches);
  }
  return publicSelection
    .map(publicRecording => {
      const candidates = candidatesByFixtureId.get(publicRecording.fixtureId) ?? [];
      if (candidates.length === 0) {
        fail(
          `missing exact v1 short fixture ${publicRecording.fixtureId}; replacement is forbidden`
        );
      }
      if (candidates.length !== 1) {
        fail(`exact v1 short fixture ${publicRecording.fixtureId} is ambiguous`);
      }
      const [candidate] = candidates;
      if (
        candidate.language !== publicRecording.language ||
        candidate.sourceId !== `fleurs-v1-${publicRecording.language}`
      ) {
        fail(`exact v1 short fixture ${publicRecording.fixtureId} language or source drifted`);
      }
      if (
        Math.abs(candidate.durationSeconds - publicRecording.durationSeconds) >
        SHORT_DURATION_TOLERANCE_SECONDS
      ) {
        fail(`exact v1 short fixture ${publicRecording.fixtureId} duration drifted`);
      }
      return { publicRecording, candidate };
    })
    .sort((left, right) => left.publicRecording.id.localeCompare(right.publicRecording.id));
}

function playbackEntry(playbackByFixtureId, fixtureId) {
  const entry =
    playbackByFixtureId instanceof Map
      ? playbackByFixtureId.get(fixtureId)
      : playbackByFixtureId?.[fixtureId];
  if (entry === null || typeof entry !== 'object') {
    fail(`normalized playback is missing for ${fixtureId}`);
  }
  return entry;
}

function buildShortRunFixtures({
  matchedCandidates,
  publicSelection,
  resolvedSources,
  shortPlaybackByFixtureId,
}) {
  if (!Array.isArray(matchedCandidates) || !Array.isArray(publicSelection)) {
    throw new TypeError('matchedCandidates and publicSelection must be arrays');
  }
  const publicByFixtureId = new Map(
    publicSelection.map(recording => [recording.fixtureId, recording])
  );
  return matchedCandidates.map(({ candidate }) => {
    const fixtureId = deriveShortFixtureId(candidate);
    const publicRecording = publicByFixtureId.get(fixtureId);
    const source = resolvedSources?.[candidate.sourceId];
    if (publicRecording === undefined || source === undefined) {
      fail(`short fixture authority is missing for ${fixtureId}`);
    }
    if (
      publicRecording.language !== candidate.language ||
      publicRecording.sourceCollection !== source.publisher ||
      publicRecording.sourceRelease !== source.release ||
      publicRecording.sourceUrl !== source.homepage
    ) {
      fail(`short fixture public provenance drifted for ${fixtureId}`);
    }
    if (
      candidate.referenceSha256 !==
      crypto.createHash('sha256').update(candidate.reference).digest('hex')
    ) {
      fail(`short fixture reference SHA-256 drifted for ${fixtureId}`);
    }
    const playback = playbackEntry(shortPlaybackByFixtureId, fixtureId);
    regularFile(playback.wavPath, `normalized playback ${fixtureId}`);
    const bytes = fs.readFileSync(playback.wavPath);
    const observedSha256 = sha256File(playback.wavPath);
    if (playback.wavSha256 !== observedSha256) {
      fail(`normalized playback SHA-256 drifted for ${fixtureId}`);
    }
    const audio = parsePcm16MonoWav(
      { bytes, sha256: observedSha256 },
      `normalized playback ${fixtureId}`
    );
    if (
      Math.abs(audio.durationSeconds - candidate.durationSeconds) > SHORT_DURATION_TOLERANCE_SECONDS
    ) {
      fail(`normalized playback duration drifted for ${fixtureId}`);
    }
    return {
      id: fixtureId,
      language: candidate.language,
      cohort: 'short',
      speakerKey: candidate.speakerKey,
      source: {
        collection: source.publisher,
        release: source.release,
        partition: candidate.partition,
        recordingId: candidate.sourceItemId,
        mediaType: source.container.format,
        sha256: candidate.sourceSha256,
        durationSeconds: candidate.durationSeconds,
        url: source.homepage,
      },
      normalizedAudio: {
        sha256: audio.wavSha256,
        durationSeconds: audio.durationSeconds,
        transform: NORMALIZED_AUDIO_TRANSFORM,
      },
      reference: {
        status: 'available',
        text: candidate.reference,
        sha256: candidate.referenceSha256,
        wordCount: candidate.referenceWordCount,
        characterCount: characterUnits(candidate.reference, candidate.language).length,
        storagePolicy: 'restricted-local-cache',
        provisional: true,
        provenance: 'source-index-published-reference',
      },
      excluded: false,
    };
  });
}

function assertPreparedAuthority({
  prepared,
  preparedPath,
  requiredPreparedPath,
  expectedSourceRegistrySha256,
}) {
  if (path.resolve(preparedPath) !== path.resolve(requiredPreparedPath)) {
    fail(`prepared long authority path must equal ${requiredPreparedPath}`);
  }
  validatePreparedLongDocument(prepared);
  if (prepared.sourceRegistrySha256 !== expectedSourceRegistrySha256) {
    fail(`prepared long source registry SHA-256 must equal ${expectedSourceRegistrySha256}`);
  }
}

function buildLongRunFixtures({
  prepared,
  preparedPath,
  publicSelection,
  requiredPreparedPath = REQUIRED_LONG_PREPARED_PATH,
  sourceRoot = DEFAULT_LONG_SOURCE_ROOT,
  expectedSourceRegistrySha256 = EXPECTED_LONG_SOURCE_REGISTRY_SHA256,
}) {
  assertPreparedAuthority({
    prepared,
    preparedPath,
    requiredPreparedPath,
    expectedSourceRegistrySha256,
  });
  if (!Array.isArray(publicSelection)) {
    throw new TypeError('publicSelection must be an array');
  }
  const qualifiedPublic = publicSelection.filter(
    recording => recording.status !== 'no-qualified-fixture'
  );
  const noQualified = publicSelection.filter(
    recording => recording.status === 'no-qualified-fixture'
  );
  if (qualifiedPublic.length !== prepared.items.length) {
    fail('prepared long manifest does not match the exact v1 long selection count');
  }
  const publicByFixtureId = new Map(
    qualifiedPublic.map(recording => [recording.fixtureId, recording])
  );
  const seen = new Set();
  const fixtures = prepared.items.map(item => {
    const publicRecording = publicByFixtureId.get(item.fixtureId);
    if (publicRecording === undefined || seen.has(item.fixtureId)) {
      fail(`prepared long fixture identifier drifted: ${item.fixtureId}`);
    }
    seen.add(item.fixtureId);
    if (
      publicRecording.language !== item.language ||
      publicRecording.sourceUrl !== item.audioPage ||
      publicRecording.referenceUrl !== item.referencePage
    ) {
      fail(`prepared long fixture language or provenance drifted: ${item.fixtureId}`);
    }
    if (
      Math.abs(publicRecording.durationSeconds - item.durationSeconds) >
      LONG_DURATION_TOLERANCE_SECONDS
    ) {
      fail(`prepared long fixture duration drifted: ${item.fixtureId}`);
    }
    const sourcePath = resolveContained(
      sourceRoot,
      item.sourceRelativePath,
      `${item.fixtureId} source path`
    );
    regularFile(sourcePath, `${item.fixtureId} source`, item.sourceBytes);
    if (sha256File(sourcePath) !== item.sourceSha256) {
      fail(`prepared long fixture source SHA-256 drifted: ${item.fixtureId}`);
    }
    const preparedRoot = path.dirname(path.resolve(preparedPath));
    const playbackPath = resolveContained(
      preparedRoot,
      item.playbackRelativePath,
      `${item.fixtureId} playback path`
    );
    regularFile(playbackPath, `${item.fixtureId} playback`, item.playbackBytes);
    const playbackBytes = fs.readFileSync(playbackPath);
    const playbackSha256 = sha256File(playbackPath);
    if (playbackSha256 !== item.playbackSha256) {
      fail(`prepared long fixture normalized WAV SHA-256 drifted: ${item.fixtureId}`);
    }
    const audio = parsePcm16MonoWav(
      { bytes: playbackBytes, sha256: playbackSha256 },
      `${item.fixtureId} playback WAV`
    );
    if (Math.abs(audio.durationSeconds - item.durationSeconds) > LONG_DURATION_TOLERANCE_SECONDS) {
      fail(`prepared long fixture normalized WAV duration drifted: ${item.fixtureId}`);
    }
    if (
      item.reference?.status !== 'available' ||
      typeof item.reference.text !== 'string' ||
      crypto.createHash('sha256').update(item.reference.text).digest('hex') !==
        item.reference.sha256
    ) {
      fail(`prepared long fixture reference SHA-256 drifted: ${item.fixtureId}`);
    }
    return {
      id: item.fixtureId,
      language: item.language,
      cohort: 'long',
      speakerKey: `spk_${crypto.createHash('sha256').update(item.fixtureId).digest('hex').slice(0, 16)}`,
      source: {
        collection: item.collection,
        release: item.release,
        partition: 'standalone-recording',
        recordingId: item.recordingId,
        mediaType: path.extname(item.sourceRelativePath).slice(1),
        sha256: item.sourceSha256,
        durationSeconds: item.durationSeconds,
        url: item.audioPage,
      },
      normalizedAudio: {
        sha256: audio.wavSha256,
        durationSeconds: audio.durationSeconds,
        transform: NORMALIZED_AUDIO_TRANSFORM,
      },
      reference: { ...item.reference },
      excluded: false,
    };
  });
  if (seen.size !== qualifiedPublic.length)
    fail('prepared long manifest fixture membership drifted');
  for (const outcome of noQualified) {
    const keys = Object.keys(outcome).sort();
    if (
      keys.join(',') !== 'cohort,language,reason,status' ||
      outcome.cohort !== 'long' ||
      typeof outcome.language !== 'string' ||
      typeof outcome.reason !== 'string' ||
      outcome.reason.trim() === ''
    ) {
      fail('public no-qualified long outcome is invalid');
    }
  }
  return [...fixtures, ...noQualified.map(outcome => ({ ...outcome }))].sort((left, right) =>
    (left.id ?? `no-qualified-long:${left.language}`).localeCompare(
      right.id ?? `no-qualified-long:${right.language}`
    )
  );
}

function filterExactShortSourceRegistry(sourceRegistry, languages = LANGUAGES) {
  const resolved = validateSourceRegistry(sourceRegistry);
  const imports = languages.map(language => {
    const sourceId = `fleurs-v1-${language}`;
    const source = resolved.sourcesById[sourceId];
    if (
      source === undefined ||
      source.language !== language ||
      source.partition !== 'test' ||
      source.indexKind !== 'fleurs-tar-tsv' ||
      source.metadata === null
    ) {
      fail(`committed v1 provenance is missing exact FLEURS source ${sourceId}`);
    }
    return sourceRegistry.imports.find(entry => entry.id === sourceId);
  });
  const objectIds = new Set();
  for (const entry of imports) {
    objectIds.add(entry.mediaObjectId);
    objectIds.add(entry.metadataObjectId);
  }
  const objects = sourceRegistry.objects.filter(object => objectIds.has(object.id));
  if (objects.length !== objectIds.size)
    fail('committed v1 FLEURS object provenance is incomplete');
  const filtered = {
    schemaVersion: sourceRegistry.schemaVersion,
    benchmarkRevision: sourceRegistry.benchmarkRevision,
    objects,
    imports,
  };
  validateSourceRegistry(filtered);
  return filtered;
}

function inspectCorpusRecoveryInputs({
  sourceRegistryPath = DEFAULT_SOURCE_REGISTRY_PATH,
  publicProjectionPath = DEFAULT_PUBLIC_PROJECTION_PATH,
  longPreparedPath = REQUIRED_LONG_PREPARED_PATH,
  requiredLongPreparedPath = REQUIRED_LONG_PREPARED_PATH,
  longSourceRoot = DEFAULT_LONG_SOURCE_ROOT,
  expectedLongSourceRegistrySha256 = EXPECTED_LONG_SOURCE_REGISTRY_SHA256,
  languages = LANGUAGES,
  expectedShortCount = 243,
  expectedLongCount = 21,
} = {}) {
  if (path.resolve(longPreparedPath) !== path.resolve(requiredLongPreparedPath)) {
    fail(`prepared long authority path must equal ${requiredLongPreparedPath}`);
  }
  const sourceRegistry = readJson(sourceRegistryPath, 'committed v1 source registry');
  const publicProjection = readJson(publicProjectionPath, 'committed v1 public projection');
  const prepared = readJson(longPreparedPath, 'prepared long authority');
  const selection = extractExactV1Selection(publicProjection, {
    languages,
    expectedShortCount,
    expectedLongCount,
  });
  const filteredRegistry = filterExactShortSourceRegistry(sourceRegistry, languages);
  assertPreparedAuthority({
    prepared,
    preparedPath: longPreparedPath,
    requiredPreparedPath: requiredLongPreparedPath,
    expectedSourceRegistrySha256: expectedLongSourceRegistrySha256,
  });
  const qualifiedLongCount = selection.long.filter(
    outcome => outcome.status !== 'no-qualified-fixture'
  ).length;
  if (prepared.items.length !== qualifiedLongCount) {
    fail('prepared long authority count does not match the exact v1 public projection');
  }
  let longSourceFiles = 0;
  let longPlaybackFiles = 0;
  for (const item of prepared.items) {
    regularFile(
      resolveContained(longSourceRoot, item.sourceRelativePath, `${item.fixtureId} source path`),
      `${item.fixtureId} source`,
      item.sourceBytes
    );
    longSourceFiles += 1;
    regularFile(
      resolveContained(
        path.dirname(path.resolve(longPreparedPath)),
        item.playbackRelativePath,
        `${item.fixtureId} playback path`
      ),
      `${item.fixtureId} playback`,
      item.playbackBytes
    );
    longPlaybackFiles += 1;
  }
  return {
    longFixtureCount: selection.long.length,
    longPlaybackFiles,
    longSourceFiles,
    preparedLongSchema: prepared.schema,
    shortArchiveObjects: filteredRegistry.objects.length,
    shortFixtureCount: selection.short.length,
    sourceRegistrySha256: sha256Canonical(sourceRegistry),
  };
}

async function responseChunks(response) {
  if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
    return response.body;
  }
  if (response.body && typeof response.body.getReader === 'function') {
    return {
      async *[Symbol.asyncIterator]() {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      },
    };
  }
  fail('source archive response must provide a readable byte stream');
}

async function downloadRegisteredObject(object, destination, fetchImpl) {
  const sourceUrl = new URL(object.acquisitionLocator);
  if (sourceUrl.protocol !== 'https:') fail(`source object ${object.id} must use HTTPS`);
  const response = await fetchImpl(sourceUrl.href);
  if (!response?.ok) {
    fail(`source object ${object.id} download failed with HTTP ${String(response?.status)}`);
  }
  const finalUrl = new URL(response.url || sourceUrl.href);
  if (finalUrl.protocol !== 'https:') fail(`source object ${object.id} redirected outside HTTPS`);
  const declaredLength = response.headers?.get?.('content-length');
  if (declaredLength !== null && declaredLength !== undefined) {
    if (!/^(?:0|[1-9]\d*)$/u.test(declaredLength) || Number(declaredLength) !== object.bytes) {
      fail(`source object ${object.id} Content-Length drifted`);
    }
  }
  const temporary = `${destination}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    try {
      for await (const value of await responseChunks(response)) {
        if (!(value instanceof Uint8Array) || value.byteLength === 0) {
          fail(`source object ${object.id} returned an invalid byte chunk`);
        }
        if (value.byteLength > object.bytes - bytes) {
          fail(`source object ${object.id} exceeded its committed byte length`);
        }
        const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        fs.writeFileSync(descriptor, chunk);
        hash.update(chunk);
        bytes += chunk.length;
      }
    } finally {
      fs.closeSync(descriptor);
    }
    if (bytes !== object.bytes || hash.digest('hex') !== object.sha256) {
      fail(`source object ${object.id} SHA-256 or byte length drifted`);
    }
    try {
      fs.linkSync(temporary, destination);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      regularFile(destination, `source object ${object.id}`, object.bytes);
      if (sha256File(destination) !== object.sha256) {
        fail(`source object ${object.id} existing cache entry drifted`);
      }
    }
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

async function reacquireSourceArchives(filteredRegistry, output, { fetchImpl = fetch } = {}) {
  const archiveRoot = path.join(output, 'source-archives');
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  const recovered = [];
  for (const object of filteredRegistry.objects) {
    if (object.acquisitionKind !== 'public-url') {
      fail(`source object ${object.id} requires unavailable non-public acquisition`);
    }
    const destination = path.join(archiveRoot, object.id);
    if (fs.existsSync(destination)) {
      regularFile(destination, `source object ${object.id}`, object.bytes);
      if (sha256File(destination) !== object.sha256) {
        fail(`source object ${object.id} existing cache entry drifted`);
      }
    } else {
      await downloadRegisteredObject(object, destination, fetchImpl);
    }
    recovered.push({ id: object.id, bytes: object.bytes, sha256: object.sha256 });
  }
  return recovered;
}

function readSourceIndexRows(filteredRegistry, output) {
  const rows = [];
  for (const source of filteredRegistry.imports) {
    const indexPath = path.join(output, 'source-indexes', `${source.id}.jsonl`);
    regularFile(indexPath, `source index ${source.id}`);
    for (const [index, line] of fs.readFileSync(indexPath, 'utf8').split('\n').entries()) {
      if (line === '') continue;
      try {
        rows.push(JSON.parse(line));
      } catch (error) {
        fail(`source index ${source.id}:${index + 1} is invalid JSON: ${error.message}`);
      }
    }
  }
  return rows;
}

function createRecoveredShortSelection(matched, languages) {
  const byLanguage = Object.create(null);
  for (const language of languages) {
    const fixturesByDuration = new Map();
    for (const { candidate, publicRecording } of matched) {
      if (candidate.language !== language) continue;
      const duration = Math.round(candidate.durationSeconds * 100);
      if (fixturesByDuration.has(duration)) {
        fail(`balanced v1 short selection duplicates ${duration / 100} seconds for ${language}`);
      }
      fixturesByDuration.set(duration, { ...candidate, fixtureId: publicRecording.fixtureId });
    }
    const fixtures = BALANCED_SHORT_DURATION_CENTISECONDS.map(duration =>
      fixturesByDuration.get(duration)
    );
    if (fixtures.includes(undefined)) {
      fail(`balanced v1 short selection duration membership drifted for ${language}`);
    }
    byLanguage[language] = {
      durationSeconds: 270,
      fixtureIds: fixtures.map(fixture => `${fixture.sourceId}:${fixture.sourceItemId}`),
      fixtures,
    };
  }
  const selection = {
    schemaVersion: 'asr-quality-short-selection-v2',
    benchmarkProfile: BALANCED_SHORT_PROFILE,
    seed: 'wasper-asr-balanced-short-v1',
    durationCentiseconds: [...BALANCED_SHORT_DURATION_CENTISECONDS],
    languages: byLanguage,
  };
  validateBalancedShortSelection(selection, { languages });
  if (
    languages.length === LANGUAGES.length &&
    [...languages].sort().every((language, index) => language === [...LANGUAGES].sort()[index])
  ) {
    const contract = validateShortSelectionDocument(selection);
    if (contract.benchmarkProfile !== BALANCED_SHORT_PROFILE) {
      fail('recovered short selection does not match the v1 balanced profile');
    }
  }
  return selection;
}

function materializeShortCorpus({
  matched,
  filteredRegistry,
  output,
  selectionsDirectory,
  languages,
  python,
  corpusCli = corpusCliMain,
}) {
  const selection = createRecoveredShortSelection(matched, languages);
  const selectionPath = path.join(selectionsDirectory, 'exact-v1-short-selection.json');
  writeJsonAtomic(selectionPath, selection);
  const shortOutput = path.join(output, 'corpus', 'short');
  corpusCli([
    'worksheet',
    '--selection',
    selectionPath,
    '--cache',
    output,
    '--python',
    python,
    '--output',
    shortOutput,
  ]);
  const worksheet = readJson(path.join(shortOutput, 'worksheet.json'), 'recovered short worksheet');
  const shortPlaybackByFixtureId = new Map(
    worksheet.items.map(item => [
      item.fixtureId,
      {
        wavPath: resolveContained(shortOutput, item.playbackFile, `${item.fixtureId} playback`),
        wavSha256: item.playbackSha256,
      },
    ])
  );
  const shortFixtures = buildShortRunFixtures({
    matchedCandidates: matched,
    publicSelection: matched.map(entry => entry.publicRecording),
    resolvedSources: validateSourceRegistry(filteredRegistry).sourcesById,
    shortPlaybackByFixtureId,
  });
  return { selection, shortFixtures };
}

async function recoverCorpus(
  {
    output,
    repositoryRoot = REPOSITORY_ROOT,
    sourceRegistryPath = path.join(
      repositoryRoot,
      'docs',
      'benchmarks',
      'asr-quality-v1',
      'sources.json'
    ),
    publicProjectionPath = path.join(
      repositoryRoot,
      'website',
      'src',
      'data',
      'asr-benchmark-public.json'
    ),
    longPreparedPath = REQUIRED_LONG_PREPARED_PATH,
    requiredLongPreparedPath = REQUIRED_LONG_PREPARED_PATH,
    longSourceRoot = DEFAULT_LONG_SOURCE_ROOT,
    expectedLongSourceRegistrySha256 = EXPECTED_LONG_SOURCE_REGISTRY_SHA256,
    languages = LANGUAGES,
    expectedShortCount = 243,
    expectedLongCount = 21,
    python = process.env.WASPER_CORPUS_PYTHON || '/usr/bin/python3',
  },
  dependencies = {}
) {
  if (typeof output !== 'string' || output.trim() === '') {
    throw new TypeError('recoverCorpus output must be a non-empty string');
  }
  const expectedOutput = path.resolve(repositoryRoot, CACHE_PATHS.root);
  if (path.resolve(output) !== expectedOutput) {
    fail(`recoverCorpus output must equal ${expectedOutput}`);
  }
  inspectCorpusRecoveryInputs({
    sourceRegistryPath,
    publicProjectionPath,
    longPreparedPath,
    requiredLongPreparedPath,
    longSourceRoot,
    expectedLongSourceRegistrySha256,
    languages,
    expectedShortCount,
    expectedLongCount,
  });
  const sourceRegistry = readJson(sourceRegistryPath, 'committed v1 source registry');
  const publicProjection = readJson(publicProjectionPath, 'committed v1 public projection');
  const preparedLong = readJson(longPreparedPath, 'prepared long authority');
  const selection = extractExactV1Selection(publicProjection, {
    languages,
    expectedShortCount,
    expectedLongCount,
  });
  const filteredRegistry = filterExactShortSourceRegistry(sourceRegistry, languages);
  const selectionsDirectory = path.join(output, 'selections');
  fs.mkdirSync(selectionsDirectory, { recursive: true, mode: 0o700 });
  const filteredRegistryPath = path.join(selectionsDirectory, 'v1-short-source-registry.json');
  writeJsonAtomic(filteredRegistryPath, filteredRegistry);
  await (dependencies.reacquireSourceArchives ?? reacquireSourceArchives)(
    filteredRegistry,
    output,
    dependencies
  );
  (dependencies.buildSourceIndexes ?? corpusCliMain)([
    'import',
    '--sources',
    filteredRegistryPath,
    '--cache',
    output,
    '--python',
    python,
  ]);
  const indexRows = (dependencies.readSourceIndexRows ?? readSourceIndexRows)(
    filteredRegistry,
    output
  );
  const matched = matchExactShortCandidates(selection.short, indexRows, { languages });
  const shortMaterialization = (dependencies.materializeShortCorpus ?? materializeShortCorpus)({
    matched,
    filteredRegistry,
    output,
    selectionsDirectory,
    languages,
    python,
    corpusCli: dependencies.corpusCli,
  });
  if (
    shortMaterialization === null ||
    typeof shortMaterialization !== 'object' ||
    !Array.isArray(shortMaterialization.shortFixtures)
  ) {
    fail('short corpus materialization did not return fixtures and selection authority');
  }
  const { selection: shortSelection, shortFixtures } = shortMaterialization;
  const longOutcomes = (dependencies.buildLongRunFixtures ?? buildLongRunFixtures)({
    prepared: preparedLong,
    preparedPath: longPreparedPath,
    publicSelection: selection.long,
    requiredPreparedPath: requiredLongPreparedPath,
    sourceRoot: longSourceRoot,
    expectedSourceRegistrySha256: expectedLongSourceRegistrySha256,
  });
  const authorities = {
    languages,
    expectedShortCount,
    expectedLongCount,
    publicProjection,
    sourceRegistry,
    preparedLong,
    shortFixtures,
    shortSelection,
    longOutcomes,
  };
  const manifest = createRecoveredCorpusManifest(authorities);
  validateRecoveredCorpusManifest(manifest, authorities);
  const identityReport = createCorpusIdentityReport(manifest);
  const manifestPath = path.join(selectionsDirectory, 'recovered-corpus.json');
  const identityReportPath = path.join(selectionsDirectory, 'identity-report.json');
  writeJsonAtomic(manifestPath, manifest);
  writeJsonAtomic(identityReportPath, identityReport);
  return { identityReport, identityReportPath, manifest, manifestPath };
}

module.exports = {
  buildLongRunFixtures,
  buildShortRunFixtures,
  createRecoveredShortSelection,
  deriveShortFixtureId,
  EXPECTED_LONG_SOURCE_REGISTRY_SHA256,
  filterExactShortSourceRegistry,
  inspectCorpusRecoveryInputs,
  matchExactShortCandidates,
  reacquireSourceArchives,
  recoverCorpus,
  REQUIRED_LONG_PREPARED_PATH,
};
