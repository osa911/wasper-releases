'use strict';

const crypto = require('node:crypto');

const { NORMALIZED_AUDIO_TRANSFORM } = require('./audio-cache.cjs');
const { LANGUAGES } = require('./constants.cjs');
const { canonicalJson, validateManifest } = require('./manifest.cjs');
const { characterUnits, wordUnits } = require('./normalization.cjs');
const { MAX_EDIT_UNITS_PER_SIDE } = require('./scoring.cjs');

const RUN_CORPUS_SCHEMA = 'wasper.asr-quality.run-corpus.v1';
const EVIDENCE_TIERS = Object.freeze(['canonical-audited', 'source-trusted-internal']);
const RUN_COHORTS = Object.freeze(['warmup', 'short', 'long']);
const SOURCE_PARTITIONS = Object.freeze(['test', 'validation', 'standalone-recording']);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const NORMALIZED_DURATION_TOLERANCE_SECONDS = 0.25;

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

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain JSON object`);
  }
}

function requireExactKeys(value, expectedKeys, label) {
  requirePlainObject(value, label);
  const actualKeys = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (
    actualKeys.length !== expected.length ||
    actualKeys.some((key, index) => key !== expected[index])
  ) {
    throw new TypeError(`${label} must contain exactly ${expected.join(', ')}`);
  }
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256`);
  }
}

function requireCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_EDIT_UNITS_PER_SIDE) {
    throw new TypeError(`${label} must be an integer between 0 and ${MAX_EDIT_UNITS_PER_SIDE}`);
  }
}

function validateSource(source, label) {
  requirePlainObject(source, label);
  const accessFields = ['url', 'authorizedFetchKey'].filter(field => Object.hasOwn(source, field));
  if (accessFields.length !== 1) {
    throw new TypeError(`${label} must contain exactly one source access field`);
  }
  requireExactKeys(
    source,
    [
      'collection',
      'release',
      'partition',
      'recordingId',
      'mediaType',
      'sha256',
      'durationSeconds',
      accessFields[0],
    ],
    label
  );
  for (const field of ['collection', 'release', 'recordingId', 'mediaType', accessFields[0]]) {
    requireNonEmptyString(source[field], `${label}.${field}`);
  }
  if (!SOURCE_PARTITIONS.includes(source.partition)) {
    throw new TypeError(`${label}.partition must be a supported source partition`);
  }
  requireSha256(source.sha256, `${label}.sha256`);
  if (!Number.isFinite(source.durationSeconds) || source.durationSeconds <= 0) {
    throw new TypeError(`${label}.durationSeconds must be a positive number`);
  }
}

function validateNormalizedAudio(audio, sourceDurationSeconds, label) {
  requireExactKeys(audio, ['sha256', 'durationSeconds', 'transform'], label);
  requireSha256(audio.sha256, `${label}.sha256`);
  if (!Number.isFinite(audio.durationSeconds) || audio.durationSeconds <= 0) {
    throw new TypeError(`${label}.durationSeconds must be a positive number`);
  }
  if (
    Math.abs(audio.durationSeconds - sourceDurationSeconds) > NORMALIZED_DURATION_TOLERANCE_SECONDS
  ) {
    throw new TypeError(
      `${label}.durationSeconds must remain within ${NORMALIZED_DURATION_TOLERANCE_SECONDS} seconds of the source duration`
    );
  }
  if (canonicalJson(audio.transform) !== canonicalJson(NORMALIZED_AUDIO_TRANSFORM)) {
    throw new TypeError(`${label}.transform must match the canonical audio transform`);
  }
}

