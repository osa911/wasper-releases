'use strict';

const REQUIRED_BUCKET_FRAMES = Object.freeze([896, 960]);

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function nearestRank(sortedValues, percentile) {
  return sortedValues[Math.max(0, Math.ceil(sortedValues.length * percentile) - 1)];
}

function createTimingSummary(records) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  const groups = new Map();
  for (const record of records) {
    if (record?.outcome !== 'success') continue;
    if (!Number.isFinite(record.wallSeconds) || record.wallSeconds <= 0) continue;
    if (!Number.isFinite(record.audioSeconds) || record.audioSeconds <= 0) continue;
    const encoderBucketFrames = Number.isSafeInteger(record.encoderBucketFrames)
      ? record.encoderBucketFrames
      : null;
    const cohort = record.cohort ?? 'unknown';
    const cacheCondition = record.cacheCondition ?? 'unknown';
    const key = JSON.stringify([cohort, cacheCondition, encoderBucketFrames]);
    const group = groups.get(key) ?? {
      cohort,
      cacheCondition,
      encoderBucketFrames,
      latenciesMs: [],
      audioSeconds: 0,
      inferenceSeconds: 0,
    };
    group.latenciesMs.push(record.wallSeconds * 1_000);
    group.audioSeconds += record.audioSeconds;
    group.inferenceSeconds += record.wallSeconds;
    groups.set(key, group);
  }
  return {
    schema: 'wasper.parakeet-runtime-benchmark.timing-summary.v1',
    percentileMethod: 'nearest-rank',
    requiredBucketFrames: [...REQUIRED_BUCKET_FRAMES],
    groups: [...groups.values()]
      .map(group => {
        const latenciesMs = group.latenciesMs.sort((left, right) => left - right);
        const rtf = group.inferenceSeconds / group.audioSeconds;
        return {
          cohort: group.cohort,
          cacheCondition: group.cacheCondition,
          encoderBucketFrames: group.encoderBucketFrames,
          count: latenciesMs.length,
          audioSeconds: round(group.audioSeconds),
          inferenceSeconds: round(group.inferenceSeconds),
          rtf: round(rtf),
          speed: round(1 / rtf, 3),
          latencyMs: {
            p50: round(nearestRank(latenciesMs, 0.5), 3),
            p95: round(nearestRank(latenciesMs, 0.95), 3),
            p99: round(nearestRank(latenciesMs, 0.99), 3),
          },
        };
      })
      .sort(
        (left, right) =>
          left.cohort.localeCompare(right.cohort) ||
          left.cacheCondition.localeCompare(right.cacheCondition) ||
          (left.encoderBucketFrames ?? Infinity) - (right.encoderBucketFrames ?? Infinity)
      ),
  };
}

module.exports = { createTimingSummary };
