'use strict';

const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const {
  AUTOMATIC_LANGUAGE_POLICY,
  CACHE_PATHS,
  LANGUAGES,
  MEASURED_PASSES,
  RUNTIME_BENCHMARK_REVISION,
  RUNTIME_BENCHMARK_SCHEMA,
  RUNTIME_DESCRIPTORS,
} = require('./constants.cjs');

const QUANTIZATION_LABELS = new Set(['f32-weights-bf16-runtime', 'fp32', 'int8', 'q8', 'mixed']);
const RUNTIME_FIELDS = ['id', 'label', 'holder', 'artifact', 'quantization', 'languagePolicy'];
const ARTIFACT_FIELDS = ['format', 'identity', 'location'];
const LANGUAGE_POLICY_FIELDS = ['mode', 'languageHint'];
const CONTRACT_FIELDS = [
  'schema',
  'revision',
  'languages',
  'measuredPasses',
  'cachePaths',
  'runtimes',
];

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactFields(value, fields, jsonPath) {
  if (!isPlainObject(value)) throw new TypeError(`${jsonPath} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index]) ||
    Reflect.ownKeys(value).length !== actual.length
  ) {
    throw new TypeError(`${jsonPath} must contain exactly: ${fields.join(', ')}`);
  }
}

function assertJsonSafe(value, jsonPath = '$', ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${jsonPath} must be a finite JSON number`);
    return;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError(`${jsonPath} contains a cycle`);
    ancestors.add(value);
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index))
        throw new TypeError(`${jsonPath}[${index}] must be a JSON value`);
      assertJsonSafe(value[index], `${jsonPath}[${index}]`, ancestors);
    }
    ancestors.delete(value);
    return;
  }
  if (!isPlainObject(value) || Reflect.ownKeys(value).length !== Object.keys(value).length) {
    throw new TypeError(`${jsonPath} must be JSON-safe`);
  }
  if (ancestors.has(value)) throw new TypeError(`${jsonPath} contains a cycle`);
  ancestors.add(value);
  for (const [key, child] of Object.entries(value)) {
    assertJsonSafe(child, `${jsonPath}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function assertNonEmptyString(value, jsonPath) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${jsonPath} must be a non-empty string`);
  }
}

