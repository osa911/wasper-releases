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
const { mergeOverlappingTranscripts } = require('../long-audio-chunking.cjs');

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

  const operations = {
    launchCommand,
    async start() {
      client = processClientFactory({ definition, modelIdentityHash });
      return client.start();
    },
    health() {
      return client.request('health');
    },
    warmup({ fixture }) {
      return client.request('warmup', { audioPath: fixture.audioPath });
    },
    async transcribe({ fixture }) {
      const audioPaths = fixture.audioChunks?.map(chunk => chunk.audioPath) ?? [fixture.audioPath];
      const responses = [];
      for (const audioPath of audioPaths) {
        responses.push(await client.request('transcribe', { audioPath }));
      }
      if (responses.length === 1) return responses[0];
      return {
        ...responses.at(-1),
        rawTranscript: mergeOverlappingTranscripts(
          responses.map(response => response.rawTranscript)
        ),
      };
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
