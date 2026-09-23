'use strict';

const path = require('node:path');

const { frozenDefinition, roots } = require('./definition.cjs');

function resolveWasperMetalDefinition(options) {
  const { repositoryRoot, homeDirectory } = roots(options);
  const packagedRepositoryRoot = options?.packagedRepositoryRoot ?? repositoryRoot;
  const applicationRoot = path.join(packagedRepositoryRoot, 'dist/mac-arm64/Wasper.app');
  const modelPath = path.join(
    homeDirectory,
    'Library/Application Support/wasper/models/parakeet-gpu'
  );
  return frozenDefinition({
    id: 'wasper-metal-int8',
    command: path.join(
      packagedRepositoryRoot,
      'dist/mac-arm64/Wasper.app/Contents/Resources/bin/wasper-parakeet-server'
    ),
    args: ['--port', '19381', '--model-dir', modelPath, '--encoder-backend', 'metal'],
    env: { WASPER_PARAKEET_INT8: '1', WASPER_PARAKEET_FP16: '0' },
    transport: {
      kind: 'http',
      port: 19381,
      healthPath: '/health',
      transcribePath: '/transcribe',
      fileField: 'audio',
      formFields: { language: 'auto', language_detection: 'skip' },
    },
    modelPath,
    modelArtifacts: [modelPath],
    modelIdentity: 'wasper-parakeet-metal-int8',
    quantization: { label: 'int8', bits: 8 },
    runtime: { name: 'Wasper wasper-parakeet-server', backend: 'Metal encoder + ONNX Runtime' },
    versionProbes: {
      executable: {
        command: '/usr/bin/plutil',
        args: [
          '-extract',
          'CFBundleShortVersionString',
          'raw',
          '-o',
          '-',
          path.join(applicationRoot, 'Contents/Info.plist'),
        ],
      },
      packages: [],
    },
  });
}

module.exports = { resolveWasperMetalDefinition };
