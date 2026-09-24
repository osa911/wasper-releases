'use strict';

const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual, promisify } = require('node:util');

const {
  OWNER_FILE,
  expectedOwnershipMarker,
  isInside,
  resolveLayout,
} = require('./config.cjs');
const { publicAuditPythonExecutable } = require('./public-audit.cjs');

const CLEANUP_DIRECTORY_NAMES = Object.freeze(['artifacts', 'corpus', 'holders', 'runs']);
const DELETE_HELPER = path.join(__dirname, 'delete-owned-cache.py');
const CLEAN_PYTHON_ENV = Object.freeze({
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin',
  PYTHONHASHSEED: '0',
});
const execFileAsync = promisify(execFile);
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
      throw new Error(
        `symlink points outside the benchmark cache: ${currentPath} -> ${target}`
      );
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
        throw new Error(
          `symlink points outside the benchmark cache: ${cleanupRoot} -> ${target}`
        );
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

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function trustedPython() {
  const executable = publicAuditPythonExecutable();
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) {
    throw new Error('benchmark cleanup requires an absolute system Python executable');
  }
  return executable;
}

async function runDescriptorHelper(pythonExecutable, arguments_) {
  if (typeof pythonExecutable !== 'string' || !path.isAbsolute(pythonExecutable)) {
    throw new Error('benchmark cleanup requires an absolute Python executable');
  }
  let stdout;
  try {
    ({ stdout } = await execFileAsync(
      pythonExecutable,
      ['-I', '-S', '-B', DELETE_HELPER, ...arguments_],
      {
        cwd: '/',
        encoding: 'utf8',
        env: CLEAN_PYTHON_ENV,
        maxBuffer: 1024 * 1024,
      }
    ));
  } catch (error) {
    const detail = error?.stderr?.trim();
    throw new Error(detail || 'descriptor-relative benchmark cleanup failed', { cause: error });
  }
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error('descriptor-relative benchmark cleanup returned invalid output', {
      cause: error,
    });
  }
}

async function restoreQuarantinedCache({
  cacheRoot,
  cacheParent,
  cacheParentIdentity,
  expectedIdentity,
  namespaceRoot,
  namespaceIdentity,
  quarantineContainer,
  quarantineIdentity,
  quarantineRoot,
  pythonExecutable,
}) {
  let result;
  try {
    result = await runDescriptorHelper(pythonExecutable, [
      'restore-cache',
      '--cache-parent',
      cacheParent,
      '--cache-parent-device',
      cacheParentIdentity.dev.toString(),
      '--cache-parent-inode',
      cacheParentIdentity.ino.toString(),
      '--cache-root',
      cacheRoot,
      '--cache-name',
      path.basename(cacheRoot),
      '--cache-device',
      expectedIdentity.dev.toString(),
      '--cache-inode',
      expectedIdentity.ino.toString(),
      '--namespace',
      namespaceRoot,
      '--namespace-device',
      namespaceIdentity.dev.toString(),
      '--namespace-inode',
      namespaceIdentity.ino.toString(),
      '--container-name',
      path.basename(quarantineContainer),
      '--container-device',
      quarantineIdentity.dev.toString(),
      '--container-inode',
      quarantineIdentity.ino.toString(),
    ]);
    if (
      result === null ||
      typeof result !== 'object' ||
      result.restored !== true ||
      result.containerRemoved !== true ||
      typeof result.cacheReplacementRemoved !== 'boolean' ||
      typeof result.ownedCacheDisplaced !== 'boolean'
    ) {
      throw new Error('descriptor-relative benchmark restoration returned invalid output');
    }
  } catch (error) {
    return new Error(`could not restore owned benchmark cache from ${quarantineRoot}`, {
      cause: error,
    });
  }

  if (result.cacheReplacementRemoved || result.ownedCacheDisplaced) {
    const replacementKind = result.cacheReplacementRemoved
      ? 'benchmark cache root'
      : 'quarantined owned cache';
    return new Error(`${replacementKind} was replaced during cleanup`);
  }
  return null;
}

