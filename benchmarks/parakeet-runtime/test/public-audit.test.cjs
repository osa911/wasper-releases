'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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
  const githubHost = ['github', 'com'].join('.');
  const privateRepository = ['https:', '', githubHost, 'osa911', 'wasper'].join('/');
  const privateRepositoryGit = `${privateRepository}.git`;
  const privateScpRepository = ['git@github.com:osa911', 'wasper.git'].join('/');
  const privateRepositoryCaseVariant = `HTTPS://${githubHost.toUpperCase()}/OSA911/WASPER.GIT`;
  const publicRepository = ['https:', '', githubHost, 'osa911', 'wasper-releases'].join('/');
  const localFileUrl = ['file:', '//', 'tmp', 'private-model'].join('');
  const privateGitControlPath = ['wasper', '.git'].join('/');
  return {
    localFileUrl,
    privateGitControlPath,
    privateRepositoryCaseVariant,
    privateRepository,
    privateRepositoryGit,
    privateScpRepository,
    privateUserPath,
    privateWorkspace,
    publicRepository,
  };
}

function escapedJsonDocument(values) {
  return JSON.stringify(values).replaceAll('/', '\\/');
}

function writeSource(directory, fileName, fragments) {
  fs.writeFileSync(path.join(directory, fileName), fragments.join(''));
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
      values.privateRepositoryGit,
      values.privateScpRepository,
      values.privateRepositoryCaseVariant,
      values.localFileUrl,
      values.privateGitControlPath,
      'https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3',
      `${values.publicRepository}/tree/main/benchmarks/parakeet-runtime`,
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
      type: 'private-wasper-repository-url',
      value: values.privateRepositoryGit,
    },
    {
      file: 'notes/audit-fixture.txt',
      type: 'private-wasper-repository-url',
      value: values.privateScpRepository,
    },
    {
      file: 'notes/audit-fixture.txt',
      type: 'private-wasper-repository-url',
      value: values.privateRepositoryCaseVariant,
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

test('decodes escaped JSON and UTF-16 text before checking private references', t => {
  const { auditPublicPackage } = require('../src/public-audit.cjs');
  const fixturePackage = temporaryPackage(t);
  const values = privateFixtureValues();
  const notesDirectory = path.join(fixturePackage, 'notes');
  fs.mkdirSync(notesDirectory);
  fs.writeFileSync(
    path.join(notesDirectory, 'escaped.json'),
    escapedJsonDocument({
      fileUrl: values.localFileUrl,
      privatePath: values.privateUserPath,
      privateRemote: values.privateRepositoryGit,
      publicRemote: `${values.publicRepository}/tree/main`,
    })
  );
  fs.writeFileSync(
    path.join(notesDirectory, 'utf16.txt'),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(values.privateScpRepository, 'utf16le')])
  );

  assert.deepEqual(auditPublicPackage(fixturePackage), [
    {
      file: 'notes/escaped.json',
      type: 'private-user-path',
      value: values.privateUserPath,
    },
    {
      file: 'notes/escaped.json',
      type: 'private-wasper-repository-url',
      value: values.privateRepositoryGit,
    },
    {
      file: 'notes/escaped.json',
      type: 'local-file-url',
      value: values.localFileUrl,
    },
    {
      file: 'notes/utf16.txt',
      type: 'private-wasper-repository-url',
      value: values.privateScpRepository,
    },
  ]);
});

test('decodes escaped JSON keys before checking private references', t => {
  const { auditPublicPackage } = require('../src/public-audit.cjs');
  const fixturePackage = temporaryPackage(t);
  const values = privateFixtureValues();
  const notesDirectory = path.join(fixturePackage, 'notes');
  fs.mkdirSync(notesDirectory);
  fs.writeFileSync(
    path.join(notesDirectory, 'escaped-keys.json'),
    escapedJsonDocument({
      [values.localFileUrl]: 'file-url key',
      [values.privateRepositoryGit]: 'private remote key',
      [values.privateUserPath]: 'private path key',
      [`${values.publicRepository}/tree/main`]: 'public remote key',
    })
  );

  assert.deepEqual(auditPublicPackage(fixturePackage), [
    {
      file: 'notes/escaped-keys.json',
      type: 'private-user-path',
      value: values.privateUserPath,
    },
    {
      file: 'notes/escaped-keys.json',
      type: 'private-wasper-repository-url',
      value: values.privateRepositoryGit,
    },
    {
      file: 'notes/escaped-keys.json',
      type: 'local-file-url',
      value: values.localFileUrl,
    },
  ]);
});

