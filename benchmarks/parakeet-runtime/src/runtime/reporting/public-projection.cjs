'use strict';

const { projectPublicFootprint } = require('../footprint.cjs');
const { projectPublicModelIdentity } = require('../model-identity.cjs');

const PUBLIC_EVIDENCE_SCHEMA = 'wasper.parakeet-runtime-benchmark.public-evidence.v1';
const PUBLIC_RUN_STATUSES = Object.freeze({
  full: Object.freeze({ cohort: 'all', verification: 'full-comparison' }),
  'ready-short': Object.freeze({ cohort: 'short', verification: 'partial-non-comparable' }),
});

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function projectedStatus(source) {
  if (typeof source?.mode !== 'string' || !Object.hasOwn(PUBLIC_RUN_STATUSES, source.mode)) {
    return undefined;
  }
  const expected = PUBLIC_RUN_STATUSES[source?.mode];
  if (source.cohort !== expected.cohort || source.verification !== expected.verification) return undefined;
  return { cohort: expected.cohort, mode: source.mode, verification: expected.verification };
}

function projectedIdentity(runIdentity) {
  const source = runIdentity ?? {};
  const result = {};
  for (const field of ['runtimeLockSha256', 'corpusSha256']) {
    if (typeof source[field] === 'string') result[field] = source[field];
  }
  if (source.hardware && typeof source.hardware === 'object') {
    result.hardware = {};
    for (const field of ['arch', 'platform', 'release']) {
      if (typeof source.hardware[field] === 'string') result.hardware[field] = source.hardware[field];
    }
  }
  if (source.wasperRelease && typeof source.wasperRelease === 'object') {
    result.wasperRelease = {};
    for (const field of ['version', 'nativeServerSha256', 'baselineKind']) {
      if (typeof source.wasperRelease[field] === 'string') {
        result.wasperRelease[field] = source.wasperRelease[field];
      }
    }
  }
  const status = projectedStatus(source);
  if (status !== undefined) result.status = status;
  return result;
}

function projectedFixture(record) {
  const evidence = record.fixtureEvidence ?? {};
  return {
    id: record.fixtureId,
    language: record.language,
    cohort: record.cohort,
    ...(typeof evidence.sourceSha256 === 'string' ? { sourceSha256: evidence.sourceSha256 } : {}),
    ...(typeof evidence.normalizedWavSha256 === 'string'
      ? { normalizedWavSha256: evidence.normalizedWavSha256 }
      : {}),
    ...(typeof evidence.referenceSha256 === 'string' ? { referenceSha256: evidence.referenceSha256 } : {}),
    ...(finite(evidence.durationSeconds) === undefined
      ? {}
      : { durationSeconds: evidence.durationSeconds }),
  };
}

function projectedScore(score) {
  const projectMetric = metric => {
    if (
      !Number.isSafeInteger(metric?.errors) ||
      !Number.isSafeInteger(metric?.referenceUnits) ||
      metric.referenceUnits <= 0
    ) {
      return null;
    }
    return {
      errors: metric.errors,
      referenceUnits: metric.referenceUnits,
      value: metric.errors / metric.referenceUnits,
    };
  };
  const wer = projectMetric(score?.wer);
  const cer = projectMetric(score?.cer);
  return wer === null || cer === null ? null : { wer, cer };
}

function projectedLimitation(record) {
  if (record.outcome === 'unavailable-long') return { state: 'unavailable-long' };
  if (record.outcome === 'error') return { state: 'runtime-error' };
  if (record.outcome !== 'memory-excluded') return undefined;
  const source = record.raw?.memoryExclusion ?? {};
  const limitation = { state: 'memory-excluded' };
  for (const field of [
    'code',
    'metric',
    'maxPhysicalFootprintBytes',
    'observedMemoryBytes',
    'observedPhysicalFootprintBytes',
  ]) {
    if (typeof source[field] === 'string' || finite(source[field]) !== undefined) {
      limitation[field] = source[field];
    }
  }
  return limitation;
}

