'use strict';

const {
  sampleOwnedProcessTree,
  validatePostResponsePhysicalFootprintEvidence,
} = require('./footprint.cjs');
const {
  validateAutomaticLanguageCommand,
  validateAutomaticLanguageResponseMetadata,
} = require('./language-policy.cjs');
const { createPrivateModelIdentityEvidence } = require('./model-identity.cjs');

function requirePlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function requireFunction(value, label) {
  if (typeof value !== 'function') throw new TypeError(`${label} must be a function`);
}

class ResidentIdentityChangeError extends Error {
  constructor(phase) {
    super(`Runtime resident identity changed during ${phase}`);
    this.name = 'ResidentIdentityChangeError';
    this.code = 'RESIDENT_IDENTITY_CHANGE';
  }
}

function validateResidentIdentity(identity) {
  requirePlainObject(identity, 'residentIdentity');
  const fields = Object.keys(identity).sort();
  if (
    fields.length !== 3 ||
    fields[0] !== 'modelIdentityHash' ||
    fields[1] !== 'modelLoadId' ||
    fields[2] !== 'processId'
  ) {
    throw new TypeError(
      'residentIdentity must contain processId, modelLoadId, and modelIdentityHash'
    );
  }
  for (const field of fields) {
    if (typeof identity[field] !== 'string' || identity[field].trim() === '') {
      throw new TypeError(`residentIdentity.${field} must be a non-empty string`);
    }
  }
  return { ...identity };
}

function assertStableResidentIdentity(candidate, expected, phase, modelIdentityHash) {
  const identity = validateResidentIdentity(candidate);
  if (expected === null && identity.modelIdentityHash !== modelIdentityHash) {
    throw new TypeError('residentIdentity model identity does not match private model evidence');
  }
  if (expected !== null && JSON.stringify(identity) !== JSON.stringify(expected)) {
    throw new ResidentIdentityChangeError(phase);
  }
  return identity;
}

function failureFrom(error, activationId) {
  const message =
    typeof error?.message === 'string' && error.message !== '' ? error.message : String(error);
  const timeoutCodes = new Set(['ABORT_ERR', 'ECONNABORTED', 'ETIMEDOUT', 'UND_ERR_ABORTED']);
  const crashCodes = new Set(['ADAPTER_PROCESS_CRASHED', 'PROCESS_CRASH', 'PROCESS_EXITED']);
  const type =
    timeoutCodes.has(error?.code) || error?.name === 'TimeoutError'
      ? 'timeout'
      : crashCodes.has(error?.code) || typeof error?.signal === 'string'
        ? 'crash'
        : 'runtime-error';
  return { error: { type, message, activationId } };
}

function resultOrFailure(result, activationId, residentIdentity, phase, modelIdentityHash) {
  try {
    requirePlainObject(result, 'runtime response');
    assertStableResidentIdentity(
      result.residentIdentity,
      residentIdentity,
      phase,
      modelIdentityHash
    );
  } catch (error) {
    if (error instanceof ResidentIdentityChangeError) {
      return {
        error: { type: 'resident-identity-change', message: error.message, activationId },
      };
    }
    return {
      error: { type: 'malformed-response', message: error.message, activationId },
    };
  }
  try {
    validateAutomaticLanguageResponseMetadata(result.responseMetadata);
  } catch (error) {
    return {
      error: { type: 'malformed-response', message: error.message, activationId },
    };
  }
  if (typeof result.rawTranscript !== 'string') {
    return {
      error: {
        type: 'malformed-response',
        message: 'Runtime response must include a string rawTranscript',
        activationId,
      },
    };
  }
  if (result.rawTranscript.trim() === '') {
    return {
      error: {
        type: 'empty-transcript',
        message: 'Runtime returned an empty transcript',
        activationId,
      },
    };
  }
  if (
    result.encoderBucketFrames !== undefined &&
    (!Number.isSafeInteger(result.encoderBucketFrames) || result.encoderBucketFrames <= 0)
  ) {
    return {
      error: {
        type: 'malformed-response',
        message: 'Runtime response encoderBucketFrames must be a positive integer',
        activationId,
      },
    };
  }
  return {
    rawTranscript: result.rawTranscript,
    activationId,
    residentIdentity,
    responseMetadata: result.responseMetadata,
    ...(result.encoderBucketFrames === undefined
      ? {}
      : { encoderBucketFrames: result.encoderBucketFrames }),
  };
}