test('rejects contained and escaping symlink entries without reading their targets', t => {
  const { auditPublicPackage } = require('../src/public-audit.cjs');
  const fixturePackage = temporaryPackage(t);
  const values = privateFixtureValues();
  const notesDirectory = path.join(fixturePackage, 'notes');
  const outsideTarget = path.join(path.dirname(fixturePackage), 'outside.txt');
  fs.mkdirSync(notesDirectory);
  fs.writeFileSync(path.join(notesDirectory, 'inside-target.txt'), values.privateGitControlPath);
  fs.writeFileSync(outsideTarget, 'outside');
  fs.symlinkSync('inside-target.txt', path.join(notesDirectory, 'inside-link.txt'));
  fs.symlinkSync(outsideTarget, path.join(notesDirectory, 'outside-link.txt'));

  const violations = auditPublicPackage(fixturePackage);

  assert.deepEqual(
    violations.filter(violation => violation.file.endsWith('-link.txt')),
    [
      {
        file: 'notes/inside-link.txt',
        type: 'symlink-entry',
        value: fs.readlinkSync(path.join(notesDirectory, 'inside-link.txt')),
      },
      {
        file: 'notes/outside-link.txt',
        type: 'symlink-entry',
        value: fs.readlinkSync(path.join(notesDirectory, 'outside-link.txt')),
      },
    ]
  );
  assert.ok(
    violations.some(
      violation =>
        violation.file === 'notes/inside-target.txt' &&
        violation.type === 'private-git-control-path' &&
        violation.value === values.privateGitControlPath
    )
  );
  assert.equal(
    violations.some(
      violation =>
        violation.type === 'private-user-path' && violation.value === values.privateUserPath
    ),
    false
  );
});

test('reports CommonJS and ESM references that resolve outside the public package', t => {
  const { auditPublicPackage } = require('../src/public-audit.cjs');
  const fixturePackage = temporaryPackage(t);
  const sourceDirectory = path.join(fixturePackage, 'src');
  const outsideTarget = path.join(path.dirname(fixturePackage), 'outside-existing.cjs');
  const outsideTypeTarget = path.join(path.dirname(fixturePackage), 'outside-existing.ts');
  const outsideRequest = ['..', '..', 'outside-existing.cjs'].join('/');
  const outsideTypeRequest = ['..', '..', 'outside-existing.ts'].join('/');
  fs.mkdirSync(sourceDirectory);
  fs.writeFileSync(outsideTarget, 'export const dependency = true;\n');
  fs.writeFileSync(outsideTypeTarget, 'export type Thing = string;\n');
  writeSource(sourceDirectory, 'commonjs.cjs', [
    'require(',
    JSON.stringify(outsideRequest),
    ');\n',
  ]);
  writeSource(sourceDirectory, 'esm-default.mjs', [
    'import dependency from ',
    JSON.stringify(outsideRequest),
    ';\n',
  ]);
  writeSource(sourceDirectory, 'esm-side-effect.mjs', [
    'import ',
    JSON.stringify(outsideRequest),
    ';\n',
  ]);
  writeSource(sourceDirectory, 'esm-dynamic.mjs', [
    'import(',
    JSON.stringify(outsideRequest),
    ');\n',
  ]);
  writeSource(sourceDirectory, 'esm-re-export.mjs', [
    'export { dependency } from ',
    JSON.stringify(outsideRequest),
    ';\n',
    'export * from ',
    JSON.stringify(outsideRequest),
    ';\n',
    'export * as namespace from ',
    JSON.stringify(outsideRequest),
    ';\n',
    'export{thing}from ',
    JSON.stringify(outsideRequest),
    ';\n',
    'export /* comment */ {thing} /* comment */ from /* comment */ ',
    JSON.stringify(outsideRequest),
    ';\n',
    'export type { Thing } from ',
    JSON.stringify(outsideTypeRequest),
    ';\n',
    'const endpoint = ',
    JSON.stringify('https://public.example'),
    '; export{thing}from ',
    JSON.stringify(outsideRequest),
    ';\n',
  ]);

  const references = auditPublicPackage(fixturePackage)
    .filter(violation => violation.type === 'unresolved-relative-import')
    .map(violation => `${violation.file}:${violation.value}`)
    .sort();

  assert.deepEqual(references, [
    `src/commonjs.cjs:${outsideRequest}`,
    `src/esm-default.mjs:${outsideRequest}`,
    `src/esm-dynamic.mjs:${outsideRequest}`,
    `src/esm-re-export.mjs:${outsideRequest}`,
    `src/esm-re-export.mjs:${outsideRequest}`,
    `src/esm-re-export.mjs:${outsideRequest}`,
    `src/esm-re-export.mjs:${outsideRequest}`,
    `src/esm-re-export.mjs:${outsideRequest}`,
    `src/esm-re-export.mjs:${outsideRequest}`,
    `src/esm-re-export.mjs:${outsideTypeRequest}`,
    `src/esm-side-effect.mjs:${outsideRequest}`,
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

test('the benchmark executable prints a real fixture violation and exits nonzero', t => {
  const fixturePackage = temporaryPackage(t);
  const values = privateFixtureValues();
  fs.cpSync(packageRoot, fixturePackage, {
    recursive: true,
    filter(source) {
      return !source.endsWith(`${path.sep}node_modules`) && !source.endsWith(`${path.sep}.git`);
    },
  });
  const notesDirectory = path.join(fixturePackage, 'notes');
  fs.mkdirSync(notesDirectory);
  fs.writeFileSync(path.join(notesDirectory, 'private.txt'), values.privateUserPath);

  const result = spawnSync(process.execPath, [path.join(fixturePackage, 'bin/benchmark.cjs'), 'audit-public'], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, new RegExp(`notes/private\\.txt: private-user-path: ${values.privateUserPath}`));
  assert.match(result.stderr, /public package audit found 1 violation\(s\)/);
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
