'use strict';

const path = require('node:path');

const { frozenDefinition, roots } = require('./definition.cjs');

function resolveHandyGgufDefinition(options) {
  const { repositoryRoot, holderRoot } = roots(options);
  const runtimeRoot = path.join(holderRoot, 'transcribe.cpp');
  const modelPath = path.join(
    holderRoot,
    'handy-computer-parakeet-tdt-0.6b-v3-gguf/parakeet-tdt-0.6b-v3-Q8_0.gguf'
  );
  const python = path.join(holderRoot, 'mlx-quant-venv/bin/python');
  return frozenDefinition({
    id: 'handy-gguf-q8',
    command: python,
    args: [
      path.join(repositoryRoot, 'src/runtime/bridges/handy_server.py'),
      '--model',
      modelPath,
    ],
    env: {
      PYTHONPATH: path.join(runtimeRoot, 'bindings/python/src'),
      TRANSCRIBE_LIBRARY: path.join(runtimeRoot, 'build-shared/src/libtranscribe.dylib'),
      TRANSCRIBE_BACKEND: 'metal',
    },
    transport: { kind: 'jsonl' },
    modelPath,
    modelArtifacts: [modelPath],
    modelIdentity: 'handy-computer/parakeet-tdt-0.6b-v3-Q8_0.gguf',
    quantization: { label: 'q8', bits: 8 },
    runtime: { name: 'Handy Computer transcribe.cpp', backend: 'GGML Metal' },
    versionProbes: {
      executable: { command: python, args: ['--version'] },
      packages: [
        {
          name: 'transcribe.cpp',
          command: '/usr/bin/git',
          args: ['-C', runtimeRoot, 'describe', '--tags', '--always', '--dirty'],
        },
      ],
    },
  });
}

module.exports = { resolveHandyGgufDefinition };
