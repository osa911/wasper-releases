'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveLayout, writeOwnershipMarker } = require('../src/config.cjs');
const { parseCommandArguments } = require('../src/cli.cjs');
const { roots } = require('../src/runtime/adapters/definition.cjs');

const OWNER_FILE = '.wasper-parakeet-runtime-benchmark-owner.json';
const OWNER_SCHEMA = 'wasper.parakeet-runtime-benchmark.owner.v1';
const packageRoot = path.resolve(__dirname, '..');

function temporaryHome(t) {
  const homeDirectory = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-layout-'))
  );
  t.after(() => fs.rmSync(homeDirectory, { force: true, recursive: true }));
  fs.mkdirSync(path.join(homeDirectory, 'Library/Caches/Wasper/benchmarks'), {
    recursive: true,
  });
  return homeDirectory;
}

test('resolveLayout uses the benchmark cache namespace by default', t => {
  const homeDirectory = temporaryHome(t);

  const layout = resolveLayout({ homeDirectory });

  const cacheRoot = path.join(
    homeDirectory,
    'Library/Caches/Wasper/benchmarks/parakeet-runtime-v1'
  );
  assert.equal(layout.packageRoot, packageRoot);
  assert.equal(layout.cacheRoot, cacheRoot);
  assert.equal(layout.artifactsRoot, path.join(cacheRoot, 'artifacts'));
  assert.equal(layout.corpusRoot, path.join(cacheRoot, 'corpus'));
  assert.equal(layout.holdersRoot, path.join(cacheRoot, 'holders'));
  assert.equal(layout.outputRoot, path.join(cacheRoot, 'runs'));
});

test('resolveLayout canonicalizes explicit cache and Wasper app paths', t => {
  const homeDirectory = temporaryHome(t);
  const actualCache = path.join(homeDirectory, 'Library/Caches/Wasper/benchmarks/canonical-cache');
  const cacheLink = path.join(homeDirectory, 'Library/Caches/Wasper/benchmarks/cache-link');
  const actualApp = path.join(homeDirectory, 'Applications/Wasper.app');
  const appLink = path.join(homeDirectory, 'Applications/Wasper-link.app');
  fs.mkdirSync(actualCache);
  fs.mkdirSync(actualApp, { recursive: true });
  fs.symlinkSync(actualCache, cacheLink);
  fs.symlinkSync(actualApp, appLink);

  const layout = resolveLayout({
    cacheDir: cacheLink,
    homeDirectory,
    wasperApp: appLink,
  });

  assert.equal(layout.cacheRoot, fs.realpathSync.native(actualCache));
  assert.equal(layout.wasperApp, fs.realpathSync.native(actualApp));
});

test('resolveLayout accepts only the marker-owned runs output directory', t => {
  const homeDirectory = temporaryHome(t);
  const cacheRoot = path.join(
    homeDirectory,
    'Library/Caches/Wasper/benchmarks/parakeet-runtime-v1'
  );
  fs.mkdirSync(path.join(cacheRoot, 'runs'), { recursive: true });

  const layout = resolveLayout({
    cacheDir: cacheRoot,
    homeDirectory,
    outputDir: 'runs',
  });

  assert.equal(layout.outputRoot, path.join(cacheRoot, 'runs'));
});

test('resolveLayout rejects a custom output directory that clean would not own', t => {
  const homeDirectory = temporaryHome(t);
  const cacheRoot = path.join(
    homeDirectory,
    'Library/Caches/Wasper/benchmarks/parakeet-runtime-v1'
  );

  assert.throws(
    () => resolveLayout({ cacheDir: cacheRoot, homeDirectory, outputDir: 'runs/comparison-a' }),
    /marker-owned runs/
  );
});

test('resolveLayout rejects a cache root outside the benchmark namespace', t => {
  const homeDirectory = temporaryHome(t);

  assert.throws(() => resolveLayout({ cacheDir: '/', homeDirectory }), /benchmark cache/);
  assert.throws(() => resolveLayout({ cacheDir: homeDirectory, homeDirectory }), /benchmark cache/);
  assert.throws(() => resolveLayout({ cacheDir: packageRoot, homeDirectory }), /repository root/);
});

