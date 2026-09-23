'use strict';

const crypto = require('node:crypto');

const {
  BALANCED_SHORT_PROFILE,
  validateBalancedShortSelection,
  validateSourceRegistry,
} = require('../asr-quality/corpus-builder.cjs');
const { canonicalJson } = require('../asr-quality/manifest.cjs');
const { runCorpusHash, validateRunCorpus } = require('../asr-quality/run-corpus.cjs');
const { RUNTIME_BENCHMARK_REVISION } = require('./constants.cjs');

const RECOVERED_CORPUS_SCHEMA = 'wasper.parakeet-runtime-benchmark.recovered-corpus.v1';
const IDENTITY_REPORT_SCHEMA = 'wasper.parakeet-runtime-benchmark.corpus-identity-report.v1';
const PUBLIC_PROJECTION_SCHEMA = 'wasper.asr-quality.public-benchmark.v1';
const PREPARED_LONG_SCHEMA = 'wasper.asr-quality.prepared-long-corpus.v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function fail(message) {
  throw new Error(message);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cloneJson(value, label) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TypeError(`${label} must be plain JSON: ${error.message}`, { cause: error });
  }
}

function sha256Canonical(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function requireExactKeys(value, keys, label) {
  requireObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function requireLanguages(languages) {
  if (
    !Array.isArray(languages) ||
    languages.length === 0 ||
    new Set(languages).size !== languages.length ||
    languages.some(language => typeof language !== 'string' || !/^[a-z]{2}$/u.test(language))
  ) {
    throw new TypeError('languages must be unique lowercase two-letter codes');
  }
}

function validatePublicRecording(recording, languages, ids) {
  requireObject(recording, 'public recording');
  const { cohort, durationSeconds, fixtureId, id, language } = recording;
  if (recording.status === 'no-qualified-fixture') {
    requireExactKeys(
      recording,
      ['language', 'cohort', 'status', 'reason'],
      'public no-qualified long outcome'
    );
    if (
      cohort !== 'long' ||
      !languages.includes(language) ||
      typeof recording.reason !== 'string' ||
      recording.reason.trim() === ''
    ) {
      fail(`public no-qualified long outcome for ${String(language)} is invalid`);
    }
    const outcomeId = `no-qualified-long:${language}`;
    if (ids.has(outcomeId)) fail(`public recording identifier duplicates ${outcomeId}`);
    ids.add(outcomeId);
    return;
  }
  if (!['short', 'long'].includes(cohort)) fail(`public recording ${String(id)} cohort is invalid`);
  if (!languages.includes(language)) fail(`public recording ${String(id)} language is invalid`);
  if (
    typeof fixtureId !== 'string' ||
    !fixtureId.startsWith(`${language}-${cohort}-`) ||
    id !== `${cohort}-${language}-${fixtureId}`
  ) {
    fail(`public recording ${String(id)} identifier is invalid`);
  }
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    fail(`public recording ${id} duration is invalid`);
  }
  if (ids.has(id)) fail(`public recording identifier duplicates ${id}`);
  ids.add(id);
  if (cohort === 'short') {
    for (const key of ['sourceCollection', 'sourceRelease', 'sourceUrl']) {
      if (typeof recording[key] !== 'string' || recording[key].trim() === '') {
        fail(`public recording ${id} ${key} is invalid`);
      }
    }
  } else {
    for (const key of ['sourceUrl', 'referenceUrl']) {
      if (typeof recording[key] !== 'string' || recording[key].trim() === '') {
        fail(`public recording ${id} ${key} is invalid`);
      }
    }
  }
}

function extractExactV1Selection(
  publicProjection,
  { languages, expectedShortCount = 243, expectedLongCount = 21 } = {}
) {
  requireLanguages(languages);
  requireCount(expectedShortCount, 'expectedShortCount');
  requireCount(expectedLongCount, 'expectedLongCount');
  requireObject(publicProjection, 'public projection');
  if (publicProjection.schema !== PUBLIC_PROJECTION_SCHEMA) {
    fail(`public projection schema must equal ${PUBLIC_PROJECTION_SCHEMA}`);
  }
  if (!Array.isArray(publicProjection.recordings)) {
    fail('public projection recordings must be an array');
  }
  const ids = new Set();
  const short = [];
  const long = [];
  for (const recording of publicProjection.recordings) {
    validatePublicRecording(recording, languages, ids);
    (recording.cohort === 'short' ? short : long).push(cloneJson(recording, 'public recording'));
  }
  short.sort((left, right) => left.id.localeCompare(right.id));
  long.sort((left, right) => outcomeIdentity(left).localeCompare(outcomeIdentity(right)));
  if (short.length !== expectedShortCount || long.length !== expectedLongCount) {
    fail(
      `public projection fixture count mismatch: expected ${expectedShortCount} short and ${expectedLongCount} long`
    );
  }
  for (const language of languages) {
    if (!short.some(recording => recording.language === language)) {
      fail(`public projection has no exact v1 short fixture for ${language}`);
    }
    if (!long.some(recording => recording.language === language)) {
      fail(`public projection has no exact v1 long fixture for ${language}`);
    }
  }
  return deepFreeze({ short, long });
}

function validatePreparedLongDocument(preparedLong) {
  requireObject(preparedLong, 'prepared long manifest');
  if (preparedLong.schema !== PREPARED_LONG_SCHEMA) {
    fail(`prepared long manifest schema must equal ${PREPARED_LONG_SCHEMA}`);
  }
  if (
    typeof preparedLong.sourceRegistrySha256 !== 'string' ||
    !SHA256_PATTERN.test(preparedLong.sourceRegistrySha256)
  ) {
    fail('prepared long manifest sourceRegistrySha256 is invalid');
  }
  if (
    !Number.isSafeInteger(preparedLong.expectedFixtureCount) ||
    preparedLong.expectedFixtureCount < 0 ||
    !Array.isArray(preparedLong.items) ||
    preparedLong.items.length !== preparedLong.expectedFixtureCount
  ) {
    fail('prepared long manifest fixture membership is invalid');
  }
  return preparedLong;
}

function outcomeIdentity(outcome) {
  return outcome.status === 'no-qualified-fixture'
    ? `no-qualified-long:${outcome.language}`
    : outcome.id;
}

function fixtureIdentityProjection(fixture) {
  if (fixture.status === 'no-qualified-fixture') {
    return {
      language: fixture.language,
      cohort: fixture.cohort,
      status: fixture.status,
      reason: fixture.reason,
    };
  }
  return {
    id: fixture.id,
    language: fixture.language,
    cohort: fixture.cohort,
    sourceSha256: fixture.source.sha256,
    normalizedWavSha256: fixture.normalizedAudio.sha256,
    sourceDurationSeconds: fixture.source.durationSeconds,
    normalizedDurationSeconds: fixture.normalizedAudio.durationSeconds,
    referenceSha256: fixture.reference.sha256,
  };
}

function manifestAuthorities(options) {
  requireObject(options, 'recovered corpus authorities');
  const selection = extractExactV1Selection(options.publicProjection, options);
  const preparedLong = validatePreparedLongDocument(options.preparedLong);
  validateSourceRegistry(options.sourceRegistry);
  if (!Array.isArray(options.shortFixtures) || !Array.isArray(options.longOutcomes)) {
    fail('recovered corpus authorities must include shortFixtures and longOutcomes arrays');
  }
  if (options.shortFixtures.length !== selection.short.length) {
    fail('recovered short fixture count does not match the exact v1 selection');
  }
  if (options.longOutcomes.length !== selection.long.length) {
    fail('recovered long fixture count does not match the exact v1 selection');
  }
  const shortFixtures = cloneJson(options.shortFixtures, 'short fixtures').sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const shortSelection = cloneJson(options.shortSelection, 'short selection');
  validateBalancedShortSelection(shortSelection, { languages: options.languages });
  const profileFixtureIds = Object.values(shortSelection.languages)
    .flatMap(cohort => cohort.fixtures.map(fixture => fixture.fixtureId))
    .sort();
  const publicShortFixtureIds = selection.short.map(recording => recording.fixtureId).sort();
  const recoveredShortFixtureIds = shortFixtures.map(fixture => fixture.id).sort();
  if (
    canonicalJson(profileFixtureIds) !== canonicalJson(publicShortFixtureIds) ||
    canonicalJson(recoveredShortFixtureIds) !== canonicalJson(publicShortFixtureIds)
  ) {
    fail('recovered short fixture membership drifted from the balanced v1 authority');
  }
  const longOutcomes = cloneJson(options.longOutcomes, 'long outcomes').sort((left, right) =>
    outcomeIdentity(left).localeCompare(outcomeIdentity(right))
  );
  const selectionProjection = [...selection.short, ...selection.long].sort((left, right) =>
    outcomeIdentity(left).localeCompare(outcomeIdentity(right))
  );
  const shortSourceRegistrySha256 = sha256Canonical(options.sourceRegistry);
  const sourceProvenanceSha256 = sha256Canonical({
    longSourceRegistrySha256: preparedLong.sourceRegistrySha256,
    shortSourceRegistrySha256,
  });
  return {
    exactV1FixtureSelectionSha256: sha256Canonical(selectionProjection),
    longOutcomes,
    preparedLongManifestSha256: sha256Canonical(preparedLong),
    profileFixtureIds,
    shortFixtures,
    sourceProvenanceSha256,
    warmupFixtureId: profileFixtureIds[0],
  };
}

function createRecoveredCorpusManifest(options) {
  const authorities = manifestAuthorities(options);
  const warmupFixture = authorities.shortFixtures.find(
    fixture => fixture.id === authorities.warmupFixtureId
  );
  if (warmupFixture === undefined) fail('balanced v1 warm-up fixture is missing');
  const warmup = {
    ...cloneJson(warmupFixture, 'warm-up fixture'),
    id: `${warmupFixture.id}-warmup`,
    cohort: 'warmup',
  };
  const runCorpus = validateRunCorpus({
    schema: 'wasper.asr-quality.run-corpus.v1',
    benchmarkRevision: 'wasper-asr-quality-v1',
    evidenceTier: 'source-trusted-internal',
    humanAudited: false,
    warmup,
    fixtures: [...authorities.shortFixtures, ...authorities.longOutcomes],
  });
  return deepFreeze({
    schema: RECOVERED_CORPUS_SCHEMA,
    benchmarkRevision: RUNTIME_BENCHMARK_REVISION,
    sourceProvenanceSha256: authorities.sourceProvenanceSha256,
    preparedLongManifestSha256: authorities.preparedLongManifestSha256,
    exactV1FixtureSelectionSha256: authorities.exactV1FixtureSelectionSha256,
    runCorpusSha256: runCorpusHash(runCorpus),
    profiles: {
      requestBalancedSpeed: {
        id: BALANCED_SHORT_PROFILE,
        fixtureIds: authorities.profileFixtureIds,
      },
    },
    runCorpus,
  });
}

function compareScoredIdentity(actual, expected, label) {
  if (actual.id !== expected.id) fail(`${label} fixture identifier drifted`);
  if (actual.language !== expected.language) fail(`${label} language drifted`);
  if (actual.cohort !== expected.cohort) fail(`${label} cohort drifted`);
  if (actual.source.sha256 !== expected.source.sha256) fail(`${label} source SHA-256 drifted`);
  if (actual.normalizedAudio.sha256 !== expected.normalizedAudio.sha256) {
    fail(`${label} normalized WAV SHA-256 drifted`);
  }
  if (actual.reference.sha256 !== expected.reference.sha256) {
    fail(`${label} reference SHA-256 drifted`);
  }
  if (
    actual.source.durationSeconds !== expected.source.durationSeconds ||
    actual.normalizedAudio.durationSeconds !== expected.normalizedAudio.durationSeconds
  ) {
    fail(`${label} duration drifted`);
  }
  if (canonicalJson(actual) !== canonicalJson(expected)) fail(`${label} identity drifted`);
}

function compareOutcomeIdentity(actual, expected, label) {
  if (expected.status === 'no-qualified-fixture') {
    if (canonicalJson(actual) !== canonicalJson(expected)) {
      fail(`${label} no-qualified-long state drifted`);
    }
    return;
  }
  compareScoredIdentity(actual, expected, label);
}

function validateRecoveredCorpusManifest(manifest, options) {
  requireExactKeys(
    manifest,
    [
      'schema',
      'benchmarkRevision',
      'sourceProvenanceSha256',
      'preparedLongManifestSha256',
      'exactV1FixtureSelectionSha256',
      'runCorpusSha256',
      'profiles',
      'runCorpus',
    ],
    'recovered corpus manifest'
  );
  if (manifest.schema !== RECOVERED_CORPUS_SCHEMA) {
    fail(`recovered corpus manifest schema must equal ${RECOVERED_CORPUS_SCHEMA}`);
  }
  if (manifest.benchmarkRevision !== RUNTIME_BENCHMARK_REVISION) {
    fail(`recovered corpus benchmarkRevision must equal ${RUNTIME_BENCHMARK_REVISION}`);
  }
  const actualRunCorpus = validateRunCorpus(manifest.runCorpus);
  const expected = createRecoveredCorpusManifest(options);
  for (const field of [
    'sourceProvenanceSha256',
    'preparedLongManifestSha256',
    'exactV1FixtureSelectionSha256',
    'runCorpusSha256',
  ]) {
    if (manifest[field] !== expected[field]) fail(`recovered corpus ${field} drifted`);
  }
  if (canonicalJson(manifest.profiles) !== canonicalJson(expected.profiles)) {
    fail('recovered corpus profile fixture identifiers drifted');
  }
  compareScoredIdentity(actualRunCorpus.warmup, expected.runCorpus.warmup, 'warm-up fixture');
  if (actualRunCorpus.fixtures.length !== expected.runCorpus.fixtures.length) {
    fail('recovered corpus fixture membership drifted');
  }
  actualRunCorpus.fixtures.forEach((fixture, index) => {
    compareOutcomeIdentity(fixture, expected.runCorpus.fixtures[index], `fixture ${index}`);
  });
  return manifest;
}

function createCorpusIdentityReport(manifest) {
  requireObject(manifest, 'recovered corpus manifest');
  const corpus = validateRunCorpus(manifest.runCorpus);
  const fixtures = corpus.fixtures.map(fixture => {
    if (fixture.status === 'no-qualified-fixture') {
      return {
        cohort: 'long',
        language: fixture.language,
        status: 'no-qualified-long',
        reason: fixture.reason,
      };
    }
    return { ...fixtureIdentityProjection(fixture), fixtureId: fixture.id, status: 'verified' };
  });
  const summary = {
    verifiedShort: fixtures.filter(item => item.cohort === 'short' && item.status === 'verified')
      .length,
    verifiedLong: fixtures.filter(item => item.cohort === 'long' && item.status === 'verified')
      .length,
    noQualifiedLong: fixtures.filter(item => item.status === 'no-qualified-long').length,
  };
  return deepFreeze({
    schema: IDENTITY_REPORT_SCHEMA,
    manifestSha256: sha256Canonical(manifest),
    summary,
    fixtures,
  });
}

module.exports = {
  createCorpusIdentityReport,
  createRecoveredCorpusManifest,
  extractExactV1Selection,
  RECOVERED_CORPUS_SCHEMA,
  sha256Canonical,
  validatePreparedLongDocument,
  validateRecoveredCorpusManifest,
};
