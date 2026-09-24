'use strict';

const path = require('node:path');

const { resolveLayout } = require('../../config.cjs');
const { discoverWasperApp } = require('../wasper-app.cjs');
const { frozenDefinition } = require('./definition.cjs');

function resolveWasperMetalDefinition(options = {}) {
  const layout = options.layout ?? resolveLayout(options);
  const discoverWasperAppImpl = options.discoverWasperAppImpl ?? discoverWasperApp;
  const release = discoverWasperAppImpl({
    ...(layout.wasperAppPath == null && layout.wasperApp == null
      ? {}
      : { appPath: layout.wasperAppPath ?? layout.wasperApp }),
    ...(options.runtimeLock === undefined ? {} : { runtimeLock: options.runtimeLock }),
    ...(options.runtimeLockPath === undefined ? {} : { runtimeLockPath: options.runtimeLockPath }),
    ...(options.discoveryOptions ?? {}),
  });
  const frozenRelease = Object.freeze({ ...release });
  const modelPath = path.join(layout.artifactsRoot, 'wasper-metal-int8');
  return frozenDefinition({
    id: 'wasper-metal-int8',
    command: release.nativeServerPath,
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
    release: frozenRelease,
    runtime: {
      name: 'Wasper wasper-parakeet-server',
      backend: 'Metal encoder + ONNX Runtime',
      release: {
        version: release.version,
        nativeServerSha256: release.nativeServerSha256,
        baselineKind: release.baselineKind,
      },
    },
    versionProbes: {
      executable: {
        command: '/usr/bin/plutil',
        args: [
          '-extract',
          'CFBundleShortVersionString',
          'raw',
          '-o',
          '-',
          path.join(release.appPath, 'Contents/Info.plist'),
        ],
        expected: release.version,
      },
      packages: [],
    },
  });
}

module.exports = { resolveWasperMetalDefinition };
