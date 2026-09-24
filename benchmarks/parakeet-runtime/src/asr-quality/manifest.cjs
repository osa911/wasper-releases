const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');

const { NORMALIZED_AUDIO_TRANSFORM } = require('./audio-cache.cjs');
const { LANGUAGES } = require('./constants.cjs');
const {
  MANIFEST_FIXTURE_ID_MAX_LENGTH,
  MANIFEST_FIXTURE_ID_PATTERN_SOURCE,
} = require('./fixture-id.cjs');
const { characterUnits, wordUnits } = require('./normalization.cjs');
const { MAX_MANIFEST_REFERENCE_UNITS } = require('./scoring.cjs');

const schema = require('../../schema/manifest.schema.json');
const fixtureIdentifierSchema = schema.$defs.fixtureIdentifier;
if (
  fixtureIdentifierSchema.maxLength !== MANIFEST_FIXTURE_ID_MAX_LENGTH ||
  fixtureIdentifierSchema.pattern !== MANIFEST_FIXTURE_ID_PATTERN_SOURCE
) {
  throw new Error('Manifest schema fixture identifier contract drifted from the runtime grammar');
}
const referenceSchema = schema.$defs.reference.properties;
if (
  referenceSchema.wordCount.maximum !== MAX_MANIFEST_REFERENCE_UNITS ||
  referenceSchema.characterCount.maximum !== MAX_MANIFEST_REFERENCE_UNITS
) {
  throw new Error('Manifest schema reference limits drifted from the scorer work budget');
}
const transformSchema = schema.$defs.normalizedAudio.properties.transform.properties;
if (
  transformSchema.tool.const !== NORMALIZED_AUDIO_TRANSFORM.tool ||
  JSON.stringify(transformSchema.arguments.const) !==
    JSON.stringify(NORMALIZED_AUDIO_TRANSFORM.arguments)
) {
  throw new Error('Manifest schema transform contract drifted from the canonical audio transform');
}
const validateSchema = new Ajv({ allErrors: true, jsonPointers: true }).compile(schema);
const SHORT_DURATION = Object.freeze({ min: 2, max: 30 });
const LONG_SOURCE_DURATION = Object.freeze({ min: 120, max: 600 });
const LONG_REGULAR_SOURCE_DURATION_MAX_SECONDS = 300;
const SHORT_TOTAL_SECONDS = Object.freeze({ min: 240, max: 330 });
const NORMALIZED_DURATION_TOLERANCE_SECONDS = 0.25;

function canonicalJson(value) {
  return canonicalize(value, new WeakSet(), '$');
}

function canonicalize(value, seen, jsonPath) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${jsonPath} must be a finite JSON number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError(`${jsonPath} contains a cycle`);
    seen.add(value);
    const entries = Array.from({ length: value.length }, (_, index) => {
      if (!(index in value)) throw new TypeError(`${jsonPath}[${index}] is not a JSON value`);
      return canonicalize(value[index], seen, `${jsonPath}[${index}]`);
    });
    const output = `[${entries.join(',')}]`;
    seen.delete(value);
    return output;
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new TypeError(`${jsonPath} is not a JSON value`);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${jsonPath} is not a plain JSON object`);
  }
  if (seen.has(value)) throw new TypeError(`${jsonPath} contains a cycle`);
  seen.add(value);
  const output = `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalize(value[key], seen, `${jsonPath}.${key}`)}`)
    .join(',')}}`;
  seen.delete(value);
  return output;
}

