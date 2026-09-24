'use strict';

const { RUNTIME_DESCRIPTORS } = require('./constants.cjs');

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function metric(records, key) {
  const counts = records.reduce(
    (total, record) => {
      const value = record.score?.[key];
      if (!value) return total;
      total.errors += value.errors;
      total.referenceUnits += value.referenceUnits;
      return total;
    },
    { errors: 0, referenceUnits: 0 }
  );
  return counts.referenceUnits === 0 ? null : counts.errors / counts.referenceUnits;
}

function languageProjection(records, schedule, { omitMetrics = false } = {}) {
  const rows = {};
  for (const language of [...new Set(schedule.map(item => item.language))].sort()) {
    const expected = schedule.filter(item => item.language === language);
    const observed = records.filter(record => record.language === language);
    const successful = observed.filter(record => record.outcome === 'success');
    const unavailable = observed.filter(record => record.outcome === 'unavailable-long');
    const memoryExcluded = observed.filter(record => record.outcome === 'memory-excluded');
    const row = {
      expectedRequests: expected.length,
      completedRequests: successful.length,
      failureCount: observed.filter(record => record.outcome === 'error').length,
      memoryExcludedRequests: memoryExcluded.length,
      ...(unavailable.length === 0 ? {} : { unavailableRequests: unavailable.length }),
    };
    if (!omitMetrics) {
      row.wer = metric(successful, 'wer');
      row.cer = metric(successful, 'cer');
    }
    rows[language] = row;
  }
  return rows;
}

function workload(records, schedule, { omitMetricsWhenIncomplete = false } = {}) {
  const successful = records.filter(record => record.outcome === 'success');
  const unavailable = records.filter(record => record.outcome === 'unavailable-long');
  const memoryExcluded = records.filter(record => record.outcome === 'memory-excluded');
  const result = {
    expectedRequests: schedule.length,
    completedRequests: successful.length,
    failureCount: records.filter(record => record.outcome === 'error').length,
    memoryExcludedRequests: memoryExcluded.length,
    unavailableRequests: unavailable.length,
    languages: languageProjection(records, schedule, {
      omitMetrics: omitMetricsWhenIncomplete && successful.length !== schedule.length,
    }),
  };
  if (omitMetricsWhenIncomplete && successful.length !== schedule.length) return result;
  return {
    ...result,
    wer: metric(successful, 'wer'),
    cer: metric(successful, 'cer'),
    medianWallSeconds: median(successful.map(record => record.wallSeconds)),
    realTimeSpeed: median(
      successful
        .filter(record => record.wallSeconds > 0)
        .map(record => record.audioSeconds / record.wallSeconds)
    ),
  };
}

function aggregateRuntimeEvidence({ records, schedule, requestBalancedFixtureIds }) {
  if (
    !Array.isArray(records) ||
    !Array.isArray(schedule) ||
    !Array.isArray(requestBalancedFixtureIds)
  ) {
    throw new TypeError('records, schedule, and requestBalancedFixtureIds must be arrays');
  }
  const cells = {};
  for (const descriptor of RUNTIME_DESCRIPTORS) {
    const cellSchedule = schedule.filter(item => item.cellId === descriptor.id);
    const cellRecords = records.filter(record => record.cellId === descriptor.id);
    const shortSchedule = cellSchedule.filter(item => item.cohort === 'short');
    const longSchedule = cellSchedule.filter(item => item.cohort === 'long');
    const speedSchedule = shortSchedule.filter(item =>
      requestBalancedFixtureIds.includes(item.fixtureId)
    );
    const scheduleKey = item =>
      JSON.stringify([item.cellId, item.pass, item.language, item.cohort, item.fixtureId]);
    const forSchedule = items => {
      const keys = new Set(items.map(scheduleKey));
      return cellRecords.filter(record => keys.has(scheduleKey(record)));
    };
    const footprints = cellRecords
      .map(record => record.footprint?.phys_footprint_peak)
      .filter(Number.isFinite);
    cells[descriptor.id] = {
      runtime: descriptor,
      phys_footprint_peak: footprints.length === 0 ? null : Math.max(...footprints),
      memoryExcluded: cellRecords.some(record => record.outcome === 'memory-excluded'),
      memoryExclusion:
        cellRecords.find(record => record.outcome === 'memory-excluded')?.raw?.memoryExclusion ??
        null,
      completedRequests: cellRecords.filter(record => record.outcome === 'success').length,
      failureCount: cellRecords.filter(record => record.outcome === 'error').length,
      workloads: {
        shortQuality: workload(forSchedule(shortSchedule), shortSchedule),
        requestBalancedSpeed: workload(forSchedule(speedSchedule), speedSchedule),
        longRobustness: workload(forSchedule(longSchedule), longSchedule, {
          omitMetricsWhenIncomplete: true,
        }),
      },
    };
  }
  return { schema: 'wasper.parakeet-runtime-benchmark.internal-aggregate.v1', cells };
}

module.exports = { aggregateRuntimeEvidence };
