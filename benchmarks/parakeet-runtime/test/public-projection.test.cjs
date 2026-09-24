'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createPublicReport } = require('../src/runtime/report.cjs');
const { projectPublicEvidence } = require('../src/runtime/reporting/public-projection.cjs');

function localRunWithText() {
  return {
    runId: '20260924T123456Z-a1b2c3d4',
    runIdentity: {
      runtimeLockSha256: 'a'.repeat(64),
      corpusSha256: 'b'.repeat(64),
      hardware: { arch: 'arm64', platform: 'darwin', release: '25.0.0' },
      wasperRelease: { version: '1.8.1', nativeServerSha256: 'c'.repeat(64) },
      privateSourceBytes: 'private source bytes',
    },
    activations: [
      {
        sequence: 0,
        cellId: 'wasper-metal-int8',
        pass: 1,
        identity: {
          identityHash: 'd'.repeat(64),
          identity: {
            schema: 'wasper.parakeet-runtime-benchmark.model-identity.v2',
            artifacts: [
              { path: '/private/models/model.bin', bytes: 42, sha256: 'e'.repeat(64) },
            ],
            executable: {
              path: '/private/bin/runtime',
              version: '1.0.0',
              versionEvidence: {
                command: ['/private/bin/runtime', '--version'],
                rawOutput: 'private version output',
              },
            },
            packages: [
              {
                name: 'runtime-package',
                version: '2.0.0',
                versionEvidence: { command: ['pip'], rawOutput: 'private package output' },
              },
            ],
            launchCommand: ['/private/bin/runtime', '--model', '/private/models/model.bin'],
          },
        },
      },
    ],
    records: [
      {
        order: 0,
        cellId: 'wasper-metal-int8',
        pass: 1,
        fixtureId: 'en-short-private',
        language: 'en',
        cohort: 'short',
        outcome: 'success',
        audioSeconds: 4,
        wallSeconds: 2,
        score: {
          wer: { errors: 1, referenceUnits: 10 },
          cer: { errors: 2, referenceUnits: 50 },
        },
        fixtureEvidence: {
          sourceSha256: 'f'.repeat(64),
          normalizedWavSha256: '0'.repeat(64),
          referenceSha256: '1'.repeat(64),
          durationSeconds: 4,
        },
        footprint: {
          phys_footprint_peak: 1234,
          physFootprintPeakBytes: 1234,
          samples: [{ rawOutput: 'private footprint output', pid: 12 }],
        },
        raw: {
          audioPath: '/private/audio.wav',
          referenceText: 'private reference text',
          sourceBytes: 'private source bytes',
          response: { rawTranscript: 'private transcript', localPath: '/private/response.json' },
        },
      },
    ],
    aggregate: {
      cells: {
        'wasper-metal-int8': {
          runtime: { id: 'wasper-metal-int8', label: 'Wasper', languagePolicy: { mode: 'automatic', languageHint: null } },
          workloads: {
            longRobustness: {
              expectedRequests: 3,
              completedRequests: 2,
              failureCount: 1,
              memoryExcludedRequests: 0,
              unavailableRequests: 0,
              wer: 0.1,
              cer: 0.2,
              realTimeSpeed: 4,
              medianWallSeconds: 3,
            },
          },
        },
      },
    },
  };
}

test('public evidence omits transcript and source bytes', () => {
  const projection = projectPublicEvidence(localRunWithText());
  const serialized = JSON.stringify(projection);

  assert.equal(serialized.includes('private transcript'), false);
  assert.equal(serialized.includes('private source bytes'), false);
  assert.equal(serialized.includes('/private/audio.wav'), false);
  assert.equal(serialized.includes('/private/models/model.bin'), false);
  assert.deepEqual(projection.records[0].fixture, {
    id: 'en-short-private',
    language: 'en',
    cohort: 'short',
    sourceSha256: 'f'.repeat(64),
    normalizedWavSha256: '0'.repeat(64),
    referenceSha256: '1'.repeat(64),
    durationSeconds: 4,
  });
  assert.deepEqual(projection.records[0].timing, {
    audioSeconds: 4,
    wallSeconds: 2,
    rtf: 0.5,
  });
  assert.deepEqual(projection.runtimeIdentities[0], {
    cellId: 'wasper-metal-int8',
    identityHash: 'd'.repeat(64),
    identity: {
      schema: 'wasper.parakeet-runtime-benchmark.model-identity.v2',
      artifacts: [{ bytes: 42, sha256: 'e'.repeat(64) }],
      executable: { version: '1.0.0' },
      packages: [{ name: 'runtime-package', version: '2.0.0' }],
    },
  });
});

