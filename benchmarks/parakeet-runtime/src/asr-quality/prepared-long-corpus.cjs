'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const { NORMALIZED_AUDIO_TRANSFORM } = require('./audio-cache.cjs');
const { BYTE_LIMITS, bindTrustedRoot, snapshotRegularFile } = require('./bounded-file-snapshot.cjs');
const {
  inspectRegisteredSource,
  validateLongSourceRegistry,
} = require('./long-corpus-preparation.cjs');
const { canonicalJson } = require('./manifest.cjs');
const { characterUnits, wordUnits } = require('./normalization.cjs');

const PREPARED_SCHEMA = 'wasper.asr-quality.prepared-long-corpus.v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const DURATION_TOLERANCE_SECONDS = 0.25;
const PREPARED_ITEM_FIELDS = Object.freeze([
  'fixtureId',
  'language',
  'recordingId',
  'collection',
  'release',
  'title',
  'sourceRelativePath',
  'sourceSha256',
  'sourceBytes',
  'durationSeconds',
  'audioPage',
  'referencePage',
  'licenseId',
  'licenseUrl',
  'attribution',
  'referenceAdapter',
  'excludedReferenceCues',
  'playbackRelativePath',
  'playbackSha256',
  'playbackBytes',
  'reference',
]);

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is invalid`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail(`${label} keys are invalid`);
  }
}

function safeRelative(value, label) {
  if (typeof value !== 'string' || value === '' || path.posix.isAbsolute(value)) {
    fail(`${label} is invalid`);
  }
  if (
    value.includes('\\') ||
    value.split('/').some(part => !part || part === '.' || part === '..')
  ) {
    fail(`${label} is invalid`);
  }
}

function parsePcm16MonoWav(snapshot, label) {
  const bytes = snapshot.bytes;
  if (
    bytes.length < 44 ||
    bytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    bytes.subarray(8, 12).toString('ascii') !== 'WAVE' ||
    bytes.readUInt32LE(4) !== bytes.length - 8
  ) {
    fail(`${label} is invalid PCM16 mono 16 kHz WAV`);
  }
  let offset = 12;
  let format = null;
  let dataBytes = null;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) fail(`${label} WAV chunk is invalid`);
    const type = bytes.subarray(offset, offset + 4).toString('ascii');
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    const paddedEnd = end + (length % 2);
    if (end > bytes.length || paddedEnd > bytes.length) fail(`${label} WAV chunk is invalid`);
    if (type === 'fmt ') {
      if (format !== null || length !== 16) fail(`${label} WAV format is invalid`);
      format = {
        audioFormat: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRateHz: bytes.readUInt32LE(start + 4),
        byteRate: bytes.readUInt32LE(start + 8),
        blockAlign: bytes.readUInt16LE(start + 12),
        bitsPerSample: bytes.readUInt16LE(start + 14),
      };
    } else if (type === 'data') {
      if (dataBytes !== null) fail(`${label} WAV data is invalid`);
      dataBytes = length;
    }
    offset = paddedEnd;
  }
  if (
    offset !== bytes.length ||
    format?.audioFormat !== 1 ||
    format.channels !== 1 ||
    format.sampleRateHz !== 16_000 ||
    format.byteRate !== 32_000 ||
    format.blockAlign !== 2 ||
    format.bitsPerSample !== 16 ||
    dataBytes === null ||
    dataBytes % 2 !== 0
  ) {
    fail(`${label} is invalid PCM16 mono 16 kHz WAV`);
  }
  return { durationSeconds: dataBytes / 32_000, wavSha256: snapshot.sha256 };
}

function registryProjection(item) {
  return {
    fixtureId: item.fixtureId,
    language: item.language,
    recordingId: item.recordingId,
    collection: item.collection,
    release: item.release,
    title: item.title,
    sourceRelativePath: item.sourceRelativePath,
    sourceSha256: item.sourceSha256,
    sourceBytes: item.sourceBytes,
    audioPage: item.audioPage,
    referencePage: item.referencePage,
    licenseId: item.licenseId,
    licenseUrl: item.licenseUrl,
    attribution: item.attribution,
    referenceAdapter: item.referenceAdapter,
    excludedReferenceCues: item.excludedReferenceCues,
  };
}

function validateReference(reference, fixture) {
  exactKeys(
    reference,
    [
      'status',
      'text',
      'sha256',
      'wordCount',
      'characterCount',
      'storagePolicy',
      'provenance',
      'provisional',
    ],
    `${fixture.fixtureId} reference`
  );
  if (
    reference.status !== 'available' ||
    reference.storagePolicy !== 'restricted-local-cache' ||
    reference.provenance !== fixture.referencePage ||
    reference.provisional !== false ||
    typeof reference.text !== 'string' ||
    reference.text.trim() === '' ||
    reference.sha256 !== sha256(reference.text) ||
    reference.wordCount !== wordUnits(reference.text, fixture.language).length ||
    reference.characterCount !== characterUnits(reference.text, fixture.language).length
  ) {
    fail(`${fixture.fixtureId} reference count or identity drifted`);
  }
}

function loadPreparedLongCorpus(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('prepared long corpus options must be an object');
  }
  const registry = validateLongSourceRegistry(options.registry);
  const prepared = options.prepared;
  exactKeys(
    prepared,
    [
      'schema',
      'benchmarkRevision',
      'generatedAt',
      'redistribution',
      'sourceRegistrySha256',
      'expectedFixtureCount',
      'items',
    ],
    'prepared long corpus'
  );
  if (
    prepared.schema !== PREPARED_SCHEMA ||
    prepared.benchmarkRevision !== registry.benchmarkRevision ||
    prepared.redistribution !== 'prohibited' ||
    prepared.sourceRegistrySha256 !== sha256(canonicalJson(registry)) ||
    prepared.expectedFixtureCount !== registry.items.length ||
    !Array.isArray(prepared.items) ||
    prepared.items.length !== registry.items.length
  ) {
    fail('prepared long corpus registry identity or membership drifted');
  }
  const sourceRoot = bindTrustedRoot(options.sourceRoot, 'prepared long source root');
  const preparedRoot = bindTrustedRoot(options.preparedRoot, 'prepared long output root');
  const registryById = new Map(registry.items.map(item => [item.fixtureId, item]));
  const seen = new Set();
  const entries = [];
  const inputs = [];
  for (const item of prepared.items) {
    exactKeys(item, PREPARED_ITEM_FIELDS, 'prepared long corpus item');
    const fixture = registryById.get(item.fixtureId);
    if (
      !fixture ||
      seen.has(item.fixtureId) ||
      canonicalJson(registryProjection(item)) !== canonicalJson(registryProjection(fixture))
    ) {
      fail(`prepared long corpus registry item drifted: ${item.fixtureId}`);
    }
    seen.add(item.fixtureId);
    inspectRegisteredSource(sourceRoot, fixture);
    const rawReference = snapshotRegularFile(
      path.join(sourceRoot.realPath, ...fixture.referenceRelativePath.split('/')),
      {
        label: `${fixture.fixtureId} original reference`,
        root: sourceRoot,
        maxBytes: BYTE_LIMITS.text,
      }
    );
    if (
      rawReference.bytes.length !== fixture.referenceBytes ||
      rawReference.sha256 !== fixture.referenceSha256
    ) {
      fail(`${fixture.fixtureId} original reference integrity drifted`);
    }
    safeRelative(item.playbackRelativePath, `${fixture.fixtureId} playback path`);
    const playback = snapshotRegularFile(
      path.join(preparedRoot.realPath, ...item.playbackRelativePath.split('/')),
      {
        label: `${fixture.fixtureId} playback WAV`,
        root: preparedRoot,
        maxBytes: BYTE_LIMITS.wav,
      }
    );
    if (
      playback.bytes.length !== item.playbackBytes ||
      playback.sha256 !== item.playbackSha256 ||
      !SHA256_PATTERN.test(item.playbackSha256)
    ) {
      fail(`${fixture.fixtureId} playback integrity drifted`);
    }
    const audio = parsePcm16MonoWav(playback, `${fixture.fixtureId} playback WAV`);
    if (Math.abs(audio.durationSeconds - item.durationSeconds) > DURATION_TOLERANCE_SECONDS) {
      fail(`${fixture.fixtureId} playback WAV duration drifted`);
    }
    validateReference(item.reference, fixture);
    entries.push({
      fixture: {
        id: fixture.fixtureId,
        language: fixture.language,
        cohort: 'long',
        speakerKey: `spk_${sha256(fixture.fixtureId).slice(0, 16)}`,
        source: {
          collection: fixture.collection,
          release: fixture.release,
          partition: 'standalone-recording',
          recordingId: fixture.recordingId,
          mediaType: path.extname(fixture.sourceRelativePath).slice(1),
          sha256: fixture.sourceSha256,
          durationSeconds: audio.durationSeconds,
          url: fixture.audioPage,
        },
        normalizedAudio: {
          sha256: audio.wavSha256,
          durationSeconds: audio.durationSeconds,
          transform: NORMALIZED_AUDIO_TRANSFORM,
        },
        reference: { ...item.reference },
        excluded: false,
      },
      prepared: {
        audio: {
          wavPath: playback.realPath,
          durationSeconds: audio.durationSeconds,
          sourceSha256: fixture.sourceSha256,
          wavSha256: audio.wavSha256,
        },
        referenceText: item.reference.text,
      },
    });
    inputs.push({
      fixtureId: fixture.fixtureId,
      sourceSha256: fixture.sourceSha256,
      referenceSourceSha256: fixture.referenceSha256,
      referenceTextSha256: item.reference.sha256,
      playbackSha256: item.playbackSha256,
    });
  }
  if (seen.size !== registry.items.length) fail('prepared long corpus is incomplete');
  entries.sort((left, right) => left.fixture.id.localeCompare(right.fixture.id));
  inputs.sort((left, right) => left.fixtureId.localeCompare(right.fixtureId));
  return {
    entries,
    inputBundle: {
      longSourceRegistrySha256: sha256(canonicalJson(registry)),
      preparedLongCorpusSha256: sha256(canonicalJson(prepared)),
      items: inputs,
    },
  };
}

module.exports = { loadPreparedLongCorpus, parsePcm16MonoWav };
