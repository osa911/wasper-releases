'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', 'node_modules']);
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const FORBIDDEN_TEXT_PATTERNS = Object.freeze([
  {
    type: 'private-user-path',
    pattern: /\/Users\/(?:[^\s'"`<>()\[\]{}]+)*/gu,
  },
  {
    type: 'private-workspace-path',
    pattern: /Documents\/1-my_code\/wasper(?:[\/\\][^\s'"`<>()\[\]{}]+)*/gu,
  },
  {
    type: 'private-wasper-repository-url',
    pattern:
      /(?:https?:\/\/)?github\.com\/osa911\/wasper(?!-releases)(?:[\/?#][^\s'"`<>()\[\]{}]*|(?=[\s'"`<>()\[\]{}])|$)/gu,
  },
  {
    type: 'local-file-url',
    pattern: /\bfile:\/\/[^\s'"`<>()\[\]{}]+/gu,
  },
  {
    type: 'private-git-control-path',
    pattern: /wasper\/\.git(?:[\/\\][^\s'"`<>()\[\]{}]+)*/gu,
  },
]);
const RELATIVE_IMPORT_PATTERNS = Object.freeze([
  /(?:^|[^\w$])require\(\s*(['"])(\.[^'"]*)\1\s*\)/gmu,
  /\bimport\s+(?:[\w*${},\s]+?\s+from\s+)?(['"])(\.[^'"]*)\1/gmu,
  /\bimport\(\s*(['"])(\.[^'"]*)\1\s*\)/gu,
]);
const RESOLVABLE_EXTENSIONS = Object.freeze(['', '.cjs', '.js', '.json', '.mjs', '.node']);

function relativePath(root, candidate) {
  return path.relative(root, candidate).split(path.sep).join('/');
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isTextFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  return !bytes.includes(0);
}

function walkTextFiles(root) {
  const files = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      if (isTextFile(entryPath)) files.push(entryPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function importRequestResolves(importingFile, request, root) {
  const basePath = path.resolve(path.dirname(importingFile), request);
  const candidates = [
    ...RESOLVABLE_EXTENSIONS.map(extension => `${basePath}${extension}`),
    ...RESOLVABLE_EXTENSIONS.filter(extension => extension !== '').map(extension =>
      path.join(basePath, `index${extension}`)
    ),
  ];
  return candidates.some(candidate => {
    let stat;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    return isInside(root, fs.realpathSync.native(candidate));
  });
}

function findUnresolvedRelativeImports(root, filePath, source) {
  if (!SOURCE_EXTENSIONS.has(path.extname(filePath))) return [];
  const unresolved = [];
  for (const pattern of RELATIVE_IMPORT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      const request = match[2];
      if (!importRequestResolves(filePath, request, root)) {
        unresolved.push({
          file: relativePath(root, filePath),
          type: 'unresolved-relative-import',
          value: request,
        });
      }
    }
  }
  return unresolved;
}

function auditPublicPackage(packageRoot) {
  if (typeof packageRoot !== 'string' || packageRoot.trim() === '') {
    throw new TypeError('public package root must be a non-empty path');
  }
  const root = fs.realpathSync.native(packageRoot);
  if (!fs.statSync(root).isDirectory()) {
    throw new TypeError('public package root must be a directory');
  }

  const violations = [];
  for (const filePath of walkTextFiles(root)) {
    const source = fs.readFileSync(filePath, 'utf8');
    const file = relativePath(root, filePath);
    for (const { type, pattern } of FORBIDDEN_TEXT_PATTERNS) {
      for (const match of source.matchAll(pattern)) {
        violations.push({ file, type, value: match[0] });
      }
    }
    violations.push(...findUnresolvedRelativeImports(root, filePath, source));
  }
  return violations;
}

function formatPublicAuditViolation({ file, type, value }) {
  return `${file}: ${type}: ${value}`;
}

module.exports = { auditPublicPackage, formatPublicAuditViolation };
