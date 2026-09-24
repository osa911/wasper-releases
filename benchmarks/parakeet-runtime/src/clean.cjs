'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const { OWNER_FILE, expectedOwnershipMarker, isInside, resolveLayout } = require('./config.cjs');

function readOwnershipMarker(cacheRoot) {
  const markerPath = path.join(cacheRoot, OWNER_FILE);
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
  if (!isInside(cacheRoot, resolvedMarker)) {
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
  if (!isDeepStrictEqual(marker, expectedOwnershipMarker(cacheRoot))) {
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

function cleanupRoots(layout) {
  const candidates = [
    layout.artifactsRoot,
    layout.corpusRoot,
    layout.holdersRoot,
    path.join(layout.cacheRoot, 'runs'),
    layout.outputRoot,
  ];
  const roots = [];
  for (const candidate of candidates) {
    if (roots.some(root => candidate === root || isInside(root, candidate))) continue;
    roots.push(candidate);
  }
  return roots;
}

async function clean(layout, { beforeRemove } = {}) {
  if (layout === null || typeof layout !== 'object') {
    throw new TypeError('layout is required');
  }
  const canonicalLayout = resolveLayout({
    cacheDir: layout.cacheRoot,
    homeDirectory: layout.homeDirectory,
    outputDir: layout.outputRoot,
    ...(layout.wasperApp === null ? {} : { wasperApp: layout.wasperApp }),
  });
  const cacheRoot = fs.realpathSync.native(canonicalLayout.cacheRoot);
  if (cacheRoot !== canonicalLayout.cacheRoot) {
    throw new Error('benchmark cache changed after layout resolution');
  }
  readOwnershipMarker(cacheRoot);

  const removals = [];
  for (const cleanupRoot of cleanupRoots(canonicalLayout)) {
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
    removals.push(resolvedRoot);
  }

  for (const removal of removals) {
    beforeRemove?.(removal);
    await fs.promises.rm(removal, { force: true, recursive: true });
  }
  return removals;
}

module.exports = { clean };
