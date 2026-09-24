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

function createPublicReport(evidence) {
  const run = evidence.run ?? {};
  return `# Parakeet runtime benchmark

Run: \`${evidence.runId}\`

Runtime lock: \`${format(run.runtimeLockSha256)}\`

Corpus: \`${format(run.corpusSha256)}\`

Machine: \`${JSON.stringify(run.hardware ?? {})}\`

Wasper release: \`${JSON.stringify(run.wasperRelease ?? {})}\`

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
