'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { resolveLayout } = require('../src/config.cjs');
const { loadRuntimeLock } = require('../src/runtime/locks.cjs');
const { bootstrapRuntime } = require('../src/runtime/bootstrap.cjs');
const { execFileSync } = require('node:child_process');
const { runtimeFixture } = require('./runtime-fixture.cjs');
const { writeOwnershipMarker } = require('../src/config.cjs');

test('blocks Local MLX INT8 and Fluid before creating a cache or fetching inputs', async t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-bootstrap-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const layout = resolveLayout({ homeDirectory: home });
  for (const id of ['mlx-int8-local', 'fluid-coreml-mixed']) {
    await assert.rejects(
      bootstrapRuntime(id, { layout, lock: loadRuntimeLock() }),
      /blocked.*(conversion|license)/i
    );
    assert.equal(fs.existsSync(layout.cacheRoot), false);
  }
});

test('clones the pinned Git source, verifies HTTP bytes and builds only inside owned roots', async t => {
  const fixture = await runtimeFixture(t);
  const { layout, authority: lock, dependencies } = fixture;
  const result = await bootstrapRuntime('handy-gguf-q8', { layout, lock }, dependencies);
  assert.equal(result.holderRoot, path.join(layout.holdersRoot, 'handy-gguf-q8'));
  assert.equal(result.artifactRoot, path.join(layout.artifactsRoot, 'handy-gguf-q8'));
  assert.equal(execFileSync(result.outputs[0], { encoding: 'utf8' }).trim(), 'fixture-built');
  assert.equal(fs.readFileSync(result.artifacts[0], 'utf8'), 'synthetic model fixture\n');
  const again = await bootstrapRuntime('handy-gguf-q8', { layout, lock }, dependencies);
  assert.equal(again.lockSha256, result.lockSha256);
  assert.equal(fixture.state.requests, 1);
  fs.writeFileSync(result.artifacts[0], 'tampered');
  await assert.rejects(
    bootstrapRuntime('handy-gguf-q8', { layout, lock }, dependencies),
    /SHA-256|size mismatch/
  );
});

test('rejects HTTP hash mismatches without promoting an artifact or building', async t => {
  const fixture = await runtimeFixture(t);
  fixture.state.body = Buffer.alloc(fixture.state.body.length, 120);
  await assert.rejects(
    bootstrapRuntime(
      'handy-gguf-q8',
      { layout: fixture.layout, lock: fixture.authority },
      fixture.dependencies
    ),
    /handy-gguf-q8.*SHA-256/
  );
  assert.equal(
    fs.existsSync(path.join(fixture.layout.artifactsRoot, 'handy-gguf-q8/model.bin')),
    false
  );
  assert.equal(
    fs.existsSync(path.join(fixture.layout.holdersRoot, 'handy-gguf-q8/build-shared/probe')),
    false
  );
});

test('refuses an unmarked nonempty cache before HTTP', async t => {
  const fixture = await runtimeFixture(t);
  fs.mkdirSync(fixture.layout.cacheRoot, { recursive: true });
  fs.writeFileSync(path.join(fixture.layout.cacheRoot, 'sentinel'), 'keep');
  await assert.rejects(
    bootstrapRuntime(
      'handy-gguf-q8',
      { layout: fixture.layout, lock: fixture.authority },
      fixture.dependencies
    ),
    /unmarked/
  );
  assert.equal(fixture.state.requests, 0);
});

test('refuses symlinked artifact roots and preserves their external targets', async t => {
  const fixture = await runtimeFixture(t);
  writeOwnershipMarker(fixture.layout);
  const outside = path.join(fixture.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'keep');
  fs.symlinkSync(outside, fixture.layout.artifactsRoot);
  await assert.rejects(
    bootstrapRuntime(
      'handy-gguf-q8',
      { layout: fixture.layout, lock: fixture.authority },
      fixture.dependencies
    ),
    /symlink/
  );
  assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
  assert.equal(fixture.state.requests, 0);
});

