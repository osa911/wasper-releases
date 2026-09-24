'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_APPLICATIONS_DIRECTORY = '/Applications';
const MINIMUM_WASPER_VERSION = Object.freeze([1, 8, 0]);
const NATIVE_SERVER_RELATIVE_PATH = 'Contents/Resources/bin/wasper-parakeet-server';
const RUNTIME_LOCK_PATH = path.resolve(__dirname, '../../locks/runtimes.json');

function parseVersion(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(version);
  if (!match) throw new Error(`Wasper returned an invalid release version: ${version}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

function hashFileSha256(filePath) {
  const info = fs.statSync(filePath);
  if (!info.isFile()) throw new Error(`packaged native server is not a regular file: ${filePath}`);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    let offset = 0;
    while (offset < info.size) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, info.size - offset),
        offset
      );
      if (bytesRead === 0) throw new Error(`packaged native server ended early: ${filePath}`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function readRuntimeLock(lockPath = RUNTIME_LOCK_PATH) {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read Wasper runtime lock at ${lockPath}`, {
      cause: error,
    });
  }
}

function expectedWasperNativeServerSha256(runtimeLock) {
  const descriptor = runtimeLock?.runtimes?.find(runtime => runtime?.id === 'wasper-metal-int8');
  const release = descriptor?.release;
  if (
    release?.version !== '1.8.0' ||
    typeof release.nativeServerSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(release.nativeServerSha256)
  ) {
    throw new Error('runtime lock must define the Wasper 1.8.0 native-server SHA-256');
  }
  return release.nativeServerSha256;
}

function discoverWasperApp(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('Wasper discovery options must be an object');
  }
  const applicationsDirectory = options.applicationsDirectory ?? DEFAULT_APPLICATIONS_DIRECTORY;
  const requestedAppPath = options.appPath ?? path.join(applicationsDirectory, 'Wasper.app');
  let appPath;
  try {
    appPath = fs.realpathSync.native(requestedAppPath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Wasper.app is missing: ${requestedAppPath}`);
    throw error;
  }
  if (!fs.statSync(appPath).isDirectory()) {
    throw new Error(`Wasper app path is not a directory: ${appPath}`);
  }

  const infoPlistPath = path.join(appPath, 'Contents/Info.plist');
  const execFileSyncImpl = options.execFileSyncImpl ?? childProcess.execFileSync;
  const version = String(
    execFileSyncImpl(
      '/usr/bin/plutil',
      ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPlistPath],
      { encoding: 'utf8' }
    )
  ).trim();
  const versionParts = parseVersion(version);
  const minimumComparison = compareVersions(versionParts, MINIMUM_WASPER_VERSION);
  if (minimumComparison < 0) {
    throw new Error(
      `public Parakeet benchmarking requires Wasper 1.8.0 or later; found ${version}`
    );
  }

  const nativeServerPath = path.join(appPath, NATIVE_SERVER_RELATIVE_PATH);
  try {
    if (!fs.statSync(nativeServerPath).isFile()) {
      throw new Error(`packaged native server is missing: ${nativeServerPath}`);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`packaged native server is missing: ${nativeServerPath}`);
    }
    throw error;
  }
  const hashFileImpl = options.hashFileImpl ?? hashFileSha256;
  const nativeServerSha256 = hashFileImpl(nativeServerPath);
  if (typeof nativeServerSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(nativeServerSha256)) {
    throw new Error('packaged native server SHA-256 is invalid');
  }

  let baselineKind;
  if (compareVersions(versionParts, MINIMUM_WASPER_VERSION) === 0) {
    const runtimeLock =
      options.runtimeLock ??
      (options.loadRuntimeLockImpl ?? readRuntimeLock)(
        options.runtimeLockPath ?? RUNTIME_LOCK_PATH
      );
    const expectedSha256 = expectedWasperNativeServerSha256(runtimeLock);
    if (nativeServerSha256 !== expectedSha256) {
      throw new Error(
        `packaged native server does not match the published Wasper 1.8.0 runtime: ${nativeServerSha256}`
      );
    }
    baselineKind = 'published-exact';
  } else {
    baselineKind = 'newer-release';
  }

  return Object.freeze({
    appPath,
    version,
    nativeServerPath,
    nativeServerSha256,
    baselineKind,
  });
}

module.exports = {
  DEFAULT_APPLICATIONS_DIRECTORY,
  NATIVE_SERVER_RELATIVE_PATH,
  RUNTIME_LOCK_PATH,
  discoverWasperApp,
  expectedWasperNativeServerSha256,
  hashFileSha256,
  readRuntimeLock,
};
