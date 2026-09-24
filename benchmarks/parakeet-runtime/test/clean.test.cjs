'use strict';

const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { promisify } = require('node:util');

const { clean } = require('../src/clean.cjs');
const { resolveLayout, writeOwnershipMarker } = require('../src/config.cjs');
const { runCli } = require('../src/cli.cjs');

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(__dirname, '..');

function ownedLayout(t, name = 'parakeet-runtime-v1') {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-clean-'));
  t.after(() => fs.rmSync(homeDirectory, { force: true, recursive: true }));
  const cacheRoot = path.join(homeDirectory, 'Library/Caches/Wasper/benchmarks', name);
  fs.mkdirSync(cacheRoot, { recursive: true });
  const layout = resolveLayout({ cacheDir: cacheRoot, homeDirectory });
  return { homeDirectory, layout };
}

function writeGeneratedFiles(layout) {
  for (const root of [
    layout.artifactsRoot,
    layout.corpusRoot,
    layout.holdersRoot,
    path.join(layout.cacheRoot, 'runs'),
  ]) {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'generated.txt'), 'generated');
  }
}

test('clean rejects a missing ownership marker and preserves generated data', async t => {
  const { layout } = ownedLayout(t);
  writeGeneratedFiles(layout);

  await assert.rejects(clean(layout), /ownership marker/);

  assert.equal(fs.existsSync(path.join(layout.artifactsRoot, 'generated.txt')), true);
  assert.equal(fs.existsSync(path.join(layout.cacheRoot, 'runs/generated.txt')), true);
});

test('clean rejects a marker whose cache root does not match', async t => {
  const { layout } = ownedLayout(t);
  fs.writeFileSync(
    path.join(layout.cacheRoot, '.wasper-parakeet-runtime-benchmark-owner.json'),
    `${JSON.stringify({
      schema: 'wasper.parakeet-runtime-benchmark.owner.v1',
      package: 'parakeet-runtime',
      cacheRoot: path.join(layout.cacheRoot, 'different'),
    })}\n`
  );
  writeGeneratedFiles(layout);

  await assert.rejects(clean(layout), /ownership marker/);

  assert.equal(fs.existsSync(path.join(layout.corpusRoot, 'generated.txt')), true);
});

test('clean removes only generated roots from a marker-owned cache', async t => {
  const { layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  const retainedFile = path.join(layout.cacheRoot, 'keep.txt');
  fs.writeFileSync(retainedFile, 'keep');

  const removed = await clean(layout);

  assert.deepEqual(removed, [
    layout.artifactsRoot,
    layout.corpusRoot,
    layout.holdersRoot,
    path.join(layout.cacheRoot, 'runs'),
  ]);
  for (const removedPath of removed) assert.equal(fs.existsSync(removedPath), false);
  assert.equal(fs.readFileSync(retainedFile, 'utf8'), 'keep');
  assert.equal(
    fs.existsSync(path.join(layout.cacheRoot, '.wasper-parakeet-runtime-benchmark-owner.json')),
    true
  );
});

test('clean preserves an unrelated explicit output root inside the marker-owned cache', async t => {
  const { homeDirectory, layout: defaultLayout } = ownedLayout(t);
  const outputRoot = path.join(defaultLayout.cacheRoot, 'comparisons', 'candidate-a');
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'result.json'), '{}');
  const layout = resolveLayout({
    cacheDir: defaultLayout.cacheRoot,
    homeDirectory,
    outputDir: 'comparisons/candidate-a',
  });
  writeOwnershipMarker(layout);

  const removed = await clean(layout);

  assert.equal(removed.includes(outputRoot), false);
  assert.equal(fs.readFileSync(path.join(outputRoot, 'result.json'), 'utf8'), '{}');
});

test('clean leaves a symlink target outside the cache untouched', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  const externalDirectory = path.join(homeDirectory, 'external');
  const externalFile = path.join(externalDirectory, 'important.txt');
  fs.mkdirSync(externalDirectory);
  fs.writeFileSync(externalFile, 'preserve');
  fs.symlinkSync(externalDirectory, path.join(layout.holdersRoot, 'escape'));

  await assert.rejects(clean(layout), /outside the benchmark cache/);

  assert.equal(fs.existsSync(externalFile), true);
  assert.equal(fs.existsSync(path.join(layout.artifactsRoot, 'generated.txt')), true);
  assert.equal(fs.existsSync(path.join(layout.holdersRoot, 'escape')), true);
});

