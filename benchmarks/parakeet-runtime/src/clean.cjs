'use strict';

const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual, promisify } = require('node:util');

const { OWNER_FILE, expectedOwnershipMarker, isInside, resolveLayout } = require('./config.cjs');

const CLEANUP_DIRECTORY_NAMES = Object.freeze(['artifacts', 'corpus', 'holders', 'runs']);
const DELETE_HELPER = path.join(__dirname, 'delete-owned-cache.py');
const DEFAULT_PYTHON = 'python3';
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

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function findOwnedCacheByIdentity(quarantineContainer, expectedIdentity) {
  const matches = [];
  for (const name of fs.readdirSync(quarantineContainer)) {
    const candidate = path.join(quarantineContainer, name);
    const stat = fs.lstatSync(candidate, { bigint: true });
    if (stat.isDirectory() && !stat.isSymbolicLink() && sameIdentity(stat, expectedIdentity)) {
      matches.push(candidate);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

async function runDescriptorHelper(pythonExecutable, arguments_) {
  let stdout;
  try {
    ({ stdout } = await execFileAsync(pythonExecutable, [DELETE_HELPER, ...arguments_], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    }));
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

async function removeSymlinkWithDirectoryDescriptor({
  pythonExecutable,
  parent,
  parentIdentity,
  name,
}) {
  const result = await runDescriptorHelper(pythonExecutable, [
    'remove-symlink',
    '--parent',
    parent,
    '--parent-device',
    parentIdentity.dev.toString(),
    '--parent-inode',
    parentIdentity.ino.toString(),
    '--name',
    name,
  ]);
  if (
    result === null ||
    typeof result !== 'object' ||
    (result.removed !== true && result.removed !== false)
  ) {
    throw new Error('descriptor-relative benchmark cleanup returned invalid output');
  }
  return result.removed;
}

async function removeQuarantineWithDirectoryDescriptors({
  pythonExecutable,
  namespaceRoot,
  namespaceIdentity,
  quarantineContainer,
  quarantineIdentity,
  entries,
}) {
  const arguments_ = [
    'remove-quarantine',
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
  ];
  for (const entry of entries) arguments_.push('--entry', entry);
  const result = await runDescriptorHelper(pythonExecutable, arguments_);
  if (
    result === null ||
    typeof result !== 'object' ||
    result.containerRemoved !== true ||
    !Array.isArray(result.removed) ||
    !isDeepStrictEqual([...result.removed].sort(), [...entries].sort())
  ) {
    throw new Error('descriptor-relative benchmark cleanup returned invalid output');
  }
}

async function restoreQuarantinedCache({
  cacheRoot,
  expectedIdentity,
  namespaceRoot,
  namespaceIdentity,
  quarantineContainer,
  quarantineIdentity,
  quarantineRoot,
  pythonExecutable,
}) {
  const replacementNotes = [];
  let removedCacheReplacement;
  try {
    removedCacheReplacement = await removeSymlinkWithDirectoryDescriptor({
      pythonExecutable,
      parent: namespaceRoot,
      parentIdentity: namespaceIdentity,
      name: path.basename(cacheRoot),
    });
  } catch (error) {
    return new Error(
      `benchmark cache root was replaced during cleanup; owned cache retained at ${quarantineRoot}`,
      { cause: error }
    );
  }
  if (removedCacheReplacement) replacementNotes.push(`${cacheRoot} was a symlink`);

  const ownedCache = findOwnedCacheByIdentity(quarantineContainer, expectedIdentity);
  if (ownedCache === null) {
    return new Error(
      `could not locate the quarantined owned cache by identity in ${quarantineContainer}`
    );
  }
  if (ownedCache !== quarantineRoot) {
    replacementNotes.push(`${quarantineRoot} changed identity`);
  }

  try {
    fs.renameSync(ownedCache, cacheRoot);
    const restoredStat = fs.lstatSync(cacheRoot, { bigint: true });
    if (!restoredStat.isDirectory() || !sameIdentity(restoredStat, expectedIdentity)) {
      throw new Error('restored benchmark cache does not match the quarantined directory identity');
    }
    readOwnershipMarker(cacheRoot, cacheRoot);

    const leftoverNames = [];
    for (const name of fs.readdirSync(quarantineContainer)) {
      const leftover = path.join(quarantineContainer, name);
      const stat = fs.lstatSync(leftover);
      if (!stat.isSymbolicLink()) {
        throw new Error(`cleanup quarantine retained an unowned entry: ${leftover}`);
      }
      leftoverNames.push(name);
    }
    await removeQuarantineWithDirectoryDescriptors({
      pythonExecutable,
      namespaceRoot,
      namespaceIdentity,
      quarantineContainer,
      quarantineIdentity,
      entries: leftoverNames,
    });
  } catch (error) {
    return new Error(`could not restore owned benchmark cache from ${quarantineRoot}`, {
      cause: error,
    });
  }

  if (replacementNotes.length > 0) {
    const replacementKind = replacementNotes.some(note => note.startsWith(cacheRoot))
      ? 'benchmark cache root'
      : 'quarantined owned cache';
    return new Error(
      `${replacementKind} was replaced during cleanup: ${replacementNotes.join(', ')}`
    );
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

async function clean(layout, { beforeRemove, pythonExecutable = DEFAULT_PYTHON } = {}) {
  const resolvedLayout = canonicalLayout(layout);
  const cacheRoot = fs.realpathSync.native(resolvedLayout.cacheRoot);
  if (cacheRoot !== resolvedLayout.cacheRoot) {
    throw new Error('benchmark cache changed after layout resolution');
  }
  readOwnershipMarker(cacheRoot, cacheRoot);
  const plannedRoots = cleanupRoots(cacheRoot);
  const expectedIdentity = fs.lstatSync(cacheRoot, { bigint: true });
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
      throw new Error('generated cleanup directories changed during descriptor-relative deletion');
    }
    for (const name of removedNames) {
      removed.push(path.join(cacheRoot, name));
    }
  } catch (error) {
    cleanupError = error;
  }

  const restoreError = await restoreQuarantinedCache({
    cacheRoot,
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
