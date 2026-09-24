'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveLayout } = require('../src/config.cjs');
const { ownedRuntimeStorage } = require('../src/runtime/owned-runtime-storage.cjs');

function temporaryStorage(t) {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-owned-storage-'));
  t.after(() => fs.rmSync(homeDirectory, { force: true, recursive: true }));
  const layout = resolveLayout({ homeDirectory });
  return { homeDirectory, layout, storage: ownedRuntimeStorage(layout) };
}

test('descriptor-relative directory creation does not follow a replaced cache root', t => {
  const { homeDirectory, layout, storage } = temporaryStorage(t);
  const outside = path.join(homeDirectory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
  let replaced = false;
  const replace = () => {
    if (replaced) return;
    replaced = true;
    fs.renameSync(layout.cacheRoot, `${layout.cacheRoot}-displaced`);
    fs.symlinkSync(outside, layout.cacheRoot);
  };
  const mkdirSync = fs.mkdirSync;
  t.mock.method(fs, 'mkdirSync', function (directory, ...args) {
    if (directory === layout.corpusRoot) replace();
    return mkdirSync.call(this, directory, ...args);
  });
  const spawnSync = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', function (command, args, options) {
    if (args.includes('mkdir')) replace();
    return spawnSync.call(this, command, args, options);
  });

  assert.throws(() => storage.directory(layout.corpusRoot), /changed|symlink|ownership/i);

  assert.equal(replaced, true, 'the replacement must run at directory creation');
  assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
});

test('descriptor-relative corpus promotion does not write through a replaced destination parent', t => {
  const { homeDirectory, layout, storage } = temporaryStorage(t);
  const downloads = storage.directory(path.join(layout.corpusRoot, 'downloads'));
  const fixtures = storage.directory(path.join(layout.corpusRoot, 'fixtures'));
  const part = path.join(downloads, 'fixture.part');
  fs.writeFileSync(part, 'owned partial');
  const outside = path.join(homeDirectory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
  let replaced = false;
  const replace = () => {
    if (replaced) return;
    replaced = true;
    fs.renameSync(fixtures, `${fixtures}-displaced`);
    fs.symlinkSync(outside, fixtures);
  };
  const renameSync = fs.renameSync;
  t.mock.method(fs, 'renameSync', function (from, to, ...args) {
    if (from === part && to === path.join(fixtures, 'fixture.part')) replace();
    return renameSync.call(this, from, to, ...args);
  });
  const spawnSync = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', function (command, args, options) {
    if (args.includes('promote')) replace();
    return spawnSync.call(this, command, args, options);
  });

  assert.throws(
    () => storage.promote(part, path.join(fixtures, 'fixture.part')),
    /changed|symlink|ownership/i
  );

  assert.equal(replaced, true, 'the replacement must run at promotion');
  assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
});

test('descriptor-relative corpus download does not write through a replaced parent', async t => {
  const { homeDirectory, layout, storage } = temporaryStorage(t);
  const downloads = storage.directory(path.join(layout.corpusRoot, 'downloads'));
  const target = path.join(downloads, 'fixture.part');
  const outside = path.join(homeDirectory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
  let replaced = false;
  const replace = () => {
    if (replaced) return;
    replaced = true;
    fs.renameSync(downloads, `${downloads}-displaced`);
    fs.symlinkSync(outside, downloads);
  };
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', function (command, args, options) {
    if (args.some(argument => argument.endsWith('owned-download.py'))) replace();
    return spawn.call(this, command, args, options);
  });

  await assert.rejects(
    storage.download(
      target,
      [Buffer.from('owned payload')],
      crypto.createHash('sha256').update('owned payload').digest('hex'),
      1024
    ),
    /changed|symlink|ownership/i
  );

  assert.equal(replaced, true, 'the replacement must run at the download write boundary');
  assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
});

test('descriptor-relative directory promotion does not rename through a replaced destination parent', t => {
  const { homeDirectory, layout, storage } = temporaryStorage(t);
  const downloads = storage.directory(path.join(layout.corpusRoot, 'downloads'));
  const fixtures = storage.directory(path.join(layout.corpusRoot, 'fixtures'));
  const stage = storage.createTempDirectory(downloads, 'stage-');
  const outside = path.join(homeDirectory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
  let replaced = false;
  const replace = () => {
    if (replaced) return;
    replaced = true;
    fs.renameSync(fixtures, `${fixtures}-displaced`);
    fs.symlinkSync(outside, fixtures);
  };
  const spawnSync = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', function (command, args, options) {
    if (args.includes('move-directory')) replace();
    return spawnSync.call(this, command, args, options);
  });

  assert.throws(
    () => storage.moveDirectory(stage, path.join(fixtures, 'fixture')),
    /changed|symlink|ownership/i
  );

  assert.equal(replaced, true, 'the replacement must run at the rename boundary');
  assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
});

test('tracked file cleanup keeps its leaf identity after a directory handoff', t => {
  const { layout, storage } = temporaryStorage(t);
  const downloads = storage.directory(path.join(layout.corpusRoot, 'downloads'));
  const stage = storage.createTempDirectory(downloads, 'stage-');
  const target = path.join(stage, 'fixture.part');
  storage.writeExclusive(target, 'owned payload');
  const destination = path.join(layout.corpusRoot, 'fixtures', path.basename(stage));
  storage.moveDirectory(stage, destination);
  const movedTarget = path.join(destination, 'fixture.part');
  fs.renameSync(movedTarget, `${movedTarget}.owned-before-swap`);
  fs.writeFileSync(movedTarget, 'substituted payload');

  assert.throws(() => storage.remove(movedTarget), /tracked|changed|unsafe/i);

  assert.equal(fs.readFileSync(movedTarget, 'utf8'), 'substituted payload');
});

test('tracked directory cleanup keeps its leaf identity after a directory handoff', t => {
  const { layout, storage } = temporaryStorage(t);
  const downloads = storage.directory(path.join(layout.corpusRoot, 'downloads'));
  const stage = storage.createTempDirectory(downloads, 'stage-');
  const leaf = storage.directory(path.join(stage, 'leaf'));
  const destination = path.join(layout.corpusRoot, 'fixtures', path.basename(stage));
  storage.moveDirectory(stage, destination);
  const movedLeaf = path.join(destination, path.basename(leaf));
  fs.renameSync(movedLeaf, `${movedLeaf}.owned-before-swap`);
  fs.mkdirSync(movedLeaf);

  assert.throws(() => storage.removeDirectory(movedLeaf), /tracked|changed|unsafe/i);

  assert.equal(fs.existsSync(movedLeaf), true);
});

test('removes a tracked regular file using its recorded leaf identity', t => {
  const { layout, storage } = temporaryStorage(t);
  const directory = storage.directory(path.join(layout.corpusRoot, 'cleanup'));
  const target = path.join(directory, 'owned.txt');
  storage.writeExclusive(target, 'owned payload');

  storage.remove(target);

  assert.equal(fs.existsSync(target), false);
});