test('clean rejects a regular file in place of a generated directory', async t => {
  const { layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  fs.writeFileSync(layout.artifactsRoot, 'not a generated directory');
  fs.mkdirSync(layout.corpusRoot);
  fs.writeFileSync(path.join(layout.corpusRoot, 'generated.txt'), 'preserve');

  await assert.rejects(clean(layout), /generated directory/);

  assert.equal(fs.readFileSync(layout.artifactsRoot, 'utf8'), 'not a generated directory');
  assert.equal(fs.existsSync(path.join(layout.corpusRoot, 'generated.txt')), true);
});

test('clean rejects an incomplete explicit layout before deleting data', async t => {
  const { layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);

  await assert.rejects(
    clean({
      cacheRoot: layout.cacheRoot,
      homeDirectory: layout.homeDirectory,
      outputRoot: layout.outputRoot,
      wasperApp: layout.wasperApp,
    }),
    /complete resolved layout/
  );

  assert.equal(fs.existsSync(path.join(layout.artifactsRoot, 'generated.txt')), true);
});

test('clean rejects a cache that became a Git worktree after layout resolution', async t => {
  const { layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  fs.writeFileSync(path.join(layout.cacheRoot, '.git'), 'gitdir: /tmp/example\n');

  await assert.rejects(clean(layout), /Git repository or worktree/);

  assert.equal(fs.existsSync(path.join(layout.holdersRoot, 'generated.txt')), true);
});

test('clean cannot follow an interleaved cache-root replacement to external data', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  const retainedFile = path.join(layout.cacheRoot, 'keep.txt');
  fs.writeFileSync(retainedFile, 'keep');

  const externalRoot = path.join(homeDirectory, 'external-replacement');
  const externalArtifact = path.join(externalRoot, 'artifacts', 'important.txt');
  fs.mkdirSync(path.dirname(externalArtifact), { recursive: true });
  fs.writeFileSync(externalArtifact, 'external');
  const displacedCache = path.join(homeDirectory, 'displaced-owned-cache');
  const originalRm = fs.promises.rm;
  let interleaved = false;
  fs.promises.rm = async (...argumentsList) => {
    if (!interleaved) {
      interleaved = true;
      if (fs.existsSync(layout.cacheRoot)) fs.renameSync(layout.cacheRoot, displacedCache);
      fs.symlinkSync(externalRoot, layout.cacheRoot);
    }
    return originalRm(...argumentsList);
  };

  try {
    await assert.rejects(clean(layout), /cache root was replaced during cleanup/);
  } finally {
    fs.promises.rm = originalRm;
  }

  assert.equal(fs.readFileSync(externalArtifact, 'utf8'), 'external');
  assert.equal(fs.readFileSync(retainedFile, 'utf8'), 'keep');
  assert.equal(
    fs.existsSync(path.join(layout.cacheRoot, '.wasper-parakeet-runtime-benchmark-owner.json')),
    true
  );
});

test('clean reports each canonical generated root before deleting it', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  let output = '';

  await runCli(['clean', '--cache-dir', layout.cacheRoot], {
    homeDirectory,
    stdout: {
      write(chunk) {
        output += chunk;
      },
    },
  });

  assert.deepEqual(output.trim().split('\n'), [
    layout.artifactsRoot,
    layout.corpusRoot,
    layout.holdersRoot,
    path.join(layout.cacheRoot, 'runs'),
  ]);
});

test('the clean command exits nonzero when the marker is absent', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeGeneratedFiles(layout);

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [path.join(packageRoot, 'bin/benchmark.cjs'), 'clean', '--cache-dir', layout.cacheRoot],
      {
        env: { ...process.env, HOME: homeDirectory },
      }
    ),
    error => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /ownership marker/);
      return true;
    }
  );
  assert.equal(fs.existsSync(path.join(layout.holdersRoot, 'generated.txt')), true);
});

test('the clean command exits nonzero for an escaping symlink', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  const externalDirectory = path.join(homeDirectory, 'external-command-target');
  const externalFile = path.join(externalDirectory, 'important.txt');
  fs.mkdirSync(externalDirectory);
  fs.writeFileSync(externalFile, 'preserve');
  fs.symlinkSync(externalDirectory, path.join(layout.corpusRoot, 'escape'));

  await assert.rejects(
    execFileAsync(
      process.execPath,
      [path.join(packageRoot, 'bin/benchmark.cjs'), 'clean', '--cache-dir', layout.cacheRoot],
      { env: { ...process.env, HOME: homeDirectory } }
    ),
    error => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /outside the benchmark cache/);
      return true;
    }
  );
  assert.equal(fs.readFileSync(externalFile, 'utf8'), 'preserve');
  assert.equal(fs.existsSync(path.join(layout.artifactsRoot, 'generated.txt')), true);
});
