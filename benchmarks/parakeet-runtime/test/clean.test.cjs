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

// Run the real helper with a filesystem interleaving immediately before rename.
// The Node hook below exercises the same interleaving in the pre-fix cleaner.
function restorationRacePython(homeDirectory, race) {
  const executable = path.join(homeDirectory, 'restoration-race-python');
  fs.writeFileSync(
    executable,
    `#!/usr/bin/env python3
import json
import os
import runpy
import stat
import sys

race = json.loads(${JSON.stringify(JSON.stringify(race))})
original_rename = os.rename
original_stat = os.stat

def interleave():
    if not os.path.exists(race["signal"]):
        original_rename(race["ancestor"], race["displaced"])
        os.symlink(race["external"], race["ancestor"])
        with open(race["signal"], "w") as signal:
            signal.write("interleaved")

def interleave_rename(source, destination, *args, **kwargs):
    if race.get("phase", "rename") == "rename":
        interleave()
    return original_rename(source, destination, *args, **kwargs)

def interleave_stat(name, *args, **kwargs):
    result = original_stat(name, *args, **kwargs)
    if (race.get("phase") == "leftover-stat" and name == "owned-cache"
            and stat.S_ISLNK(result.st_mode) and os.path.isdir(race["cacheRoot"])):
        interleave()
    return result

os.rename = interleave_rename
os.stat = interleave_stat
arguments = sys.argv[1:]
while arguments and arguments[0] in ('-I', '-S', '-B'):
    arguments.pop(0)
target, *target_arguments = arguments
sys.argv = [target, *target_arguments]
runpy.run_path(target, run_name="__main__")
`,
    { mode: 0o700 }
  );
  return executable;
}

function deletionRacePython(homeDirectory, { entry, replacement }) {
  const executable = path.join(homeDirectory, `delete-race-${entry}-python`);
  fs.writeFileSync(
    executable,
    `#!/usr/bin/python3
import os
import runpy
import sys

ENTRY = ${JSON.stringify(entry)}
REPLACEMENT = ${JSON.stringify(replacement)}
opened = set()
swapped = False
original_close = os.close
original_open = os.open

def open_entry(name, *args, **kwargs):
    descriptor = original_open(name, *args, **kwargs)
    if name == ENTRY:
        opened.add(descriptor)
    return descriptor

def close_entry(descriptor):
    global swapped
    original_close(descriptor)
    if descriptor not in opened or swapped:
        return
    swapped = True
    root = sys.argv[sys.argv.index('--root') + 1]
    target = os.path.join(root, ENTRY) if REPLACEMENT == 'directory' else os.path.join(root, 'artifacts', ENTRY)
    if os.path.lexists(target):
        os.rename(target, target + '.owned-before-swap')
    if REPLACEMENT == 'file':
        with open(target, 'w', encoding='utf-8') as output:
            output.write('substituted entry')
    else:
        os.mkdir(target)

os.open = open_entry
os.close = close_entry
arguments = sys.argv[1:]
while arguments and arguments[0] in ('-I', '-S', '-B'):
    arguments.pop(0)
target, *target_arguments = arguments
sys.argv = [target, *target_arguments]
runpy.run_path(target, run_name='__main__')
`,
    { mode: 0o700 }
  );
  return executable;
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
  assert.equal(
    fs
      .readdirSync(layout.cacheNamespaceRoot)
      .some(name => name.startsWith('.parakeet-runtime-clean-')),
    false
  );
});

test('clean ignores a PATH-shadowed Python executable', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  const bin = path.join(homeDirectory, 'untrusted-bin');
  const witness = path.join(homeDirectory, 'untrusted-python-ran');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'python3'),
    `#!/bin/sh\nprintf unsafe > ${JSON.stringify(witness)}\nexit 99\n`,
    { mode: 0o700 }
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  try {
    await clean(layout);
  } finally {
    process.env.PATH = previousPath;
  }

  assert.equal(fs.existsSync(witness), false);
  assert.equal(fs.existsSync(layout.artifactsRoot), false);
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

