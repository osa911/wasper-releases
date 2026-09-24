'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runCli } = require('../src/cli.cjs');
const { collectModelIdentity } = require('../src/runtime/model-identity.cjs');
const { resolveWasperMetalDefinition } = require('../src/runtime/adapters/wasper-metal.cjs');
const { discoverWasperApp } = require('../src/runtime/wasper-app.cjs');

const EXPECTED_SHA256 = 'a'.repeat(64);
const OTHER_SHA256 = 'b'.repeat(64);

function temporaryDirectory(t) {
  const directory = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-wasper-app-'))
  );
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  return directory;
}

function createApp(root, name, version, { server = true, sha256 = EXPECTED_SHA256 } = {}) {
  const appPath = path.join(root, name);
  const contentsPath = path.join(appPath, 'Contents');
  const nativeServerPath = path.join(contentsPath, 'Resources/bin/wasper-parakeet-server');
  fs.mkdirSync(path.dirname(nativeServerPath), { recursive: true });
  fs.writeFileSync(path.join(contentsPath, 'Info.plist'), version);
  if (server) fs.writeFileSync(nativeServerPath, `server:${sha256}`);
  return { appPath, nativeServerPath, sha256, version };
}

function runtimeLock(expectedSha256 = EXPECTED_SHA256) {
  return {
    runtimes: [
      {
        id: 'wasper-metal-int8',
        release: {
          version: '1.8.0',
          nativeServerSha256: expectedSha256,
        },
      },
    ],
  };
}

function discoveryDependencies(apps) {
  const byPlist = new Map(
    apps.map(app => [path.join(app.appPath, 'Contents/Info.plist'), app.version])
  );
  const byServer = new Map(apps.map(app => [app.nativeServerPath, app.sha256]));
  return {
    execFileSyncImpl(command, args, options) {
      assert.equal(command, '/usr/bin/plutil');
      assert.deepEqual(args.slice(0, 6), [
        '-extract',
        'CFBundleShortVersionString',
        'raw',
        '-o',
        '-',
        args[5],
      ]);
      assert.equal(options.encoding, 'utf8');
      return `${byPlist.get(args[5])}\n`;
    },
    hashFileImpl(serverPath) {
      return byServer.get(serverPath);
    },
  };
}

test('discovers Wasper.app from the default Applications directory', t => {
  const root = temporaryDirectory(t);
  const applicationsDirectory = path.join(root, 'Applications');
  const app = createApp(applicationsDirectory, 'Wasper.app', '1.8.0');

  const discovered = discoverWasperApp({
    applicationsDirectory,
    runtimeLock: runtimeLock(),
    ...discoveryDependencies([app]),
  });

  assert.deepEqual(discovered, {
    appPath: app.appPath,
    version: '1.8.0',
    nativeServerPath: app.nativeServerPath,
    nativeServerSha256: EXPECTED_SHA256,
    baselineKind: 'published-exact',
  });
});

test('uses an explicit Wasper.app path instead of the default location', t => {
  const root = temporaryDirectory(t);
  const explicit = createApp(root, 'Wasper Preview.app', '1.8.1', {
    sha256: OTHER_SHA256,
  });

  const discovered = discoverWasperApp({
    appPath: explicit.appPath,
    applicationsDirectory: path.join(root, 'unused-applications'),
    runtimeLock: {},
    ...discoveryDependencies([explicit]),
  });

  assert.equal(discovered.appPath, explicit.appPath);
  assert.equal(discovered.version, '1.8.1');
  assert.equal(discovered.nativeServerSha256, OTHER_SHA256);
  assert.equal(discovered.baselineKind, 'newer-release');
});

test('rejects a release older than 1.8.0', t => {
  const root = temporaryDirectory(t);
  const oldApp = createApp(root, 'Wasper.app', '1.7.9');

  assert.throws(
    () =>
      discoverWasperApp({
        appPath: oldApp.appPath,
        runtimeLock: runtimeLock(),
        ...discoveryDependencies([oldApp]),
      }),
    /requires Wasper 1\.8\.0 or later/
  );
});

test('rejects a prerelease that is not the published 1.8.0 release', t => {
  const root = temporaryDirectory(t);
  const prereleaseApp = createApp(root, 'Wasper.app', '1.8.0-beta.1');

  assert.throws(
    () =>
      discoverWasperApp({
        appPath: prereleaseApp.appPath,
        runtimeLock: runtimeLock(),
        ...discoveryDependencies([prereleaseApp]),
      }),
    /invalid release version/
  );
});

test('rejects a release version with a leading-zero component', t => {
  const root = temporaryDirectory(t);
  const invalidApp = createApp(root, 'Wasper.app', '1.8.00');

  assert.throws(
    () =>
      discoverWasperApp({
        appPath: invalidApp.appPath,
        runtimeLock: runtimeLock(),
        ...discoveryDependencies([invalidApp]),
      }),
    /invalid release version/
  );
});

test('labels a later release as a valid newer run', t => {
  const root = temporaryDirectory(t);
  const newerApp = createApp(root, 'Wasper.app', '1.8.1', {
    sha256: OTHER_SHA256,
  });

  assert.equal(
    discoverWasperApp({
      appPath: newerApp.appPath,
      runtimeLock: runtimeLock(),
      ...discoveryDependencies([newerApp]),
    }).baselineKind,
    'newer-release'
  );
});

