'use strict';

const path = require('node:path');
const { resolveLayout } = require('../../config.cjs');
const { discoverWasperApp } = require('../wasper-app.cjs');
const { loadRuntimeLock } = require('../locks.cjs');
const { frozenDefinition, resolveLockedDefinition } = require('./definition.cjs');

function resolveWasperMetalDefinition(options = {}) {
  const layout = options.layout ?? resolveLayout(options);
  const lock = options.lock ?? options.runtimeLock ?? loadRuntimeLock(options.runtimeLockPath);
  const release = (options.discoverWasperAppImpl ?? discoverWasperApp)({
    ...(layout.wasperAppPath == null && layout.wasperApp == null
      ? {}
      : { appPath: layout.wasperAppPath ?? layout.wasperApp }),
    runtimeLock: lock,
    ...(options.discoveryOptions ?? {}),
  });
  const definition = resolveLockedDefinition('wasper-metal-int8', {
    ...options,
    layout,
    lock,
    wasperRelease: release,
  });
  return frozenDefinition({
    ...definition,
    release: Object.freeze({ ...release }),
    runtime: {
      ...definition.runtime,
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
