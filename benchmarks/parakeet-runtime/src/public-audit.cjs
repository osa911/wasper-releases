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
const SYMLINK_TARGET_REDACTION = '[redacted symlink target]';
const MAX_AUDIT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_AUDIT_TOTAL_BYTES = 8 * 1024 * 1024;
const MAX_AUDIT_ENTRY_COUNT = 50_000;
const MAX_AUDIT_METADATA_BYTES = 8 * 1024 * 1024;
const MAX_AUDIT_VIOLATIONS = 10_000;
const MAX_AUDIT_HELPER_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEFAULT_AUDIT_LIMITS = Object.freeze({
  maxEntries: MAX_AUDIT_ENTRY_COUNT,
  maxFileBytes: MAX_AUDIT_FILE_BYTES,
  maxMetadataBytes: MAX_AUDIT_METADATA_BYTES,
  maxTotalBytes: MAX_AUDIT_TOTAL_BYTES,
  maxViolations: MAX_AUDIT_VIOLATIONS,
});
const AUDIT_PYTHON_ENV = Object.freeze({
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin',
  PYTHONHASHSEED: '0',
});
const AUDIT_PYTHON_PROBE = String.raw`
import os
import stat

assert hasattr(os, 'O_NOFOLLOW') and hasattr(os, 'O_DIRECTORY')
assert os.open in os.supports_dir_fd
assert os.stat in os.supports_dir_fd
assert os.stat in os.supports_follow_symlinks
assert os.readlink in os.supports_dir_fd
assert os.scandir in os.supports_fd

flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
descriptor = os.open('/', flags)
try:
    assert stat.S_ISDIR(os.fstat(descriptor).st_mode)
    with os.scandir(descriptor) as entries:
        next(entries, None)
    os.stat('.', dir_fd=descriptor, follow_symlinks=False)
    try:
        os.readlink('.', dir_fd=descriptor)
    except OSError:
        pass
    else:
        raise AssertionError('readlink unexpectedly followed a non-link')
    child_descriptor = os.open('.', flags, dir_fd=descriptor)
    os.close(child_descriptor)
finally:
    os.close(descriptor)
`;
const AUDIT_PYTHON_PROBE_ARGUMENTS = Object.freeze([
  '-I',
  '-S',
  '-B',
  '-c',
  AUDIT_PYTHON_PROBE,
]);

function publicAuditPythonExecutable(platform = process.platform) {
  return platform === 'darwin' || platform === 'linux' ? '/usr/bin/python3' : null;
}

function publicAuditPythonProbeArguments() {
  return [...AUDIT_PYTHON_PROBE_ARGUMENTS];
}

function resolveAuditLimits(overrides = undefined) {
  if (overrides === undefined) return DEFAULT_AUDIT_LIMITS;
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('public audit limits must be an object');
  }
  const limits = { ...DEFAULT_AUDIT_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in limits)) throw new TypeError(`public audit does not support the ${key} limit`);
    if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_AUDIT_LIMITS[key]) {
      throw new RangeError(`public audit ${key} limit must be a safe positive integer`);
    }
    limits[key] = value;
  }
  return Object.freeze(limits);
}

