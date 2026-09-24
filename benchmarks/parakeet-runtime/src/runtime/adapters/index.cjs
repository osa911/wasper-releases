'use strict';

const { createResidentAdapter } = require('../adapter-protocol.cjs');
const { createPrivateModelIdentityEvidence } = require('../model-identity.cjs');
const { collectRuntimeVersionEvidence } = require('../runtime-version.cjs');
const { resolveFluidCoreMlDefinition } = require('./fluid-coreml.cjs');
const { resolveHandyGgufDefinition } = require('./handy-gguf.cjs');
const { resolveIstupakovOnnxDefinition } = require('./istupakov-onnx.cjs');
const { resolveMlxDefinition } = require('./mlx.cjs');
const { resolveNvidiaGgufDefinition } = require('./nvidia-gguf.cjs');
const { createProcessClient } = require('./process-client.cjs');
const { resolveWasperMetalDefinition } = require('./wasper-metal.cjs');
const { resolveLayout } = require('../../config.cjs');
const { loadRuntimeLock } = require('../locks.cjs');
const { verifyRuntimeInstallation } = require('../bootstrap.cjs');

function resolveRuntimeAdapterDefinition(runtimeId, options = {}) {
  switch (runtimeId) {
    case 'wasper-metal-int8':
      return resolveWasperMetalDefinition(options);
    case 'mlx-fp32':
    case 'mlx-int8-local':
      return resolveMlxDefinition(runtimeId, options);
    case 'handy-gguf-q8':
      return resolveHandyGgufDefinition(options);
    case 'nvidia-gguf-q8':
      return resolveNvidiaGgufDefinition(options);
    case 'istupakov-onnx-int8':
      return resolveIstupakovOnnxDefinition(options);
    case 'fluid-coreml-mixed':
      return resolveFluidCoreMlDefinition(options);
    default:
      throw new TypeError(`unknown runtime adapter: ${runtimeId}`);
  }
}

function createRuntimeAdapter(runtimeId, options = {}) {
  const installationOptions = {
    layout: options.layout ?? resolveLayout(options),
    lock: options.lock ?? options.runtimeLock ?? loadRuntimeLock(),
    python: options.python ?? 'python3',
  };
  const verify = () =>
    verifyRuntimeInstallation(runtimeId, installationOptions, {
      authority: options.lockAuthority,
    });
  verify();
  const definition = resolveRuntimeAdapterDefinition(runtimeId, options);
  const privateRuntimeEvidence = definition.collectPrivateRuntimeEvidence?.();
  const launchCommand = [definition.command, ...definition.args];
  const modelIdentity = options.modelIdentityInput ?? {
    artifacts: definition.modelArtifacts,
    ...collectRuntimeVersionEvidence(definition, options.runtimeVersionOptions),
    launchCommand,
    ...(definition.release === undefined ? {} : { release: definition.release }),
  };
  const modelIdentityHash = createPrivateModelIdentityEvidence(modelIdentity).identityHash;
  const processClientFactory = options.createProcessClientImpl ?? createProcessClient;
  let client = null;

  function completeRecording(fixture) {
    if (
      definition.longAudio.input !== 'complete-recording' ||
      definition.longAudio.benchmarkChunking !== false ||
      fixture.audioChunks !== undefined
    ) {
      throw new Error(
        'complete-recording input is required; benchmark-owned chunks are forbidden'
      );
    }
    if (typeof fixture.audioPath !== 'string' || !fixture.audioPath.trim()) {
      throw new Error('complete-recording input requires an audioPath');
    }
    return { audioPath: fixture.audioPath };
  }

  const operations = {
    launchCommand,
    async start() {
      verify();
      client = processClientFactory({ definition, modelIdentityHash });
      return client.start();
    },
    health() {
      return client.request('health');
    },
    warmup({ fixture }) {
      return client.request('warmup', completeRecording(fixture));
    },
    async transcribe({ fixture }) {
      return client.request('transcribe', completeRecording(fixture));
    },
    ownedProcessTree() {
      return client.ownedProcessTree();
    },
    async stop() {
      await client.stop();
      client = null;
    },
    identity:
      privateRuntimeEvidence === undefined
        ? definition.runtime
        : { ...definition.runtime, sourceEvidence: privateRuntimeEvidence },
  };

  return createResidentAdapter(operations, {
    modelIdentity,
    now: options.now,
    sampleFootprintImpl: options.sampleFootprintImpl,
  });
}

module.exports = { createRuntimeAdapter, resolveRuntimeAdapterDefinition };
