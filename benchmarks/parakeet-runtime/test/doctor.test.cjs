'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveLayout } = require('../src/config.cjs');
const { runCli } = require('../src/cli.cjs');
const { RUNTIME_DESCRIPTORS } = require('../src/runtime/constants.cjs');
const { doctor, formatDoctor } = require('../src/doctor.cjs');

const GIB = 1024 ** 3;

function temporaryLayout(t) {
  const homeDirectory = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-doctor-'))
  );
  t.after(() => fs.rmSync(homeDirectory, { force: true, recursive: true }));
  return resolveLayout({ homeDirectory });
}

function runtimeLock({ blocked = [] } = {}) {
  return {
    runtimes: RUNTIME_DESCRIPTORS.map(runtime => ({
      id: runtime.id,
      label: runtime.label,
      reproduction: {
        state: blocked.includes(runtime.id) ? 'blocked' : 'ready',
        limitations: blocked.includes(runtime.id) ? ['public reproduction is blocked'] : [],
      },
    })),
  };
}

function readyDependencies(overrides = {}) {
  return {
    systemInfo() {
      return {
        platform: 'darwin',
        arch: 'arm64',
        release: '24.6.0',
        cpuBrand: 'Apple M1 Pro',
        nodeVersion: 'v22.13.1',
      };
    },
    freeDiskBytes() {
      return 80 * GIB;
    },
    findTool(name) {
      return `/usr/bin/${name}`;
    },
    auditPythonExecutable() {
      return '/usr/bin/python3';
    },
    probeAuditPython() {
      return true;
    },
    networkAccess() {
      return true;
    },
    discoverWasperApp() {
      return {
        appPath: '/Applications/Wasper.app',
        version: '1.8.0',
        nativeServerPath: '/Applications/Wasper.app/Contents/Resources/bin/wasper-parakeet-server',
        nativeServerSha256: 'a'.repeat(64),
        baselineKind: 'published-exact',
      };
    },
    sourceManifests: [
      { fixtures: [{ cohort: 'short', acquisition: { state: 'automatic' } }] },
      { fixtures: [{ cohort: 'long', acquisition: { state: 'automatic' } }] },
    ],
    ...overrides,
  };
}

function check(result, id) {
  const value = result.checks.find(candidate => candidate.id === id);
  assert.ok(value, `missing ${id} check`);
  return value;
}

test('reports a supported M-series Mac without creating the cache or output directory', t => {
  const layout = temporaryLayout(t);

  const result = doctor(layout, runtimeLock(), readyDependencies());

  assert.equal(result.ok, true);
  assert.deepEqual(result.system, {
    platform: 'darwin',
    arch: 'arm64',
    release: '24.6.0',
    cpuBrand: 'Apple M1 Pro',
    nodeVersion: 'v22.13.1',
    freeDiskBytes: 80 * GIB,
  });
  assert.equal(check(result, 'apple-silicon').state, 'ready');
  assert.equal(check(result, 'network').state, 'ready');
  assert.match(formatDoctor(result), /Darwin kernel: darwin 24\.6\.0/);
  assert.equal(result.wasper.baselineKind, 'published-exact');
  assert.equal(result.runtimes.length, RUNTIME_DESCRIPTORS.length);
  assert.ok(result.runtimes.every(runtime => runtime.state === 'ready'));
  assert.equal(fs.existsSync(layout.cacheRoot), false);
  assert.equal(fs.existsSync(layout.outputRoot), false);
});

test('rejects an Intel Mac as a full-run prerequisite failure', t => {
  const layout = temporaryLayout(t);

  const result = doctor(
    layout,
    runtimeLock(),
    readyDependencies({
      systemInfo() {
        return {
          platform: 'darwin',
          arch: 'x64',
          release: '24.6.0',
          cpuBrand: 'Intel Core i9',
          nodeVersion: 'v22.13.1',
        };
      },
    })
  );

  assert.equal(result.ok, false);
  assert.equal(check(result, 'apple-silicon').state, 'blocked');
  assert.match(check(result, 'apple-silicon').detail, /Apple Silicon/);
  assert.equal(fs.existsSync(layout.cacheRoot), false);
});

test('rejects a disk shortage without creating benchmark artifacts', t => {
  const layout = temporaryLayout(t);

  const result = doctor(layout, runtimeLock(), readyDependencies({ freeDiskBytes: () => GIB }));

  assert.equal(result.ok, false);
  assert.equal(check(result, 'free-disk').state, 'blocked');
  assert.match(check(result, 'free-disk').detail, /24 GiB/);
  assert.equal(fs.existsSync(layout.cacheRoot), false);
  assert.equal(fs.existsSync(layout.outputRoot), false);
});

test('blocks the public audit when the exact descriptor capability probe fails', t => {
  const layout = temporaryLayout(t);

  const result = doctor(
    layout,
    runtimeLock(),
    readyDependencies({
      auditPythonExecutable() {
        return '/usr/bin/public-audit-python';
      },
      probeAuditPython(executable, arguments_) {
        assert.equal(executable, '/usr/bin/public-audit-python');
        assert.deepEqual(arguments_.slice(0, 3), ['-I', '-S', '-B']);
        return false;
      },
    })
  );

  assert.equal(result.ok, false);
  assert.equal(check(result, 'public-audit-python').state, 'blocked');
  assert.match(check(result, 'public-audit-python').detail, /\/usr\/bin\/public-audit-python/);
  assert.equal(fs.existsSync(layout.cacheRoot), false);
});