function pinnedDirectoryWalker(limits) {
  return String.raw`
import base64
import json
import os
import stat
import sys

EXCLUDED_DIRECTORY_NAMES = {'.git', 'node_modules'}
MAX_AUDIT_ENTRY_COUNT = ${limits.maxEntries}
MAX_AUDIT_FILE_BYTES = ${limits.maxFileBytes}
MAX_AUDIT_METADATA_BYTES = ${limits.maxMetadataBytes}
MAX_AUDIT_TOTAL_BYTES = ${limits.maxTotalBytes}
MAX_AUDIT_VIOLATIONS = ${limits.maxViolations}
SYMLINK_TARGET_REDACTION = '${SYMLINK_TARGET_REDACTION}'

if (
    not hasattr(os, 'O_NOFOLLOW')
    or not hasattr(os, 'O_DIRECTORY')
    or os.open not in os.supports_dir_fd
    or os.stat not in os.supports_dir_fd
    or os.stat not in os.supports_follow_symlinks
    or os.readlink not in os.supports_dir_fd
    or os.scandir not in os.supports_fd
):
    print(json.dumps({'error': 'no-follow descriptor support is unavailable'}))
    sys.exit(0)

OPEN_FLAGS = os.O_RDONLY | os.O_NOFOLLOW
DIRECTORY_FLAGS = OPEN_FLAGS | os.O_DIRECTORY
if hasattr(os, 'O_CLOEXEC'):
    OPEN_FLAGS |= os.O_CLOEXEC
    DIRECTORY_FLAGS |= os.O_CLOEXEC

files = []
violations = []
entry_count = 0
metadata_bytes = 0
total_regular_bytes = 0

def fail(message):
    print(json.dumps({'error': message}))
    sys.exit(0)

def record_entry(logical_path):
    global entry_count, metadata_bytes
    entry_count += 1
    if entry_count > MAX_AUDIT_ENTRY_COUNT:
        fail('public audit entry limit exceeded before serializing directory entries')
    metadata_bytes += len(logical_path.encode('utf-8', 'surrogateescape')) + 96
    if metadata_bytes > MAX_AUDIT_METADATA_BYTES:
        fail('public audit metadata limit exceeded before serializing directory entries')

def record_violation(logical_path, violation_type, value):
    if len(violations) >= MAX_AUDIT_VIOLATIONS:
        fail('public audit violation limit exceeded before serializing violations')
    violations.append({
        'file': logical_path,
        'type': violation_type,
        'value': value,
    })

def classify_entry(parent_descriptor, name):
    try:
        return os.stat(name, dir_fd=parent_descriptor, follow_symlinks=False)
    except OSError:
        fail('could not classify an entry without following it')

def special_kind(mode):
    if stat.S_ISFIFO(mode):
        return 'fifo'
    if stat.S_ISCHR(mode):
        return 'character-device'
    if stat.S_ISBLK(mode):
        return 'block-device'
    if stat.S_ISSOCK(mode):
        return 'socket'
    return 'unknown-special-entry'

def read_regular_file(descriptor, expected_size):
    remaining = expected_size
    chunks = []
    while remaining > 0:
        chunk = os.read(descriptor, min(65536, remaining))
        if not chunk:
            fail('a regular file changed while the public audit was reading it')
        chunks.append(chunk)
        remaining -= len(chunk)
    if os.read(descriptor, 1):
        fail('a regular file exceeded its checked size while the public audit was reading it')
    return b''.join(chunks)

def record_regular_file(parent_descriptor, name, logical_path, expected_size):
    try:
        descriptor = os.open(name, OPEN_FLAGS, dir_fd=parent_descriptor)
    except OSError:
        fail('could not open a regular entry without following it')
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size != expected_size:
            fail('a regular file changed while the public audit was opening it')
        content = read_regular_file(descriptor, expected_size)
        if b'\x00' in content and not content.startswith((b'\xff\xfe', b'\xfe\xff')):
            files.append({'file': logical_path, 'size': expected_size, 'binary': True})
        else:
            files.append({
                'file': logical_path,
                'size': expected_size,
                'bytes': base64.b64encode(content).decode('ascii'),
            })
    finally:
        os.close(descriptor)

def walk_directory(parent_descriptor, name, logical_path, parts):
    try:
        descriptor = os.open(name, DIRECTORY_FLAGS, dir_fd=parent_descriptor)
    except OSError:
        fail('could not open a directory entry without following it')
    try:
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            fail('a directory changed while the public audit was opening it')
        walk(descriptor, parts)
    finally:
        os.close(descriptor)

def walk(directory_descriptor, parts):
    global total_regular_bytes
    try:
        entries = os.scandir(directory_descriptor)
    except OSError:
        fail('could not enumerate a pinned directory')
    try:
        for entry in entries:
            name = entry.name
            if not isinstance(name, str):
                fail('could not safely enumerate a directory entry name')
            logical_path = '/'.join(parts + [name])
            record_entry(logical_path)
            metadata = classify_entry(directory_descriptor, name)
            if stat.S_ISLNK(metadata.st_mode):
                record_violation(logical_path, 'symlink-entry', SYMLINK_TARGET_REDACTION)
            elif stat.S_ISDIR(metadata.st_mode):
                if name not in EXCLUDED_DIRECTORY_NAMES:
                    walk_directory(directory_descriptor, name, logical_path, parts + [name])
            elif stat.S_ISREG(metadata.st_mode):
                if metadata.st_size > MAX_AUDIT_FILE_BYTES:
                    fail('public audit per-file limit exceeded before reading a regular file')
                if total_regular_bytes + metadata.st_size > MAX_AUDIT_TOTAL_BYTES:
                    fail('public audit aggregate limit exceeded before reading regular files')
                total_regular_bytes += metadata.st_size
                record_regular_file(directory_descriptor, name, logical_path, metadata.st_size)
            else:
                record_violation(logical_path, 'special-entry', special_kind(metadata.st_mode))
    except OSError:
        fail('could not enumerate a pinned directory')
    finally:
        entries.close()

try:
    root_descriptor = 3
    if not stat.S_ISDIR(os.fstat(root_descriptor).st_mode):
        fail('the pinned public package root is not a directory')
    walk(root_descriptor, [])
    print(json.dumps({'files': files, 'violations': violations}))
except OSError:
    fail('could not safely walk the public package')
`;
}

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
  return {
    file: '.',
    type: 'symlink-entry',
    value: SYMLINK_TARGET_REDACTION,
  };
}

