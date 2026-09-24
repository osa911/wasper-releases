'use strict';

const { spawnSync } = require('node:child_process');
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
  /(?:^|[^\w$])require\s*\(\s*(['"])(\.[^'"]*)\1\s*\)/gmu,
  /\bimport\s+(?:[\w*${},\s]+?\s+from\s+)?(['"])(\.[^'"]*)\1/gmu,
  /\bimport\s*\(\s*(['"])(\.[^'"]*)\1\s*\)/gu,
  /\bexport(?:\s+type)?\s*(?:\*\s*(?:as\s+[\w$]+)?|\{[^}]*\})\s*from\s*(['"])(\.[^'"]*)\1/gmu,
]);
const RESOLVABLE_EXTENSIONS = Object.freeze([
  '',
  '.cjs',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.node',
  '.ts',
  '.tsx',
]);
const REGULAR_EXPRESSION_PRECEDERS = new Set([
  'await',
  'case',
  'delete',
  'do',
  'else',
  'in',
  'instanceof',
  'new',
  'of',
  'return',
  'throw',
  'typeof',
  'void',
  'yield',
]);
const PYTHON_EXECUTABLE = process.platform === 'darwin' ? '/usr/bin/python3' : 'python3';
const PINNED_DIRECTORY_WALKER = String.raw`
import base64
import errno
import json
import os
import stat
import sys

EXCLUDED_DIRECTORY_NAMES = {'.git', 'node_modules'}
OPEN_FLAGS = os.O_RDONLY | os.O_NOFOLLOW
if hasattr(os, 'O_CLOEXEC'):
    OPEN_FLAGS |= os.O_CLOEXEC

files = []
symlinks = []

def fail(message):
    print(json.dumps({'error': message}))
    sys.exit(0)

def read_regular_file(descriptor):
    first_chunk = os.read(descriptor, 8192)
    if b'\x00' in first_chunk and not first_chunk.startswith((b'\xff\xfe', b'\xfe\xff')):
        return None
    chunks = [first_chunk]
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            return b''.join(chunks)
        chunks.append(chunk)

def record_symlink(parent_descriptor, name, logical_path):
    try:
        target = os.readlink(name, dir_fd=parent_descriptor)
    except OSError as error:
        fail('could not read a symlink without following it: ' + str(error))
    symlinks.append({'file': logical_path, 'type': 'symlink-entry', 'value': target})

def walk(directory_descriptor, parts):
    try:
        names = sorted(os.listdir(directory_descriptor))
    except OSError as error:
        fail('could not enumerate a pinned directory: ' + str(error))
    for name in names:
        logical_path = '/'.join(parts + [name])
        try:
            descriptor = os.open(name, OPEN_FLAGS, dir_fd=directory_descriptor)
        except OSError as error:
            if error.errno == errno.ELOOP:
                record_symlink(directory_descriptor, name, logical_path)
                continue
            fail('could not open an entry without following it: ' + str(error))
        try:
            metadata = os.fstat(descriptor)
            if stat.S_ISDIR(metadata.st_mode):
                if name not in EXCLUDED_DIRECTORY_NAMES:
                    walk(descriptor, parts + [name])
            elif stat.S_ISREG(metadata.st_mode):
                content = read_regular_file(descriptor)
                if content is None:
                    files.append({'file': logical_path, 'binary': True})
                else:
                    files.append({
                        'file': logical_path,
                        'bytes': base64.b64encode(content).decode('ascii'),
                    })
        except OSError as error:
            fail('could not inspect a pinned entry: ' + str(error))
        finally:
            os.close(descriptor)

try:
    root_descriptor = 3
    if not stat.S_ISDIR(os.fstat(root_descriptor).st_mode):
        fail('the pinned public package root is not a directory')
    walk(root_descriptor, [])
    print(json.dumps({'files': files, 'violations': symlinks}))
except OSError as error:
    fail('could not safely walk the public package: ' + str(error))
`;

function decodeTextBytes(bytes) {
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

function noFollowDirectoryFlags() {
  const { O_DIRECTORY, O_NOFOLLOW, O_RDONLY } = fs.constants;
  if (!Number.isInteger(O_DIRECTORY) || !Number.isInteger(O_NOFOLLOW)) {
    throw new Error('public audit requires O_DIRECTORY and O_NOFOLLOW support');
  }
  return O_RDONLY | O_DIRECTORY | O_NOFOLLOW;
}

function rootSymlinkViolation(root) {
  let metadata;
  try {
    metadata = fs.lstatSync(root);
  } catch (error) {
    throw new Error(`public audit could not inspect its root without following it: ${error.message}`);
  }
  if (!metadata.isSymbolicLink()) return null;
  try {
    return {
      file: '.',
      type: 'symlink-entry',
      value: fs.readlinkSync(root),
    };
  } catch (error) {
    throw new Error(`public audit could not read its root symlink without following it: ${error.message}`);
  }
}

function runPinnedDirectoryWalker(rootDescriptor) {
  const result = spawnSync(PYTHON_EXECUTABLE, ['-c', PINNED_DIRECTORY_WALKER], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe', rootDescriptor],
  });
  if (result.error) {
    throw new Error(`public audit requires safe descriptor traversal: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `public audit descriptor traversal failed: ${(result.stderr || 'unknown helper failure').trim()}`
    );
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new Error('public audit descriptor traversal returned an invalid response');
  }
  if (typeof response?.error === 'string') {
    throw new Error(`public audit descriptor traversal failed safely: ${response.error}`);
  }
  if (!Array.isArray(response?.files) || !Array.isArray(response?.violations)) {
    throw new Error('public audit descriptor traversal returned an invalid result');
  }
  return response;
}

function walkTextFiles(root) {
  let rootDescriptor;
  try {
    rootDescriptor = fs.openSync(root, noFollowDirectoryFlags());
  } catch (error) {
    const violation = rootSymlinkViolation(root);
    if (violation !== null) return { files: [], violations: [violation], knownFiles: new Set() };
    throw new Error(`public audit could not pin its root without following it: ${error.message}`);
  }
  try {
    if (!fs.fstatSync(rootDescriptor).isDirectory()) {
      throw new TypeError('public package root must be a directory');
    }
    const walked = runPinnedDirectoryWalker(rootDescriptor);
    const knownFiles = new Set();
    const files = [];
    for (const record of walked.files) {
      if (
        typeof record?.file !== 'string' ||
        (record.binary !== true && typeof record.bytes !== 'string')
      ) {
        throw new Error('public audit descriptor traversal returned an invalid file record');
      }
      knownFiles.add(record.file);
      if (record.binary === true) continue;
      const source = decodeTextBytes(Buffer.from(record.bytes, 'base64'));
      if (source !== null) files.push({ file: record.file, source });
    }
    return {
      files: files.sort((left, right) => left.file.localeCompare(right.file)),
      violations: walked.violations.sort((left, right) => left.file.localeCompare(right.file)),
      knownFiles,
    };
  } finally {
    fs.closeSync(rootDescriptor);
  }
}

function importRequestResolves(importingFile, request, knownFiles) {
  const basePath = path.posix.normalize(path.posix.join(path.posix.dirname(importingFile), request));
  const candidates = [
    ...RESOLVABLE_EXTENSIONS.map(extension => `${basePath}${extension}`),
    ...RESOLVABLE_EXTENSIONS.filter(extension => extension !== '').map(extension =>
      path.posix.join(basePath, `index${extension}`)
    ),
  ];
  return candidates.some(candidate => knownFiles.has(candidate));
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

function copyQuotedLiteral(source, start) {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index += 1;
  }
  return source.length;
}

function copyRegularExpression(source, start) {
  let inCharacterClass = false;
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '[') inCharacterClass = true;
    if (character === ']') inCharacterClass = false;
    if (character === '/' && !inCharacterClass) {
      index += 1;
      while (/[a-z]/iu.test(source[index] ?? '')) index += 1;
      return index;
    }
    if (character === '\n' || character === '\r') return index;
    index += 1;
  }
  return source.length;
}

function sourceWithoutComments(source) {
  let result = '';
  let expectsExpression = true;
  for (let index = 0; index < source.length; ) {
    const character = source[index];
    const next = source[index + 1];
    if (/\s/u.test(character)) {
      result += character;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === '`') {
      const end = copyQuotedLiteral(source, index);
      result += source.slice(index, end);
      index = end;
      expectsExpression = false;
      continue;
    }
    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2);
      const commentEnd = end === -1 ? source.length : end;
      result += source.slice(index, commentEnd).replace(/[^\r\n]/gu, ' ');
      index = commentEnd;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const commentEnd = end === -1 ? source.length : end + 2;
      result += source.slice(index, commentEnd).replace(/[^\r\n]/gu, ' ');
      index = commentEnd;
      continue;
    }
    if (character === '/' && expectsExpression) {
      const end = copyRegularExpression(source, index);
      result += source.slice(index, end);
      index = end;
      expectsExpression = false;
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      let end = index + 1;
      while (/[\w$]/u.test(source[end] ?? '')) end += 1;
      const identifier = source.slice(index, end);
      result += identifier;
      index = end;
      expectsExpression = REGULAR_EXPRESSION_PRECEDERS.has(identifier);
      continue;
    }
    if (/[0-9]/u.test(character)) {
      let end = index + 1;
      while (/[\w.]/u.test(source[end] ?? '')) end += 1;
      result += source.slice(index, end);
      index = end;
      expectsExpression = false;
      continue;
    }
    result += character;
    index += 1;
    if (character === ')' || character === ']' || character === '}') {
      expectsExpression = false;
    } else if (character !== '.') {
      expectsExpression = true;
    }
  }
  return result;
}

function findUnresolvedRelativeImports(file, source, knownFiles) {
  if (!SOURCE_EXTENSIONS.has(path.extname(file))) return [];
  const unresolved = [];
  const importSource = sourceWithoutComments(source);
  for (const pattern of RELATIVE_IMPORT_PATTERNS) {
    for (const match of importSource.matchAll(pattern)) {
      const request = match[2];
      if (!importRequestResolves(file, request, knownFiles)) {
        unresolved.push({
          file,
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
  const walked = walkTextFiles(path.resolve(packageRoot));
  const violations = [...walked.violations];
  for (const { file, source } of walked.files) {
    violations.push(...findForbiddenText(file, source));
    violations.push(...findUnresolvedRelativeImports(file, source, walked.knownFiles));
  }
  return violations;
}

function formatPublicAuditViolation({ file, type, value }) {
  return `${file}: ${type}: ${value}`;
}

module.exports = { auditPublicPackage, formatPublicAuditViolation };
