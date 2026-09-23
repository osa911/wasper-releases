'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BYTE_LIMITS = Object.freeze({
  json: 16 * 1024 * 1024,
  jsonl: 16 * 1024 * 1024,
  text: 4 * 1024 * 1024,
  source: 64 * 1024 * 1024,
  wav: 64 * 1024 * 1024,
});

function fail(message) {
  throw new Error(message);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

function sameDirectoryIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function normalizePlatformAlias(absolute, filesystem) {
  for (const alias of ['/var', '/tmp']) {
    if (absolute !== alias && !absolute.startsWith(`${alias}${path.sep}`)) continue;
    let info;
    try {
      info = filesystem.lstatSync(alias);
    } catch {
      continue;
    }
    if (!info.isSymbolicLink()) continue;
    return path.join(filesystem.realpathSync.native(alias), path.relative(alias, absolute));
  }
  return absolute;
}

function captureDirectoryChain(directory, label, filesystem) {
  const absolute = normalizePlatformAlias(path.resolve(directory), filesystem);
  const parsed = path.parse(absolute);
  const directories = [];
  let current = parsed.root;
  for (const segment of ['', ...path.relative(parsed.root, absolute).split(path.sep)]) {
    if (segment !== '') current = path.join(current, segment);
    let info;
    try {
      info = filesystem.lstatSync(current);
    } catch {
      fail(`${label} is missing`);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail(`${label} contains a symlink or non-directory ancestor`);
    }
    directories.push(Object.freeze({ path: current, dev: info.dev, ino: info.ino }));
  }
  return Object.freeze(directories);
}

function assertDirectoryChain(directories, label, filesystem) {
  for (const expected of directories) {
    let current;
    try {
      current = filesystem.lstatSync(expected.path);
    } catch {
      fail(`${label} ancestor changed or was replaced`);
    }
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameDirectoryIdentity(current, expected)
    ) {
      fail(`${label} ancestor changed or was replaced`);
    }
  }
}

function bindTrustedRoot(rootPath, label = 'trusted containment root', filesystem = fs) {
  const realPath = normalizePlatformAlias(path.resolve(rootPath), filesystem);
  const ancestors = captureDirectoryChain(realPath, label, filesystem);
  const descriptor = filesystem.openSync(
    realPath,
    filesystem.constants.O_RDONLY | (filesystem.constants.O_NOFOLLOW ?? 0)
  );
  try {
    const opened = filesystem.fstatSync(descriptor);
    const expected = ancestors.at(-1);
    if (!opened.isDirectory() || !sameDirectoryIdentity(opened, expected)) {
      fail(`${label} changed while being bound`);
    }
    assertDirectoryChain(ancestors, label, filesystem);
  } finally {
    filesystem.closeSync(descriptor);
  }
  return Object.freeze({ realPath, ancestors });
}

function normalizeRoot(root, label, filesystem) {
  if (!root || typeof root.realPath !== 'string') {
    fail(`${label} requires an explicit trusted containment root`);
  }
  if (Array.isArray(root.ancestors)) {
    assertDirectoryChain(root.ancestors, `${label} trusted containment root`, filesystem);
    return root;
  }
  return bindTrustedRoot(root.realPath, `${label} trusted containment root`, filesystem);
}

function assertNoSymlinkAncestors(filePath, label, filesystem = fs) {
  const absolute = path.resolve(filePath);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of path.relative(parsed.root, absolute).split(path.sep)) {
    if (segment === '') continue;
    current = path.join(current, segment);
    if (!filesystem.existsSync(current)) break;
    if (filesystem.lstatSync(current).isSymbolicLink()) {
      if (current === '/var' || current === '/tmp') {
        current = filesystem.realpathSync.native(current);
        continue;
      }
      fail(`${label} contains a symlink ancestor`);
    }
  }
  return absolute;
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function snapshotRegularFile(filePath, { label, root, maxBytes, filesystem = fs }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new TypeError('snapshot maxBytes must be a positive safe integer');
  }
  const trustedRoot = normalizeRoot(root, label, filesystem);
  const absolute = normalizePlatformAlias(path.resolve(filePath), filesystem);
  if (!isWithin(trustedRoot.realPath, absolute)) {
    fail(`${label} escapes its trusted containment root`);
  }
  const ancestors = captureDirectoryChain(path.dirname(absolute), label, filesystem);
  assertDirectoryChain(trustedRoot.ancestors, `${label} trusted containment root`, filesystem);
  assertDirectoryChain(ancestors, label, filesystem);
  let namedBefore;
  try {
    namedBefore = filesystem.lstatSync(absolute);
  } catch {
    fail(`${label} is missing`);
  }
  if (namedBefore.isSymbolicLink() || !namedBefore.isFile()) {
    fail(`${label} must be a non-symlink regular file`);
  }
  if (namedBefore.size > maxBytes) fail(`${label} exceeds its ${maxBytes}-byte size limit`);
  let descriptor;
  try {
    assertDirectoryChain(trustedRoot.ancestors, `${label} trusted containment root`, filesystem);
    assertDirectoryChain(ancestors, label, filesystem);
    descriptor = filesystem.openSync(
      absolute,
      filesystem.constants.O_RDONLY | (filesystem.constants.O_NOFOLLOW ?? 0)
    );
  } catch (error) {
    fail(`${label} could not be opened without following symlinks: ${error.message}`);
  }
  try {
    const openedBefore = filesystem.fstatSync(descriptor);
    assertDirectoryChain(trustedRoot.ancestors, `${label} trusted containment root`, filesystem);
    assertDirectoryChain(ancestors, label, filesystem);
    if (!openedBefore.isFile() || !sameIdentity(namedBefore, openedBefore)) {
      fail(`${label} changed while being opened`);
    }
    if (openedBefore.size > maxBytes) fail(`${label} exceeds its ${maxBytes}-byte size limit`);
    const bounded = Buffer.allocUnsafe(maxBytes + 1);
    let length = 0;
    while (length < bounded.length) {
      const bytesRead = filesystem.readSync(
        descriptor,
        bounded,
        length,
        Math.min(64 * 1024, bounded.length - length),
        null
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) fail(`${label} exceeds its ${maxBytes}-byte size limit`);
    const bytes = bounded.subarray(0, length);
    const openedAfter = filesystem.fstatSync(descriptor);
    assertDirectoryChain(trustedRoot.ancestors, `${label} trusted containment root`, filesystem);
    assertDirectoryChain(ancestors, label, filesystem);
    const namedAfter = filesystem.lstatSync(absolute);
    if (
      namedAfter.isSymbolicLink() ||
      !namedAfter.isFile() ||
      !sameIdentity(openedBefore, openedAfter) ||
      !sameIdentity(openedAfter, namedAfter) ||
      openedBefore.mtimeMs !== openedAfter.mtimeMs
    ) {
      fail(`${label} changed while being read`);
    }
    const realPath = filesystem.realpathSync.native(absolute);
    if (!isWithin(trustedRoot.realPath, realPath)) {
      fail(`${label} escapes its trusted containment root`);
    }
    assertDirectoryChain(trustedRoot.ancestors, `${label} trusted containment root`, filesystem);
    assertDirectoryChain(ancestors, label, filesystem);
    return {
      bytes,
      realPath,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  } finally {
    filesystem.closeSync(descriptor);
  }
}

module.exports = {
  BYTE_LIMITS,
  assertDirectoryChain,
  assertNoSymlinkAncestors,
  bindTrustedRoot,
  snapshotRegularFile,
};
