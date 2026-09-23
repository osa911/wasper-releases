'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const packageRoot = path.resolve(__dirname, '..');
const REQUIRE_PATTERN = /require\(\s*(['"])(\.[^'"]*)\1\s*\)/gu;
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js']);

function walkJavaScriptFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(entryPath);
    }
  }
  return files.sort();
}

function isInsideRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function relativeRequireResolves(importingFile, request, root) {
  const candidate = path.resolve(path.dirname(importingFile), request);
  const candidates = [
    candidate,
    `${candidate}.cjs`,
    `${candidate}.js`,
    `${candidate}.json`,
    path.join(candidate, 'index.cjs'),
    path.join(candidate, 'index.js'),
    path.join(candidate, 'index.json'),
  ];
  return candidates.some(candidatePath => {
    if (!fs.existsSync(candidatePath)) return false;
    return isInsideRoot(root, fs.realpathSync.native(candidatePath));
  });
}

function findUnresolvedRelativeRequires(root) {
  const unresolved = [];
  const resolvedRoot = fs.realpathSync.native(root);
  for (const filePath of walkJavaScriptFiles(root)) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(REQUIRE_PATTERN)) {
      const request = match[2];
      if (!relativeRequireResolves(filePath, request, resolvedRoot)) {
        unresolved.push(`${path.relative(root, filePath)} -> ${request}`);
      }
    }
  }
  return unresolved;
}

test('every relative require resolves inside the public package', () => {
  assert.deepEqual(findUnresolvedRelativeRequires(packageRoot), []);
});

test('relative requires that escape the public package are unresolved', t => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-import-closure-'));
  const fixturePackage = path.join(fixtureRoot, 'package');
  const sourceDirectory = path.join(fixturePackage, 'src');
  fs.mkdirSync(sourceDirectory, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, 'private-module.cjs'), "'use strict';\n");
  fs.writeFileSync(
    path.join(sourceDirectory, 'escaping-require.cjs'),
    ['require(', "'../../private-module.cjs'", ');\n'].join('')
  );
  t.after(() => fs.rmSync(fixtureRoot, { force: true, recursive: true }));

  assert.deepEqual(findUnresolvedRelativeRequires(fixturePackage), [
    'src/escaping-require.cjs -> ../../private-module.cjs',
  ]);
});
