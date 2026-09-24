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

function withoutSymlinkTargetIo(paths, operation) {
  const blocked = new Set(paths.map(candidate => path.resolve(candidate)));
  const methods = ['realpathSync', 'statSync', 'readFileSync', 'readdirSync'];
  const originals = Object.fromEntries(methods.map(method => [method, fs[method]]));
  for (const method of methods) {
    const guardedFilesystemMethod = function guardedFilesystemMethod(...arguments_) {
      const candidate = arguments_[0];
      if (typeof candidate === 'string' && blocked.has(path.resolve(candidate))) {
        throw new Error(`unsafe ${method} on symlink path or target: ${candidate}`);
      }
      return originals[method].apply(this, arguments_);
    };
    if (method === 'realpathSync') {
      guardedFilesystemMethod.native = function guardedNativeRealpath(...arguments_) {
        return guardedFilesystemMethod(...arguments_);
      };
    }
    fs[method] = guardedFilesystemMethod;
  }
  try {
    return operation();
  } finally {
    for (const method of methods) fs[method] = originals[method];
  }
}

function symlinkFixture(t) {
  const fixturePackage = temporaryPackage(t);
  const values = privateFixtureValues();
  const notesDirectory = path.join(fixturePackage, 'notes');
  const excludedDirectory = path.join(fixturePackage, 'node_modules');
  const outsideDirectory = path.join(path.dirname(fixturePackage), 'outside');
  const containedFileTarget = path.join(excludedDirectory, 'contained-file.txt');
  const containedDirectoryTarget = path.join(excludedDirectory, 'contained-directory');
  const outsideFileTarget = path.join(outsideDirectory, 'outside-file.txt');
  const outsideDirectoryTarget = path.join(outsideDirectory, 'outside-directory');
  fs.mkdirSync(notesDirectory);
  fs.mkdirSync(containedDirectoryTarget, { recursive: true });
  fs.mkdirSync(outsideDirectoryTarget, { recursive: true });
  fs.writeFileSync(containedFileTarget, values.privateGitControlPath);
  fs.writeFileSync(path.join(containedDirectoryTarget, 'private.txt'), values.privateUserPath);
  fs.writeFileSync(outsideFileTarget, values.privateUserPath);
  fs.writeFileSync(path.join(outsideDirectoryTarget, 'private.txt'), values.privateGitControlPath);
  const links = [
    ['contained-file-link', path.relative(notesDirectory, containedFileTarget)],
    ['contained-directory-link', path.relative(notesDirectory, containedDirectoryTarget)],
    ['outside-file-link', outsideFileTarget],
    ['outside-directory-link', outsideDirectoryTarget],
  ].map(([name, target]) => {
    const link = path.join(notesDirectory, name);
    fs.symlinkSync(target, link);
    return { file: `notes/${name}`, link, target };
  });
  return {
    fixturePackage,
    links,
    targets: [
      containedFileTarget,
      containedDirectoryTarget,
      outsideFileTarget,
      outsideDirectoryTarget,
      path.join(containedDirectoryTarget, 'private.txt'),
      path.join(outsideDirectoryTarget, 'private.txt'),
    ],
    values,
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

test('rejects contained and escaping file and directory symlinks without target I/O', t => {
  const { auditPublicPackage } = require('../src/public-audit.cjs');
  const fixture = symlinkFixture(t);
  const violations = withoutSymlinkTargetIo(
    [...fixture.links.map(link => link.link), ...fixture.targets],
    () => auditPublicPackage(fixture.fixturePackage)
  );
  assert.deepEqual(
    violations.filter(violation => violation.type === 'symlink-entry'),
    fixture.links
      .map(link => ({
        file: link.file,
        type: 'symlink-entry',
        value: fs.readlinkSync(link.link),
      }))
      .sort((left, right) => left.file.localeCompare(right.file))
  );
});

test('rejects a symlinked package root without reading its target', t => {
  const { auditPublicPackage } = require('../src/public-audit.cjs');
  const fixturePackage = temporaryPackage(t);
  const rootLink = path.join(path.dirname(fixturePackage), 'package-link');
  fs.symlinkSync(fixturePackage, rootLink);

  const violations = withoutSymlinkTargetIo([rootLink, fixturePackage], () =>
    auditPublicPackage(rootLink)
  );

  assert.deepEqual(violations, [
    {
      file: '.',
      type: 'symlink-entry',
      value: fs.readlinkSync(rootLink),
    },
  ]);
});

test('pins the root and rejects a queued directory that swaps to a symlink', t => {
  const { auditPublicPackage } = require('../src/public-audit.cjs');
  const fixturePackage = temporaryPackage(t);
  const queuedDirectory = path.join(fixturePackage, 'queued');
  const outsideRoot = path.join(path.dirname(fixturePackage), 'outside-root');
  const outsideDirectory = path.join(path.dirname(fixturePackage), 'outside-directory');
  const displacedRoot = path.join(path.dirname(fixturePackage), 'displaced-root');
  const displacedDirectory = path.join(fixturePackage, 'displaced-directory');
  fs.mkdirSync(queuedDirectory);
  fs.mkdirSync(outsideRoot);
  fs.mkdirSync(outsideDirectory);
  fs.writeFileSync(path.join(outsideRoot, 'private.txt'), privateFixtureValues().privateUserPath);
  fs.writeFileSync(path.join(outsideDirectory, 'private.txt'), privateFixtureValues().privateUserPath);
  const originalOpen = fs.openSync;
  let rootSwapped = false;
  let directorySwapped = false;
  fs.openSync = function swapAfterPinning(pathValue, ...arguments_) {
    const descriptor = originalOpen.call(this, pathValue, ...arguments_);
    if (!rootSwapped && pathValue === fixturePackage) {
      rootSwapped = true;
      fs.renameSync(fixturePackage, displacedRoot);
      fs.symlinkSync(outsideRoot, fixturePackage);
      directorySwapped = true;
      fs.renameSync(path.join(displacedRoot, 'queued'), displacedDirectory);
      fs.symlinkSync(outsideDirectory, path.join(displacedRoot, 'queued'));
    }
    return descriptor;
  };
  let violations;
  try {
    violations = withoutSymlinkTargetIo(
      [fixturePackage, queuedDirectory, outsideRoot, outsideDirectory],
      () => auditPublicPackage(fixturePackage)
    );
  } finally {
    fs.openSync = originalOpen;
    if (rootSwapped) {
      fs.unlinkSync(fixturePackage);
      fs.renameSync(displacedRoot, fixturePackage);
    }
  }

  assert.equal(rootSwapped, true);
  assert.equal(directorySwapped, true);
  assert.deepEqual(violations, [
    {
      file: 'queued',
      type: 'symlink-entry',
      value: outsideDirectory,
    },
  ]);
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
  writeSource(sourceDirectory, 'commonjs-spaced.cjs', [
    'require (',
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
  writeSource(sourceDirectory, 'esm-dynamic-spaced.mjs', [
    'import (',
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
    'const matcher = /"/;\n',
    'const endpointAfterMatcher = ',
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
    `src/commonjs-spaced.cjs:${outsideRequest}`,
    `src/esm-default.mjs:${outsideRequest}`,
    `src/esm-dynamic.mjs:${outsideRequest}`,
    `src/esm-dynamic-spaced.mjs:${outsideRequest}`,
    `src/esm-re-export.mjs:${outsideRequest}`,
    `src/esm-re-export.mjs:${outsideRequest}`,
    `src/esm-re-export.mjs:${outsideRequest}`,
    `src/esm-re-export.mjs:${outsideRequest}`,
    `src/esm-re-export.mjs:${outsideRequest}`,
    `src/esm-re-export.mjs:${outsideRequest}`,
    `src/esm-re-export.mjs:${outsideRequest}`,
    `src/esm-re-export.mjs:${outsideTypeRequest}`,
    `src/esm-side-effect.mjs:${outsideRequest}`,
  ].sort());
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
