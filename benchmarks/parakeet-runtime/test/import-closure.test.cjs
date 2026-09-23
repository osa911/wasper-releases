'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
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

function relativeRequireResolves(importingFile, request) {
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
  return candidates.some(candidatePath => fs.existsSync(candidatePath));
}

function findUnresolvedRelativeRequires(root) {
  const unresolved = [];
  for (const filePath of walkJavaScriptFiles(root)) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(REQUIRE_PATTERN)) {
      const request = match[2];
      if (!relativeRequireResolves(filePath, request)) {
        unresolved.push(`${path.relative(root, filePath)} -> ${request}`);
      }
    }
  }
  return unresolved;
}

test('every relative require resolves inside the public package', () => {
  assert.deepEqual(findUnresolvedRelativeRequires(packageRoot), []);
});
