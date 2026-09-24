'use strict';

const childProcess = require('node:child_process');

const TOP_COMMAND = '/usr/bin/top';
const TOP_TIMEOUT_MS = 5_000;
const TOP_UNIT_BYTES = Object.freeze({
  B: 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
  P: 1024 ** 5,
});

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requirePositivePid(value, label = 'pid') {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
}

function isUnsignedDecimal(value) {
  const parts = value.split('.');
  return parts.length <= 2 && parts.every(part => part !== '' && !/[^0-9]/u.test(part));
}

function parseTopMemoryValue(value) {
  if (typeof value !== 'string' || value.length < 2) return null;
  const unit = value.at(-1);
  const numeric = value.slice(0, -1);
  if (!isUnsignedDecimal(numeric) || !Object.hasOwn(TOP_UNIT_BYTES, unit)) return null;
  return { numeric, unit };
}

function parseTopPostResponsePhysicalFootprint(rawOutput, pid) {
  if (typeof rawOutput !== 'string') throw new TypeError('top raw output must be a string');
  requirePositivePid(pid);
  const matches = rawOutput
    .split(/\r?\n/u)
    .map(line => line.trim().split(/\s+/u))
    .filter(parts => parts.length === 2 && parts[0] === String(pid))
    .map(parts => parseTopMemoryValue(parts[1]))
    .filter(Boolean);
  if (matches.length !== 1) {
    throw new Error('top output must contain exactly one physical-memory value for the target pid');
  }
  const value = Number(matches[0].numeric);
  const bytes = value * TOP_UNIT_BYTES[matches[0].unit];
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error('top physical-memory value must be a positive finite value');
  }
  return bytes;
}

function topFailure(result) {
  if (result?.error?.code === 'ETIMEDOUT') return 'top command timed out';
  if (result?.signal) return `top command exited from signal ${result.signal}`;
  if (result?.status !== 0) {
    const detail =
      typeof result?.stderr === 'string' && result.stderr.trim() !== ''
        ? `: ${result.stderr.trim()}`
        : '';
    return `top command failed with status ${String(result?.status)}${detail}`;
  }
  return null;
}

function samplePostResponsePhysicalFootprint(
  pid,
  { spawnSyncImpl = childProcess.spawnSync, clock = () => new Date() } = {}
) {
  requirePositivePid(pid);
  if (typeof spawnSyncImpl !== 'function') throw new TypeError('spawnSyncImpl must be a function');
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const arguments_ = ['-l', '1', '-pid', String(pid), '-stats', 'pid,mem'];
  const result = spawnSyncImpl(TOP_COMMAND, arguments_, {
    encoding: 'utf8',
    timeout: TOP_TIMEOUT_MS,
  });
  const failure = topFailure(result);
  if (failure) throw new Error(failure, { cause: result?.error });
  if (typeof result?.stdout !== 'string') {
    throw new TypeError('top command stdout must be a string');
  }
  const timestamp = clock();
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.valueOf())) {
    throw new TypeError('footprint clock must return a valid Date');
  }
  const physicalFootprintBytes = parseTopPostResponsePhysicalFootprint(result.stdout, pid);
  return deepFreeze({
    pid,
    timestamp: timestamp.toISOString(),
    command: `${TOP_COMMAND} ${arguments_.join(' ')}`,
    rawOutput: result.stdout,
    post_response_phys_footprint: physicalFootprintBytes,
    post_response_phys_footprint_unit: 'bytes',
    postResponsePhysicalFootprintBytes: physicalFootprintBytes,
  });
}

function sampleOwnedProcessTree(processes, options = {}) {
  if (!Array.isArray(processes) || processes.length === 0) {
    throw new TypeError('owned process tree must contain at least one process');
  }
  const pids = new Set();
  const samples = processes.map((process, index) => {
    if (process === null || typeof process !== 'object') {
      throw new TypeError(`owned process tree entry ${index} must be an object`);
    }
    requirePositivePid(process.pid, `owned process tree entry ${index}.pid`);
    if (pids.has(process.pid)) {
      throw new TypeError(`owned process tree contains duplicate PID ${process.pid}`);
    }
    pids.add(process.pid);
    return samplePostResponsePhysicalFootprint(process.pid, options);
  });
  return validatePostResponsePhysicalFootprintEvidence({
    samples,
    post_response_phys_footprint: samples.reduce(
      (total, sample) => total + sample.post_response_phys_footprint,
      0
    ),
    post_response_phys_footprint_unit: 'bytes',
    postResponsePhysicalFootprintBytes: samples.reduce(
      (total, sample) => total + sample.postResponsePhysicalFootprintBytes,
      0
    ),
  });
}