test('clean restores a nested cache without unlinking an unrelated namespace symlink', async t => {
  const { homeDirectory, layout } = ownedLayout(t, 'team/parakeet-runtime-v1');
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  const retainedFile = path.join(layout.cacheRoot, 'keep.txt');
  fs.writeFileSync(retainedFile, 'keep');
  const externalRoot = path.join(homeDirectory, 'unrelated-namespace-target');
  fs.mkdirSync(externalRoot);
  const externalFile = path.join(externalRoot, 'important.txt');
  fs.writeFileSync(externalFile, 'external');
  const unrelatedLink = path.join(layout.cacheNamespaceRoot, 'parakeet-runtime-v1');
  fs.symlinkSync(externalRoot, unrelatedLink);
  const linkIdentity = fs.lstatSync(unrelatedLink, { bigint: true });

  // Check preservation before reporting a cleanup error: the previous cleaner
  // unlinked the unrelated symlink, then reported that the cache was replaced.
  let cleanupError;
  let removed;
  try {
    removed = await clean(layout);
  } catch (error) {
    cleanupError = error;
  }

  assert.deepEqual(fs.lstatSync(unrelatedLink, { bigint: true }).ino, linkIdentity.ino);
  assert.equal(fs.readlinkSync(unrelatedLink), externalRoot);
  assert.equal(fs.readFileSync(externalFile, 'utf8'), 'external');
  assert.equal(cleanupError, undefined);
  assert.deepEqual(removed, [
    layout.artifactsRoot,
    layout.corpusRoot,
    layout.holdersRoot,
    path.join(layout.cacheRoot, 'runs'),
  ]);
  assert.equal(fs.readFileSync(retainedFile, 'utf8'), 'keep');
  assert.equal(fs.lstatSync(layout.cacheRoot).isDirectory(), true);
});

