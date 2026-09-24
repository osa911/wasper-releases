'use strict';

const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const { OWNER_FILE, expectedOwnershipMarker, isInside, resolveLayout } = require('./config.cjs');

const CLEANUP_DIRECTORY_NAMES = Object.freeze(['artifacts', 'corpus', 'holders', 'runs']);
const LAYOUT_FIELDS = Object.freeze([
  'packageRoot',
  'repositoryRoot',
  'homeDirectory',
  'cacheNamespaceRoot',
  'cacheRoot',
  'artifactsRoot',
  'corpusRoot',
  'holdersRoot',
  'outputRoot',
  'wasperApp',
]);

function assertCompleteLayout(layout) {
  if (layout === null || typeof layout !== 'object' || Array.isArray(layout)) {
    throw new TypeError('clean requires a complete resolved layout');
  }
  for (const field of LAYOUT_FIELDS) {
    if (!Object.hasOwn(layout, field)) {
      throw new TypeError('clean requires a complete resolved layout');
    }
  }
}

function canonicalLayout(layout) {
  assertCompleteLayout(layout);
  const resolved = resolveLayout({
    cacheDir: layout.cacheRoot,
    homeDirectory: layout.homeDirectory,
    outputDir: layout.outputRoot,
    ...(layout.wasperApp === null ? {} : { wasperApp: layout.wasperApp }),
  });
  if (LAYOUT_FIELDS.some(field => layout[field] !== resolved[field])) {
    throw new TypeError('clean requires a complete resolved layout');
  }
  return resolved;
}

function readOwnershipMarker(storageRoot, ownedCacheRoot) {
  const markerPath = path.join(storageRoot, OWNER_FILE);
  let markerStat;
  try {
    markerStat = fs.lstatSync(markerPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`benchmark ownership marker is missing: ${markerPath}`);
    }
    throw error;
  }
  if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
    throw new Error(`benchmark ownership marker is not a regular file: ${markerPath}`);
  }
  const resolvedMarker = fs.realpathSync.native(markerPath);
  if (!isInside(storageRoot, resolvedMarker)) {
    throw new Error(`benchmark ownership marker is outside the benchmark cache: ${markerPath}`);
  }
  let marker;
  try {
    marker = JSON.parse(fs.readFileSync(resolvedMarker, 'utf8'));
  } catch (error) {
    throw new Error(`benchmark ownership marker is invalid: ${markerPath}`, {
      cause: error,
    });
  }
  if (!isDeepStrictEqual(marker, expectedOwnershipMarker(ownedCacheRoot))) {
    throw new Error(`benchmark ownership marker does not match this cache: ${markerPath}`);
  }
}

function inspectSymlinks(currentPath, cacheRoot) {
  const stat = fs.lstatSync(currentPath);
  if (stat.isSymbolicLink()) {
    let target;
    try {
      target = fs.realpathSync.native(currentPath);
    } catch (error) {
      throw new Error(`unsafe symlink cannot be resolved: ${currentPath}`, {
        cause: error,
      });
    }
    if (!isInside(cacheRoot, target)) {
      throw new Error(`symlink points outside the benchmark cache: ${currentPath} -> ${target}`);
    }
    return;
  }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(currentPath)) {
    inspectSymlinks(path.join(currentPath, entry), cacheRoot);
  }
}

function cleanupRoots(cacheRoot) {
  const roots = [];
  for (const name of CLEANUP_DIRECTORY_NAMES) {
    const cleanupRoot = path.join(cacheRoot, name);
    let stat;
    try {
      stat = fs.lstatSync(cleanupRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      const target = fs.realpathSync.native(cleanupRoot);
      if (!isInside(cacheRoot, target)) {
        throw new Error(`symlink points outside the benchmark cache: ${cleanupRoot} -> ${target}`);
      }
      throw new Error(`managed cleanup root must not be a symlink: ${cleanupRoot}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`cleanup path must be a generated directory: ${cleanupRoot}`);
    }
    const resolvedRoot = fs.realpathSync.native(cleanupRoot);
    if (!isInside(cacheRoot, resolvedRoot)) {
      throw new Error(`cleanup path is outside the benchmark cache: ${cleanupRoot}`);
    }
    inspectSymlinks(resolvedRoot, cacheRoot);
    roots.push({ name, path: resolvedRoot });
  }
  return roots;
}

function lstatOrNull(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function restoreQuarantinedCache({ cacheRoot, quarantineContainer, quarantineRoot }) {
  const replacement = lstatOrNull(cacheRoot);
  let replacementTarget = null;

  if (replacement?.isSymbolicLink()) {
    replacementTarget = fs.realpathSync.native(cacheRoot);
    fs.unlinkSync(cacheRoot);
  } else if (replacement !== null) {
    return new Error(
      `benchmark cache root was replaced during cleanup; owned cache retained at ${quarantineRoot}`
    );
  }

  try {
    fs.renameSync(quarantineRoot, cacheRoot);
    const resolvedContainer = fs.realpathSync.native(quarantineContainer);
    if (resolvedContainer !== quarantineContainer) {
      throw new Error('cleanup quarantine changed before removal');
    }
    fs.rmdirSync(resolvedContainer);
  } catch (error) {
    return new Error(`could not restore owned benchmark cache from ${quarantineRoot}`, {
      cause: error,
    });
  }

  if (replacementTarget !== null) {
    return new Error(
      `benchmark cache root was replaced during cleanup by a symlink to ${replacementTarget}`
    );
  }
  return null;
}

async function clean(layout, { beforeRemove } = {}) {
  const resolvedLayout = canonicalLayout(layout);
  const cacheRoot = fs.realpathSync.native(resolvedLayout.cacheRoot);
  if (cacheRoot !== resolvedLayout.cacheRoot) {
    throw new Error('benchmark cache changed after layout resolution');
  }
  readOwnershipMarker(cacheRoot, cacheRoot);
  cleanupRoots(cacheRoot);

  const quarantineContainer = fs.mkdtempSync(
    path.join(resolvedLayout.cacheNamespaceRoot, `.parakeet-runtime-clean-${randomUUID()}-`)
  );
  const quarantineRoot = path.join(quarantineContainer, 'owned-cache');
  fs.renameSync(cacheRoot, quarantineRoot);

  const removed = [];
  let cleanupError = null;
  try {
    const movedStat = fs.lstatSync(quarantineRoot);
    if (!movedStat.isDirectory() || movedStat.isSymbolicLink()) {
      throw new Error('quarantined benchmark cache must be a real directory');
    }
    const resolvedQuarantineRoot = fs.realpathSync.native(quarantineRoot);
    if (resolvedQuarantineRoot !== quarantineRoot) {
      throw new Error('quarantined benchmark cache changed after move');
    }
    readOwnershipMarker(resolvedQuarantineRoot, cacheRoot);
    const quarantinedRoots = cleanupRoots(resolvedQuarantineRoot);

    for (const quarantined of quarantinedRoots) {
      const originalPath = path.join(cacheRoot, quarantined.name);
      beforeRemove?.(originalPath);
      await fs.promises.rm(quarantined.path, { force: true, recursive: true });
      removed.push(originalPath);
    }
  } catch (error) {
    cleanupError = error;
  }

  const restoreError = restoreQuarantinedCache({
    cacheRoot,
    quarantineContainer,
    quarantineRoot,
  });
  if (restoreError !== null) {
    if (cleanupError !== null) restoreError.cause = cleanupError;
    throw restoreError;
  }
  if (cleanupError !== null) throw cleanupError;
  return removed;
}

module.exports = { clean };