test('public evidence omits the machine identifier', () => {
  const run = localRunWithText();
  run.runIdentity.hardware.machine = 'review-fixture-host.example';

  const projection = projectPublicEvidence(run);

  assert.deepEqual(projection.run.hardware, {
    arch: 'arm64',
    platform: 'darwin',
    release: '25.0.0',
  });
  assert.equal(JSON.stringify(projection).includes('review-fixture-host.example'), false);
});

test('public evidence strips numeric metrics from incomplete long workloads', () => {
  const projection = projectPublicEvidence(localRunWithText());
  const long = projection.aggregate.cells['wasper-metal-int8'].workloads.longRobustness;

  assert.deepEqual(long, {
    expectedRequests: 3,
    completedRequests: 2,
    failureCount: 1,
    memoryExcludedRequests: 0,
    unavailableRequests: 0,
  });
});

test('public evidence derives the Wasper release label from the runtime identity', () => {
  const run = localRunWithText();
  delete run.runIdentity.wasperRelease;
  run.activations[0].identity.identity.release = {
    version: '1.8.1',
    nativeServerSha256: 'c'.repeat(64),
    baselineKind: 'newer-release',
  };

  const projection = projectPublicEvidence(run);

  assert.deepEqual(projection.run.wasperRelease, {
    version: '1.8.1',
    nativeServerSha256: 'c'.repeat(64),
    baselineKind: 'newer-release',
  });
});

test('public evidence exposes a privacy-safe ready-short status and warns in the report', () => {
  const run = localRunWithText();
  run.runIdentity = {
    ...run.runIdentity,
    cohort: 'short',
    mode: 'ready-short',
    verification: 'partial-non-comparable',
    machine: 'review-fixture-host.example',
    rawTranscript: 'private ready-short transcript',
  };

  const projection = projectPublicEvidence(run);
  const report = createPublicReport(projection);
  const serialized = JSON.stringify({ projection, report });

  assert.deepEqual(projection.run.status, {
    cohort: 'short',
    mode: 'ready-short',
    verification: 'partial-non-comparable',
  });
  assert.match(report, /Cohort: `short`/u);
  assert.match(report, /Mode: `ready-short`/u);
  assert.match(report, /Verification: `partial-non-comparable`/u);
  assert.match(
    report,
    /Warning: This run is partial and non-comparable\. Do not compare it with full benchmark results\./u
  );
  assert.equal(serialized.includes('review-fixture-host.example'), false);
  assert.equal(serialized.includes('private ready-short transcript'), false);
  assert.equal(serialized.includes('private transcript'), false);
});

test('full-run status remains comparable and has no partial-run warning', () => {
  const run = localRunWithText();
  run.runIdentity = {
    ...run.runIdentity,
    cohort: 'all',
    mode: 'full',
    verification: 'full-comparison',
  };

  const projection = projectPublicEvidence(run);
  const report = createPublicReport(projection);

  assert.deepEqual(projection.run.status, {
    cohort: 'all',
    mode: 'full',
    verification: 'full-comparison',
  });
  assert.match(report, /Cohort: `all`/u);
  assert.match(report, /Mode: `full`/u);
  assert.match(report, /Verification: `full-comparison`/u);
  assert.doesNotMatch(report, /^Warning:/mu);
});

test('public evidence omits invalid run-status values before rendering the report', () => {
  const run = localRunWithText();
  const privateValue = 'sensitive-status-value';
  run.runIdentity = {
    ...run.runIdentity,
    cohort: privateValue,
    mode: privateValue,
    verification: privateValue,
  };

  const projection = projectPublicEvidence(run);
  const report = createPublicReport(projection);
  const serialized = JSON.stringify({ projection, report });

  assert.equal(projection.run.status, undefined);
  assert.equal(serialized.includes(privateValue), false);
});
