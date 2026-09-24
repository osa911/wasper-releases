'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const {
  resolveLayout,
  writeOwnershipMarker,
  expectedOwnershipMarker,
  OWNER_FILE,
  isInside,
} = require('../config.cjs');

function ownedRuntimeStorage(supplied, { create = true } = {}) {
  const layout = resolveLayout({
    cacheDir: supplied.cacheRoot,
    homeDirectory: supplied.homeDirectory,
    outputDir: supplied.outputRoot,
    ...(supplied.wasperApp ? { wasperApp: supplied.wasperApp } : {}),
  });
  for (const key of ['cacheRoot', 'holdersRoot', 'artifactsRoot', 'packageRoot']) {
    if (layout[key] !== supplied[key]) throw new Error('runtime layout changed or is forged');
  }
  const marker = path.join(layout.cacheRoot, OWNER_FILE);
  if (create) {
    if (
      fs.existsSync(layout.cacheRoot) &&
      !fs.existsSync(marker) &&
      fs.readdirSync(layout.cacheRoot).length
    ) {
      throw new Error('refusing an unmarked nonempty benchmark cache');
    }
    writeOwnershipMarker(layout);
  }
  const directories = new Map();
  const identity = info => `${info.dev}:${info.ino}`;
  function remember(directory) {
    const stat = fs.lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(directory) !== directory
    ) {
      throw new Error('runtime cache directory must not be a symlink');
    }
    if (directories.has(directory) && directories.get(directory) !== identity(stat)) {
      throw new Error('runtime cache directory changed during bootstrap');
    }
    directories.set(directory, identity(stat));
  }
  remember(layout.cacheRoot);
  function check() {
    for (const directory of directories.keys()) remember(directory);
    const info = fs.lstatSync(marker);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      !isDeepStrictEqual(
        JSON.parse(fs.readFileSync(marker, 'utf8')),
        expectedOwnershipMarker(layout.cacheRoot)
      )
    ) {
      throw new Error('runtime ownership marker mismatch');
    }
  }
  function directory(target, make = create) {
    check();
    if (!isInside(layout.cacheRoot, target) && target !== layout.cacheRoot)
      throw new Error('runtime path escapes owned cache');
    let cursor = layout.cacheRoot;
    for (const part of path
      .relative(layout.cacheRoot, target)
      .split(path.sep)
      .filter(Boolean)) {
      cursor = path.join(cursor, part);
      if (!fs.existsSync(cursor) && make) fs.mkdirSync(cursor, { mode: 0o700 });
      remember(cursor);
    }
    return target;
  }
  function regular(file) {
    directory(path.dirname(file), false);
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new Error(`unsafe runtime file: ${path.basename(file)}`);
    return info;
  }
  function hashFile(file) {
    const before = regular(file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (identity(fs.fstatSync(fd)) !== identity(before))
        throw new Error('runtime file changed while opening');
      const hash = crypto.createHash('sha256');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      let size = 0;
      for (let count; (count = fs.readSync(fd, buffer)) > 0; ) {
        size += count;
        hash.update(buffer.subarray(0, count));
      }
      const after = regular(file);
      if (
        identity(after) !== identity(before) ||
        after.size !== size ||
        after.mtimeMs !== before.mtimeMs
      )
        throw new Error('runtime file changed while hashing');
      return { sha256: hash.digest('hex'), sizeBytes: size };
    } finally {
      fs.closeSync(fd);
    }
  }
  function writeExclusive(file, bytes) {
    directory(path.dirname(file));
    const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_NOFOLLOW,
      0o600
    );
    try {
      fs.writeFileSync(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
    check();
  }
  function openDirectory(target) {
    directory(target, false);
    const fd = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    try {
      const info = fs.fstatSync(fd);
      if (!info.isDirectory() || identity(info) !== directories.get(target)) {
        throw new Error('runtime download directory changed while opening');
      }
      check();
      return fd;
    } catch (error) {
      fs.closeSync(fd);
      throw error;
    }
  }
  check();
  return { layout, check, directory, regular, hashFile, writeExclusive, openDirectory };
}

module.exports = { ownedRuntimeStorage };
