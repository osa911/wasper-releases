'use strict';

function format(value) {
  return value === null || value === undefined
    ? '—'
    : typeof value === 'number'
      ? String(value)
      : value;
}

function workloadTable(aggregate, workloadName) {
  const rows = Object.values(aggregate.cells)
    .map(row => {
      const workload = row.workloads[workloadName];
      return `| ${row.runtime.label} | ${format(workload.wer)} | ${format(workload.cer)} | ${format(workload.medianWallSeconds)} | ${format(workload.realTimeSpeed)} | ${workload.completedRequests}/${workload.expectedRequests} | ${workload.unavailableRequests} | ${workload.memoryExcludedRequests} | ${workload.failureCount} |`;
    })
    .join('\n');
  return `| Runtime | WER | CER | Median measured time | Speed | Completed/expected | Unavailable | Memory excluded | Failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}`;
}

function languageTable(aggregate) {
  const rows = Object.values(aggregate.cells)
    .flatMap(row =>
      Object.entries(row.workloads.shortQuality.languages).map(
        ([language, value]) =>
          `| ${row.runtime.label} | ${language} | ${format(value.wer)} | ${format(value.cer)} | ${value.completedRequests}/${value.expectedRequests} | ${value.unavailableRequests ?? 0} | ${value.memoryExcludedRequests ?? 0} | ${value.failureCount} |`
      )
    )
    .join('\n');
  return `| Runtime | Language | WER | CER | Completed/expected | Unavailable | Memory excluded | Failures |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
${rows || '| — | — | — | — | 0/0 | 0 | 0 | 0 |'}`;
}

function writeInternalReport({ store, runIdentity, aggregate }) {
  const summaryRows = Object.values(aggregate.cells)
    .map(row => {
      const quality = row.workloads.shortQuality;
      const speed = row.workloads.requestBalancedSpeed;
      const long = row.workloads.longRobustness;
      const eligibility = row.memoryExcluded
        ? `Excluded: exceeded ${format(row.memoryExclusion?.maxPhysicalFootprintBytes)} bytes`
        : 'Eligible';
      return `| ${row.runtime.label} | ${eligibility} | ${format(quality.wer)} | ${format(quality.cer)} | ${format(speed.medianWallSeconds)} (warm-up excluded) | ${format(speed.realTimeSpeed)} | ${format(row.phys_footprint_peak)} | ${row.completedRequests}/${quality.expectedRequests + long.expectedRequests} | ${row.failureCount} |`;
    })
    .join('\n');
  const report = `# Parakeet runtime benchmark — internal review

Run identity: \`${store.runId}\`

Hardware: \`${JSON.stringify(runIdentity.hardware)}\`

Model artifact hashes: \`${JSON.stringify(runIdentity.artifact)}\`

## Aggregate runtime cells

| Runtime | Eligibility | WER | CER | Median/warm time | Speed | phys_footprint_peak | Completed/expected | Failures |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${summaryRows}

## Workload: short quality

${workloadTable(aggregate, 'shortQuality')}

## Workload: request-balanced speed

${workloadTable(aggregate, 'requestBalancedSpeed')}

## Workload: long robustness

${workloadTable(aggregate, 'longRobustness')}

## Per-language rows

${languageTable(aggregate)}

## Methodology

Three measured passes use one fresh resident activation per runtime cell/pass. Warm-up establishes residency but is not part of measured wall time. Quality uses short fixtures; request-balanced speed uses the frozen short profile; long robustness retains unavailable long fixtures explicitly.

## Quantization notes

Local MLX int8 is weight-only 8-bit/group 64. Fluid is mixed precision.
`;
  store.writeText('internal-report.md', report);
  return report;
}

module.exports = { writeInternalReport };
