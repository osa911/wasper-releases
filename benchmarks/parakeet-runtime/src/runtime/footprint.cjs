'use strict';

const childProcess = require('node:child_process');

const FOOTPRINT_COMMAND = '/usr/bin/footprint';
const TOP_COMMAND = '/usr/bin/top';
const TOP_TIMEOUT_MS = 5_000;
const UNIT_BYTES = Object.freeze({
  B: 1,
  KB: 1_000,
  KiB: 1024,
  MB: 1_000_000,
  MiB: 1024 ** 2,
  GB: 1_000_000_000,
  GiB: 1024 ** 3,
});
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

function parsePhysicalFootprint(rawOutput) {
  if (typeof rawOutput !== 'string') throw new TypeError('footprint raw output must be a string');
  const matches = rawOutput
    .split(/\r?\n/u)
    .map(line => line.trim().split(':'))
    .filter(parts => parts.length === 2 && parts[0].trim() === 'phys_footprint_peak')
    .map(parts => parts[1].trim().split(/\s+/u))
    .filter(parts => parts.length === 2 && isUnsignedDecimal(parts[0]));
  if (matches.length !== 1 || !Object.hasOwn(UNIT_BYTES, matches[0][1])) {
    throw new Error(
      'footprint output must contain exactly one phys_footprint_peak value with a unit'
    );
  }
  const value = Number(matches[0][0]);
  const bytes = value * UNIT_BYTES[matches[0][1]];
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error('phys_footprint_peak must be a positive finite value');
  }
  return bytes;
}

function parseTopMemoryValue(value) {
  if (typeof value !== 'string' || value.length < 2) return null;
  const unit = value.at(-1);
  const numeric = value.slice(0, -1);
  if (!isUnsignedDecimal(numeric) || !Object.hasOwn(TOP_UNIT_BYTES, unit)) return null;
  return { numeric, unit };
}

function parseTopPhysicalFootprint(rawOutput, pid) {
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

function samplePhysicalFootprint(
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
  if (typeof result?.stdout !== 'string')
    throw new TypeError('top command stdout must be a string');
  const timestamp = clock();
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.valueOf())) {
    throw new TypeError('footprint clock must return a valid Date');
  }
  const physicalFootprintBytes = parseTopPhysicalFootprint(result.stdout, pid);
  return deepFreeze({
    pid,
    timestamp: timestamp.toISOString(),
    command: `${TOP_COMMAND} ${arguments_.join(' ')}`,
    rawOutput: result.stdout,
    phys_footprint_peak: physicalFootprintBytes,
    phys_footprint_peak_unit: 'bytes',
    physFootprintPeakBytes: physicalFootprintBytes,
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
    if (pids.has(process.pid))
      throw new TypeError(`owned process tree contains duplicate PID ${process.pid}`);
    pids.add(process.pid);
    return samplePhysicalFootprint(process.pid, options);
  });
  return validatePhysicalFootprintEvidence({
    samples,
    phys_footprint_peak: samples.reduce((total, sample) => total + sample.phys_footprint_peak, 0),
    phys_footprint_peak_unit: 'bytes',
    physFootprintPeakBytes: samples.reduce(
      (total, sample) => total + sample.physFootprintPeakBytes,
      0
    ),
  });
}

function parseSamplePhysicalFootprint(sample) {
  const topCommand = `${TOP_COMMAND} -l 1 -pid ${sample.pid} -stats pid,mem`;
  if (sample.command === topCommand) return parseTopPhysicalFootprint(sample.rawOutput, sample.pid);
  const legacyFootprintCommand = `${FOOTPRINT_COMMAND} -p ${sample.pid}`;
  if (sample.command === legacyFootprintCommand) return parsePhysicalFootprint(sample.rawOutput);
  throw new TypeError(
    `physical footprint sample command must equal ${topCommand} or ${legacyFootprintCommand}`
  );
}

function validatePhysicalFootprintEvidence(evidence) {
  if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new TypeError('physical footprint evidence must be an object');
  }
  if (Object.hasOwn(evidence, 'totalRssBytes') || Object.hasOwn(evidence, 'rssBytes')) {
    throw new TypeError('RSS is not physical footprint evidence');
  }
  if (!Array.isArray(evidence.samples) || evidence.samples.length === 0) {
    throw new TypeError('physical footprint evidence must include one or more samples');
  }
  if (!Number.isFinite(evidence.physFootprintPeakBytes) || evidence.physFootprintPeakBytes <= 0) {
    throw new TypeError(
      'physical footprint evidence must include a positive numeric physFootprintPeakBytes'
    );
  }
  if (
    !Number.isFinite(evidence.phys_footprint_peak) ||
    evidence.phys_footprint_peak <= 0 ||
    evidence.phys_footprint_peak_unit !== 'bytes'
  ) {
    throw new TypeError(
      'physical footprint evidence must include numeric phys_footprint_peak in bytes'
    );
  }
  let total = 0;
  const samples = evidence.samples.map((sample, index) => {
    if (sample === null || typeof sample !== 'object' || Array.isArray(sample)) {
      throw new TypeError(`physical footprint sample ${index} must be an object`);
    }
    requirePositivePid(sample.pid, `physical footprint sample ${index}.pid`);
    if (typeof sample.timestamp !== 'string' || Number.isNaN(Date.parse(sample.timestamp))) {
      throw new TypeError(`physical footprint sample ${index}.timestamp must be an ISO timestamp`);
    }
    if (typeof sample.rawOutput !== 'string' || sample.rawOutput === '') {
      throw new TypeError(
        `physical footprint sample ${index}.rawOutput must retain command output`
      );
    }
    let parsed;
    try {
      parsed = parseSamplePhysicalFootprint(sample);
    } catch (error) {
      throw new TypeError(`physical footprint sample ${index}.command is invalid`, {
        cause: error,
      });
    }
    if (
      sample.physFootprintPeakBytes !== parsed ||
      sample.phys_footprint_peak !== parsed ||
      sample.phys_footprint_peak_unit !== 'bytes'
    ) {
      throw new TypeError(
        `physical footprint sample ${index} does not match its raw command output`
      );
    }
    total += parsed;
    return {
      pid: sample.pid,
      timestamp: sample.timestamp,
      command: sample.command,
      rawOutput: sample.rawOutput,
      phys_footprint_peak: parsed,
      phys_footprint_peak_unit: 'bytes',
      physFootprintPeakBytes: parsed,
    };
  });
  if (evidence.physFootprintPeakBytes !== total || evidence.phys_footprint_peak !== total) {
    throw new TypeError('physical footprint evidence total does not match owned process samples');
  }
  return deepFreeze({
    samples,
    phys_footprint_peak: total,
    phys_footprint_peak_unit: 'bytes',
    physFootprintPeakBytes: total,
  });
}

module.exports = {
  FOOTPRINT_COMMAND,
  TOP_COMMAND,
  TOP_TIMEOUT_MS,
  parsePhysicalFootprint,
  parseTopPhysicalFootprint,
  sampleOwnedProcessTree,
  samplePhysicalFootprint,
  validatePhysicalFootprintEvidence,
};