test('detects artifact directory replacement during HTTP without writing outside', async t => {
  const fixture = await runtimeFixture(t);
  const outside = path.join(fixture.root, 'outside');
  fs.mkdirSync(outside);
  fixture.state.onRequest = () => {
    fs.renameSync(fixture.layout.artifactsRoot, `${fixture.layout.artifactsRoot}-displaced`);
    fs.symlinkSync(outside, fixture.layout.artifactsRoot);
  };
  await assert.rejects(
    bootstrapRuntime(
      'handy-gguf-q8',
      { layout: fixture.layout, lock: fixture.authority },
      fixture.dependencies
    ),
    /changed|symlink/
  );
  assert.equal(fixture.state.requests, 1);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('dirty source and changed build output cannot be reused for timing', async t => {
  const fixture = await runtimeFixture(t);
  const options = { layout: fixture.layout, lock: fixture.authority };
  const ready = await bootstrapRuntime('handy-gguf-q8', options, fixture.dependencies);
  const { verifyRuntimeInstallation } = require('../src/runtime/bootstrap.cjs');
  fs.appendFileSync(ready.outputs[0], 'tampered');
  assert.throws(
    () => verifyRuntimeInstallation('handy-gguf-q8', options, fixture.dependencies),
    /output SHA-256/
  );
  fs.appendFileSync(path.join(ready.holderRoot, 'main.c'), '\n// changed\n');
  await assert.rejects(
    bootstrapRuntime('handy-gguf-q8', options, fixture.dependencies),
    /dirty/
  );
});

test('names missing prerequisites and does not download or run an installer', async t => {
  const fixture = await runtimeFixture(t);
  await assert.rejects(
    bootstrapRuntime(
      'handy-gguf-q8',
      { layout: fixture.layout, lock: fixture.authority },
      { ...fixture.dependencies, tools: { cmake: path.join(fixture.root, 'missing-cmake') } }
    ),
    /Handy Q8 requires CMake and Xcode Command Line Tools\.\nInstall the documented prerequisite, then run npm run benchmark -- full --accept-source-terms again\./
  );
  assert.equal(fixture.state.requests, 0);
});

test(
  'detects missing Xcode tools before any model request',
  { skip: process.platform !== 'darwin' },
  async t => {
    const fixture = await runtimeFixture(t);
    await assert.rejects(
      bootstrapRuntime(
        'handy-gguf-q8',
        { layout: fixture.layout, lock: fixture.authority },
        {
          ...fixture.dependencies,
          tools: { xcodeSelect: path.join(fixture.root, 'missing-xcode-select') },
        }
      ),
      /requires CMake and Xcode Command Line Tools/
    );
    assert.equal(fixture.state.requests, 0);
  }
);

test('rejects extra model files and source drift in the pre-timing gate', async t => {
  const fixture = await runtimeFixture(t);
  const options = { layout: fixture.layout, lock: fixture.authority };
  const ready = await bootstrapRuntime('handy-gguf-q8', options, fixture.dependencies);
  fs.writeFileSync(path.join(ready.artifactRoot, 'config.json'), '{}');
  const { verifyRuntimeInstallation } = require('../src/runtime/bootstrap.cjs');
  assert.throws(
    () => verifyRuntimeInstallation('handy-gguf-q8', options, fixture.dependencies),
    /unlocked artifact/
  );
});

test('adapter activation rejects corrupted models before probing or timing any runtime', async t => {
  const fixture = await runtimeFixture(t);
  const options = { layout: fixture.layout, lock: fixture.authority };
  const ready = await bootstrapRuntime('handy-gguf-q8', options, fixture.dependencies);
  fs.writeFileSync(ready.artifacts[0], 'corrupt');
  const { createRuntimeAdapter } = require('../src/runtime/adapters/index.cjs');
  assert.throws(
    () =>
      createRuntimeAdapter('handy-gguf-q8', { ...options, lockAuthority: fixture.authority }),
    /artifact SHA-256/
  );
});

test('builds a pinned Swift dependency and bridge inside the owned holder', async t => {
  const fixture = await runtimeFixture(t);
  const crypto = require('node:crypto');
  fs.writeFileSync(
    path.join(fixture.source, 'Package.swift'),
    '// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "Fixture", products: [.library(name: "Fixture", targets: ["Fixture"])], targets: [.target(name: "Fixture")])\n'
  );
  fs.mkdirSync(path.join(fixture.source, 'Sources/Fixture'), { recursive: true });
  fs.writeFileSync(
    path.join(fixture.source, 'Sources/Fixture/message.swift'),
    'public let message = "swift-fixture-built"\n'
  );
  execFileSync('git', ['-C', fixture.source, 'add', '.']);
  execFileSync('git', [
    '-C',
    fixture.source,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'swift',
  ]);
  const revision = execFileSync('git', ['-C', fixture.source, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const bridge = path.join(fixture.root, 'bridge');
  fs.mkdirSync(path.join(bridge, 'Sources/probe'), { recursive: true });
  fs.writeFileSync(
    path.join(bridge, 'Package.swift'),
    `// swift-tools-version: 6.0\nimport PackageDescription\nlet package = Package(name: "probe", dependencies: [.package(url: "https://github.com/fixture/runtime.git", revision: "${revision}")], targets: [.executableTarget(name: "probe", dependencies: [.product(name: "Fixture", package: "runtime")])])\n`
  );
  fs.writeFileSync(
    path.join(bridge, 'Sources/probe/main.swift'),
    'import Fixture\nprint(message)\n'
  );
  fs.writeFileSync(
    path.join(bridge, 'Package.resolved'),
    JSON.stringify({
      version: 2,
      pins: [
        {
          identity: 'runtime',
          kind: 'remoteSourceControl',
          location: 'https://github.com/fixture/runtime.git',
          state: { revision },
        },
      ],
    })
  );
  fixture.runtime.source.revision = revision;
  fixture.runtime.build = {
    kind: 'swift',
    directory: 'bridge',
    outputs: ['bridge/.build/release/probe'],
    bridgeFiles: ['Package.swift', 'Package.resolved', 'Sources/probe/main.swift'].map(
      file => ({
        path: file,
        sha256: crypto
          .createHash('sha256')
          .update(fs.readFileSync(path.join(bridge, file)))
          .digest('hex'),
      })
    ),
  };
  const ready = await bootstrapRuntime(
    'handy-gguf-q8',
    { layout: fixture.layout, lock: fixture.authority },
    { ...fixture.dependencies, bridgeRoot: bridge }
  );
  assert.equal(
    execFileSync(ready.outputs[0], { encoding: 'utf8' }).trim(),
    'swift-fixture-built'
  );
  assert.equal(fs.existsSync(path.join(bridge, '.build')), false);
  const { verifyRuntimeInstallation } = require('../src/runtime/bootstrap.cjs');
  verifyRuntimeInstallation(
    'handy-gguf-q8',
    { layout: fixture.layout, lock: fixture.authority },
    fixture.dependencies
  );
  fs.appendFileSync(
    path.join(ready.holderRoot, 'bridge/Sources/probe/main.swift'),
    '\nprint("changed")\n'
  );
  assert.throws(
    () =>
      verifyRuntimeInstallation(
        'handy-gguf-q8',
        { layout: fixture.layout, lock: fixture.authority },
        fixture.dependencies
      ),
    /bridge source SHA-256/
  );
});

test('pre-timing verification rejects new importable files in a pinned source checkout', async t => {
  const fixture = await runtimeFixture(t);
  const options = { layout: fixture.layout, lock: fixture.authority };
  const ready = await bootstrapRuntime('handy-gguf-q8', options, fixture.dependencies);
  fs.writeFileSync(path.join(ready.holderRoot, 'new-module.py'), 'print("injected")');
  const { verifyRuntimeInstallation } = require('../src/runtime/bootstrap.cjs');
  assert.throws(
    () => verifyRuntimeInstallation('handy-gguf-q8', options, fixture.dependencies),
    /unexpected untracked/
  );
});

test('bootstrap records and rechecks dependent runtime libraries, not only the executable', async t => {
  const fixture = await runtimeFixture(t);
  fs.appendFileSync(
    path.join(fixture.source, 'CMakeLists.txt'),
    'file(WRITE "${CMAKE_BINARY_DIR}/runtime-helper.dylib" "synthetic companion library")\n'
  );
  execFileSync('git', ['-C', fixture.source, 'add', '.']);
  execFileSync('git', [
    '-C',
    fixture.source,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'library',
  ]);
  fixture.runtime.source.revision = execFileSync(
    'git',
    ['-C', fixture.source, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' }
  ).trim();
  const options = { layout: fixture.layout, lock: fixture.authority };
  const ready = await bootstrapRuntime('handy-gguf-q8', options, fixture.dependencies);
  fs.writeFileSync(path.join(ready.holderRoot, 'build-shared/runtime-helper.dylib'), 'changed');
  const { verifyRuntimeInstallation } = require('../src/runtime/bootstrap.cjs');
  assert.throws(
    () => verifyRuntimeInstallation('handy-gguf-q8', options, fixture.dependencies),
    /build inventory/
  );
});

test('bootstrap cannot report readiness with an extra model file in the cache', async t => {
  const fixture = await runtimeFixture(t);
  writeOwnershipMarker(fixture.layout);
  const artifactRoot = path.join(fixture.layout.artifactsRoot, 'handy-gguf-q8');
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.writeFileSync(path.join(artifactRoot, 'config.json'), '{}');
  await assert.rejects(
    bootstrapRuntime(
      'handy-gguf-q8',
      { layout: fixture.layout, lock: fixture.authority },
      fixture.dependencies
    ),
    /unlocked artifact/
  );
});

test('bootstrap refuses an existing build directory without its verified receipt', async t => {
  const fixture = await runtimeFixture(t);
  writeOwnershipMarker(fixture.layout);
  const holder = path.join(fixture.layout.holdersRoot, 'handy-gguf-q8');
  fs.mkdirSync(path.dirname(holder), { recursive: true });
  execFileSync('git', ['clone', '--quiet', fixture.source, holder]);
  fs.mkdirSync(path.join(holder, 'build-shared'));
  fs.writeFileSync(path.join(holder, 'build-shared/untrusted-input'), 'keep');
  await assert.rejects(
    bootstrapRuntime(
      'handy-gguf-q8',
      { layout: fixture.layout, lock: fixture.authority },
      fixture.dependencies
    ),
    /nonempty build.*receipt/
  );
  assert.equal(
    fs.readFileSync(path.join(holder, 'build-shared/untrusted-input'), 'utf8'),
    'keep'
  );
});

test('clones pinned submodules independently and rejects later submodule edits', async t => {
  const fixture = await runtimeFixture(t);
  const child = path.join(fixture.root, 'child');
  execFileSync('git', ['clone', '--quiet', fixture.source, child]);
  const childRevision = execFileSync('git', ['-C', child, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  execFileSync('git', [
    '-C',
    fixture.source,
    '-c',
    'protocol.file.allow=always',
    'submodule',
    'add',
    '--quiet',
    child,
    'child',
  ]);
  execFileSync('git', [
    '-C',
    fixture.source,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qam',
    'submodule',
  ]);
  fixture.runtime.source.revision = execFileSync(
    'git',
    ['-C', fixture.source, 'rev-parse', 'HEAD'],
    { encoding: 'utf8' }
  ).trim();
  fixture.runtime.source.submodules = [
    { path: 'child', url: 'https://github.com/fixture/child.git', revision: childRevision },
  ];
  fixture.dependencies.sourceTransport = url =>
    url.endsWith('/child.git') ? child : fixture.source;
  const options = { layout: fixture.layout, lock: fixture.authority };
  const ready = await bootstrapRuntime('handy-gguf-q8', options, fixture.dependencies);
  assert.equal(
    fs
      .readFileSync(path.join(ready.holderRoot, 'child/main.c'), 'utf8')
      .includes('fixture-built'),
    true
  );
  fs.appendFileSync(path.join(ready.holderRoot, 'child/main.c'), '\n// changed\n');
  const { verifyRuntimeInstallation } = require('../src/runtime/bootstrap.cjs');
  assert.throws(
    () => verifyRuntimeInstallation('handy-gguf-q8', options, fixture.dependencies),
    /dirty/
  );
});