function validateAvailableReference(reference, language, evidenceTier, label) {
  if (!['redistributable', 'restricted-local-cache'].includes(reference.storagePolicy)) {
    throw new TypeError(`${label}.storagePolicy must be redistributable or restricted-local-cache`);
  }
  const expectedKeys = [
    'status',
    'sha256',
    'wordCount',
    'characterCount',
    'storagePolicy',
    'provisional',
    'provenance',
  ];
  const hasText = Object.hasOwn(reference, 'text');
  if (reference.storagePolicy === 'redistributable' && !hasText) {
    throw new TypeError(`${label}.text is required for redistributable references`);
  }
  if (hasText) expectedKeys.push('text');
  requireExactKeys(reference, expectedKeys, label);
  requireSha256(reference.sha256, `${label}.sha256`);
  requireCount(reference.wordCount, `${label}.wordCount`);
  requireCount(reference.characterCount, `${label}.characterCount`);
  if (typeof reference.provisional !== 'boolean') {
    throw new TypeError(`${label}.provisional must be a boolean`);
  }
  if (evidenceTier === 'canonical-audited' && reference.provisional) {
    throw new TypeError('canonical-audited available reference must not be provisional');
  }
  requireNonEmptyString(reference.provenance, `${label}.provenance`);
  if (!hasText) return;
  requireNonEmptyString(reference.text, `${label}.text`);
  const actualHash = crypto.createHash('sha256').update(reference.text, 'utf8').digest('hex');
  if (reference.sha256 !== actualHash) {
    throw new TypeError(`${label}.sha256 must match its embedded text`);
  }
  if (reference.wordCount !== wordUnits(reference.text, language).length) {
    throw new TypeError(`${label}.wordCount must match normalized reference text`);
  }
  if (reference.characterCount !== characterUnits(reference.text, language).length) {
    throw new TypeError(`${label}.characterCount must match normalized reference text`);
  }
}

function validateReference(reference, fixture, evidenceTier, label) {
  requirePlainObject(reference, label);
  if (reference.status === 'available') {
    validateAvailableReference(reference, fixture.language, evidenceTier, label);
    return;
  }
  requireExactKeys(reference, ['status', 'reason', 'provisional', 'provenance'], label);
  if (reference.status !== 'unavailable') {
    throw new TypeError(`${label}.status must be available or unavailable`);
  }
  requireNonEmptyString(reference.reason, `${label}.reason`);
  requireNonEmptyString(reference.provenance, `${label}.provenance`);
  if (reference.provisional !== true) {
    throw new TypeError(`${label}.provisional must be true when the reference is unavailable`);
  }
  if (evidenceTier !== 'source-trusted-internal') {
    throw new TypeError(`${label} is permitted only for source-trusted-internal evidence`);
  }
  if (fixture.cohort !== 'long') {
    throw new TypeError(
      `${label} unavailable reference is permitted only for a non-warm-up long fixture`
    );
  }
}

function validateNoQualifiedFixture(fixture, label) {
  requireExactKeys(fixture, ['language', 'cohort', 'status', 'reason'], label);
  if (!LANGUAGES.includes(fixture.language)) {
    throw new TypeError(`${label}.language must be a supported ASR benchmark language`);
  }
  if (fixture.cohort !== 'long' || fixture.status !== 'no-qualified-fixture') {
    throw new TypeError(`${label} must be an explicit no-qualified long fixture`);
  }
  requireNonEmptyString(fixture.reason, `${label}.reason`);
}

function validateScoredFixture(fixture, label, evidenceTier, expectedCohort) {
  const expectedKeys = [
    'id',
    'language',
    'cohort',
    'speakerKey',
    'source',
    'normalizedAudio',
    'reference',
    'excluded',
  ];
  if (Object.hasOwn(fixture, 'exclusionReason')) expectedKeys.push('exclusionReason');
  requireExactKeys(fixture, expectedKeys, label);
  requireNonEmptyString(fixture.id, `${label}.id`);
  if (!LANGUAGES.includes(fixture.language)) {
    throw new TypeError(`${label}.language must be a supported ASR benchmark language`);
  }
  if (!RUN_COHORTS.includes(fixture.cohort) || fixture.cohort !== expectedCohort) {
    throw new TypeError(`${label}.cohort must be ${expectedCohort}`);
  }
  requireNonEmptyString(fixture.speakerKey, `${label}.speakerKey`);
  if (typeof fixture.excluded !== 'boolean') {
    throw new TypeError(`${label}.excluded must be a boolean`);
  }
  if (fixture.excluded !== Object.hasOwn(fixture, 'exclusionReason')) {
    throw new TypeError(`${label}.exclusionReason must be present exactly for excluded fixtures`);
  }
  if (fixture.excluded) requireNonEmptyString(fixture.exclusionReason, `${label}.exclusionReason`);
  validateSource(fixture.source, `${label}.source`);
  validateNormalizedAudio(
    fixture.normalizedAudio,
    fixture.source.durationSeconds,
    `${label}.normalizedAudio`
  );
  validateReference(fixture.reference, fixture, evidenceTier, `${label}.reference`);
}