function createResidentAdapter(
  operations,
  {
    modelIdentity,
    now = () => performance.now(),
    sampleFootprintImpl = sampleOwnedProcessTree,
  } = {}
) {
  requirePlainObject(operations, 'adapter operations');
  for (const method of ['start', 'health', 'warmup', 'transcribe', 'ownedProcessTree', 'stop']) {
    requireFunction(operations[method], `adapter operations.${method}`);
  }
  const launchCommand = validateAutomaticLanguageCommand(operations.launchCommand);
  const privateModelEvidence = createPrivateModelIdentityEvidence(modelIdentity);
  if (
    JSON.stringify(launchCommand) !==
    JSON.stringify(validateAutomaticLanguageCommand(privateModelEvidence.identity.launchCommand))
  ) {
    throw new TypeError('adapter launch command must match private model identity evidence');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof sampleFootprintImpl !== 'function')
    throw new TypeError('sampleFootprintImpl must be a function');

  let activation = null;
  let activationSequence = 0;
  let state = 'stopped';
  let warmupCompleted = false;

  function requireState(expected, method) {
    if (state !== expected)
      throw new Error(
        `${method} requires ${expected === 'healthy' ? 'successful health' : 'start'} state`
      );
  }

  function activationId() {
    return activation.activationId;
  }

  function residentIdentityForOperation() {
    return { ...activation.residentIdentity };
  }

  function invalidateActivation() {
    warmupCompleted = false;
    state = 'invalidated';
  }

  async function start() {
    if (state !== 'stopped') throw new Error('start requires a stopped adapter');
    const nextActivationId = `activation-${++activationSequence}`;
    const started = await operations.start({ activationId: nextActivationId });
    requirePlainObject(started, 'start response');
    const residentIdentity = Object.freeze(
      assertStableResidentIdentity(
        started.residentIdentity,
        null,
        'start',
        privateModelEvidence.identityHash
      )
    );
    activation = { activationId: nextActivationId, residentIdentity };
    warmupCompleted = false;
    state = 'started';
    return { activationId: nextActivationId, residentIdentity: { ...residentIdentity } };
  }

  async function health() {
    requireState('started', 'health');
    const result = await operations.health({
      activationId: activationId(),
      residentIdentity: residentIdentityForOperation(),
    });
    requirePlainObject(result, 'health response');
    if (result.status !== 'ok') throw new Error('health response status must equal ok');
    let residentIdentity;
    try {
      residentIdentity = assertStableResidentIdentity(
        result.residentIdentity,
        activation.residentIdentity,
        'health',
        privateModelEvidence.identityHash
      );
    } catch (error) {
      if (error instanceof ResidentIdentityChangeError) invalidateActivation();
      throw error;
    }
    warmupCompleted = false;
    state = 'healthy';
    return { ...result, activationId: activationId(), residentIdentity };
  }

  async function warmup(fixture) {
    requireState('healthy', 'warmup');
    try {
      const outcome = resultOrFailure(
        await operations.warmup({
          fixture,
          activationId: activationId(),
          residentIdentity: residentIdentityForOperation(),
        }),
        activationId(),
        activation.residentIdentity,
        'warmup',
        privateModelEvidence.identityHash
      );
      if (outcome.error) {
        invalidateActivation();
        return outcome;
      }
      warmupCompleted = true;
      return outcome;
    } catch (error) {
      invalidateActivation();
      return failureFrom(error, activationId());
    }
  }

  async function transcribe(fixture) {
    if (state === 'invalidated') {
      throw new Error('transcribe requires stop and fresh activation after invalidation');
    }
    requireState('healthy', 'transcribe');
    if (!warmupCompleted) throw new Error('transcribe requires successful warm-up');
    const startedAt = now();
    if (!Number.isFinite(startedAt)) throw new TypeError('now must return a finite monotonic time');
    let result;
    try {
      result = await operations.transcribe({
        fixture,
        activationId: activationId(),
        residentIdentity: residentIdentityForOperation(),
      });
    } catch (error) {
      return failureFrom(error, activationId());
    }
    const outcome = resultOrFailure(
      result,
      activationId(),
      activation.residentIdentity,
      'transcribe',
      privateModelEvidence.identityHash
    );
    if (outcome.error) {
      if (outcome.error.type === 'resident-identity-change') invalidateActivation();
      return outcome;
    }
    const endedAt = now();
    if (!Number.isFinite(endedAt) || endedAt <= startedAt) {
      return {
        error: {
          type: 'invalid-timing',
          message: 'request wall clock must increase',
          activationId: activationId(),
        },
      };
    }
    return { ...outcome, wallSeconds: (endedAt - startedAt) / 1_000 };
  }

  async function sampleFootprint() {
    requireState('healthy', 'sampleFootprint');
    const tree = await operations.ownedProcessTree({ activationId: activationId() });
    requirePlainObject(tree, 'owned process tree');
    return validatePostResponsePhysicalFootprintEvidence(await sampleFootprintImpl(tree.processes));
  }

  async function identity() {
    const runtimeIdentity =
      typeof operations.identity === 'function'
        ? await operations.identity({ activationId: activation?.activationId ?? null })
        : operations.identity;
    requirePlainObject(runtimeIdentity, 'runtime identity');
    return {
      schema: 'wasper.parakeet-runtime-benchmark.private-adapter-identity.v1',
      visibility: 'private-evidence',
      runtime: structuredClone(runtimeIdentity),
      modelEvidence: privateModelEvidence,
    };
  }

  async function stop() {
    if (state === 'stopped') throw new Error('stop requires an active adapter');
    const currentActivationId = activationId();
    await operations.stop({ activationId: currentActivationId });
    activation = null;
    warmupCompleted = false;
    state = 'stopped';
  }

  return Object.freeze({ start, health, warmup, transcribe, sampleFootprint, identity, stop });
}

module.exports = {
  createResidentAdapter,
  validateAutomaticLanguageCommand,
  validateAutomaticLanguageResponseMetadata,
};
