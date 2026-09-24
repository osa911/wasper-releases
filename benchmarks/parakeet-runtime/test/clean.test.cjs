'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { execFile } = childProcess;
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

function retainedOwnedCacheFile(layout, name) {
  for (const containerName of fs.readdirSync(layout.cacheNamespaceRoot)) {
    if (!containerName.startsWith('.parakeet-runtime-clean-')) continue;
    const container = path.join(layout.cacheNamespaceRoot, containerName);
    if (!fs.lstatSync(container).isDirectory()) continue;
    for (const entry of fs.readdirSync(container)) {
      const candidate = path.join(container, entry, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error(`could not locate retained owned cache file: ${name}`);
}

function retainedDeletionHandoffEntry(layout) {
  const outerName = fs
    .readdirSync(layout.cacheRoot)
    .find(name => name.startsWith('.wasper-parakeet-delete-'));
  assert.notEqual(outerName, undefined);
  const outerEntry = path.join(layout.cacheRoot, outerName, 'owned-entry');
  const innerName = fs
    .readdirSync(outerEntry)
    .find(name => name.startsWith('.wasper-parakeet-delete-'));
  assert.notEqual(innerName, undefined);
  return path.join(outerEntry, innerName, 'owned-entry');
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
arguments = sys.argv[1:]
while arguments and arguments[0] in ('-I', '-S', '-B'):
    arguments.pop(0)
target, *target_arguments = arguments
is_restore = bool(target_arguments and target_arguments[0] == 'restore-cache')
container_name = target_arguments[target_arguments.index('--container-name') + 1] if '--container-name' in target_arguments else None

def interleave():
    if not os.path.exists(race["signal"]):
        ancestor = race.get("ancestor")
        if ancestor is None:
            namespace = os.path.realpath('/dev/fd/3')
            ancestor = os.path.join(namespace, container_name)
        displaced = race.get("displaced", ancestor + '-displaced')
        original_rename(ancestor, displaced)
        os.symlink(race["external"], ancestor)
        with open(race["signal"], "w") as signal:
            signal.write("interleaved")

def interleave_rename(source, destination, *args, **kwargs):
    if is_restore and race.get("phase", "rename") == "rename":
        interleave()
    return original_rename(source, destination, *args, **kwargs)

def interleave_stat(name, *args, **kwargs):
    result = original_stat(name, *args, **kwargs)
    if (is_restore and race.get("phase") == "leftover-stat" and name == "owned-cache"
            and stat.S_ISLNK(result.st_mode)):
        interleave()
    return result

os.rename = interleave_rename
os.stat = interleave_stat
sys.argv = [target, *target_arguments]
runpy.run_path(target, run_name="__main__")
`,
    { mode: 0o700 }
  );
  return executable;
}

function deletionCloseRacePython(homeDirectory, replacement) {
  const executable = path.join(homeDirectory, `delete-close-race-${replacement}-python`);
  fs.writeFileSync(
    executable,
    `#!/usr/bin/python3
import os
import runpy
import sys

REPLACEMENT = ${JSON.stringify(replacement)}
opened = {}
swapped = False
original_close = os.close
original_open = os.open

def open_entry(name, *args, **kwargs):
    descriptor = original_open(name, *args, **kwargs)
    if name == 'owned-entry':
        opened[descriptor] = kwargs['dir_fd']
    return descriptor

def close_entry(descriptor):
    global swapped
    parent = opened.pop(descriptor, None)
    original_close(descriptor)
    if parent is None or swapped:
        return
    swapped = True
    try:
        os.rename('owned-entry', 'owned-entry.owned-before-swap', src_dir_fd=parent, dst_dir_fd=parent)
    except FileNotFoundError:
        pass
    if REPLACEMENT == 'file':
        target = os.open('owned-entry', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent)
        with os.fdopen(target, 'w', encoding='utf-8') as output:
            output.write('substituted entry')
    else:
        os.mkdir('owned-entry', dir_fd=parent)

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

function deletionHandoffRacePython(homeDirectory, { entry, external }) {
  const executable = path.join(homeDirectory, `delete-handoff-race-${entry}-python`);
  fs.writeFileSync(
    executable,
    `#!/usr/bin/python3
import os
import runpy
import sys

ENTRY = ${JSON.stringify(entry)}
EXTERNAL = ${JSON.stringify(external)}
swapped = False
original_rename = os.rename

def rename_entry(source, destination, *args, **kwargs):
    global swapped
    if source == ENTRY and not swapped:
        swapped = True
        container_name = sys.argv[sys.argv.index('--container-name') + 1]
        namespace = os.path.realpath('/dev/fd/3')
        root = os.path.join(namespace, container_name, 'owned-cache')
        target = os.path.join(root, ENTRY)
        original_rename(target, target + '.owned-before-swap')
        os.symlink(EXTERNAL, target)
    return original_rename(source, destination, *args, **kwargs)

os.rename = rename_entry
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

test('clean refuses a cache root swapped immediately before quarantine handoff', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  const external = path.join(homeDirectory, 'external-cache');
  fs.mkdirSync(external);
  const sentinel = path.join(external, 'sentinel');
  fs.writeFileSync(sentinel, 'unchanged');
  let swapped = false;
  const spawnSync = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', function swapBeforeQuarantine(command, args, options) {
    if (args.includes('quarantine-cache') && !swapped) {
      swapped = true;
      fs.renameSync(layout.cacheRoot, `${layout.cacheRoot}.owned-before-swap`);
      fs.symlinkSync(external, layout.cacheRoot);
    }
    return spawnSync.call(this, command, args, options);
  });

  await assert.rejects(clean(layout), /changed|symlink|cleanup/i);

  assert.equal(swapped, true, 'the cache replacement must run at quarantine handoff');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  assert.equal(fs.existsSync(path.join(external, 'artifacts')), false);
});

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

test('a custom output root is rejected before clean can adopt its data', t => {
  const { homeDirectory, layout: defaultLayout } = ownedLayout(t);
  const outputRoot = path.join(defaultLayout.cacheRoot, 'comparisons', 'candidate-a');
  fs.mkdirSync(outputRoot, { recursive: true });
  fs.writeFileSync(path.join(outputRoot, 'result.json'), '{}');

  assert.throws(
    () =>
      resolveLayout({
        cacheDir: defaultLayout.cacheRoot,
        homeDirectory,
        outputDir: 'comparisons/candidate-a',
      }),
    /marker-owned runs/
  );
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

test('clean does not unlink through a generated directory swapped before deletion handoff', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  const external = path.join(homeDirectory, 'external-file-parent');
  const externalFile = path.join(external, 'generated.txt');
  fs.mkdirSync(external);
  fs.writeFileSync(externalFile, 'external file');
  const pythonExecutable = deletionHandoffRacePython(homeDirectory, {
    entry: 'artifacts',
    external,
  });

  await assert.rejects(clean(layout, { pythonExecutable }), /changed|cleanup/i);

  assert.equal(fs.readFileSync(externalFile, 'utf8'), 'external file');
});

test('clean does not rmdir a generated directory swapped before deletion handoff', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  const external = path.join(homeDirectory, 'external-directory');
  fs.mkdirSync(external);
  const sentinel = path.join(external, 'sentinel');
  fs.writeFileSync(sentinel, 'external directory');
  const pythonExecutable = deletionHandoffRacePython(homeDirectory, {
    entry: 'artifacts',
    external,
  });

  await assert.rejects(clean(layout, { pythonExecutable }), /changed|cleanup/i);

  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external directory');
});

test('clean preserves a file substituted after its verified descriptor closes', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  const pythonExecutable = deletionCloseRacePython(homeDirectory, 'file');

  await assert.rejects(clean(layout, { pythonExecutable }), /cleanup|directory/i);

  assert.equal(
    fs.readFileSync(retainedDeletionHandoffEntry(layout), 'utf8'),
    'substituted entry'
  );
});

test('clean preserves a directory substituted after its verified descriptor closes', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  const pythonExecutable = deletionCloseRacePython(homeDirectory, 'directory');

  await assert.rejects(clean(layout, { pythonExecutable }), /cleanup|directory/i);

  assert.equal(fs.lstatSync(retainedDeletionHandoffEntry(layout)).isDirectory(), true);
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
  fs.writeFileSync(path.join(layout.cacheRoot, 'keep.txt'), 'keep');

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
  assert.equal(fs.readFileSync(path.join(layout.cacheRoot, 'keep.txt'), 'utf8'), 'keep');
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

test('restoration refuses an unsafe quarantined source without touching external data', async t => {
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
  const pythonExecutable = restorationRacePython(homeDirectory, {
    external: externalAncestor,
    signal,
  });

  await assert.rejects(clean(layout, { pythonExecutable }));

  assert.equal(fs.readFileSync(externalFile, 'utf8'), 'external');
  assert.equal(fs.lstatSync(externalDirectory, { bigint: true }).ino, externalIdentity.ino);
  assert.equal(fs.readFileSync(retainedOwnedCacheFile(layout, 'keep.txt'), 'utf8'), 'keep');
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
  let cleanupError;
  try {
    await clean(layout, { pythonExecutable });
  } catch (error) {
    cleanupError = error;
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

test('clean refuses an unsafe quarantined owned-cache replacement', async t => {
  const { homeDirectory, layout } = ownedLayout(t);
  writeOwnershipMarker(layout);
  writeGeneratedFiles(layout);
  fs.writeFileSync(path.join(layout.cacheRoot, 'keep.txt'), 'keep');

  const replacementTarget = path.join(homeDirectory, 'quarantine-entry-target');
  fs.mkdirSync(replacementTarget);
  const externalAncestor = path.join(homeDirectory, 'external-quarantine-ancestor');
  const externalFile = path.join(externalAncestor, 'owned-cache');
  fs.mkdirSync(externalAncestor);
  fs.writeFileSync(externalFile, 'external');

  const signal = path.join(homeDirectory, 'leftover-stat-interleaved');
  const pythonExecutable = restorationRacePython(homeDirectory, {
    phase: 'leftover-stat',
    external: externalAncestor,
    signal,
  });
  let quarantineContainer;

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
        const ownedCache = path.join(quarantineContainer, 'owned-cache');
        fs.renameSync(ownedCache, path.join(quarantineContainer, 'displaced-owned-cache'));
        fs.symlinkSync(replacementTarget, ownedCache);
      },
    })
  );

  assert.equal(fs.readFileSync(externalFile, 'utf8'), 'external');
  assert.equal(fs.readFileSync(retainedOwnedCacheFile(layout, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(
    fs.existsSync(
      retainedOwnedCacheFile(layout, '.wasper-parakeet-runtime-benchmark-owner.json')
    ),
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