function projectedRecord(record) {
  const result = {
    order: record.order,
    runtimeId: record.cellId,
    pass: record.pass,
    status: record.outcome,
    fixture: projectedFixture(record),
  };
  const score = record.outcome === 'success' ? projectedScore(record.score) : null;
  if (score !== null) result.score = score;
  if (record.outcome === 'success' && finite(record.audioSeconds) !== undefined && finite(record.wallSeconds) !== undefined) {
    result.timing = {
      audioSeconds: record.audioSeconds,
      wallSeconds: record.wallSeconds,
      ...(record.audioSeconds > 0 ? { rtf: record.wallSeconds / record.audioSeconds } : {}),
    };
  }
  const footprint = projectPublicFootprint(record.footprint);
  if (footprint !== null) result.footprint = footprint;
  const limitation = projectedLimitation(record);
  if (limitation !== undefined) result.limitation = limitation;
  return result;
}

function projectedWorkload(workload, { omitPartialLongMetrics = false } = {}) {
  const result = {};
  for (const field of [
    'expectedRequests',
    'completedRequests',
    'failureCount',
    'memoryExcludedRequests',
    'unavailableRequests',
  ]) {
    if (Number.isSafeInteger(workload?.[field]) && workload[field] >= 0) result[field] = workload[field];
  }
  const partial =
    omitPartialLongMetrics &&
    Number.isSafeInteger(result.expectedRequests) &&
    result.completedRequests !== result.expectedRequests;
  if (!partial) {
    for (const field of ['wer', 'cer', 'medianWallSeconds', 'realTimeSpeed', 'rtf']) {
      if (finite(workload?.[field]) !== undefined) result[field] = workload[field];
    }
  }
  if (workload?.languages && typeof workload.languages === 'object') {
    result.languages = Object.fromEntries(
      Object.entries(workload.languages).map(([language, value]) => [
        language,
        projectedWorkload(value, { omitPartialLongMetrics }),
      ])
    );
  }
  return result;
}

function projectedAggregate(aggregate) {
  const cells = {};
  for (const [runtimeId, cell] of Object.entries(aggregate?.cells ?? {})) {
    const runtime = cell.runtime ?? {};
    cells[runtimeId] = {
      runtime: Object.fromEntries(
        ['id', 'label', 'holder', 'quantization', 'languagePolicy']
          .filter(field => runtime[field] !== undefined)
          .map(field => [field, runtime[field]])
      ),
      ...(finite(cell.phys_footprint_peak) === undefined
        ? {}
        : { phys_footprint_peak: cell.phys_footprint_peak }),
      ...(typeof cell.memoryExcluded === 'boolean' ? { memoryExcluded: cell.memoryExcluded } : {}),
      workloads: Object.fromEntries(
        Object.entries(cell.workloads ?? {}).map(([name, workload]) => [
          name,
          projectedWorkload(workload, { omitPartialLongMetrics: name === 'longRobustness' }),
        ])
      ),
    };
  }
  return { cells };
}

function projectedRuntimeIdentities(activations) {
  const byRuntime = new Map();
  for (const activation of activations ?? []) {
    if (typeof activation?.cellId !== 'string' || byRuntime.has(activation.cellId)) continue;
    if (!activation.identity) continue;
    const identity = projectPublicModelIdentity(
      activation.identity.modelEvidence ?? activation.identity
    );
    byRuntime.set(activation.cellId, {
      cellId: activation.cellId,
      ...(identity.identityHash === undefined ? {} : { identityHash: identity.identityHash }),
      identity: identity.identity,
    });
  }
  return [...byRuntime.values()];
}

function projectPublicEvidence(run) {
  if (run === null || typeof run !== 'object' || Array.isArray(run)) {
    throw new TypeError('local run evidence must be an object');
  }
  if (typeof run.runId !== 'string' || run.runId === '') throw new TypeError('local run id is required');
  if (!Array.isArray(run.records)) throw new TypeError('local run records are required');
  const runtimeIdentities = projectedRuntimeIdentities(run.activations);
  const publicRun = projectedIdentity(run.runIdentity);
  if (publicRun.wasperRelease === undefined) {
    const wasperIdentity = runtimeIdentities.find(identity => identity.cellId === 'wasper-metal-int8');
    if (wasperIdentity?.identity.release !== undefined) {
      publicRun.wasperRelease = wasperIdentity.identity.release;
    }
  }
  return {
    schema: PUBLIC_EVIDENCE_SCHEMA,
    runId: run.runId,
    run: publicRun,
    runtimeIdentities,
    records: run.records.map(projectedRecord),
    aggregate: projectedAggregate(run.aggregate),
  };
}

module.exports = { PUBLIC_EVIDENCE_SCHEMA, projectPublicEvidence };
