'use strict';

const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { isDeepStrictEqual } = require('node:util');

const {
  resolveLayout,
  writeOwnershipMarker,
  expectedOwnershipMarker,
  OWNER_FILE,
  isInside,
} = require('../config.cjs');
const { publicAuditPythonExecutable } = require('../public-audit.cjs');

const OWNED_DOWNLOAD = path.join(__dirname, 'owned-download.py');
const OWNED_DIRECTORY = path.join(__dirname, 'owned-directory.py');
const OWNED_WRITE = path.join(__dirname, 'owned-write.py');
const TRUSTED_PYTHON_ENV = Object.freeze({
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin',
  PYTHONHASHSEED: '0',
});

function ownedRuntimeStorage(supplied, { create = true } = {}) {
  const layout = resolveLayout({
    cacheDir: supplied.cacheRoot,
    homeDirectory: supplied.homeDirectory,
    outputDir: supplied.outputRoot,
    ...(supplied.wasperApp ? { wasperApp: supplied.wasperApp } : {}),
  });
  for (const key of [
    'cacheRoot',
    'holdersRoot',
    'artifactsRoot',
    'corpusRoot',
    'outputRoot',
    'packageRoot',
  ]) {
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
  const files = new Map();
  const identity = info => `${info.dev}:${info.ino}`;

  function trustedPython() {
    const executable = publicAuditPythonExecutable();
    if (typeof executable !== 'string' || !path.isAbsolute(executable)) {
      throw new Error('owned runtime storage requires an absolute system Python executable');
    }
    return executable;
  }

  function remember(directory) {
    const stat = fs.lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      fs.realpathSync.native(directory) !== directory
    ) {
      throw new Error('runtime cache directory must not be a symlink');
    }
    if (directories.has(directory) && directories.get(directory) !== identity(stat)) {
      throw new Error('runtime cache directory changed during storage operation');
    }
    directories.set(directory, identity(stat));
  }

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

  function runOwnedHelper(
    arguments_,
    { descriptors = [], env = TRUSTED_PYTHON_ENV, input, script = OWNED_WRITE } = {}
  ) {
    const result = childProcess.spawnSync(
      trustedPython(),
      ['-I', '-S', '-B', script, ...arguments_],
      {
        cwd: '/',
        encoding: 'utf8',
        env,
        ...(input === undefined ? {} : { input }),
        stdio: ['pipe', 'pipe', 'pipe', ...descriptors],
        timeout: 60_000,
      }
    );
    if (result.error) throw new Error(`owned storage helper failed: ${result.error.message}`);
    if (result.signal) throw new Error(`owned storage helper exited from ${result.signal}`);
    if (result.status !== 0) {
      throw new Error(`owned storage helper failed: ${(result.stderr ?? '').trim()}`);
    }
    return result.stdout;
  }

  function openKnownDirectory(target) {
    const expected = directories.get(target);
    if (expected === undefined) throw new Error('runtime owned directory was not recorded');
    const before = fs.lstatSync(target);
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      identity(before) !== expected ||
      fs.realpathSync.native(target) !== target
    ) {
      throw new Error('runtime owned directory changed while opening');
    }
    const descriptor = fs.openSync(
      target,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    try {
      const actual = fs.fstatSync(descriptor);
      if (!actual.isDirectory() || identity(actual) !== expected) {
        throw new Error('runtime owned directory changed while opening');
      }
      return descriptor;
    } catch (error) {
      fs.closeSync(descriptor);
      throw error;
    }
  }

  function directory(target, make = create) {
    check();
    if (!isInside(layout.cacheRoot, target) && target !== layout.cacheRoot) {
      throw new Error('runtime path escapes owned cache');
    }
    let cursor = layout.cacheRoot;
    for (const part of path
      .relative(layout.cacheRoot, target)
      .split(path.sep)
      .filter(Boolean)) {
      const next = path.join(cursor, part);
      try {
        remember(next);
      } catch (error) {
        if (error?.code !== 'ENOENT' || !make) throw error;
        const parentDescriptor = openKnownDirectory(cursor);
        try {
          runOwnedHelper(['mkdir', part], {
            descriptors: [parentDescriptor],
            script: OWNED_DIRECTORY,
          });
        } finally {
          fs.closeSync(parentDescriptor);
        }
        check();
        remember(next);
      }
      cursor = next;
    }
    return target;
  }

  function openDirectory(target) {
    directory(target, false);
    const descriptor = openKnownDirectory(target);
    try {
      check();
      return descriptor;
    } catch (error) {
      fs.closeSync(descriptor);
      throw error;
    }
  }

  function regular(file) {
    directory(path.dirname(file), false);
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      throw new Error(`unsafe runtime file: ${path.basename(file)}`);
    }
    return info;
  }

  function track(file) {
    files.set(file, identity(regular(file)));
    return file;
  }

  function moveTrackedPaths(entries, from, to) {
    for (const [trackedPath, trackedIdentity] of [...entries]) {
      if (trackedPath !== from && !trackedPath.startsWith(`${from}${path.sep}`)) continue;
      entries.delete(trackedPath);
      entries.set(`${to}${trackedPath.slice(from.length)}`, trackedIdentity);
    }
  }

  function forgetTrackedPaths(entries, target) {
    for (const trackedPath of entries.keys()) {
      if (trackedPath === target || trackedPath.startsWith(`${target}${path.sep}`)) {
        entries.delete(trackedPath);
      }
    }
  }

  function hashFile(file) {
    const before = regular(file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      if (identity(fs.fstatSync(fd)) !== identity(before)) {
        throw new Error('runtime file changed while opening');
      }
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
      ) {
        throw new Error('runtime file changed while hashing');
      }
      return { sha256: hash.digest('hex'), sizeBytes: size };
    } finally {
      fs.closeSync(fd);
    }
  }

  function write(file, bytes, operation, { python = trustedPython(), env = TRUSTED_PYTHON_ENV } = {}) {
    if (typeof python !== 'string' || !python) {
      throw new TypeError('owned write requires a selected Python executable');
    }
    directory(path.dirname(file));
    const descriptor = openDirectory(path.dirname(file));
    try {
      const arguments_ =
        operation === 'exclusive' ? [path.basename(file)] : [operation, path.basename(file)];
      const result = childProcess.spawnSync(
        python,
        ['-I', '-S', '-B', OWNED_WRITE, ...arguments_],
        {
          cwd: '/',
          encoding: 'utf8',
          env,
          input: bytes,
          stdio: ['pipe', 'ignore', 'pipe', descriptor],
          timeout: 60_000,
        }
      );
      if (result.error) throw new Error(`owned write failed: ${result.error.message}`, { cause: result.error });
      if (result.signal) throw new Error(`owned write exited from ${result.signal}`);
      if (result.status !== 0) {
        throw new Error(`owned write failed: ${(result.stderr ?? '').trim()}`);
      }
    } finally {
      fs.closeSync(descriptor);
    }
    check();
    track(file);
  }

  function writeExclusive(file, bytes, options = {}) {
    write(file, bytes, 'exclusive', options);
  }

  function writeReplace(file, bytes, options = {}) {
    write(file, bytes, 'replace', options);
  }

  function promote(from, to) {
    const source = regular(from);
    directory(path.dirname(to));
    const sourceDescriptor = openDirectory(path.dirname(from));
    const destinationDescriptor = openDirectory(path.dirname(to));
    try {
      runOwnedHelper(
        ['promote', path.basename(from), path.basename(to), source.dev.toString(), source.ino.toString()],
        { descriptors: [sourceDescriptor, destinationDescriptor] }
      );
    } finally {
      fs.closeSync(destinationDescriptor);
      fs.closeSync(sourceDescriptor);
    }
    files.delete(from);
    check();
    track(to);
  }

  function moveDirectory(from, to) {
    directory(from, false);
    directory(path.dirname(to));
    const source = fs.lstatSync(from);
    if (!source.isDirectory() || source.isSymbolicLink()) {
      throw new Error('runtime move source must be a real directory');
    }
    const sourceDescriptor = openDirectory(path.dirname(from));
    const destinationDescriptor = openDirectory(path.dirname(to));
    try {
      runOwnedHelper(
        [
          'move-directory',
          path.basename(from),
          path.basename(to),
          source.dev.toString(),
          source.ino.toString(),
        ],
        { descriptors: [sourceDescriptor, destinationDescriptor] }
      );
    } finally {
      fs.closeSync(destinationDescriptor);
      fs.closeSync(sourceDescriptor);
    }
    moveTrackedPaths(directories, from, to);
    moveTrackedPaths(files, from, to);
    check();
    remember(to);
  }

  function createTempDirectory(parent, prefix) {
    directory(parent);
    const descriptor = openDirectory(parent);
    let name;
    try {
      name = runOwnedHelper(['mkdtemp', prefix], {
        descriptors: [descriptor],
        script: OWNED_DIRECTORY,
      }).trim();
    } finally {
      fs.closeSync(descriptor);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name)) {
      throw new Error('owned storage helper returned an unsafe temporary directory name');
    }
    check();
    const target = path.join(parent, name);
    remember(target);
    return target;
  }

  function remove(file) {
    const expected = files.get(file);
    if (expected === undefined) throw new Error('runtime file was not tracked for cleanup');
    if (identity(regular(file)) !== expected) {
      throw new Error('runtime tracked file changed before cleanup');
    }
    const [device, inode] = expected.split(':');
    const descriptor = openDirectory(path.dirname(file));
    try {
      runOwnedHelper(
        ['remove-file', path.basename(file), device, inode],
        { descriptors: [descriptor] }
      );
    } finally {
      fs.closeSync(descriptor);
    }
    forgetTrackedPaths(files, file);
    check();
  }

  function removeDirectory(target) {
    const trackedIdentity = directories.get(target);
    if (trackedIdentity === undefined) {
      throw new Error('runtime directory was not tracked for cleanup');
    }
    directory(target, false);
    const expected = fs.lstatSync(target);
    if (
      !expected.isDirectory() ||
      expected.isSymbolicLink() ||
      identity(expected) !== trackedIdentity
    ) {
      throw new Error('runtime remove target must be a real directory');
    }
    const [device, inode] = trackedIdentity.split(':');
    const descriptor = openDirectory(path.dirname(target));
    try {
      runOwnedHelper(
        ['remove-directory', path.basename(target), device, inode],
        { descriptors: [descriptor] }
      );
    } finally {
      fs.closeSync(descriptor);
    }
    forgetTrackedPaths(directories, target);
    forgetTrackedPaths(files, target);
    check();
  }

  async function download(file, body, expectedHash, maximumBytes) {
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
      throw new TypeError('owned download requires a SHA-256 checksum');
    }
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new TypeError('owned download requires a positive byte limit');
    }
    directory(path.dirname(file));
    const descriptor = openDirectory(path.dirname(file));
    try {
      const writer = childProcess.spawn(
        trustedPython(),
        [
          '-I',
          '-S',
          '-B',
          OWNED_DOWNLOAD,
          path.basename(file),
          expectedHash,
          '-',
          String(maximumBytes),
        ],
        {
          cwd: '/',
          env: TRUSTED_PYTHON_ENV,
          stdio: ['pipe', 'ignore', 'pipe', descriptor],
          timeout: 60 * 60_000,
        }
      );
      let detail = '';
      writer.stderr.on('data', chunk => {
        detail = (detail + chunk).slice(-65536);
      });
      const finished = new Promise((resolve, reject) => {
        writer.once('error', reject);
        writer.once('close', code =>
          code === 0 ? resolve() : reject(new Error(`download failed: ${detail.trim()}`))
        );
      });
      const transfer = pipeline(Readable.from(body), writer.stdin).catch(error => {
        writer.kill();
        throw error;
      });
      const results = await Promise.allSettled([finished, transfer]);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
    } finally {
      fs.closeSync(descriptor);
    }
    check();
    track(file);
  }

  remember(layout.cacheRoot);
  check();
  return {
    layout,
    files,
    directories,
    check,
    createTempDirectory,
    directory,
    download,
    hashFile,
    identity,
    moveDirectory,
    openDirectory,
    promote,
    regular,
    rememberDirectory: remember,
    remove,
    removeDirectory,
    track,
    writeExclusive,
    writeReplace,
  };
}

module.exports = { ownedRuntimeStorage };
