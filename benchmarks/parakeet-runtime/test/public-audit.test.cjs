'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { runCli } = require('../src/cli.cjs');

const packageRoot = path.resolve(__dirname, '..');

function temporaryPackage(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-public-audit-'));
  const fixturePackage = path.join(root, 'package');
  fs.mkdirSync(fixturePackage);
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  return fixturePackage;
}

function privateFixtureValues() {
  const privateUserPath = path.join(path.sep, 'Users', 'osa911', 'Models', 'example');
  const privateWorkspace = ['Documents', '1-my_code', 'wasper'].join('/');
  const privateRepository = ['https://github.com/osa911', 'wasper'].join('/');
  const localFileUrl = ['file:', '//', 'tmp', 'private-model'].join('');
  const privateGitControlPath = ['wasper', '.git'].join('/');
  return {
    localFileUrl,
    privateGitControlPath,
    privateRepository,
    privateUserPath,
    privateWorkspace,
  };
}

test('reports every seeded private reference and copied relative import', t => {
  const { auditPublicPackage } = require('../src/public-audit.cjs');
  const fixturePackage = temporaryPackage(t);
  const values = privateFixtureValues();
  const notesDirectory = path.join(fixturePackage, 'notes');
  const sourceDirectory = path.join(fixturePackage, 'src');
  fs.mkdirSync(notesDirectory);
  fs.mkdirSync(sourceDirectory);
  fs.writeFileSync(
    path.join(notesDirectory, 'audit-fixture.txt'),
    [
      values.privateUserPath,
      values.privateWorkspace,
      values.privateRepository,
      values.localFileUrl,
      values.privateGitControlPath,
      'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3',
      'https://github.com/osa911/wasper-releases/tree/main/benchmarks/parakeet-runtime',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(sourceDirectory, 'copied.cjs'),
    ['require(', JSON.stringify('./outside.cjs'), ');\n'].join('')
  );

  assert.deepEqual(auditPublicPackage(fixturePackage), [
    {
      file: 'notes/audit-fixture.txt',
      type: 'private-user-path',
      value: values.privateUserPath,
    },
    {
      file: 'notes/audit-fixture.txt',
      type: 'private-workspace-path',
      value: values.privateWorkspace,
    },
    {
      file: 'notes/audit-fixture.txt',
      type: 'private-wasper-repository-url',
      value: values.privateRepository,
    },
    {
      file: 'notes/audit-fixture.txt',
      type: 'local-file-url',
      value: values.localFileUrl,
    },
    {
      file: 'notes/audit-fixture.txt',
      type: 'private-git-control-path',
      value: values.privateGitControlPath,
    },
    {
      file: 'src/copied.cjs',
      type: 'unresolved-relative-import',
      value: './outside.cjs',
    },
  ]);
});

test('the audit-public command prints every violation and exits nonzero', async () => {
  const writes = [];
  const violations = [
    { file: 'notes/a.txt', type: 'private-user-path', value: privateFixtureValues().privateUserPath },
    { file: 'src/b.cjs', type: 'unresolved-relative-import', value: './missing.cjs' },
  ];

  await assert.rejects(
    runCli(['audit-public'], {
      auditPublicPackageImpl() {
        return violations;
      },
      stdout: { write(value) { writes.push(value); } },
    }),
    /public package audit found 2 violation\(s\)/
  );

  assert.deepEqual(writes, [
    `notes/a.txt: private-user-path: ${violations[0].value}\n`,
    'src/b.cjs: unresolved-relative-import: ./missing.cjs\n',
  ]);
});

test('the real package is clean and the audit-public command is read-only', async () => {
  const { auditPublicPackage } = require('../src/public-audit.cjs');
  const writes = [];

  assert.deepEqual(auditPublicPackage(packageRoot), []);
  const result = await runCli(['audit-public'], {
    stdout: { write(value) { writes.push(value); } },
  });

  assert.deepEqual(result, {
    command: 'audit-public',
    violations: [],
    writes: false,
  });
  assert.deepEqual(writes, ['Public package audit: clean\n']);
});