test('rejects an app without the packaged native server', t => {
  const root = temporaryDirectory(t);
  const app = createApp(root, 'Wasper.app', '1.8.0', { server: false });

  assert.throws(
    () =>
      discoverWasperApp({
        appPath: app.appPath,
        runtimeLock: runtimeLock(),
        ...discoveryDependencies([app]),
      }),
    /packaged native server is missing/
  );
});

test('rejects an unexpected native-server hash for Wasper 1.8.0', t => {
  const root = temporaryDirectory(t);
  const app = createApp(root, 'Wasper.app', '1.8.0', { sha256: OTHER_SHA256 });

  assert.throws(
    () =>
      discoverWasperApp({
        appPath: app.appPath,
        runtimeLock: runtimeLock(),
        ...discoveryDependencies([app]),
      }),
    /does not match the published Wasper 1\.8\.0 runtime/
  );
});

test('requires the runtime lock digest before accepting Wasper 1.8.0', t => {
  const root = temporaryDirectory(t);
  const app = createApp(root, 'Wasper.app', '1.8.0');

  assert.throws(
    () =>
      discoverWasperApp({
        appPath: app.appPath,
        runtimeLock: {},
        ...discoveryDependencies([app]),
      }),
    /runtime lock.*Wasper 1\.8\.0 native-server SHA-256/
  );
});

test('routes the Wasper adapter through the released app and public artifact cache', t => {
  const root = temporaryDirectory(t);
  const layout = {
    packageRoot: path.join(root, 'package'),
    homeDirectory: root,
    holdersRoot: path.join(root, 'holders'),
    artifactsRoot: path.join(root, 'artifacts'),
    wasperApp: path.join(root, 'Applications/Wasper.app'),
  };
  const release = {
    appPath: layout.wasperApp,
    version: '1.8.1',
    nativeServerPath: path.join(layout.wasperApp, 'Contents/Resources/bin/wasper-parakeet-server'),
    nativeServerSha256: OTHER_SHA256,
    baselineKind: 'newer-release',
  };

  const definition = resolveWasperMetalDefinition({
    layout,
    discoverWasperAppImpl: () => release,
  });

  const modelPath = path.join(layout.artifactsRoot, 'wasper-metal-int8');
  assert.equal(definition.command, release.nativeServerPath);
  assert.equal(definition.modelPath, modelPath);
  assert.deepEqual(definition.modelArtifacts, [modelPath]);
  assert.deepEqual(definition.args, [
    '--port',
    '19381',
    '--model-dir',
    modelPath,
    '--encoder-backend',
    'metal',
  ]);
  assert.deepEqual(definition.transport.formFields, {
    language: 'auto',
    language_detection: 'skip',
  });
  assert.deepEqual(definition.release, release);
  assert.deepEqual(definition.runtime.release, {
    version: '1.8.1',
    nativeServerSha256: OTHER_SHA256,
    baselineKind: 'newer-release',
  });
});

test('routes --wasper-app from the smoke command into the resolved layout', async t => {
  const homeDirectory = temporaryDirectory(t);
  fs.mkdirSync(path.join(homeDirectory, 'Library/Caches/Wasper/benchmarks'), {
    recursive: true,
  });
  const app = createApp(path.join(homeDirectory, 'Applications'), 'Wasper.app', '1.8.1');
  let receivedLayout = null;

  await runCli(
    [
      'smoke',
      '--output-dir',
      'runs',
      '--wasper-app',
      app.appPath,
    ],
    {
      homeDirectory,
      repositoryRoot: path.resolve(__dirname, '..'),
      stdout: { write() {} },
      async recoverCorpusImpl() {
        return { manifest: { schema: 'wasper.public-run-corpus.v1', fixtures: [] } };
      },
      async smokeRuntimeAdaptersImpl({ layout }) {
        receivedLayout = layout;
        return { evidencePath: 'smoke.json', cells: [] };
      },
    }
  );

  assert.equal(receivedLayout.wasperApp, app.appPath);
});

test('preserves the Wasper release classification in model identity', t => {
  const root = temporaryDirectory(t);
  const modelPath = path.join(root, 'model.bin');
  fs.writeFileSync(modelPath, 'model');

  const identity = collectModelIdentity({
    artifacts: [modelPath],
    executable: {
      path: '/Applications/Wasper.app/Contents/Resources/bin/wasper-parakeet-server',
      version: '1.8.0',
      versionEvidence: { command: ['/usr/bin/plutil'], rawOutput: '1.8.0\n' },
    },
    launchCommand: ['wasper-parakeet-server', '--model-dir', modelPath],
    release: {
      appPath: '/Applications/Wasper.app',
      version: '1.8.0',
      nativeServerPath: '/Applications/Wasper.app/Contents/Resources/bin/wasper-parakeet-server',
      nativeServerSha256: EXPECTED_SHA256,
      baselineKind: 'published-exact',
    },
  });

  assert.deepEqual(identity.release, {
    version: '1.8.0',
    nativeServerSha256: EXPECTED_SHA256,
    baselineKind: 'published-exact',
  });
});
