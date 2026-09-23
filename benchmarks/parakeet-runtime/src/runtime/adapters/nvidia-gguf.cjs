'use strict';

const path = require('node:path');

const { frozenDefinition, roots } = require('./definition.cjs');

function resolveNvidiaGgufDefinition(options) {
  const { holderRoot } = roots(options);
  const runtimeRoot = path.join(holderRoot, 'NeMo-Speech.cpp');
  const modelPath = path.join(
    holderRoot,
    'nvidia-parakeet-tdt-0.6b-v3/parakeet-tdt-0.6b-v3.q8_0.gguf'
  );
  const command = path.join(runtimeRoot, 'build/metal-asr-http/bin/nemo-speech');
  return frozenDefinition({
    id: 'nvidia-gguf-q8',
    command,
    args: ['serve', '--asr-model', modelPath, '--host', '127.0.0.1', '--port', '19382', '--no-ui'],
    env: {},
    transport: {
      kind: 'http',
      port: 19382,
      healthPath: '/health',
      transcribePath: '/v1/audio/transcriptions',
      fileField: 'file',
    },
    modelPath,
    modelArtifacts: [modelPath],
    modelIdentity: 'nvidia/parakeet-tdt-0.6b-v3.q8_0.gguf',
    quantization: { label: 'q8', bits: 8 },
    runtime: { name: 'NVIDIA NeMo-Speech.cpp', backend: 'GGML Metal' },
    versionProbes: {
      executable: { command, args: ['--version'] },
      packages: [
        {
          name: 'NeMo-Speech.cpp',
          command: '/usr/bin/git',
          args: ['-C', runtimeRoot, 'describe', '--tags', '--always', '--dirty'],
        },
      ],
    },
  });
}

module.exports = { resolveNvidiaGgufDefinition };