test('resolveLayout rejects output outside the selected cache', t => {
  const homeDirectory = temporaryHome(t);
  const cacheRoot = path.join(
    homeDirectory,
    'Library/Caches/Wasper/benchmarks/parakeet-runtime-v1'
  );
  const externalOutput = path.join(homeDirectory, 'external-output');
  fs.mkdirSync(cacheRoot);
  fs.mkdirSync(externalOutput);

  assert.throws(
    () =>
      resolveLayout({
        cacheDir: cacheRoot,
        homeDirectory,
        outputDir: externalOutput,
      }),
    /marker-owned runs/
  );
});

test('resolveLayout rejects a cache root that is a Git repository or worktree', t => {
  const homeDirectory = temporaryHome(t);
  const namespaceRoot = path.join(homeDirectory, 'Library/Caches/Wasper/benchmarks');

  for (const [name, createGitEntry] of [
    ['repository', gitPath => fs.mkdirSync(gitPath)],
    ['worktree', gitPath => fs.writeFileSync(gitPath, 'gitdir: /tmp/example\n')],
  ]) {
    const cacheRoot = path.join(namespaceRoot, name);
    fs.mkdirSync(cacheRoot);
    createGitEntry(path.join(cacheRoot, '.git'));

    assert.throws(
      () => resolveLayout({ cacheDir: cacheRoot, homeDirectory }),
      /Git repository or worktree/
    );
    assert.equal(fs.existsSync(path.join(cacheRoot, OWNER_FILE)), false);
  }
});

test('writeOwnershipMarker creates the exact owner document', t => {
  const homeDirectory = temporaryHome(t);
  const layout = resolveLayout({ homeDirectory });

  const markerPath = writeOwnershipMarker(layout);

  assert.equal(markerPath, path.join(layout.cacheRoot, OWNER_FILE));
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath, 'utf8')), {
    schema: OWNER_SCHEMA,
    package: 'parakeet-runtime',
    cacheRoot: layout.cacheRoot,
  });
});

test('writeOwnershipMarker refuses a symlink marker without changing its target', t => {
  const homeDirectory = temporaryHome(t);
  const layout = resolveLayout({ homeDirectory });
  fs.mkdirSync(layout.cacheRoot);
  const externalMarker = path.join(homeDirectory, 'external-marker.json');
  fs.writeFileSync(externalMarker, 'preserve');
  fs.symlinkSync(externalMarker, path.join(layout.cacheRoot, OWNER_FILE));

  assert.throws(() => writeOwnershipMarker(layout), /regular file/);
  assert.equal(fs.readFileSync(externalMarker, 'utf8'), 'preserve');
});

test('writeOwnershipMarker rejects a forged layout outside the benchmark namespace', t => {
  const homeDirectory = temporaryHome(t);
  const externalCache = path.join(homeDirectory, 'external-cache');
  const markerPath = path.join(externalCache, OWNER_FILE);

  assert.throws(
    () =>
      writeOwnershipMarker({
        cacheRoot: externalCache,
        homeDirectory,
        outputRoot: path.join(externalCache, 'runs'),
        wasperApp: null,
      }),
    /benchmark cache/
  );
  assert.equal(fs.existsSync(markerPath), false);
});

test('runtime adapter roots use the layout holders root', t => {
  const homeDirectory = temporaryHome(t);
  const layout = resolveLayout({ homeDirectory });

  const resolved = roots({ layout });

  assert.equal(resolved.holderRoot, layout.holdersRoot);
  assert.equal(resolved.repositoryRoot, layout.packageRoot);
  assert.equal(resolved.homeDirectory, homeDirectory);
});

test('clean layout flags require a separate value', () => {
  assert.throws(
    () => parseCommandArguments(['clean', '--cache-dir']),
    /--cache-dir requires a value/
  );
  assert.throws(
    () => parseCommandArguments(['clean', '--cache-dir', '--output-dir', 'runs']),
    /--cache-dir requires a value/
  );
});
