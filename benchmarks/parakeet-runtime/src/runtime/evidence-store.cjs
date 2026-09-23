'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { canonicalJson } = require('../asr-quality/manifest.cjs');

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

function createEvidenceStore({ outputRoot, runIdentity, resume = false }) {
  if (typeof outputRoot !== 'string' || outputRoot.trim() === '') {
    throw new TypeError('outputRoot must be a non-empty string');
  }
  const identity = cloneJson(runIdentity, 'runIdentity');
  const runId = hash(identity);
  const runDirectory = path.join(path.resolve(outputRoot), 'runs', runId);
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
      const runsDirectory = path.join(path.resolve(outputRoot), 'runs');
      const existingRuns = fs.existsSync(runsDirectory)
        ? fs
            .readdirSync(runsDirectory)
            .map(name => path.join(runsDirectory, name, 'run.json'))
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