function validateRunCorpus(value) {
  const corpus = cloneJson(value, 'run corpus');
  requireExactKeys(
    corpus,
    ['schema', 'benchmarkRevision', 'evidenceTier', 'humanAudited', 'warmup', 'fixtures'],
    'run corpus'
  );
  if (corpus.schema !== RUN_CORPUS_SCHEMA) {
    throw new TypeError(`run corpus.schema must equal ${RUN_CORPUS_SCHEMA}`);
  }
  requireNonEmptyString(corpus.benchmarkRevision, 'run corpus.benchmarkRevision');
  if (!EVIDENCE_TIERS.includes(corpus.evidenceTier)) {
    throw new TypeError('run corpus.evidenceTier must be a supported evidence tier');
  }
  if (typeof corpus.humanAudited !== 'boolean') {
    throw new TypeError('run corpus.humanAudited must be a boolean');
  }
  if (corpus.humanAudited !== (corpus.evidenceTier === 'canonical-audited')) {
    throw new TypeError('run corpus.humanAudited must match its evidence tier');
  }
  validateScoredFixture(corpus.warmup, 'run corpus.warmup', corpus.evidenceTier, 'warmup');
  if (!Array.isArray(corpus.fixtures) || corpus.fixtures.length === 0) {
    throw new TypeError('run corpus.fixtures must be a non-empty array');
  }
  const ids = new Set([corpus.warmup.id]);
  for (const [index, fixture] of corpus.fixtures.entries()) {
    const label = `run corpus.fixtures[${index}]`;
    if (fixture.status === 'no-qualified-fixture') {
      validateNoQualifiedFixture(fixture, label);
      continue;
    }
    validateScoredFixture(fixture, label, corpus.evidenceTier, fixture.cohort);
    if (fixture.cohort === 'warmup') {
      throw new TypeError(`${label}.cohort must not be warmup`);
    }
    if (ids.has(fixture.id)) throw new TypeError(`${label}.id duplicates another runner fixture`);
    ids.add(fixture.id);
  }
  return deepFreeze(corpus);
}

function projectCanonicalFixture(fixture) {
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
    speakerKey: fixture.speakerKey,
    source: fixture.source,
    normalizedAudio: fixture.normalizedAudio,
    reference: {
      status: 'available',
      sha256: fixture.reference.sha256,
      wordCount: fixture.reference.wordCount,
      characterCount: fixture.reference.characterCount,
      storagePolicy: fixture.reference.storagePolicy,
      provisional: false,
      provenance: fixture.audit.provenanceClassification,
      ...(fixture.reference.storagePolicy === 'redistributable'
        ? { text: fixture.reference.text }
        : {}),
    },
    excluded: fixture.excluded,
    ...(fixture.excluded ? { exclusionReason: fixture.exclusionReason } : {}),
  };
}

function projectCanonicalManifest(manifest) {
  const safe = validateManifest(manifest, { requireCoverage: false });
  return validateRunCorpus({
    schema: RUN_CORPUS_SCHEMA,
    benchmarkRevision: safe.benchmarkRevision,
    evidenceTier: 'canonical-audited',
    humanAudited: true,
    warmup: projectCanonicalFixture(safe.warmup),
    fixtures: safe.fixtures.map(projectCanonicalFixture),
  });
}

function runCorpusHash(corpus) {
  const safe = validateRunCorpus(corpus);
  return crypto.createHash('sha256').update(canonicalJson(safe)).digest('hex');
}

module.exports = {
  projectCanonicalManifest,
  runCorpusHash,
  validateRunCorpus,
};