test('probes the exact public-audit Python executable instead of PATH python3', t => {
  const layout = temporaryLayout(t);
  const probes = [];

  const result = doctor(
    layout,
    runtimeLock(),
    readyDependencies({
      auditPythonExecutable() {
        return '/opt/public-audit-python';
      },
      probeAuditPython(executable, arguments_) {
        probes.push({ executable, arguments_ });
        return true;
      },
      findTool(name) {
        assert.notEqual(name, 'python3');
        return `/usr/bin/${name}`;
      },
    })
  );

  assert.equal(probes.length, 1);
  assert.equal(probes[0].executable, '/opt/public-audit-python');
  assert.deepEqual(probes[0].arguments_.slice(0, 4), ['-I', '-S', '-B', '-c']);
  assert.match(probes[0].arguments_[4], /os\.scandir/u);
  assert.match(probes[0].arguments_[4], /os\.readlink/u);
  assert.match(probes[0].arguments_[4], /follow_symlinks=False/u);
  assert.equal(check(result, 'public-audit-python').state, 'ready');
  assert.equal(check(result, 'public-audit-python').detail, '/opt/public-audit-python');
  assert.equal(fs.existsSync(layout.cacheRoot), false);
});

test('reports a missing Wasper.app without attempting a download', t => {
  const layout = temporaryLayout(t);

  const result = doctor(
    layout,
    runtimeLock(),
    readyDependencies({
      discoverWasperApp() {
        throw new Error('Wasper.app is missing: /Applications/Wasper.app');
      },
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.wasper.state, 'blocked');
  assert.match(result.wasper.detail, /Wasper\.app is missing/);
  assert.match(
    check(result, 'wasper-app').remediation,
    /https:\/\/github\.com\/osa911\/wasper-releases\/releases/
  );
  assert.equal(fs.existsSync(layout.cacheRoot), false);
});

test('accepts a later Wasper release and preserves its classification', t => {
  const layout = temporaryLayout(t);

  const result = doctor(
    layout,
    runtimeLock(),
    readyDependencies({
      discoverWasperApp() {
        return {
          appPath: '/Applications/Wasper.app',
          version: '1.8.1',
          nativeServerPath: '/Applications/Wasper.app/Contents/Resources/bin/wasper-parakeet-server',
          nativeServerSha256: 'b'.repeat(64),
          baselineKind: 'newer-release',
        };
      },
    })
  );

  assert.equal(result.ok, true);
  assert.equal(result.wasper.state, 'ready');
  assert.equal(result.wasper.baselineKind, 'newer-release');
  assert.equal(fs.existsSync(layout.cacheRoot), false);
});

test('reports locked runtimes and manual long sources as full-run blockers', t => {
  const layout = temporaryLayout(t);

  const result = doctor(
    layout,
    runtimeLock({ blocked: ['mlx-int8-local', 'fluid-coreml-mixed'] }),
    readyDependencies({
      sourceManifests: [
        { fixtures: [{ cohort: 'short', acquisition: { state: 'automatic' } }] },
        {
          fixtures: [
            {
              cohort: 'long',
              acquisition: { state: 'manual-authorized-input-required' },
            },
          ],
        },
      ],
    })
  );

  assert.equal(result.ok, false);
  assert.equal(
    result.runtimes.find(runtime => runtime.id === 'mlx-int8-local').state,
    'blocked'
  );
  assert.equal(
    result.runtimes.find(runtime => runtime.id === 'fluid-coreml-mixed').state,
    'blocked'
  );
  assert.equal(check(result, 'long-corpus').state, 'blocked');
  assert.equal(fs.existsSync(layout.cacheRoot), false);
});

test('routes the doctor command through the public CLI without creating the cache', async t => {
  const layout = temporaryLayout(t);
  const writes = [];

  const result = await runCli(['doctor'], {
    homeDirectory: layout.homeDirectory,
    stdout: { write(value) { writes.push(value); } },
    doctorImpl(receivedLayout, receivedLock) {
      assert.equal(receivedLayout.cacheRoot, layout.cacheRoot);
      assert.deepEqual(receivedLock, runtimeLock());
      return {
        ok: true,
        system: {},
        layout: { cacheRoot: layout.cacheRoot, outputRoot: layout.outputRoot },
        checks: [],
        wasper: { state: 'ready', baselineKind: 'published-exact' },
        runtimes: [],
      };
    },
    loadRuntimeLockImpl: () => runtimeLock(),
  });

  assert.equal(result.command, 'doctor');
  assert.equal(result.writes, false);
  assert.match(writes.join(''), /Doctor/);
  assert.equal(fs.existsSync(layout.cacheRoot), false);
});

test('the doctor command exits nonzero when full-run locks are blocked', t => {
  const homeDirectory = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-doctor-cli-'))
  );
  t.after(() => fs.rmSync(homeDirectory, { force: true, recursive: true }));

  const result = spawnSync(process.execPath, [path.join(__dirname, '../bin/benchmark.cjs'), 'doctor'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: homeDirectory },
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /Full run: blocked/);
  assert.match(result.stderr, /doctor found prerequisites that block a full run/);
  assert.equal(
    fs.existsSync(
      path.join(homeDirectory, 'Library/Caches/Wasper/benchmarks/parakeet-runtime-v1')
    ),
    false
  );
});