test('restoration rejects a different real cache parent before mutating its entries', async t => {
  const { layout } = ownedLayout(t, 'team/project/parakeet-runtime-v1');
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  fs.writeFileSync(path.join(layout.cacheRoot, 'keep.txt'), 'keep');
  const cacheParent = path.dirname(layout.cacheRoot);
  let replacementIdentity;
  let cleanupError;
  try {
    await clean(layout, {
      beforeRemove() {
        if (replacementIdentity !== undefined) return;
        fs.renameSync(cacheParent, `${cacheParent}-displaced`);
        fs.mkdirSync(layout.cacheRoot, { recursive: true });
        replacementIdentity = fs.lstatSync(layout.cacheRoot, { bigint: true });
      },
    });
  } catch (error) {
    cleanupError = error;
  }

  assert.equal(fs.lstatSync(layout.cacheRoot, { bigint: true }).ino, replacementIdentity.ino);
  assert.deepEqual(fs.readdirSync(layout.cacheRoot), []);
  assert.ok(cleanupError, 'a different parent inode must be rejected');
  const quarantineName = fs
    .readdirSync(layout.cacheNamespaceRoot)
    .find(name => name.startsWith('.parakeet-runtime-clean-'));
  assert.notEqual(quarantineName, undefined);
  const retainedCache = path.join(layout.cacheNamespaceRoot, quarantineName, 'owned-cache');
  assert.equal(fs.readFileSync(path.join(retainedCache, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(
    fs.existsSync(path.join(retainedCache, '.wasper-parakeet-runtime-benchmark-owner.json')),
    true
  );
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

test('clean does not unlink a file substituted when its verified descriptor closes', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  const pythonExecutable = deletionRacePython(homeDirectory, {
    entry: 'generated.txt',
    replacement: 'file',
  });

  await assert.rejects(clean(layout, { pythonExecutable }), /cleanup|directory/i);

  assert.equal(
    fs.readFileSync(path.join(layout.artifactsRoot, 'generated.txt'), 'utf8'),
    'substituted entry'
  );
});

test('clean does not rmdir a directory substituted when its verified descriptor closes', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  fs.mkdirSync(layout.artifactsRoot, { recursive: true });
  const pythonExecutable = deletionRacePython(homeDirectory, {
    entry: 'artifacts',
    replacement: 'directory',
  });

  await clean(layout, { pythonExecutable });

  assert.equal(fs.lstatSync(layout.artifactsRoot).isDirectory(), true);
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
  let interleaved = false;

  await assert.rejects(
    clean(layout, {
      beforeRemove() {
        if (interleaved) return;
        interleaved = true;
        if (fs.existsSync(layout.cacheRoot)) fs.renameSync(layout.cacheRoot, displacedCache);
        fs.symlinkSync(externalRoot, layout.cacheRoot);
      },
    }),
    /cache root was replaced during cleanup/
  );

  assert.equal(fs.readFileSync(externalArtifact, 'utf8'), 'external');
  assert.equal(fs.readFileSync(retainedFile, 'utf8'), 'keep');
  assert.equal(
    fs.existsSync(path.join(layout.cacheRoot, '.wasper-parakeet-runtime-benchmark-owner.json')),
    true
  );
});

test('clean cannot follow an interleaved quarantine replacement to external data', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  const retainedFile = path.join(layout.cacheRoot, 'keep.txt');
  fs.writeFileSync(retainedFile, 'keep');

  const externalRoot = path.join(homeDirectory, 'external-quarantine-replacement');
  const externalFiles = ['artifacts', 'corpus', 'holders', 'runs'].map(name => {
    const filePath = path.join(externalRoot, name, 'important.txt');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `external-${name}`);
    return filePath;
  });
  let interleaved = false;

  await assert.rejects(
    clean(layout, {
      beforeRemove() {
        if (interleaved) return;
        interleaved = true;
        const quarantineName = fs
          .readdirSync(layout.cacheNamespaceRoot)
          .find(name => name.startsWith('.parakeet-runtime-clean-'));
        assert.notEqual(quarantineName, undefined);
        const quarantineContainer = path.join(layout.cacheNamespaceRoot, quarantineName);
        const ownedCache = path.join(quarantineContainer, 'owned-cache');
        fs.renameSync(ownedCache, path.join(quarantineContainer, 'displaced-owned-cache'));
        fs.symlinkSync(externalRoot, ownedCache);
      },
    })
  );

  for (const [index, externalFile] of externalFiles.entries()) {
    assert.equal(
      fs.readFileSync(externalFile, 'utf8'),
      `external-${['artifacts', 'corpus', 'holders', 'runs'][index]}`
    );
  }
  const restoredStat = fs.lstatSync(layout.cacheRoot);
  assert.equal(restoredStat.isDirectory(), true);
  assert.equal(restoredStat.isSymbolicLink(), false);
  assert.equal(fs.readFileSync(retainedFile, 'utf8'), 'keep');
  assert.equal(
    fs.existsSync(path.join(layout.cacheRoot, '.wasper-parakeet-runtime-benchmark-owner.json')),
    true
  );
  assert.equal(fs.existsSync(path.join(layout.artifactsRoot, 'generated.txt')), true);
  assert.equal(
    fs
      .readdirSync(layout.cacheNamespaceRoot)
      .some(name => name.startsWith('.parakeet-runtime-clean-')),
    false
  );
});

test('restoration cannot rename external data through a replaced source ancestor', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  fs.writeFileSync(path.join(layout.cacheRoot, 'keep.txt'), 'keep');
  const externalAncestor = path.join(homeDirectory, 'external-restore-source');
  const externalDirectory = path.join(externalAncestor, 'owned-cache');
  fs.mkdirSync(externalDirectory, { recursive: true });
  const externalFile = path.join(externalDirectory, 'important.txt');
  fs.writeFileSync(externalFile, 'external');
  const externalIdentity = fs.lstatSync(externalDirectory, { bigint: true });
  const signal = path.join(homeDirectory, 'restore-source-interleaved');
  const pythonExecutable = path.join(homeDirectory, 'restoration-race-python');
  let quarantineContainer;
  const originalRenameSync = fs.renameSync;
  fs.renameSync = function interleaveRestoration(source, destination) {
    if (destination === layout.cacheRoot && !fs.existsSync(signal)) {
      originalRenameSync(quarantineContainer, `${quarantineContainer}-displaced`);
      fs.symlinkSync(externalAncestor, quarantineContainer);
      fs.writeFileSync(signal, 'interleaved');
    }
    return originalRenameSync(source, destination);
  };

  try {
    await assert.rejects(
      clean(layout, {
        pythonExecutable,
        beforeRemove() {
          if (quarantineContainer !== undefined) return;
          const quarantineName = fs
            .readdirSync(layout.cacheNamespaceRoot)
            .find(name => name.startsWith('.parakeet-runtime-clean-'));
          assert.notEqual(quarantineName, undefined);
          quarantineContainer = path.join(layout.cacheNamespaceRoot, quarantineName);
          restorationRacePython(homeDirectory, {
            ancestor: quarantineContainer,
            displaced: `${quarantineContainer}-displaced`,
            external: externalAncestor,
            signal,
          });
        },
      })
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(fs.readFileSync(signal, 'utf8'), 'interleaved');
  assert.equal(fs.readFileSync(externalFile, 'utf8'), 'external');
  assert.equal(fs.lstatSync(externalDirectory, { bigint: true }).ino, externalIdentity.ino);
  assert.equal(fs.readFileSync(path.join(layout.cacheRoot, 'keep.txt'), 'utf8'), 'keep');
});

test('restoration cannot overwrite an external directory through a replaced destination parent', async t => {
  const { homeDirectory, layout } = ownedLayout(t, 'team/parakeet-runtime-v1');
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  fs.writeFileSync(path.join(layout.cacheRoot, 'keep.txt'), 'keep');
  const externalParent = path.join(homeDirectory, 'external-restore-destination');
  const externalCache = path.join(externalParent, 'parakeet-runtime-v1');
  fs.mkdirSync(externalCache, { recursive: true });
  const externalIdentity = fs.lstatSync(externalCache, { bigint: true });
  const cacheParent = path.dirname(layout.cacheRoot);
  const displacedParent = `${cacheParent}-displaced`;
  const signal = path.join(homeDirectory, 'restore-destination-interleaved');
  const pythonExecutable = restorationRacePython(homeDirectory, {
    ancestor: cacheParent,
    displaced: displacedParent,
    external: externalParent,
    signal,
  });
  const originalRenameSync = fs.renameSync;
  fs.renameSync = function interleaveRestoration(source, destination) {
    if (destination === layout.cacheRoot && !fs.existsSync(signal)) {
      originalRenameSync(cacheParent, displacedParent);
      fs.symlinkSync(externalParent, cacheParent);
      fs.writeFileSync(signal, 'interleaved');
    }
    return originalRenameSync(source, destination);
  };
  let cleanupError;
  try {
    await clean(layout, { pythonExecutable });
  } catch (error) {
    cleanupError = error;
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(fs.readFileSync(signal, 'utf8'), 'interleaved');
  assert.equal(fs.lstatSync(externalCache, { bigint: true }).ino, externalIdentity.ino);
  assert.deepEqual(fs.readdirSync(externalCache), []);
  assert.equal(
    fs.readFileSync(path.join(displacedParent, 'parakeet-runtime-v1/keep.txt'), 'utf8'),
    'keep'
  );
  assert.ok(cleanupError, 'a replaced destination parent must be reported');
});

test('clean cannot unlink through an interleaved quarantine-ancestor replacement', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  const retainedFile = path.join(layout.cacheRoot, 'keep.txt');
  fs.writeFileSync(retainedFile, 'keep');

  const replacementTarget = path.join(homeDirectory, 'quarantine-entry-target');
  fs.mkdirSync(replacementTarget);
  const externalAncestor = path.join(homeDirectory, 'external-quarantine-ancestor');
  const externalFile = path.join(externalAncestor, 'owned-cache');
  fs.mkdirSync(externalAncestor);
  fs.writeFileSync(externalFile, 'external');

  const originalLstatSync = fs.lstatSync;
  const signal = path.join(homeDirectory, 'leftover-stat-interleaved');
  const pythonExecutable = path.join(homeDirectory, 'restoration-race-python');
  let quarantineContainer;
  let ancestorReplaced = false;

  fs.lstatSync = function interleaveQuarantineAncestor(filePath, options) {
    const result = originalLstatSync(filePath, options);
    if (
      !ancestorReplaced &&
      quarantineContainer !== undefined &&
      filePath === path.join(quarantineContainer, 'owned-cache') &&
      result.isSymbolicLink() &&
      fs.existsSync(layout.cacheRoot)
    ) {
      ancestorReplaced = true;
      fs.renameSync(quarantineContainer, `${quarantineContainer}-displaced`);
      fs.symlinkSync(externalAncestor, quarantineContainer);
      fs.writeFileSync(signal, 'interleaved');
    }
    return result;
  };

  try {
    await assert.rejects(
      clean(layout, {
        pythonExecutable,
        beforeRemove() {
          if (quarantineContainer !== undefined) return;
          const quarantineName = fs
            .readdirSync(layout.cacheNamespaceRoot)
            .find(name => name.startsWith('.parakeet-runtime-clean-'));
          assert.notEqual(quarantineName, undefined);
          quarantineContainer = path.join(layout.cacheNamespaceRoot, quarantineName);
          restorationRacePython(homeDirectory, {
            phase: 'leftover-stat',
            cacheRoot: layout.cacheRoot,
            ancestor: quarantineContainer,
            displaced: `${quarantineContainer}-displaced`,
            external: externalAncestor,
            signal,
          });
          const ownedCache = path.join(quarantineContainer, 'owned-cache');
          fs.renameSync(ownedCache, path.join(quarantineContainer, 'displaced-owned-cache'));
          fs.symlinkSync(replacementTarget, ownedCache);
        },
      })
    );
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  assert.equal(fs.readFileSync(signal, 'utf8'), 'interleaved');
  assert.equal(fs.readFileSync(externalFile, 'utf8'), 'external');
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