function parsePostResponsePhysicalFootprintSample(sample) {
  const topCommand = `${TOP_COMMAND} -l 1 -pid ${sample.pid} -stats pid,mem`;
  if (sample.command === topCommand) {
    return parseTopPostResponsePhysicalFootprint(sample.rawOutput, sample.pid);
  }
  throw new TypeError(`post-response physical footprint sample command must equal ${topCommand}`);
}

function validatePostResponsePhysicalFootprintEvidence(evidence) {
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new TypeError('post-response physical footprint evidence must be an object');
  }
  if (Object.hasOwn(evidence, 'totalRssBytes') || Object.hasOwn(evidence, 'rssBytes')) {
    throw new TypeError('RSS is not physical footprint evidence');
  }
  if (!Array.isArray(evidence.samples) || evidence.samples.length === 0) {
    throw new TypeError('post-response physical footprint evidence must include one or more samples');
  }
  if (
    !Number.isFinite(evidence.postResponsePhysicalFootprintBytes) ||
    evidence.postResponsePhysicalFootprintBytes <= 0
  ) {
    throw new TypeError(
      'post-response physical footprint evidence must include a positive numeric postResponsePhysicalFootprintBytes'
    );
  }
  if (
    !Number.isFinite(evidence.post_response_phys_footprint) ||
    evidence.post_response_phys_footprint <= 0 ||
    evidence.post_response_phys_footprint_unit !== 'bytes'
  ) {
    throw new TypeError(
      'post-response physical footprint evidence must include numeric post_response_phys_footprint in bytes'
    );
  }
  let total = 0;
  const samples = evidence.samples.map((sample, index) => {
    if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) {
      throw new TypeError(`post-response physical footprint sample ${index} must be an object`);
    }
    requirePositivePid(sample.pid, `post-response physical footprint sample ${index}.pid`);
    if (typeof sample.timestamp !== 'string' || Number.isNaN(Date.parse(sample.timestamp))) {
      throw new TypeError(
        `post-response physical footprint sample ${index}.timestamp must be an ISO timestamp`
      );
    }
    if (typeof sample.rawOutput !== 'string' || sample.rawOutput === '') {
      throw new TypeError(
        `post-response physical footprint sample ${index}.rawOutput must retain command output`
      );
    }
    let parsed;
    try {
      parsed = parsePostResponsePhysicalFootprintSample(sample);
    } catch (error) {
      throw new TypeError(`post-response physical footprint sample ${index}.command is invalid`, {
        cause: error,
      });
    }
    if (
      sample.postResponsePhysicalFootprintBytes !== parsed ||
      sample.post_response_phys_footprint !== parsed ||
      sample.post_response_phys_footprint_unit !== 'bytes'
    ) {
      throw new TypeError(
        `post-response physical footprint sample ${index} does not match its raw command output`
      );
    }
    total += parsed;
    return {
      pid: sample.pid,
      timestamp: sample.timestamp,
      command: sample.command,
      rawOutput: sample.rawOutput,
      post_response_phys_footprint: parsed,
      post_response_phys_footprint_unit: 'bytes',
      postResponsePhysicalFootprintBytes: parsed,
    };
  });
  if (
    evidence.postResponsePhysicalFootprintBytes !== total ||
    evidence.post_response_phys_footprint !== total
  ) {
    throw new TypeError(
      'post-response physical footprint evidence total does not match owned process samples'
    );
  }
  return deepFreeze({
    samples,
    post_response_phys_footprint: total,
    post_response_phys_footprint_unit: 'bytes',
    postResponsePhysicalFootprintBytes: total,
  });
}

function projectPublicFootprint(evidence) {
  const bytes =
    evidence?.postResponsePhysicalFootprintBytes ?? evidence?.post_response_phys_footprint;
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return Object.freeze({ post_response_phys_footprint: bytes });
}

module.exports = {
  TOP_COMMAND,
  TOP_TIMEOUT_MS,
  parseTopPostResponsePhysicalFootprint,
  projectPublicFootprint,
  sampleOwnedProcessTree,
  samplePostResponsePhysicalFootprint,
  validatePostResponsePhysicalFootprintEvidence,
};