function manifestHash(manifest) {
  return crypto.createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

function formatSchemaPath(error) {
  const pointer = error.dataPath || error.instancePath || '';
  const base =
    pointer
      .replace(/~1/gu, '/')
      .replace(/~0/gu, '~')
      .replace(/\/([^/]+)/gu, (_, segment) =>
        /^\d+$/u.test(segment) ? `[${segment}]` : `.${segment}`
      ) || '$';
  if (error.keyword === 'required') return `${base}.${error.params.missingProperty}`;
  if (error.keyword === 'additionalProperties') return `${base}.${error.params.additionalProperty}`;
  return base;
}

function throwViolations(violations) {
  if (violations.length > 0) {
    throw new Error(`Invalid ASR quality manifest: ${violations.join('; ')}`);
  }
}

function addViolation(violations, jsonPath, message) {
  violations.push(`${jsonPath}: ${message}`);
}

function validateAssetIntegrity(asset, jsonPath, revision, violations) {
  if (asset.benchmarkRevision !== revision) {
    addViolation(
      violations,
      `${jsonPath}.benchmarkRevision`,
      'must match the manifest benchmarkRevision'
    );
  }
  if (asset.audit.benchmarkRevision !== revision) {
    addViolation(
      violations,
      `${jsonPath}.audit.benchmarkRevision`,
      'must bind the privacy/provenance attestation to the manifest benchmarkRevision'
    );
  }
  if (Object.hasOwn(asset.source, 'url')) {
    let sourceUrl = null;
    try {
      sourceUrl = new URL(asset.source.url);
    } catch {}
    if (sourceUrl === null || sourceUrl.protocol !== 'https:' || sourceUrl.hostname.length === 0) {
      addViolation(
        violations,
        `${jsonPath}.source.url`,
        'must be an absolute HTTPS URL with a hostname'
      );
    }
  }
  if (asset.audit.provenanceClassification === 'owned-or-commissioned-benchmark-recording') {
    if (asset.cohort !== 'long') {
      addViolation(
        violations,
        `${jsonPath}.audit.provenanceClassification`,
        'owned or commissioned benchmark recordings are permitted only in the long cohort'
      );
    }
    if (
      asset.source.partition !== 'standalone-recording' ||
      !Object.hasOwn(asset.source, 'authorizedFetchKey') ||
      Object.hasOwn(asset.source, 'url')
    ) {
      addViolation(
        violations,
        `${jsonPath}.source.url`,
        'owned or commissioned long audio must use a restricted standalone authorized fetch key'
      );
    }
    if (
      asset.reference.storagePolicy !== 'restricted-local-cache' ||
      !Object.hasOwn(asset.reference, 'authorizedFetchKey') ||
      Object.hasOwn(asset.reference, 'text')
    ) {
      addViolation(
        violations,
        `${jsonPath}.reference.storagePolicy`,
        'owned or commissioned long references must remain in the restricted local cache'
      );
    }
  }
  const sourceDuration = asset.source.durationSeconds;
  const normalizedDuration = asset.normalizedAudio.durationSeconds;
  const transform = asset.normalizedAudio.transform;
  if (transform.tool !== NORMALIZED_AUDIO_TRANSFORM.tool) {
    addViolation(
      violations,
      `${jsonPath}.normalizedAudio.transform.tool`,
      `must equal ${NORMALIZED_AUDIO_TRANSFORM.tool}`
    );
  }
  if (canonicalJson(transform.arguments) !== canonicalJson(NORMALIZED_AUDIO_TRANSFORM.arguments)) {
    addViolation(
      violations,
      `${jsonPath}.normalizedAudio.transform.arguments`,
      'must exactly match the canonical ordered whole-recording conversion arguments'
    );
  }
  if (Math.abs(sourceDuration - normalizedDuration) > NORMALIZED_DURATION_TOLERANCE_SECONDS) {
    addViolation(
      violations,
      `${jsonPath}.normalizedAudio.durationSeconds`,
      `must be within ${NORMALIZED_DURATION_TOLERANCE_SECONDS} seconds of source.durationSeconds`
    );
  }
  if (asset.reference.storagePolicy === 'redistributable') {
    const actualWordCount = wordUnits(asset.reference.text, asset.language).length;
    const actualCharacterCount = characterUnits(asset.reference.text, asset.language).length;
    const actualReferenceHash = crypto
      .createHash('sha256')
      .update(asset.reference.text, 'utf8')
      .digest('hex');
    if (asset.reference.sha256 !== actualReferenceHash) {
      addViolation(
        violations,
        `${jsonPath}.reference.sha256`,
        'must equal the lowercase SHA-256 of the raw embedded UTF-8 reference text'
      );
    }
    if (asset.reference.wordCount !== actualWordCount) {
      addViolation(
        violations,
        `${jsonPath}.reference.wordCount`,
        `must equal ${actualWordCount} after ${asset.language} scoring normalization`
      );
    }
    if (asset.reference.characterCount !== actualCharacterCount) {
      addViolation(
        violations,
        `${jsonPath}.reference.characterCount`,
        `must equal ${actualCharacterCount} after ${asset.language} scoring normalization`
      );
    }
  }
}

function validateAuditDate(asset, jsonPath, violations) {
  const auditDate = asset.audit.date;
  const auditDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(auditDate);
  if (auditDateMatch) {
    const [, year, month, day] = auditDateMatch.map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (
      parsed.getUTCFullYear() !== year ||
      parsed.getUTCMonth() !== month - 1 ||
      parsed.getUTCDate() !== day
    ) {
      addViolation(violations, `${jsonPath}.audit.date`, 'must be a real calendar date');
    }
  }
}

function validateFixture(fixture, index, revision, violations) {
  const jsonPath = `fixtures[${index}]`;
  if (fixture.status === 'no-qualified-fixture') return;
  validateAssetIntegrity(fixture, jsonPath, revision, violations);
  validateAuditDate(fixture, jsonPath, violations);
  if (
    fixture.cohort === 'long' &&
    !fixture.excluded &&
    fixture.audit.speakerCompositionStatus !== 'predominantly-one-speaker'
  ) {
    addViolation(
      violations,
      `${jsonPath}.audit.speakerCompositionStatus`,
      'must attest predominantly-one-speaker for a qualified long recording'
    );
  }
  if (fixture.cohort === 'long' && !fixture.excluded) {
    if (fixture.reference.wordCount <= 0) {
      addViolation(
        violations,
        `${jsonPath}.reference.wordCount`,
        'must contain positive normalized scoring units for a qualified long recording'
      );
    }
    if (fixture.reference.characterCount <= 0) {
      addViolation(
        violations,
        `${jsonPath}.reference.characterCount`,
        'must contain positive normalized scoring units for a qualified long recording'
      );
    }
  }
  const sourceDuration = fixture.source.durationSeconds;
  const sourceLimits = fixture.cohort === 'short' ? SHORT_DURATION : LONG_SOURCE_DURATION;
  if (sourceDuration < sourceLimits.min || sourceDuration > sourceLimits.max) {
    addViolation(
      violations,
      `${jsonPath}.source.durationSeconds`,
      `must be between ${sourceLimits.min} and ${sourceLimits.max} seconds for the ${fixture.cohort} cohort`
    );
  }
}

function validateCorpus(manifest, requireCoverage) {
  const violations = [];
  const rowsByLanguage = new Map(LANGUAGES.map(language => [language, []]));
  const ids = new Map([[manifest.warmup.id, 'warmup.id']]);
  const sourceHashes = new Map([[manifest.warmup.source.sha256, 'warmup.source.sha256']]);
  const normalizedHashes = new Map([
    [manifest.warmup.normalizedAudio.sha256, 'warmup.normalizedAudio.sha256'],
  ]);

  validateAssetIntegrity(manifest.warmup, 'warmup', manifest.benchmarkRevision, violations);
  validateAuditDate(manifest.warmup, 'warmup', violations);

  for (const [index, fixture] of manifest.fixtures.entries()) {
    const jsonPath = `fixtures[${index}]`;
    if (fixture.status !== 'no-qualified-fixture') {
      const priorPath = ids.get(fixture.id);
      if (priorPath) addViolation(violations, `${jsonPath}.id`, `duplicates ${priorPath}`);
      else ids.set(fixture.id, `${jsonPath}.id`);
      const sourceHashPath = sourceHashes.get(fixture.source.sha256);
      if (sourceHashPath) {
        addViolation(violations, `${jsonPath}.source.sha256`, `duplicates ${sourceHashPath}`);
      } else {
        sourceHashes.set(fixture.source.sha256, `${jsonPath}.source.sha256`);
      }
      const normalizedHashPath = normalizedHashes.get(fixture.normalizedAudio.sha256);
      if (normalizedHashPath) {
        addViolation(
          violations,
          `${jsonPath}.normalizedAudio.sha256`,
          `duplicates ${normalizedHashPath}`
        );
      } else {
        normalizedHashes.set(fixture.normalizedAudio.sha256, `${jsonPath}.normalizedAudio.sha256`);
      }
      validateFixture(fixture, index, manifest.benchmarkRevision, violations);
    }
    rowsByLanguage.get(fixture.language).push({ fixture, index });
  }

  for (const language of LANGUAGES) {
    const rows = rowsByLanguage.get(language);
    const longOutcomes = rows.filter(
      ({ fixture }) =>
        fixture.cohort === 'long' &&
        (fixture.status === 'no-qualified-fixture' || fixture.excluded === false)
    );
    if (longOutcomes.length !== 1) {
      addViolation(
        violations,
        'fixtures',
        `must contain exactly one qualified or explicitly unavailable long outcome for language ${language}`
      );
    }
    if (!requireCoverage) continue;

    const shortRows = rows.filter(({ fixture }) => fixture.cohort === 'short' && !fixture.excluded);
    if (shortRows.length === 0) {
      addViolation(
        violations,
        'fixtures',
        `is missing qualified short coverage for language ${language}`
      );
      continue;
    }
    const totalSeconds = shortRows.reduce(
      (sum, { fixture }) => sum + fixture.normalizedAudio.durationSeconds,
      0
    );
    if (totalSeconds < SHORT_TOTAL_SECONDS.min || totalSeconds > SHORT_TOTAL_SECONDS.max) {
      addViolation(
        violations,
        'fixtures',
        `short normalized duration for ${language} must total ${SHORT_TOTAL_SECONDS.min}-${SHORT_TOTAL_SECONDS.max} seconds`
      );
    }
    const wordsBySpeaker = new Map();
    const recordingConditions = new Set();
    let totalWords = 0;
    for (const { fixture } of shortRows) {
      const words = fixture.reference.wordCount;
      totalWords += words;
      wordsBySpeaker.set(fixture.speakerKey, (wordsBySpeaker.get(fixture.speakerKey) ?? 0) + words);
      recordingConditions.add(fixture.audit.recordingCondition);
    }
    if (wordsBySpeaker.size < 5) {
      addViolation(
        violations,
        'fixtures',
        `short coverage for ${language} requires at least five speakers`
      );
    }
    if (recordingConditions.size < 2) {
      addViolation(
        violations,
        'fixtures',
        `short coverage for ${language} requires at least two recording conditions`
      );
    }
    if (totalWords === 0) {
      addViolation(violations, 'fixtures', `short coverage for ${language} has no reference words`);
    } else {
      for (const [speakerKey, words] of wordsBySpeaker) {
        const fixtureIndex = shortRows.find(
          ({ fixture }) => fixture.speakerKey === speakerKey
        ).index;
        if (words === 0) {
          addViolation(
            violations,
            `fixtures[${fixtureIndex}].speakerKey`,
            `short speaker cluster must contain positive reference words for ${language}`
          );
        } else if (words / totalWords > 0.25) {
          addViolation(
            violations,
            `fixtures[${fixtureIndex}].speakerKey`,
            `contributes more than 25% of ${language} short reference words`
          );
        }
      }
    }
  }
  const longExceptions = manifest.fixtures.filter(
    fixture =>
      fixture.cohort === 'long' &&
      fixture.status !== 'no-qualified-fixture' &&
      !fixture.excluded &&
      fixture.source.durationSeconds > LONG_REGULAR_SOURCE_DURATION_MAX_SECONDS
  );
  for (const fixture of longExceptions.slice(1)) {
    const fixtureIndex = manifest.fixtures.indexOf(fixture);
    addViolation(
      violations,
      `fixtures[${fixtureIndex}].source.durationSeconds`,
      'only one suite-wide natural whole-recording long exception may exceed 300 seconds'
    );
  }
  return violations;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function validateManifest(manifest, { requireCoverage = true } = {}) {
  if (!validateSchema(manifest)) {
    const violations = validateSchema.errors.map(
      error => `${formatSchemaPath(error)}: ${error.message}`
    );
    throwViolations(violations);
  }
  const violations = validateCorpus(manifest, requireCoverage);
  throwViolations(violations);
  return deepFreeze(manifest);
}

function loadManifest(manifestPath, options) {
  const resolvedPath = path.resolve(manifestPath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to load ASR quality manifest at ${resolvedPath}: ${error.message}`);
  }
  return validateManifest(parsed, options);
}

module.exports = { canonicalJson, manifestHash, validateManifest, loadManifest };
