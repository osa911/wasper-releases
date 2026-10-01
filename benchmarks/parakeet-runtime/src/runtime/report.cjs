'use strict';

function format(value) {
  return value === null || value === undefined ? '—' : String(value);
}

function workloadRows(evidence, workloadName) {
  return Object.values(evidence.aggregate.cells)
    .map(cell => {
      const workload = cell.workloads[workloadName] ?? {};
      return `| ${format(cell.runtime.label ?? cell.runtime.id)} | ${format(workload.wer)} | ${format(workload.cer)} | ${format(workload.medianWallSeconds)} | ${format(workload.realTimeSpeed)} | ${format(workload.completedRequests)}/${format(workload.expectedRequests)} | ${format(workload.unavailableRequests)} | ${format(workload.memoryExcludedRequests)} | ${format(workload.failureCount)} | ${format(workload.pendingRequests)} |`;
    })
    .join('\n');
}

function workloadTable(evidence, name, title) {
  return `## ${title}

| Runtime | WER | CER | Median response seconds | Speed | Completed/expected | Unavailable | Memory excluded | Failures | Pending |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${workloadRows(evidence, name)}`;
}

function isPartialOrNonComparable(status) {
  return status?.mode === 'ready-short' || status?.verification === 'partial-non-comparable';
}

function createPublicReport(evidence) {
  const run = evidence.run ?? {};
  const status = run.status ?? {};
  const completion = evidence.completion;
  const progress = completion
    ? `
Execution: ${completion.state}. Recorded ${completion.recordedRequests}/${completion.expectedRequests} scheduled outcomes; ${completion.pendingRequests} pending.
${completion.state === 'interrupted' ? `\nWarning: This run was interrupted. Completed evidence is preserved. Stop reason: ${format(completion.interruption?.code)} ${format(completion.interruption?.operation)}. See local-review-queue.json for diagnostics.\n` : ''}
${completion.runtimeFailures.length ? `\nRuntime setup failures:\n\n${completion.runtimeFailures.map(failure => `- ${failure.runtimeId}: ${failure.phase} failed (${format(failure.code)}). See local-review-queue.json for diagnostics.`).join('\n')}\n` : ''}`
    : '';
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
${progress}
Warm-up establishes runtime residency and is discarded. Timed requests measure runtime response only. Rows with incomplete coverage intentionally omit quality and speed metrics. Pending requests have no saved outcome; failures and memory exclusions are recorded separately.

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
