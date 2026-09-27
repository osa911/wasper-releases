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

test('an opened evidence file stays in its original directory after a parent replacement', t => {
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
    if (typeof file === 'number' || file === path.join(store.runDirectory, 'raw-evidence.json'))
      replace();
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

test('an interrupted request write does not publish an empty record', t => {
  const { layout } = temporaryLayout(t);
  const store = createEvidenceStore({
    layout,
    runIdentity: { schema: 'test.evidence-store.v1' },
    clock: () => new Date('2026-09-24T12:34:56.000Z'),
  });
  const requestPath = path.join(store.runDirectory, 'requests', '00000000.json');
  t.mock.method(fs, 'writeFileSync', () => {
    throw new Error('simulated interrupted write');
  });
  const spawnSync = childProcess.spawnSync;
  t.mock.method(childProcess, 'spawnSync', function (command, args, options) {
    if (args[3]?.endsWith('owned-write.py') && args.at(-1)?.includes('00000000')) {
      return {
        status: 1,
        signal: null,
        error: null,
        stderr: 'simulated interrupted write',
      };
    }
    return spawnSync.call(this, command, args, options);
  });

  assert.throws(
    () => store.writeRequest({ order: 0, outcome: 'ok' }),
    /simulated interrupted write/
  );
  assert.equal(fs.existsSync(requestPath), false);
  assert.deepEqual(store.readRequests(), []);
});

test('large multilingual results and reports are saved directly without a child writer', t => {
  const { layout } = temporaryLayout(t);
  const store = createEvidenceStore({
    layout,
    runIdentity: { schema: 'test.evidence-store.v1' },
  });
  t.mock.method(childProcess, 'spawnSync', () => {
    throw new Error('result persistence must not launch a child process');
  });
  const record = {
    order: 0,
    outcome: 'success',
    raw: { transcript: 'Ελληνικά Nederlands 日本語 '.repeat(50000) },
  };
  store.writeRequest(record);
  store.writeRequest({ order: 0, outcome: 'error' });
  store.writeActivation({ sequence: 0, lifecycle: ['start', 'stop'] });
  store.writeArtifact('public-evidence.json', { requests: 1 });
  store.writeText('report.md', 'Completed one request.\n');
  assert.deepEqual(store.readRequests(), [record]);
  assert.deepEqual(store.readActivations(), [{ sequence: 0, lifecycle: ['start', 'stop'] }]);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(store.runDirectory, 'public-evidence.json'))),
    { requests: 1 }
  );
  assert.equal(
    fs.readFileSync(path.join(store.runDirectory, 'report.md'), 'utf8'),
    'Completed one request.\n'
  );
  assert.deepEqual(fs.readdirSync(path.join(store.runDirectory, 'requests')), ['00000000.json']);
});

test('a failed replacement preserves the previous complete artifact', t => {
  const { layout } = temporaryLayout(t);
  const store = createEvidenceStore({
    layout,
    runIdentity: { schema: 'test.evidence-store.v1' },
  });
  store.writeArtifact('public-evidence.json', { complete: true });
  t.mock.method(fs, 'writeFileSync', () => {
    throw new Error('disk write failed');
  });
  assert.throws(
    () => store.writeArtifact('public-evidence.json', { complete: false }),
    /disk write failed/
  );
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(store.runDirectory, 'public-evidence.json'))),
    { complete: true }
  );
});

test('result writes reject existing symlinks without modifying their targets', t => {
  const { homeDirectory, layout } = temporaryLayout(t);
  const store = createEvidenceStore({ layout, runIdentity: { schema: 'test.evidence-store.v1' } });
  const target = path.join(homeDirectory, 'sentinel.json');
  fs.writeFileSync(target, '{"untouched":true}');
  fs.symlinkSync(target, path.join(store.runDirectory, 'report.md'));
  fs.symlinkSync(target, path.join(store.runDirectory, 'requests', '00000000.json'));
  assert.throws(
    () => store.writeText('report.md', 'replacement'),
    error => error.code === 'EVIDENCE_WRITE_FAILED'
  );
  assert.throws(
    () => store.writeRequest({ order: 0, outcome: 'success' }),
    error => error.code === 'EVIDENCE_WRITE_FAILED'
  );
  assert.equal(fs.readFileSync(target, 'utf8'), '{"untouched":true}');
});