function assertPositiveInteger(value, jsonPath) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${jsonPath} must be a positive safe integer`);
  }
}

function validateQuantization(quantization, jsonPath) {
  if (!isPlainObject(quantization)) throw new TypeError(`${jsonPath} must be a plain object`);
  assertNonEmptyString(quantization.label, `${jsonPath}.label`);
  if (!QUANTIZATION_LABELS.has(quantization.label)) {
    throw new TypeError(`${jsonPath}.label must be one of ${[...QUANTIZATION_LABELS].join(', ')}`);
  }

  const fieldsByLabel = {
    'f32-weights-bf16-runtime': ['label', 'runtimeBits', 'weightBits'],
    fp32: ['label', 'bits'],
    int8: quantization.groupSize === undefined ? ['label', 'bits'] : ['label', 'bits', 'groupSize'],
    q8: ['label', 'bits'],
    mixed: ['label', 'encoderPaletteBits', 'preprocessorOperationBits'],
  };
  assertExactFields(quantization, fieldsByLabel[quantization.label], jsonPath);

  if (quantization.label === 'mixed') {
    assertPositiveInteger(quantization.encoderPaletteBits, `${jsonPath}.encoderPaletteBits`);
    assertPositiveInteger(
      quantization.preprocessorOperationBits,
      `${jsonPath}.preprocessorOperationBits`
    );
    return;
  }

  if (quantization.label === 'f32-weights-bf16-runtime') {
    assertPositiveInteger(quantization.runtimeBits, `${jsonPath}.runtimeBits`);
    assertPositiveInteger(quantization.weightBits, `${jsonPath}.weightBits`);
    if (quantization.runtimeBits !== 16 || quantization.weightBits !== 32) {
      throw new TypeError(`${jsonPath} must declare F32 weights and BF16 runtime`);
    }
    return;
  }

  assertPositiveInteger(quantization.bits, `${jsonPath}.bits`);
  if (quantization.label === 'fp32' && quantization.bits !== 32) {
    throw new TypeError(`${jsonPath}.bits must be 32 for fp32`);
  }
  if ((quantization.label === 'int8' || quantization.label === 'q8') && quantization.bits !== 8) {
    throw new TypeError(`${jsonPath}.bits must be 8 for ${quantization.label}`);
  }
  if (quantization.groupSize !== undefined) {
    assertPositiveInteger(quantization.groupSize, `${jsonPath}.groupSize`);
  }
}

function validateRuntimeDescriptor(runtime, index, ids) {
  const jsonPath = `runtimes[${index}]`;
  if (isPlainObject(runtime)) {
    for (const field of RUNTIME_FIELDS) {
      if (!Object.hasOwn(runtime, field)) throw new TypeError(`${jsonPath}.${field} is required`);
    }
  }
  assertExactFields(runtime, RUNTIME_FIELDS, jsonPath);
  assertJsonSafe(runtime, jsonPath);
  for (const field of ['id', 'label', 'holder'])
    assertNonEmptyString(runtime[field], `${jsonPath}.${field}`);
  if (ids.has(runtime.id)) throw new TypeError(`duplicate runtime id: ${runtime.id}`);
  ids.add(runtime.id);

  assertExactFields(runtime.artifact, ARTIFACT_FIELDS, `${jsonPath}.artifact`);
  for (const field of ARTIFACT_FIELDS) {
    assertNonEmptyString(runtime.artifact[field], `${jsonPath}.artifact.${field}`);
  }
  validateQuantization(runtime.quantization, `${jsonPath}.quantization`);
  assertExactFields(runtime.languagePolicy, LANGUAGE_POLICY_FIELDS, `${jsonPath}.languagePolicy`);
  if (
    runtime.languagePolicy.mode !== AUTOMATIC_LANGUAGE_POLICY.mode ||
    runtime.languagePolicy.languageHint !== AUTOMATIC_LANGUAGE_POLICY.languageHint
  ) {
    throw new TypeError(`${jsonPath}.languagePolicy must declare automatic language with no hint`);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function validateRuntimeBenchmarkContract(input = {}) {
  if (!isPlainObject(input))
    throw new TypeError('runtime benchmark contract must be a plain object');
  for (const field of Object.keys(input)) {
    if (!CONTRACT_FIELDS.includes(field))
      throw new TypeError(`runtime benchmark contract has unknown field ${field}`);
  }
  const contract = {
    schema: input.schema ?? RUNTIME_BENCHMARK_SCHEMA,
    revision: input.revision ?? RUNTIME_BENCHMARK_REVISION,
    languages: input.languages ?? LANGUAGES,
    measuredPasses: input.measuredPasses ?? MEASURED_PASSES,
    cachePaths: input.cachePaths ?? CACHE_PATHS,
    runtimes: input.runtimes ?? RUNTIME_DESCRIPTORS,
  };
  assertJsonSafe(contract);
  if (contract.schema !== RUNTIME_BENCHMARK_SCHEMA) {
    throw new TypeError(`schema must equal ${RUNTIME_BENCHMARK_SCHEMA}`);
  }
  if (contract.revision !== RUNTIME_BENCHMARK_REVISION) {
    throw new TypeError(`revision must equal ${RUNTIME_BENCHMARK_REVISION}`);
  }
  if (JSON.stringify(contract.languages) !== JSON.stringify(LANGUAGES)) {
    throw new TypeError('languages must equal the frozen v1 language order');
  }
  if (contract.measuredPasses !== MEASURED_PASSES) {
    throw new TypeError(`measuredPasses must equal ${MEASURED_PASSES}`);
  }
  if (JSON.stringify(contract.cachePaths) !== JSON.stringify(CACHE_PATHS)) {
    throw new TypeError('cachePaths must equal the private runtime benchmark cache paths');
  }
  if (
    !Array.isArray(contract.runtimes) ||
    contract.runtimes.length !== RUNTIME_DESCRIPTORS.length
  ) {
    throw new TypeError(`runtimes must contain exactly ${RUNTIME_DESCRIPTORS.length} descriptors`);
  }
  const ids = new Set();
  contract.runtimes.forEach((runtime, index) => {
    validateRuntimeDescriptor(runtime, index, ids);
    if (!isDeepStrictEqual(runtime, RUNTIME_DESCRIPTORS[index])) {
      throw new TypeError(`runtimes[${index}] must match the canonical runtime descriptor`);
    }
  });
  return deepFreeze(structuredClone(contract));
}

function resolvePrivateOutputPath(
  output,
  { repositoryRoot = path.resolve(__dirname, '..', '..') } = {}
) {
  assertNonEmptyString(output, 'output');
  assertNonEmptyString(repositoryRoot, 'repositoryRoot');
  const root = path.resolve(repositoryRoot);
  const cacheRoot = path.resolve(root, CACHE_PATHS.root);
  const resolvedOutput = path.resolve(root, output);
  const relative = path.relative(cacheRoot, resolvedOutput);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`output must stay under the private benchmark cache: ${CACHE_PATHS.root}`);
  }
  return resolvedOutput;
}

module.exports = {
  assertJsonSafe,
  resolvePrivateOutputPath,
  validateRuntimeBenchmarkContract,
};