function runPinnedDirectoryWalker(rootDescriptor, limits) {
  const executable = publicAuditPythonExecutable();
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) {
    throw new Error('public audit requires an absolute system Python executable');
  }
  const result = spawnSync(executable, ['-I', '-S', '-B', '-c', pinnedDirectoryWalker(limits)], {
    cwd: '/',
    encoding: 'utf8',
    env: AUDIT_PYTHON_ENV,
    maxBuffer: MAX_AUDIT_HELPER_OUTPUT_BYTES,
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

function walkTextFiles(root, limits) {
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
    const walked = runPinnedDirectoryWalker(rootDescriptor, limits);
    if (walked.violations.length > limits.maxViolations) {
      throw new Error('public audit descriptor traversal exceeded its violation limit');
    }
    const knownFiles = new Set();
    const files = [];
    let totalBytes = 0;
    for (const record of walked.files) {
      if (
        typeof record?.file !== 'string' ||
        !Number.isSafeInteger(record.size) ||
        record.size < 0 ||
        record.size > limits.maxFileBytes ||
        (record.binary !== true && typeof record.bytes !== 'string')
      ) {
        throw new Error('public audit descriptor traversal returned an invalid file record');
      }
      totalBytes += record.size;
      if (totalBytes > limits.maxTotalBytes) {
        throw new Error('public audit descriptor traversal exceeded its aggregate limit');
      }
      knownFiles.add(record.file);
      if (record.binary === true) continue;
      const bytes = Buffer.from(record.bytes, 'base64');
      if (bytes.length !== record.size) {
        throw new Error('public audit descriptor traversal returned an invalid text payload');
      }
      const source = decodeTextBytes(bytes);
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

function literalStringValue(source, start, end) {
  const literal = source.slice(start, end);
  if (literal[0] === '"') {
    try {
      return JSON.parse(literal);
    } catch {
      return null;
    }
  }
  return literal.slice(1, -1).replace(/\\(['"\\])/gu, '$1');
}

function lexTemplateLiteral(source, start) {
  const tokens = [];
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '`') return { end: index + 1, tokens };
    if (character === '$' && source[index + 1] === '{') {
      const expression = lexSourceRange(source, index + 2, true);
      tokens.push(...expression.tokens);
      index = expression.index;
      continue;
    }
    index += 1;
  }
  return { end: source.length, tokens };
}

function lexSourceRange(source, start = 0, stopAtInterpolationEnd = false) {
  const tokens = [];
  let expectsExpression = true;
  let interpolationDepth = 0;
  for (let index = start; index < source.length; ) {
    const character = source[index];
    const next = source[index + 1];
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '`') {
      const template = lexTemplateLiteral(source, index);
      tokens.push({ type: 'template' });
      tokens.push(...template.tokens);
      index = template.end;
      expectsExpression = false;
      continue;
    }
    if (character === "'" || character === '"') {
      const end = copyQuotedLiteral(source, index);
      tokens.push({ type: 'string', value: literalStringValue(source, index, end) });
      index = end;
      expectsExpression = false;
      continue;
    }
    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index + 2);
      index = end === -1 ? source.length : end;
      continue;
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (character === '/' && expectsExpression) {
      const end = copyRegularExpression(source, index);
      tokens.push({ type: 'regular-expression', value: source.slice(index, end) });
      index = end;
      expectsExpression = false;
      continue;
    }
    if (/[A-Za-z_$]/u.test(character)) {
      let end = index + 1;
      while (/[\w$]/u.test(source[end] ?? '')) end += 1;
      const identifier = source.slice(index, end);
      tokens.push({ type: 'identifier', value: identifier });
      index = end;
      expectsExpression = REGULAR_EXPRESSION_PRECEDERS.has(identifier);
      continue;
    }
    if (/[0-9]/u.test(character)) {
      let end = index + 1;
      while (/[\w.]/u.test(source[end] ?? '')) end += 1;
      tokens.push({ type: 'number', value: source.slice(index, end) });
      index = end;
      expectsExpression = false;
      continue;
    }
    if (stopAtInterpolationEnd && character === '}' && interpolationDepth === 0) {
      return { index: index + 1, tokens };
    }
    tokens.push({ type: 'punctuator', value: character });
    index += 1;
    if (stopAtInterpolationEnd && character === '{') interpolationDepth += 1;
    if (stopAtInterpolationEnd && character === '}') interpolationDepth -= 1;
    if (character === ')' || character === ']' || character === '}') {
      expectsExpression = false;
    } else if (character !== '.') {
      expectsExpression = true;
    }
  }
  return { index: source.length, tokens };
}

function lexSourceTokens(source) {
  return lexSourceRange(source).tokens;
}

function isIdentifier(token, value) {
  return token?.type === 'identifier' && token.value === value;
}

function isPunctuator(token, value) {
  return token?.type === 'punctuator' && token.value === value;
}

function relativeStringValue(token) {
  return token?.type === 'string' && typeof token.value === 'string' && token.value.startsWith('.')
    ? token.value
    : null;
}

function relativeFirstCallArgument(tokens, index) {
  if (!isPunctuator(tokens[index + 1], '(')) return null;
  return relativeStringValue(tokens[index + 2]);
}

function closingPunctuator(tokens, start, opening, closing) {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    if (isPunctuator(tokens[index], opening)) depth += 1;
    if (isPunctuator(tokens[index], closing)) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function sourceImportRequests(source) {
  const tokens = lexSourceTokens(source);
  const requests = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isIdentifier(token, 'require')) {
      if (isPunctuator(tokens[index - 1], '.')) continue;
      const request = relativeFirstCallArgument(tokens, index);
      if (request !== null) requests.push(request);
      continue;
    }
    if (isIdentifier(token, 'import')) {
      if (isPunctuator(tokens[index - 1], '.')) continue;
      const request = relativeFirstCallArgument(tokens, index);
      if (request !== null) {
        requests.push(request);
        continue;
      }
      const sideEffectRequest = relativeStringValue(tokens[index + 1]);
      if (sideEffectRequest !== null) {
        requests.push(sideEffectRequest);
        continue;
      }
      for (let next = index + 1; next + 1 < tokens.length; next += 1) {
        if (isPunctuator(tokens[next], ';') || tokens[next].type === 'template') break;
        if (isIdentifier(tokens[next], 'from')) {
          const request = relativeStringValue(tokens[next + 1]);
          if (request !== null) requests.push(request);
          break;
        }
      }
      continue;
    }
    if (!isIdentifier(token, 'export')) continue;
    let next = index + 1;
    if (isIdentifier(tokens[next], 'type')) next += 1;
    if (isPunctuator(tokens[next], '{')) {
      next = closingPunctuator(tokens, next, '{', '}');
      if (next === -1) continue;
      next += 1;
    } else if (isPunctuator(tokens[next], '*')) {
      next += 1;
      if (isIdentifier(tokens[next], 'as')) next += 2;
    } else {
      continue;
    }
    if (!isIdentifier(tokens[next], 'from')) continue;
    const request = relativeStringValue(tokens[next + 1]);
    if (request !== null) requests.push(request);
  }
  return requests;
}

function findUnresolvedRelativeImports(file, source, knownFiles) {
  if (!SOURCE_EXTENSIONS.has(path.extname(file))) return [];
  const unresolved = [];
  for (const request of sourceImportRequests(source)) {
    if (!importRequestResolves(file, request, knownFiles)) {
      unresolved.push({
        file,
        type: 'unresolved-relative-import',
        value: request,
      });
    }
  }
  return unresolved;
}

function auditPublicPackage(packageRoot, { limits } = {}) {
  if (typeof packageRoot !== 'string' || packageRoot.trim() === '') {
    throw new TypeError('public package root must be a non-empty path');
  }
  const walked = walkTextFiles(path.resolve(packageRoot), resolveAuditLimits(limits));
  const violations = [...walked.violations];
  for (const { file, source } of walked.files) {
    violations.push(...findForbiddenText(file, source));
    violations.push(...findUnresolvedRelativeImports(file, source, walked.knownFiles));
  }
  return violations;
}

function escapeTerminalControls(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, character =>
    `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`
  );
}

function formatPublicAuditViolation({ file, type, value }) {
  return `${escapeTerminalControls(file)}: ${escapeTerminalControls(type)}: ${escapeTerminalControls(value)}`;
}

module.exports = {
  auditPublicPackage,
  formatPublicAuditViolation,
  publicAuditPythonExecutable,
  publicAuditPythonProbeArguments,
};
