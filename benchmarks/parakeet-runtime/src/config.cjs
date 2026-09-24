'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const OWNER_FILE = '.wasper-parakeet-runtime-benchmark-owner.json';
const OWNER_SCHEMA = 'wasper.parakeet-runtime-benchmark.owner.v1';
const PACKAGE_NAME = 'parakeet-runtime';
const packageRoot = fs.realpathSync.native(path.resolve(__dirname, '..'));

function assertPath(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty path`);
  }
}

function canonicalizePath(value, label, base = process.cwd()) {
  assertPath(value, label);
  const absolutePath = path.resolve(base, value);
  const missingSegments = [];
  let existingPath = absolutePath;

  while (true) {
    try {
      fs.lstatSync(existingPath);
      break;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(existingPath);
      if (parent === existingPath) throw error;
      missingSegments.unshift(path.basename(existingPath));
      existingPath = parent;
    }
  }

  const canonicalParent = fs.realpathSync.native(existingPath);
  return path.join(canonicalParent, ...missingSegments);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function findRepositoryRoot(start) {
  let current = start;
  while (true) {
    if (fs.existsSync(path.join(current, '.git'))) return fs.realpathSync.native(current);
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function expectedOwnershipMarker(cacheRoot) {
  return {
    schema: OWNER_SCHEMA,
    package: PACKAGE_NAME,
    cacheRoot,
  };
}

function resolveLayout(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('layout options must be an object');
  }
  const homeDirectory = canonicalizePath(options.homeDirectory ?? os.homedir(), 'home directory');
  const cacheNamespaceRoot = canonicalizePath(
    path.join(homeDirectory, 'Library/Caches/Wasper/benchmarks'),
    'benchmark cache namespace'
  );
  const cacheRoot = canonicalizePath(
    options.cacheDir ?? path.join(cacheNamespaceRoot, 'parakeet-runtime-v1'),
    'benchmark cache'
  );
  const repositoryRoot = findRepositoryRoot(packageRoot);

  if (cacheRoot === path.parse(cacheRoot).root || cacheRoot === homeDirectory) {
    throw new Error('benchmark cache must not be a filesystem root or home directory');
  }
  if (cacheRoot === packageRoot || cacheRoot === repositoryRoot) {
    throw new Error('benchmark cache must not be a repository root');
  }
  if (!isInside(cacheNamespaceRoot, cacheRoot)) {
    throw new Error(`benchmark cache must stay under ${cacheNamespaceRoot}`);
  }

  const rawOutputRoot = options.outputDir ?? path.join(cacheRoot, 'runs');
  const outputRoot = canonicalizePath(
    rawOutputRoot,
    'benchmark output',
    path.isAbsolute(rawOutputRoot) ? process.cwd() : cacheRoot
  );
  if (!isInside(cacheRoot, outputRoot)) {
    throw new Error('output must stay under the benchmark cache');
  }

  const wasperApp =
    options.wasperApp === undefined ? null : canonicalizePath(options.wasperApp, 'Wasper app');

  return Object.freeze({
    packageRoot,
    repositoryRoot,
    homeDirectory,
    cacheNamespaceRoot,
    cacheRoot,
    artifactsRoot: path.join(cacheRoot, 'artifacts'),
    corpusRoot: path.join(cacheRoot, 'corpus'),
    holdersRoot: path.join(cacheRoot, 'holders'),
    outputRoot,
    wasperApp,
  });
}

function writeOwnershipMarker(layout) {
  if (layout === null || typeof layout !== 'object') {
    throw new TypeError('layout is required');
  }
  const canonicalLayout = resolveLayout({
    cacheDir: layout.cacheRoot,
    ...(layout.homeDirectory === undefined ? {} : { homeDirectory: layout.homeDirectory }),
    ...(layout.outputRoot === undefined ? {} : { outputDir: layout.outputRoot }),
    ...(layout.wasperApp == null ? {} : { wasperApp: layout.wasperApp }),
  });
  fs.mkdirSync(canonicalLayout.cacheRoot, { recursive: true, mode: 0o700 });
  const cacheRoot = fs.realpathSync.native(canonicalLayout.cacheRoot);
  if (cacheRoot !== canonicalLayout.cacheRoot) {
    throw new Error('benchmark cache changed after layout resolution');
  }
  const markerPath = path.join(cacheRoot, OWNER_FILE);
  const expected = expectedOwnershipMarker(cacheRoot);

  try {
    const markerStat = fs.lstatSync(markerPath);
    if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
      throw new Error('benchmark ownership marker must be a regular file');
    }
    const existing = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (!isDeepStrictEqual(existing, expected)) {
      throw new Error('benchmark ownership marker does not match this cache');
    }
    return markerPath;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    (fs.constants.O_NOFOLLOW ?? 0);
  const descriptor = fs.openSync(markerPath, flags, 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(expected, null, 2)}\n`);
  } finally {
    fs.closeSync(descriptor);
  }
  return markerPath;
}

module.exports = {
  OWNER_FILE,
  OWNER_SCHEMA,
  expectedOwnershipMarker,
  isInside,
  resolveLayout,
  writeOwnershipMarker,
};
