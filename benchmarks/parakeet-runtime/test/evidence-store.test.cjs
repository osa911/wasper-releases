'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveLayout, writeOwnershipMarker } = require('../src/config.cjs');
const { createEvidenceStore } = require('../src/runtime/evidence-store.cjs');

function temporaryLayout(t) {
  const homeDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-evidence-store-'));
  t.after(() => fs.rmSync(homeDirectory, { force: true, recursive: true }));
  const layout = resolveLayout({ homeDirectory });
  writeOwnershipMarker(layout);
  return { homeDirectory, layout };
}

test('private evidence writes stay in the pinned run directory after a parent replacement', t => {
  const { homeDirectory, layout } = temporaryLayout(t);
  const store = createEvidenceStore({
    layout,
    runIdentity: { schema: 'test.evidence-store.v1' },
    clock: () => new Date('2026-09-24T12:34:56.000Z'),
  });
  const outside = path.join(homeDirectory, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
  const displaced = `${store.runDirectory}-displaced`;
  let replaced = false;
  const replace = () => {
    if (replaced) return;
    replaced = true;
    fs.renameSync(store.runDirectory, displaced);
    fs.symlinkSync(outside, store.runDirectory);
  };
  const writeFileSync = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', function (file, ...args) {
    if (file === path.join(store.runDirectory, 'raw-evidence.json')) replace();
    return writeFileSync.call(this, file, ...args);
  });
  const spawnSync = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', function (command, args, options) {
    if (args.includes('replace')) replace();
    return spawnSync.call(this, command, args, options);
  });

  assert.throws(
    () => store.writeArtifact('raw-evidence.json', { private: 'record' }),
    /changed|ownership|unsafe|symlink/i
  );

  assert.equal(replaced, true, 'the replacement must run at the evidence write boundary');
  assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
});
