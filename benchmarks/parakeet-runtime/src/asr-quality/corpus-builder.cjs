'use strict';

const crypto = require('node:crypto');

const { wordUnits } = require('./normalization.cjs');

const REGISTRY_SCHEMA_VERSION = 'asr-quality-source-registry-v1';
const BENCHMARK_REVISION = 'wasper-asr-quality-v1';
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const LANGUAGE_PATTERN = /^[a-z]{2}$/u;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const SPEAKER_PATTERN = /^spk_[a-f0-9]{16}$/u;
const ALLOWED_PARTITIONS = new Set(['test', 'validation']);
const ALLOWED_INDEX_KINDS = new Set([
  'common-voice-tar-tsv',
  'fleurs-tar-tsv',
  'librispeech-tar',
  'mls-parquet',
]);
const ALLOWED_SPEAKER_POLICIES = new Set(['conservative-language-unknown', 'provided-source-id']);
const ALLOWED_CONDITIONS = new Set([
  'studio-or-close-talk',
  'quiet-consumer-device',
  'noisy-consumer-device',
  'far-field',
  'telephony',
]);
const BALANCED_SHORT_PROFILE = 'request-balanced-speed-v1';
const BALANCED_SHORT_DURATION_CENTISECONDS = Object.freeze([
  882, 888, 900, 918, 924, 930, 936, 948, 954, 960, 966, 972, 984, 996, 1008, 1014, 1020, 1032,
  1038, 1056, 1068, 1086, 1092, 1098, 1104, 1110, 1116,
]);
const OBJECT_KEYS = new Set([
  'id',
  'publisher',
  'title',
  'release',
  'acquisitionKind',
  'homepage',
  'acquisitionLocator',
  'format',
  'sha256',
  'bytes',
  'parquet',
  'license',
]);
const PARQUET_KEYS = new Set(['rows', 'schema']);
const PARQUET_FIELD_KEYS = new Set(['name', 'type']);
const REQUIRED_PARQUET_FIELDS = new Set([
  'audio',
  'transcript',
  'audio_duration',
  'speaker_id',
  'file',
  'id',
]);
const LICENSE_KEYS = new Set([
  'id',
  'attribution',
  'access',
  'redistribution',
  'benchmarkUse',
  'reviewedOn',
]);
const IMPORT_KEYS = new Set([
  'id',
  'language',
  'partition',
  'indexKind',
  'mediaObjectId',
  'metadataObjectId',
  'transcriptPolicy',
  'speakerPolicy',
]);

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be an object`);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`${label} contains unknown key ${unknown[0]}`);
}

function assertNonemptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertIdentifier(value, label) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) {
    throw new Error(`${label} must use the bounded identifier grammar`);
  }
}

function assertHttpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.length === 0) {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  if (
    /(?:x-amz-|signature|credential|authorization|(?:^|[_-])token|api[_-]?key)/iu.test(
      `${parsed.search}${parsed.hash}`
    )
  ) {
    throw new Error(`${label} must not contain a signed URL, credential, token, or secret`);
  }
}

function assertSafePublicString(value, label) {
  assertNonemptyString(value, label);
  if (
    /(?:^|[\s"'])(?:\/Users\/|\/private\/|file:\/\/|[a-z]:\\)/iu.test(value) ||
    /(?:bearer\s+|authorization|api[_-]?key|x-amz-signature|credential=|token=)/iu.test(value)
  ) {
    throw new Error(`${label} contains a private path, credential, token, or secret`);
  }
}

function assertRealDate(value, label) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) {
    throw new Error(`${label} must be a canonical date`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new Error(`${label} must be a real calendar date`);
  }
}

function validateLicense(license, label) {
  assertExactKeys(license, LICENSE_KEYS, label);
  for (const key of ['id', 'attribution', 'access', 'redistribution']) {
    assertSafePublicString(license[key], `${label}.${key}`);
  }
  if (license.benchmarkUse !== 'approved') {
    throw new Error(`${label}.benchmarkUse must equal approved`);
  }
  assertRealDate(license.reviewedOn, `${label}.reviewedOn`);
}

function validateParquetContract(parquet, label) {
  assertExactKeys(parquet, PARQUET_KEYS, label);
  if (!Number.isSafeInteger(parquet.rows) || parquet.rows <= 0) {
    throw new Error(`${label}.rows must be a positive safe integer`);
  }
  if (!Array.isArray(parquet.schema) || parquet.schema.length === 0 || parquet.schema.length > 64) {
    throw new Error(`${label}.schema must be a non-empty bounded array`);
  }
  const names = new Set();
  parquet.schema.forEach((field, index) => {
    const fieldLabel = `${label}.schema[${index}]`;
    assertExactKeys(field, PARQUET_FIELD_KEYS, fieldLabel);
    if (typeof field.name !== 'string' || !/^[a-z][a-z0-9_]*$/u.test(field.name)) {
      throw new Error(`${fieldLabel}.name is invalid`);
    }
    assertSafePublicString(field.type, `${fieldLabel}.type`);
    if (names.has(field.name)) throw new Error(`${label}.schema contains duplicate ${field.name}`);
    names.add(field.name);
  });
  for (const name of REQUIRED_PARQUET_FIELDS) {
    if (!names.has(name)) throw new Error(`${label}.schema is missing required field ${name}`);
  }
}

function validateObject(entry, index) {
  const label = `objects[${index}]`;
  assertExactKeys(entry, OBJECT_KEYS, label);
  assertIdentifier(entry.id, `${label}.id`);
  for (const key of ['publisher', 'title', 'release', 'format']) {
    assertSafePublicString(entry[key], `${label}.${key}`);
  }
  if (!['public-url', 'authenticated-preseed'].includes(entry.acquisitionKind)) {
    throw new Error(`${label}.acquisitionKind must be public-url or authenticated-preseed`);
  }
  assertHttpsUrl(entry.homepage, `${label}.homepage`);
  if (entry.acquisitionKind === 'public-url') {
    assertHttpsUrl(entry.acquisitionLocator, `${label}.acquisitionLocator`);
  } else {
    assertSafePublicString(entry.acquisitionLocator, `${label}.acquisitionLocator`);
    if (!ID_PATTERN.test(entry.acquisitionLocator)) {
      throw new Error(`${label}.acquisitionLocator must be a stable non-secret identifier`);
    }
  }
  if (!SHA256_PATTERN.test(entry.sha256)) throw new Error(`${label}.sha256 is invalid`);
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) {
    throw new Error(`${label}.bytes must be a positive safe integer`);
  }
  if (entry.format === 'parquet') {
    validateParquetContract(entry.parquet, `${label}.parquet`);
  } else if (entry.parquet !== undefined) {
    throw new Error(`${label}.parquet is only valid for Parquet objects`);
  }
  validateLicense(entry.license, `${label}.license`);
}

function validateImport(entry, index) {
  const label = `imports[${index}]`;
  assertExactKeys(entry, IMPORT_KEYS, label);
  assertIdentifier(entry.id, `${label}.id`);
  if (typeof entry.language !== 'string' || !LANGUAGE_PATTERN.test(entry.language)) {
    throw new Error(`${label}.language must be a lowercase two-letter code`);
  }
  if (!ALLOWED_PARTITIONS.has(entry.partition)) {
    throw new Error(`${label}.partition must be test or validation`);
  }
  if (!ALLOWED_INDEX_KINDS.has(entry.indexKind)) {
    throw new Error(`${label}.indexKind is not supported`);
  }
  assertIdentifier(entry.mediaObjectId, `${label}.mediaObjectId`);
  if (entry.metadataObjectId !== undefined) {
    assertIdentifier(entry.metadataObjectId, `${label}.metadataObjectId`);
  }
  assertSafePublicString(entry.transcriptPolicy, `${label}.transcriptPolicy`);
  if (!ALLOWED_SPEAKER_POLICIES.has(entry.speakerPolicy)) {
    throw new Error(`${label}.speakerPolicy is not supported`);
  }
}

function validateSourceRegistry(registry) {
  assertExactKeys(
    registry,
    new Set(['schemaVersion', 'benchmarkRevision', 'objects', 'imports']),
    'source registry'
  );
  if (registry.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new Error(`source registry schemaVersion must equal ${REGISTRY_SCHEMA_VERSION}`);
  }
  if (registry.benchmarkRevision !== BENCHMARK_REVISION) {
    throw new Error(`source registry benchmarkRevision must equal ${BENCHMARK_REVISION}`);
  }
  if (!Array.isArray(registry.objects) || registry.objects.length === 0) {
    throw new Error('source registry objects must be a non-empty array');
  }
  if (!Array.isArray(registry.imports) || registry.imports.length === 0) {
    throw new Error('source registry imports must be a non-empty array');
  }

  const objectsById = Object.create(null);
  registry.objects.forEach((entry, index) => {
    validateObject(entry, index);
    if (Object.hasOwn(objectsById, entry.id))
      throw new Error(`duplicate source object ${entry.id}`);
    objectsById[entry.id] = entry;
  });

  const sourcesById = Object.create(null);
  registry.imports.forEach((entry, index) => {
    validateImport(entry, index);
    if (Object.hasOwn(sourcesById, entry.id))
      throw new Error(`duplicate source import ${entry.id}`);
    const media = objectsById[entry.mediaObjectId];
    if (media === undefined) {
      throw new Error(
        `imports[${index}].mediaObjectId references missing object ${entry.mediaObjectId}`
      );
    }
    if (entry.indexKind === 'mls-parquet' && media.format !== 'parquet') {
      throw new Error(`imports[${index}] mls-parquet must reference an exact Parquet object`);
    }
    if (entry.indexKind !== 'mls-parquet' && media.format === 'parquet') {
      throw new Error(`imports[${index}] non-Parquet index must not reference a Parquet object`);
    }
    let metadata = null;
    if (entry.metadataObjectId !== undefined) {
      metadata = objectsById[entry.metadataObjectId];
      if (metadata === undefined) {
        throw new Error(
          `imports[${index}].metadataObjectId references missing object ${entry.metadataObjectId}`
        );
      }
    }
    sourcesById[entry.id] = {
      id: entry.id,
      language: entry.language,
      partition: entry.partition,
      indexKind: entry.indexKind,
      transcriptPolicy: entry.transcriptPolicy,
      speakerPolicy: entry.speakerPolicy,
      container: {
        id: media.id,
        format: media.format === 'parquet' ? 'parquet' : 'tar',
        sourceFormat: media.format,
        sha256: media.sha256,
        bytes: media.bytes,
        acquisitionKind: media.acquisitionKind,
        acquisitionLocator: media.acquisitionLocator,
        parquet: media.format === 'parquet' ? cloneJson(media.parquet) : null,
      },
      metadata:
        metadata === null
          ? null
          : {
              id: metadata.id,
              format: metadata.format,
              sha256: metadata.sha256,
              bytes: metadata.bytes,
              acquisitionKind: metadata.acquisitionKind,
              acquisitionLocator: metadata.acquisitionLocator,
            },
      license: cloneJson(media.license),
      publisher: media.publisher,
      title: media.title,
      release: media.release,
      homepage: media.homepage,
    };
  });

  return deepFreeze({
    schemaVersion: registry.schemaVersion,
    benchmarkRevision: registry.benchmarkRevision,
    objectsById,
    sourcesById,
  });
}

function opaqueSpeakerKey({ sourceId, partition, sourceSpeakerId }) {
  assertIdentifier(sourceId, 'sourceId');
  if (!ALLOWED_PARTITIONS.has(partition)) throw new Error('partition must be test or validation');
  assertNonemptyString(sourceSpeakerId, 'sourceSpeakerId');
  const hash = crypto
    .createHash('sha256')
    .update(`wasper-asr-quality-v1-speaker\0${sourceId}\0${partition}\0${sourceSpeakerId}`, 'utf8')
    .digest('hex');
  return `spk_${hash.slice(0, 16)}`;
}

function unknownFleursSpeaker(language) {
  const hash = crypto
    .createHash('sha256')
    .update(`wasper-asr-quality-v1-fleurs-unknown\0${language}`, 'utf8')
    .digest('hex');
  return `spk_${hash.slice(0, 16)}`;
}

function assertRawCandidate(raw, source) {
  if (!isPlainObject(raw)) throw new TypeError('raw candidate must be an object');
  const common = [
    'durationSeconds',
    'language',
    'partition',
    'reference',
    'sourceBytes',
    'sourceId',
    'sourceItemId',
    'sourceSha256',
  ];
  let formatSpecific;
  if (source.indexKind === 'mls-parquet') {
    formatSpecific = ['audioPath', 'rowIndex', 'sourceSpeakerId'];
  } else if (source.indexKind === 'fleurs-tar-tsv') {
    formatSpecific = ['audioMember', 'gender'];
  } else {
    formatSpecific = ['audioMember', 'sourceSpeakerId'];
  }
  assertExactKeys(raw, new Set([...common, ...formatSpecific]), 'raw candidate');
  if (raw.sourceId !== source.id) throw new Error('raw candidate sourceId mismatch');
  if (raw.language !== source.language) throw new Error('raw candidate language mismatch');
  if (raw.partition !== source.partition) throw new Error('raw candidate partition mismatch');
  assertIdentifier(raw.sourceItemId, 'raw candidate sourceItemId');
  if (!SHA256_PATTERN.test(raw.sourceSha256)) throw new Error('raw candidate sourceSha256 invalid');
  if (!Number.isSafeInteger(raw.sourceBytes) || raw.sourceBytes <= 0) {
    throw new Error('raw candidate sourceBytes must be positive');
  }
  if (!Number.isFinite(raw.durationSeconds) || raw.durationSeconds <= 0) {
    throw new Error('raw candidate durationSeconds must be finite and positive');
  }
  assertNonemptyString(raw.reference, 'raw candidate reference');
}

function normalizeCandidate(raw, source) {
  if (!isPlainObject(source)) throw new TypeError('source must be a resolved registry source');
  assertRawCandidate(raw, source);
  let locator;
  if (source.indexKind === 'mls-parquet') {
    if (!Number.isSafeInteger(raw.rowIndex) || raw.rowIndex < 0) {
      throw new Error('raw candidate rowIndex must be non-negative');
    }
    if (raw.audioPath !== `${raw.sourceItemId}.opus`) {
      throw new Error('raw candidate audioPath must bind the source item ID');
    }
    locator = { itemId: raw.sourceItemId, rowIndex: raw.rowIndex };
  } else {
    assertNonemptyString(raw.audioMember, 'raw candidate audioMember');
    locator = { member: raw.audioMember };
  }
  let speakerKey;
  if (source.speakerPolicy === 'conservative-language-unknown') {
    speakerKey = unknownFleursSpeaker(raw.language);
  } else {
    speakerKey = opaqueSpeakerKey({
      sourceId: raw.sourceId,
      partition: raw.partition,
      sourceSpeakerId: raw.sourceSpeakerId,
    });
  }
  const referenceSha256 = crypto.createHash('sha256').update(raw.reference, 'utf8').digest('hex');
  const referenceWordCount = wordUnits(raw.reference, raw.language).length;
  if (referenceWordCount <= 0) throw new Error('raw candidate reference has no scoring words');
  return deepFreeze({
    attribution: source.license.attribution,
    container: {
      format: source.container.format,
      id: source.container.id,
      locator,
      sha256: source.container.sha256,
    },
    durationSeconds: raw.durationSeconds,
    language: raw.language,
    licenseId: source.license.id,
    partition: raw.partition,
    reference: raw.reference,
    referenceSha256,
    referenceWordCount,
    sourceBytes: raw.sourceBytes,
    sourceId: raw.sourceId,
    sourceItemId: raw.sourceItemId,
    sourceSha256: raw.sourceSha256,
    speakerKey,
    wholeRecording: true,
  });
}

function selectionKey(seed, candidate) {
  return crypto
    .createHash('sha256')
    .update(
      `${seed}\0${candidate.language}\0${candidate.sourceId}\0${candidate.sourceItemId}`,
      'utf8'
    )
    .digest('hex');
}

function validateSelectableCandidate(candidate, language, requireConditions) {
  if (!isPlainObject(candidate)) return 'not-an-object';
  if (candidate.language !== language) return 'wrong-language';
  if (candidate.wholeRecording !== true) return 'not-whole-recording';
  if (!Number.isFinite(candidate.durationSeconds)) return 'invalid-duration';
  if (candidate.durationSeconds < 2 || candidate.durationSeconds > 30) return 'duration-window';
  if (!SPEAKER_PATTERN.test(candidate.speakerKey)) return 'invalid-speaker';
  if (!Number.isSafeInteger(candidate.referenceWordCount) || candidate.referenceWordCount <= 0) {
    return 'invalid-reference-words';
  }
  if (requireConditions && !ALLOWED_CONDITIONS.has(candidate.condition)) return 'invalid-condition';
  if (typeof candidate.sourceId !== 'string' || typeof candidate.sourceItemId !== 'string') {
    return 'invalid-source-identity';
  }
  return null;
}

function cohortStats(fixtures) {
  let durationSeconds = 0;
  let totalReferenceWords = 0;
  const speakerWords = new Map();
  const conditions = new Set();
  for (const fixture of fixtures) {
    durationSeconds += fixture.durationSeconds;
    totalReferenceWords += fixture.referenceWordCount;
    speakerWords.set(
      fixture.speakerKey,
      (speakerWords.get(fixture.speakerKey) || 0) + fixture.referenceWordCount
    );
    if (fixture.condition !== undefined) conditions.add(fixture.condition);
  }
  const speakerWordShares = [...speakerWords]
    .map(([speakerKey, words]) => ({
      share: totalReferenceWords === 0 ? 1 : words / totalReferenceWords,
      speakerKey,
      words,
    }))
    .sort((left, right) => left.speakerKey.localeCompare(right.speakerKey));
  return {
    conditions: [...conditions].sort(),
    durationSeconds,
    speakerWordShares,
    totalReferenceWords,
  };
}

function deficits(stats, constraints) {
  const result = [];
  if (stats.durationSeconds < constraints.minSeconds) {
    result.push(
      `duration ${stats.durationSeconds.toFixed(3)}s is below ${constraints.minSeconds}s`
    );
  }
  if (stats.durationSeconds > constraints.maxSeconds) {
    result.push(`duration ${stats.durationSeconds.toFixed(3)}s exceeds ${constraints.maxSeconds}s`);
  }
  if (stats.speakerWordShares.length < constraints.minSpeakers) {
    result.push(
      `speaker coverage ${stats.speakerWordShares.length} is below ${constraints.minSpeakers}`
    );
  }
  if (constraints.requireConditions && stats.conditions.length < 2) {
    result.push(`condition coverage ${stats.conditions.length} is below 2`);
  }
  const maximumShare = stats.speakerWordShares.reduce(
    (maximum, entry) => Math.max(maximum, entry.share),
    0
  );
  if (maximumShare > constraints.maxSpeakerWordShare) {
    result.push(
      `speaker concentration ${maximumShare.toFixed(6)} exceeds ${constraints.maxSpeakerWordShare}`
    );
  }
  return result;
}

function selectLanguage(candidates, language, constraints) {
  const accepted = [];
  const rejected = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (candidate?.language !== language) continue;
    const reason = validateSelectableCandidate(candidate, language, constraints.requireConditions);
    const identity = `${candidate?.sourceId}\0${candidate?.sourceItemId}`;
    if (reason !== null) {
      rejected.push({ identity, reason });
      continue;
    }
    if (seen.has(identity)) {
      rejected.push({ identity, reason: 'duplicate-source-item' });
      continue;
    }
    seen.add(identity);
    accepted.push({ candidate, key: selectionKey(constraints.seed, candidate) });
  }
  accepted.sort((left, right) => left.key.localeCompare(right.key));

  const groups = new Map();
  for (const entry of accepted) {
    const group = groups.get(entry.candidate.speakerKey) || [];
    group.push(entry);
    groups.set(entry.candidate.speakerKey, group);
  }
  const orderedGroups = [...groups.values()].sort((left, right) =>
    left[0].key.localeCompare(right[0].key)
  );
  const selected = [];
  const nextIndexes = new Array(orderedGroups.length).fill(0);
  let selectedDuration = 0;
  while (selectedDuration < constraints.targetSeconds) {
    let progressed = false;
    for (let groupIndex = 0; groupIndex < orderedGroups.length; groupIndex += 1) {
      const group = orderedGroups[groupIndex];
      const entry = group[nextIndexes[groupIndex]];
      if (entry === undefined) continue;
      nextIndexes[groupIndex] += 1;
      if (selectedDuration + entry.candidate.durationSeconds > constraints.maxSeconds) {
        rejected.push({
          identity: `${entry.candidate.sourceId}\0${entry.candidate.sourceItemId}`,
          reason: 'would-exceed-duration-maximum',
        });
        continue;
      }
      selected.push(entry);
      selectedDuration += entry.candidate.durationSeconds;
      progressed = true;
      if (selectedDuration >= constraints.targetSeconds) break;
    }
    if (!progressed) break;
  }

  const fixtures = selected.map(entry => entry.candidate);
  rejected.sort((left, right) =>
    `${left.identity}\0${left.reason}`.localeCompare(`${right.identity}\0${right.reason}`)
  );
  const stats = cohortStats(fixtures);
  const missing = deficits(stats, constraints);
  if (missing.length > 0) {
    throw new Error(`Language ${language} short cohort is invalid: ${missing.join('; ')}`);
  }
  return {
    ...stats,
    fixtureIds: fixtures.map(fixture => `${fixture.sourceId}:${fixture.sourceItemId}`),
    fixtures,
    rejected,
  };
}

function selectShortCohort(
  candidates,
  {
    languages,
    targetSeconds = 270,
    minSeconds = 240,
    maxSeconds = 330,
    minSpeakers = 5,
    maxSpeakerWordShare = 0.25,
    requireConditions = true,
    seed = 'wasper-asr-v1-short',
  } = {}
) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  if (!Array.isArray(languages) || languages.length === 0) {
    throw new TypeError('languages must be a non-empty array');
  }
  if (new Set(languages).size !== languages.length) throw new Error('languages must be unique');
  for (const language of languages) {
    if (!LANGUAGE_PATTERN.test(language)) throw new Error(`invalid language ${language}`);
  }
  const constraints = {
    maxSeconds,
    maxSpeakerWordShare,
    minSeconds,
    minSpeakers,
    requireConditions,
    seed,
    targetSeconds,
  };
  if (
    !Number.isFinite(targetSeconds) ||
    !Number.isFinite(minSeconds) ||
    !Number.isFinite(maxSeconds) ||
    minSeconds <= 0 ||
    targetSeconds < minSeconds ||
    maxSeconds < targetSeconds ||
    !Number.isInteger(minSpeakers) ||
    minSpeakers < 1 ||
    !Number.isFinite(maxSpeakerWordShare) ||
    maxSpeakerWordShare <= 0 ||
    maxSpeakerWordShare > 1 ||
    typeof requireConditions !== 'boolean' ||
    typeof seed !== 'string' ||
    seed.length === 0
  ) {
    throw new Error('short selection constraints are invalid');
  }
  const languageResults = Object.create(null);
  for (const language of languages) {
    languageResults[language] = selectLanguage(candidates, language, constraints);
  }
  return deepFreeze({
    schemaVersion: 'asr-quality-short-selection-v1',
    seed,
    languages: languageResults,
  });
}

function balancedCandidateRank(seed, language, durationCentiseconds, candidate) {
  return crypto
    .createHash('sha256')
    .update(`${seed}\0${language}\0${durationCentiseconds}\0${candidate.sourceItemId}`, 'utf8')
    .digest('hex');
}

function balancedLanguageSelection(candidates, language, seed) {
  const expectedSourceId = `fleurs-v1-${language}`;
  const byDuration = new Map(
    BALANCED_SHORT_DURATION_CENTISECONDS.map(duration => [duration, new Map()])
  );
  for (const candidate of candidates) {
    if (
      candidate?.language !== language ||
      candidate.sourceId !== expectedSourceId ||
      candidate.partition !== 'test' ||
      candidate.wholeRecording !== true ||
      typeof candidate.referenceSha256 !== 'string' ||
      !SHA256_PATTERN.test(candidate.referenceSha256) ||
      typeof candidate.sourceItemId !== 'string'
    ) {
      continue;
    }
    const durationCentiseconds = Math.round(candidate.durationSeconds * 100);
    if (
      !byDuration.has(durationCentiseconds) ||
      Math.abs(candidate.durationSeconds * 100 - durationCentiseconds) > 1e-6
    ) {
      continue;
    }
    const candidatesByReference = byDuration.get(durationCentiseconds);
    const existing = candidatesByReference.get(candidate.referenceSha256);
    if (
      existing === undefined ||
      balancedCandidateRank(seed, language, durationCentiseconds, candidate).localeCompare(
        balancedCandidateRank(seed, language, durationCentiseconds, existing)
      ) < 0
    ) {
      candidatesByReference.set(candidate.referenceSha256, candidate);
    }
  }

  const slots = BALANCED_SHORT_DURATION_CENTISECONDS.map(durationCentiseconds => {
    const options = [...byDuration.get(durationCentiseconds).values()].sort((left, right) =>
      balancedCandidateRank(seed, language, durationCentiseconds, left).localeCompare(
        balancedCandidateRank(seed, language, durationCentiseconds, right)
      )
    );
    if (options.length === 0) {
      throw new Error(
        `Language ${language} balanced speed cohort is missing duration ${(durationCentiseconds / 100).toFixed(2)} seconds`
      );
    }
    return { durationCentiseconds, options };
  });
  const orderedSlots = [...slots].sort(
    (left, right) =>
      left.options.length - right.options.length ||
      left.durationCentiseconds - right.durationCentiseconds
  );
  function match(position, usedReferences, selectedByDuration) {
    if (position === orderedSlots.length) return selectedByDuration;
    const slot = orderedSlots[position];
    for (const candidate of slot.options) {
      if (usedReferences.has(candidate.referenceSha256)) continue;
      usedReferences.add(candidate.referenceSha256);
      selectedByDuration.set(slot.durationCentiseconds, candidate);
      const result = match(position + 1, usedReferences, selectedByDuration);
      if (result !== null) return result;
      selectedByDuration.delete(slot.durationCentiseconds);
      usedReferences.delete(candidate.referenceSha256);
    }
    return null;
  }
  const selectedByDuration = match(0, new Set(), new Map());
  if (selectedByDuration === null) {
    throw new Error(`Language ${language} balanced speed cohort cannot match 27 unique references`);
  }
  const fixtures = BALANCED_SHORT_DURATION_CENTISECONDS.map(duration =>
    selectedByDuration.get(duration)
  );
  if (fixtures.includes(undefined)) {
    throw new Error(`Language ${language} balanced speed cohort invariant failed`);
  }
  const stats = cohortStats(fixtures);
  if (
    fixtures.length !== BALANCED_SHORT_DURATION_CENTISECONDS.length ||
    Math.abs(stats.durationSeconds - 270) > 1e-9 ||
    new Set(fixtures.map(fixture => fixture.referenceSha256)).size !== fixtures.length
  ) {
    throw new Error(`Language ${language} balanced speed cohort invariant failed`);
  }
  return {
    ...stats,
    fixtureIds: fixtures.map(fixture => `${fixture.sourceId}:${fixture.sourceItemId}`),
    fixtures,
    rejected: [],
  };
}

function selectBalancedShortCohort(
  candidates,
  { languages, seed = 'wasper-asr-balanced-short-v1' } = {}
) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array');
  if (!Array.isArray(languages) || languages.length === 0) {
    throw new TypeError('languages must be a non-empty array');
  }
  if (new Set(languages).size !== languages.length) throw new Error('languages must be unique');
  for (const language of languages) {
    if (!LANGUAGE_PATTERN.test(language)) throw new Error(`invalid language ${language}`);
  }
  if (typeof seed !== 'string' || seed.length === 0) throw new Error('seed must be non-empty');
  const languageResults = Object.create(null);
  for (const language of languages) {
    languageResults[language] = balancedLanguageSelection(candidates, language, seed);
  }
  return deepFreeze({
    schemaVersion: 'asr-quality-short-selection-v2',
    benchmarkProfile: BALANCED_SHORT_PROFILE,
    seed,
    durationCentiseconds: [...BALANCED_SHORT_DURATION_CENTISECONDS],
    languages: languageResults,
  });
}

function validateBalancedShortSelection(selection, { languages } = {}) {
  if (!isPlainObject(selection)) throw new TypeError('balanced selection must be an object');
  if (
    selection.schemaVersion !== 'asr-quality-short-selection-v2' ||
    selection.benchmarkProfile !== BALANCED_SHORT_PROFILE ||
    typeof selection.seed !== 'string' ||
    selection.seed.length === 0
  ) {
    throw new Error('balanced selection profile is invalid');
  }
  if (
    !Array.isArray(selection.durationCentiseconds) ||
    selection.durationCentiseconds.length !== BALANCED_SHORT_DURATION_CENTISECONDS.length ||
    selection.durationCentiseconds.some(
      (duration, index) => duration !== BALANCED_SHORT_DURATION_CENTISECONDS[index]
    )
  ) {
    throw new Error('balanced selection duration profile is invalid');
  }
  if (
    !Array.isArray(languages) ||
    languages.length === 0 ||
    new Set(languages).size !== languages.length
  ) {
    throw new TypeError('balanced selection languages must be a unique non-empty array');
  }
  if (!isPlainObject(selection.languages))
    throw new Error('balanced selection languages are invalid');
  const actualLanguages = Object.keys(selection.languages).sort();
  const expectedLanguages = [...languages].sort();
  if (
    actualLanguages.length !== expectedLanguages.length ||
    actualLanguages.some((language, index) => language !== expectedLanguages[index])
  ) {
    throw new Error('balanced selection language coverage is invalid');
  }
  const sourceItems = new Set();
  for (const language of languages) {
    const cohort = selection.languages[language];
    if (
      !isPlainObject(cohort) ||
      !Array.isArray(cohort.fixtures) ||
      cohort.fixtures.length !== BALANCED_SHORT_DURATION_CENTISECONDS.length ||
      !Array.isArray(cohort.fixtureIds) ||
      cohort.fixtureIds.length !== cohort.fixtures.length ||
      cohort.durationSeconds !== 270
    ) {
      throw new Error(`Language ${language} balanced selection size or duration is invalid`);
    }
    const references = new Set();
    for (const [index, fixture] of cohort.fixtures.entries()) {
      const expectedDuration = BALANCED_SHORT_DURATION_CENTISECONDS[index];
      if (
        !isPlainObject(fixture) ||
        fixture.language !== language ||
        fixture.sourceId !== `fleurs-v1-${language}` ||
        fixture.partition !== 'test' ||
        fixture.wholeRecording !== true ||
        !Number.isFinite(fixture.durationSeconds) ||
        Math.abs(fixture.durationSeconds * 100 - expectedDuration) > 1e-6 ||
        typeof fixture.referenceSha256 !== 'string' ||
        !SHA256_PATTERN.test(fixture.referenceSha256) ||
        references.has(fixture.referenceSha256) ||
        typeof fixture.sourceItemId !== 'string' ||
        sourceItems.has(`${fixture.sourceId}\0${fixture.sourceItemId}`) ||
        cohort.fixtureIds[index] !== `${fixture.sourceId}:${fixture.sourceItemId}`
      ) {
        throw new Error(`Language ${language} balanced selection fixture ${index} is invalid`);
      }
      references.add(fixture.referenceSha256);
      sourceItems.add(`${fixture.sourceId}\0${fixture.sourceItemId}`);
    }
  }
  return selection;
}

module.exports = {
  ALLOWED_CONDITIONS,
  BALANCED_SHORT_DURATION_CENTISECONDS,
  BALANCED_SHORT_PROFILE,
  normalizeCandidate,
  opaqueSpeakerKey,
  selectBalancedShortCohort,
  selectShortCohort,
  validateBalancedShortSelection,
  validateSourceRegistry,
};
