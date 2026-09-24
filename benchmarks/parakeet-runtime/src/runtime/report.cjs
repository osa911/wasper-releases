'use strict';

function format(value) {
  return value === null || value === undefined ? '—' : String(value);
}

function workloadRows(evidence, workloadName) {
  return Object.values(evidence.aggregate.cells)
    .map(cell => {
      const workload = cell.workloads[workloadName] ?? {};
      return `| ${format(cell.runtime.label ?? cell.runtime.id)} | ${format(workload.wer)} | ${format(workload.cer)} | ${format(workload.medianWallSeconds)} | ${format(workload.realTimeSpeed)} | ${format(workload.completedRequests)}/${format(workload.expectedRequests)} | ${format(workload.unavailableRequests)} | ${format(workload.memoryExcludedRequests)} | ${format(workload.failureCount)} |`;
    })
    .join('\n');
}

function workloadTable(evidence, name, title) {
  return `## ${title}

| Runtime | WER | CER | Median response seconds | Speed | Completed/expected | Unavailable | Memory excluded | Failures |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${workloadRows(evidence, name)}`;
}

function isPartialOrNonComparable(status) {
  return status?.mode === 'ready-short' || status?.verification === 'partial-non-comparable';
}

function createPublicReport(evidence) {
  const run = evidence.run ?? {};
  const status = run.status ?? {};
  const partialRunWarning = isPartialOrNonComparable(status)
    ? '\nWarning: This run is partial and non-comparable. Do not compare it with full benchmark results.\n'
    : '';
  return `# Parakeet runtime benchmark

Run: \`${evidence.runId}\`

Runtime lock: \`${format(run.runtimeLockSha256)}\`

Corpus: \`${format(run.corpusSha256)}\`

Machine: \`${JSON.stringify(run.hardware ?? {})}\`

Wasper release: \`${JSON.stringify(run.wasperRelease ?? {})}\`

Cohort: \`${format(status.cohort)}\`

Mode: \`${format(status.mode)}\`

Verification: \`${format(status.verification)}\`
${partialRunWarning}
Warm-up establishes runtime residency and is discarded. Timed requests measure runtime response only. Long rows with incomplete coverage intentionally omit quality and speed metrics.

${workloadTable(evidence, 'shortQuality', 'Short quality')}

${workloadTable(evidence, 'requestBalancedSpeed', 'Request-balanced speed')}

${workloadTable(evidence, 'longRobustness', 'Long robustness')}
`;
}

function writePublicReport({ store, evidence }) {
  const report = createPublicReport(evidence);
  store.writeText('report.md', report);
  return report;
}

module.exports = { createPublicReport, writePublicReport };
