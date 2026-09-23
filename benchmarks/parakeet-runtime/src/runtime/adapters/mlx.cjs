'use strict';

const path = require('node:path');

const { frozenDefinition, roots } = require('./definition.cjs');

const MAX_METAL_MEMORY_BYTES = 8 * 1024 ** 3;

function resolveMlxDefinition(runtimeId, options) {
  const { repositoryRoot, holderRoot } = roots(options);
  const int8 = runtimeId === 'mlx-int8-local';
  if (!int8 && runtimeId !== 'mlx-fp32') throw new TypeError(`unknown MLX runtime: ${runtimeId}`);
  const modelPath = path.join(
    holderRoot,
    int8 ? 'mlx-community-parakeet-tdt-0.6b-v3-int8-local' : 'mlx-community-parakeet-tdt-0.6b-v3'
  );
  const bridge = path.join(
    repositoryRoot,
    'src/runtime/bridges/mlx_server.py'
  );
  const python = path.join(holderRoot, 'mlx-quant-venv/bin/python');
  const packageProbe = packageName => ({
    name: packageName,
    command: python,
    args: [
      '-c',
      `import importlib.metadata; print(importlib.metadata.version(${JSON.stringify(packageName)}))`,
    ],
  });
  return frozenDefinition({
    id: runtimeId,
    command: python,
    args: [
      bridge,
      '--model',
      modelPath,
      '--precision',
      int8 ? 'int8-g64' : 'bf16',
      '--chunk-duration-seconds',
      '120',
      '--overlap-duration-seconds',
      '15',
      '--max-metal-memory-bytes',
      String(MAX_METAL_MEMORY_BYTES),
    ],
    env: { PYTHONUNBUFFERED: '1' },
    transport: { kind: 'jsonl' },
    modelPath,
    modelArtifacts: [modelPath],
    modelIdentity: int8
      ? 'wasper/parakeet-tdt-0.6b-v3-mlx-int8-g64'
      : 'mlx-community/parakeet-tdt-0.6b-v3',
    quantization: int8
      ? { label: 'int8', bits: 8, groupSize: 64 }
      : { label: 'f32-weights-bf16-runtime', runtimeBits: 16, weightBits: 32 },
    runtime: {
      name: 'parakeet-mlx',
      backend: 'MLX',
      precision: int8 ? 'int8-g64' : 'bf16',
    },
    versionProbes: {
      executable: { command: python, args: ['--version'] },
      packages: [packageProbe('parakeet-mlx'), packageProbe('mlx')],
    },
  });
}

module.exports = { resolveMlxDefinition };
