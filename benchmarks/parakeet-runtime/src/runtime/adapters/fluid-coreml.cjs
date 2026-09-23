'use strict';

const path = require('node:path');

const {
  FLUID_AUDIO_SOURCE_IDENTITY,
  collectFluidAudioSourceEvidence,
} = require('../fluid-audio-source.cjs');
const { frozenDefinition, roots } = require('./definition.cjs');

function formatFluidAudioSourceIdentity(identity) {
  return `FluidAudio HEAD ${identity.head} ${identity.state} diff SHA-256 ${identity.uncommittedDiffSha256}`;
}

function resolveFluidCoreMlDefinition(options) {
  const { repositoryRoot, holderRoot } = roots(options);
  const modelPath = path.join(holderRoot, 'parakeet-tdt-0.6b-v3-coreml');
  const command = path.join(
    repositoryRoot,
    'src/runtime/bridges/fluid-coreml-server/.build/release/fluid-coreml-server'
  );
  return frozenDefinition({
    id: 'fluid-coreml-mixed',
    command,
    args: ['--model', modelPath],
    env: {},
    transport: { kind: 'jsonl' },
    modelPath,
    modelArtifacts: [
      path.join(modelPath, 'Decoder.mlmodelc'),
      path.join(modelPath, 'Encoder.mlmodelc'),
      path.join(modelPath, 'JointDecision.mlmodelc'),
      path.join(modelPath, 'Preprocessor.mlmodelc'),
      path.join(modelPath, 'parakeet_vocab.json'),
    ],
    modelIdentity: 'fluid-inference/parakeet-tdt-0.6b-v3-coreml-mixed',
    quantization: { label: 'mixed', encoderPaletteBits: 6, preprocessorOperationBits: 8 },
    runtime: {
      name: 'FluidAudio',
      backend: 'Core ML',
      fluidAudioSourceIdentity: FLUID_AUDIO_SOURCE_IDENTITY,
      computeUnits: {
        preprocessor: 'cpuOnly',
        encoder: 'cpuAndNeuralEngine',
        decoder: 'cpuAndNeuralEngine',
        joint: 'cpuAndNeuralEngine',
      },
    },
    versionProbes: {
      executable: { command, args: ['--version'] },
      packages: [
        {
          name: 'FluidAudio',
          command,
          args: ['--fluid-audio-revision'],
          expected: formatFluidAudioSourceIdentity(FLUID_AUDIO_SOURCE_IDENTITY),
          collectSourceEvidence: collectFluidAudioSourceEvidence,
        },
      ],
    },
    collectPrivateRuntimeEvidence: collectFluidAudioSourceEvidence,
  });
}

module.exports = {
  FLUID_AUDIO_SOURCE_IDENTITY,
  formatFluidAudioSourceIdentity,
  resolveFluidCoreMlDefinition,
};
