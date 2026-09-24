'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXCLUDED_DIRECTORY_NAMES = new Set(['.git', 'node_modules']);
const SOURCE_EXTENSIONS = new Set(['.cjs', '.js', '.jsx', '.mjs', '.ts', '.tsx']);
const FORBIDDEN_TEXT_PATTERNS = Object.freeze([
  {
    type: 'private-user-path',
    pattern: /\/Users\/(?:[^\s'"`<>()\[\]{}]+)*/giu,
  },
  {
    type: 'private-workspace-path',
    pattern: /Documents\/1-my_code\/wasper(?:[\/\\][^\s'"`<>()\[\]{}]+)*/giu,
  },
  {
    type: 'private-wasper-repository-url',
    pattern:
      /(?:(?:https?|ssh):\/\/(?:git@)?|git@)?github\.com[/:]osa911[/:]wasper(?!-releases)(?:\.git)?(?:[\/?#][^\s'"`<>()\[\]{}]*|(?=[\s'"`<>()\[\]{}])|$)/giu,
  },
  {
    type: 'local-file-url',
    pattern: /\bfile:\/\/[^\s'"`<>()\[\]{}]+/giu,
  },
  {
    type: 'private-git-control-path',
    pattern: /wasper\/\.git(?:[\/\\][^\s'"`<>()\[\]{}]+)*/giu,
  },
]);
const RELATIVE_IMPORT_PATTERNS = Object.freeze([
  /(?:^|[^\w$])require\(\s*(['"])(\.[^'"]*)\1\s*\)/gmu,
  /\bimport\s+(?:[\w*${},\s]+?\s+from\s+)?(['"])(\.[^'"]*)\1/gmu,
  /\bimport\(\s*(['"])(\.[^'"]*)\1\s*\)/gu,
  /\bexport(?:\s+type)?\s*(?:\*\s*(?:as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])(\.[^'"]*)\1/gmu,
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

function readTextFile(filePath) {
  const bytes = fs.readFileSync(filePath);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const littleEndianBytes = Buffer.from(bytes.subarray(2));
    for (let index = 0; index + 1 < littleEndianBytes.length; index += 2) {
      const next = littleEndianBytes[index];
      littleEndianBytes[index] = littleEndianBytes[index + 1];
      littleEndianBytes[index + 1] = next;
    }
    return littleEndianBytes.toString('utf16le');
  }
  if (bytes.includes(0)) return null;
  return bytes.toString('utf8');
}

function walkTextFiles(root) {
  const files = [];
  const violations = [];
  const pending = [root];
  const visitedDirectories = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    const resolvedCurrent = fs.realpathSync.native(current);
    if (visitedDirectories.has(resolvedCurrent)) continue;
    visitedDirectories.add(resolvedCurrent);
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        violations.push({
          file: relativePath(root, entryPath),
          type: 'symlink-entry',
          value: fs.readlinkSync(entryPath),
        });
        continue;
      }
      if (entry.isDirectory() && EXCLUDED_DIRECTORY_NAMES.has(entry.name)) continue;
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const source = readTextFile(entryPath);
      if (source !== null) files.push({ filePath: entryPath, source });
    }
  }
  return {
    files: files.sort((left, right) => left.filePath.localeCompare(right.filePath)),
    violations: violations.sort((left, right) => left.file.localeCompare(right.file)),
  };
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
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return false;
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    return isInside(root, fs.realpathSync.native(candidate));
  });
}

function jsonStringFragments(source) {
  let parsed;
  try {
    parsed = JSON.parse(source);
  } catch {
    return [];
  }
  const fragments = [];
  const pending = [parsed];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === 'string') {
      fragments.push(value);
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        fragments.push(key);
        pending.push(child);
      }
    }
  }
  return fragments;
}

function findForbiddenText(file, source) {
  const violations = [];
  const rawValues = new Set();
  for (const { type, pattern } of FORBIDDEN_TEXT_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      violations.push({ file, type, value: match[0] });
      rawValues.add(`${type}\u0000${match[0]}`);
    }
  }
  if (path.extname(file) !== '.json') return violations;
  for (const { type, pattern } of FORBIDDEN_TEXT_PATTERNS) {
    for (const value of jsonStringFragments(source)) {
      for (const match of value.matchAll(pattern)) {
        if (rawValues.has(`${type}\u0000${match[0]}`)) continue;
        violations.push({ file, type, value: match[0] });
      }
    }
  }
  return violations;
}

function sourceWithoutComments(source) {
  let result = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "'" || character === '"' || character === '`') {
      const quote = character;
      result += character;
      for (index += 1; index < source.length; index += 1) {
        const quotedCharacter = source[index];
        result += quotedCharacter;
        if (quotedCharacter === '\\' && index + 1 < source.length) {
          index += 1;
          result += source[index];
          continue;
        }
        if (quotedCharacter === quote) break;
      }
      continue;
    }
    if (character !== '/' || (source[index + 1] !== '/' && source[index + 1] !== '*')) {
      result += character;
      continue;
    }
    const commentEnd =
      source[index + 1] === '/'
        ? source.indexOf('\n', index + 2)
        : source.indexOf('*/', index + 2);
    const end = commentEnd === -1 ? source.length : commentEnd + (source[index + 1] === '/' ? 0 : 2);
    result += source.slice(index, end).replace(/[^\r\n]/gu, ' ');
    index = end - 1;
  }
  return result;
}

function findUnresolvedRelativeImports(root, filePath, source) {
  if (!SOURCE_EXTENSIONS.has(path.extname(filePath))) return [];
  const unresolved = [];
  const importSource = sourceWithoutComments(source);
  for (const pattern of RELATIVE_IMPORT_PATTERNS) {
    for (const match of importSource.matchAll(pattern)) {
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

  const walked = walkTextFiles(root);
  const violations = [...walked.violations];
  for (const { filePath, source } of walked.files) {
    const file = relativePath(root, filePath);
    violations.push(...findForbiddenText(file, source));
    violations.push(...findUnresolvedRelativeImports(root, filePath, source));
  }
  return violations;
}

function formatPublicAuditViolation({ file, type, value }) {
  return `${file}: ${type}: ${value}`;
}

module.exports = { auditPublicPackage, formatPublicAuditViolation };