async function deleteWithDirectoryDescriptors({ pythonExecutable, quarantineRoot, identity }) {
  const result = await runDescriptorHelper(pythonExecutable, [
    'delete-generated',
    '--root',
    quarantineRoot,
    '--device',
    identity.dev.toString(),
    '--inode',
    identity.ino.toString(),
  ]);
  if (
    result === null ||
    typeof result !== 'object' ||
    !Array.isArray(result.removed) ||
    result.removed.some(name => !CLEANUP_DIRECTORY_NAMES.includes(name))
  ) {
    throw new Error('descriptor-relative benchmark cleanup returned invalid output');
  }
  return result.removed;
}

async function clean(layout, { beforeRemove, pythonExecutable = trustedPython() } = {}) {
  const resolvedLayout = canonicalLayout(layout);
  const cacheRoot = fs.realpathSync.native(resolvedLayout.cacheRoot);
  if (cacheRoot !== resolvedLayout.cacheRoot) {
    throw new Error('benchmark cache changed after layout resolution');
  }
  readOwnershipMarker(cacheRoot, cacheRoot);
  const plannedRoots = cleanupRoots(cacheRoot);
  const expectedIdentity = fs.lstatSync(cacheRoot, { bigint: true });
  const cacheParent = path.dirname(cacheRoot);
  const cacheParentIdentity = fs.lstatSync(cacheParent, { bigint: true });
  const namespaceIdentity = fs.lstatSync(resolvedLayout.cacheNamespaceRoot, { bigint: true });

  const quarantineContainer = fs.mkdtempSync(
    path.join(resolvedLayout.cacheNamespaceRoot, `.parakeet-runtime-clean-${randomUUID()}-`)
  );
  const quarantineIdentity = fs.lstatSync(quarantineContainer, { bigint: true });
  const quarantineRoot = path.join(quarantineContainer, 'owned-cache');
  fs.renameSync(cacheRoot, quarantineRoot);

  const removed = [];
  let cleanupError = null;
  try {
    const movedStat = fs.lstatSync(quarantineRoot, { bigint: true });
    if (
      !movedStat.isDirectory() ||
      movedStat.isSymbolicLink() ||
      !sameIdentity(movedStat, expectedIdentity)
    ) {
      throw new Error('quarantined benchmark cache must be a real directory');
    }
    const resolvedQuarantineRoot = fs.realpathSync.native(quarantineRoot);
    if (resolvedQuarantineRoot !== quarantineRoot) {
      throw new Error('quarantined benchmark cache changed after move');
    }
    readOwnershipMarker(resolvedQuarantineRoot, cacheRoot);
    const quarantinedRoots = cleanupRoots(resolvedQuarantineRoot);
    const plannedNames = plannedRoots.map(root => root.name);
    const quarantinedNames = quarantinedRoots.map(root => root.name);
    if (!isDeepStrictEqual(quarantinedNames, plannedNames)) {
      throw new Error('generated cleanup directories changed during quarantine');
    }
    for (const name of plannedNames) {
      beforeRemove?.(path.join(cacheRoot, name));
    }
    const removedNames = await deleteWithDirectoryDescriptors({
      pythonExecutable,
      quarantineRoot,
      identity: expectedIdentity,
    });
    if (!isDeepStrictEqual(removedNames, plannedNames)) {
      throw new Error(
        'generated cleanup directories changed during descriptor-relative deletion'
      );
    }
    for (const name of removedNames) {
      removed.push(path.join(cacheRoot, name));
    }
  } catch (error) {
    cleanupError = error;
  }

  const restoreError = await restoreQuarantinedCache({
    cacheRoot,
    cacheParent,
    cacheParentIdentity,
    expectedIdentity,
    namespaceRoot: resolvedLayout.cacheNamespaceRoot,
    namespaceIdentity,
    quarantineContainer,
    quarantineIdentity,
    quarantineRoot,
    pythonExecutable,
  });
  if (restoreError !== null) {
    if (cleanupError !== null) restoreError.cause = cleanupError;
    throw restoreError;
  }
  if (cleanupError !== null) throw cleanupError;
  return removed;
}

module.exports = { clean };
