'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const { canonicalJson } = require('../asr-quality/manifest.cjs');
const { OWNER_FILE, expectedOwnershipMarker, resolveLayout } = require('../config.cjs');

function cloneJson(value, label = 'value') {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TypeError(`${label} must be plain JSON: ${error.message}`, { cause: error });
  }
}

function hash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function resolveOwnedLayout(layout) {
  if (layout === null || typeof layout !== 'object' || Array.isArray(layout)) {
    throw new TypeError('layout is required for local benchmark evidence');
  }
  const resolved = resolveLayout({
    cacheDir: layout.cacheRoot,
    outputDir: layout.outputRoot,
    ...(layout.homeDirectory === undefined ? {} : { homeDirectory: layout.homeDirectory }),
    ...(layout.wasperApp == null ? {} : { wasperApp: layout.wasperApp }),
  });
  if (resolved.cacheRoot !== layout.cacheRoot || resolved.outputRoot !== layout.outputRoot) {
    throw new Error('benchmark evidence layout changed or is forged');
  }
  const markerPath = path.join(resolved.cacheRoot, OWNER_FILE);
  let marker;
  try {
    const stat = fs.lstatSync(markerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
    marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  } catch (error) {
    throw new Error(`benchmark ownership marker is invalid: ${markerPath}`, { cause: error });
  }
  if (!isDeepStrictEqual(marker, expectedOwnershipMarker(resolved.cacheRoot))) {
    throw new Error(`benchmark ownership marker does not match this cache: ${markerPath}`);
  }
  return resolved;
}

function timestampId(now) {
  if (!(now instanceof Date) || Number.isNaN(now.valueOf())) {
    throw new TypeError('evidence clock must return a valid Date');
  }
  return now.toISOString().replace(/[-:.]/gu, '').replace('Z', 'Z');
}

function createEvidenceStore({ layout, runIdentity, resume = false, clock = () => new Date() }) {
  const ownedLayout = resolveOwnedLayout(layout);
  if (typeof clock !== 'function') throw new TypeError('evidence clock must be a function');
  const identity = cloneJson(runIdentity, 'runIdentity');
  const runId = `${timestampId(clock())}-${hash(identity).slice(0, 12)}`;
  const runDirectory = path.join(ownedLayout.outputRoot, runId);
  const runPath = path.join(runDirectory, 'run.json');
  const requestsDirectory = path.join(runDirectory, 'requests');
  const activationsDirectory = path.join(runDirectory, 'activations');
  const existed = fs.existsSync(runPath);

  if (existed) {
    const persisted = readJson(runPath);
    if (canonicalJson(persisted.identity) !== canonicalJson(identity)) {
      throw new Error('run identity does not match immutable persisted identity');
    }
    if (!resume) throw new Error(`run ${runId} already exists; use resume to continue it`);
  } else {
    if (resume) {
      const existingRuns = fs.existsSync(ownedLayout.outputRoot)
        ? fs
            .readdirSync(ownedLayout.outputRoot)
            .map(name => path.join(ownedLayout.outputRoot, name, 'run.json'))
            .filter(filePath => fs.existsSync(filePath))
        : [];
      if (existingRuns.length === 1) {
        const persisted = readJson(existingRuns[0]);
        if (canonicalJson(persisted.identity) !== canonicalJson(identity)) {
          throw new Error('run identity does not match immutable persisted identity');
        }
      }
      throw new Error(`cannot resume missing run ${runId}`);
    }
    writeJson(runPath, {
      schema: 'wasper.parakeet-runtime-benchmark.private-run-evidence.v1',
      runId,
      identity,
      createdAt: new Date().toISOString(),
    });
  }

  function requestPath(order) {
    if (!Number.isSafeInteger(order) || order < 0)
      throw new TypeError('request order must be a non-negative integer');
    return path.join(requestsDirectory, `${String(order).padStart(8, '0')}.json`);
  }

  return Object.freeze({
    runId,
    runDirectory,
    existed,
    writeActivation(record) {
      if (!Number.isSafeInteger(record?.sequence) || record.sequence < 0) {
        throw new TypeError('activation record sequence must be a non-negative integer');
      }
      writeJson(
        path.join(activationsDirectory, `${String(record.sequence).padStart(4, '0')}.json`),
        cloneJson(record, 'activation record')
      );
    },
    writeRequest(record) {
      const filePath = requestPath(record?.order);
      if (fs.existsSync(filePath)) return;
      writeJson(filePath, cloneJson(record, 'request record'));
    },
    readRequests() {
      if (!fs.existsSync(requestsDirectory)) return [];
      return fs
        .readdirSync(requestsDirectory)
        .filter(name => name.endsWith('.json'))
        .sort()
        .map(name => readJson(path.join(requestsDirectory, name)));
    },
    readActivations() {
      if (!fs.existsSync(activationsDirectory)) return [];
      return fs
        .readdirSync(activationsDirectory)
        .filter(name => name.endsWith('.json'))
        .sort()
        .map(name => readJson(path.join(activationsDirectory, name)));
    },
    writeArtifact(name, value) {
      if (!/^[a-z0-9][a-z0-9-]*\.json$/u.test(name)) {
        throw new TypeError('private artifact name must be a lowercase JSON filename');
      }
      writeJson(path.join(runDirectory, name), cloneJson(value, name));
    },
    writeText(name, text) {
      if (!/^[a-z0-9][a-z0-9-]*\.md$/u.test(name) || typeof text !== 'string') {
        throw new TypeError(
          'private text artifact must be a lowercase Markdown filename and string'
        );
      }
      fs.writeFileSync(path.join(runDirectory, name), text, { mode: 0o600 });
    },
    evidenceHash(records) {
      return hash(
        records
          .map(record => cloneJson(record.raw, 'raw record'))
          .sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))
      );
    },
  });
}

module.exports = { createEvidenceStore };
