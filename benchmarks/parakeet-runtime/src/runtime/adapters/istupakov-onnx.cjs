'use strict';

const path = require('node:path');

const { frozenDefinition, roots } = require('./definition.cjs');

function resolveIstupakovOnnxDefinition(options) {
  const { repositoryRoot, holderRoot } = roots(options);
  const modelPath = path.join(holderRoot, 'istupakov-parakeet-tdt-0.6b-v3-onnx');
  const python = path.join(holderRoot, 'istupakov-venv/bin/python');
  const packageProbe = packageName => ({
    name: packageName,
    command: python,
    args: [
      '-c',
      `import importlib.metadata; print(importlib.metadata.version(${JSON.stringify(packageName)}))`,
    ],
  });
  return frozenDefinition({
    id: 'istupakov-onnx-int8',
    command: python,
    args: [
      path.join(repositoryRoot, 'src/runtime/bridges/istupakov_server.py'),
      '--model',
      modelPath,
    ],
    env: { PYTHONUNBUFFERED: '1' },
    transport: { kind: 'jsonl' },
    modelPath,
    modelArtifacts: [
      path.join(modelPath, 'config.json'),
      path.join(modelPath, 'decoder_joint-model.int8.onnx'),
      path.join(modelPath, 'encoder-model.int8.onnx'),
      path.join(modelPath, 'nemo128.onnx'),
      path.join(modelPath, 'vocab.txt'),
    ],
    modelIdentity: 'istupakov/parakeet-tdt-0.6b-v3-onnx-int8',
    quantization: { label: 'int8', bits: 8 },
    runtime: { name: 'Istupakov onnx-asr', backend: 'ONNX Runtime CPU' },
    versionProbes: {
      executable: { command: python, args: ['--version'] },
      packages: [packageProbe('onnx-asr'), packageProbe('onnxruntime')],
    },
  });
}

module.exports = { resolveIstupakovOnnxDefinition };
