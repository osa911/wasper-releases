'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveLayout, writeOwnershipMarker } = require('../src/config.cjs');
const { RUNTIME_DESCRIPTORS } = require('../src/runtime/constants.cjs');
const { runRuntimeBenchmark } = require('../src/runtime/runner.cjs');

function temporaryLayout(t) {
  const homeDirectory = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-runner-parity-'))
  );
  t.after(() => fs.rmSync(homeDirectory, { force: true, recursive: true }));
  fs.mkdirSync(path.join(homeDirectory, 'Library/Caches/Wasper/benchmarks'), {
    recursive: true,
  });
  const layout = resolveLayout({ homeDirectory });
  writeOwnershipMarker(layout);
  return layout;
}

function writeFixture(layout, fixtureId, cohort, text) {
  const directory = path.join(layout.corpusRoot, 'fixtures', fixtureId);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'normalized.wav'), 'not-real-audio');
  fs.writeFileSync(path.join(directory, 'reference.txt'), text);
  return {
    fixtureId,
    language: 'en',
    cohort,
    source: {
      sha256: 'a'.repeat(64),
      path: `fixtures/${fixtureId}/source`,
    },
    normalizedAudio: {
      durationSeconds: 2,
      sha256: 'b'.repeat(64),
      path: `fixtures/${fixtureId}/normalized.wav`,
    },
    reference: {
      sha256: 'c'.repeat(64),
      path: `fixtures/${fixtureId}/reference.txt`,
    },
  };
}

function publicManifest(layout) {
  return {
    schema: 'wasper.public-run-corpus.v1',
    cohort: 'all',
    fixtures: [
      writeFixture(layout, 'en-short-parity', 'short', 'alpha bravo'),
      writeFixture(layout, 'en-long-parity', 'long', 'charlie delta'),
    ],
  };
}

function runIdentity() {
  return {
    schema: 'wasper.parakeet-runtime-benchmark.public-run.v1',
    runtimeLockSha256: 'd'.repeat(64),
    corpusSha256: 'e'.repeat(64),
    hardware: { arch: 'arm64', platform: 'darwin', release: 'test' },
    schedule: { seed: 'runner-parity' },
  };
}

function fakeAdapterFactory(events) {
  let activeRuntime = null;
  const failedLongRequests = new Set();
  return runtime => {
    assert.deepEqual(runtime.languagePolicy, { mode: 'automatic', languageHint: null });
    return {
      async start() {
        assert.equal(activeRuntime, null, `only one runtime may be active; found ${activeRuntime}`);
        activeRuntime = runtime.id;
        events.push({ type: 'start', runtimeId: runtime.id });
        return { activationId: `${runtime.id}-activation` };
      },
      async health() {
        events.push({ type: 'health', runtimeId: runtime.id });
        return { status: 'ok' };
      },
      async identity() {
        return {
          identityHash: `${runtime.id}-identity`,
          identity: {
            schema: 'wasper.parakeet-runtime-benchmark.model-identity.v2',
            artifacts: [
              {
                path: `/private/models/${runtime.id}/model.bin`,
                bytes: 12,
                sha256: 'f'.repeat(64),
              },
            ],
            executable: {
              path: `/private/bin/${runtime.id}`,
              version: '1.0.0',
              versionEvidence: { command: ['/private/bin/version'], rawOutput: 'private output' },
            },
            packages: [],
            launchCommand: ['/private/bin/runtime'],
          },
        };
      },
      async sampleFootprint() {
        return { phys_footprint_peak: 1024, physFootprintPeakBytes: 1024 };
      },
      async warmup(fixture, requestOptions) {
        events.push({ type: 'warmup', runtimeId: runtime.id, fixtureId: fixture.id, requestOptions });
        return { rawTranscript: 'discarded warmup transcript', wallSeconds: 999 };
      },
      async transcribe(fixture, requestOptions) {
        events.push({
          type: 'transcribe',
          runtimeId: runtime.id,
          fixtureId: fixture.id,
          requestOptions,
        });
        if (
          runtime.id === RUNTIME_DESCRIPTORS[0].id &&
          fixture.cohort === 'long' &&
          !failedLongRequests.has(runtime.id)
        ) {
          failedLongRequests.add(runtime.id);
          throw new Error('simulated incomplete long recording');
        }
        return { rawTranscript: fixture.reference.text, wallSeconds: 0.5 };
      },
      async stop() {
        assert.equal(activeRuntime, runtime.id);
        events.push({ type: 'stop', runtimeId: runtime.id });
        activeRuntime = null;
      },
    };
  };
}

test('runner preserves sequential automatic-language three-pass timing and partial-long rules', async t => {
  const layout = temporaryLayout(t);
  const events = [];

  const run = await runRuntimeBenchmark({
    layout,
    manifest: publicManifest(layout),
    runIdentity: runIdentity(),
    adapterFactory: fakeAdapterFactory(events),
    now: () => new Date('2026-09-24T12:34:56.000Z'),
  });

  const starts = events.filter(event => event.type === 'start').map(event => event.runtimeId);
  assert.deepEqual(starts, [
    ...RUNTIME_DESCRIPTORS.map(runtime => runtime.id),
    ...RUNTIME_DESCRIPTORS.slice(1).map(runtime => runtime.id),
    RUNTIME_DESCRIPTORS[0].id,
    ...RUNTIME_DESCRIPTORS.slice(2).map(runtime => runtime.id),
    RUNTIME_DESCRIPTORS[0].id,
    RUNTIME_DESCRIPTORS[1].id,
  ]);
  assert.equal(events.filter(event => event.type === 'warmup').length, 21);
  assert.equal(events.filter(event => event.type === 'stop').length, 21);
  for (const event of events.filter(
    event => event.type === 'warmup' || event.type === 'transcribe'
  )) {
    assert.deepEqual(event.requestOptions, {
      languagePolicy: { mode: 'automatic', languageHint: null },
    });
  }
  assert.ok(run.records.every(record => record.wallSeconds === null || record.wallSeconds === 0.5));

  const partialLong = run.aggregate.cells[RUNTIME_DESCRIPTORS[0].id].workloads.longRobustness;
  assert.equal(partialLong.completedRequests, 2);
  for (const field of ['wer', 'cer', 'medianWallSeconds', 'realTimeSpeed', 'rtf']) {
    assert.equal(Object.hasOwn(partialLong, field), false, `${field} must be omitted`);
  }
  assert.equal(fs.existsSync(path.join(run.runDirectory, 'public-evidence.json')), true);
  assert.equal(fs.existsSync(path.join(run.runDirectory, 'report.md')), true);
});

test('runner rotates a supplied valid runtime order after its first pass', async t => {
  const layout = temporaryLayout(t);
  const events = [];
  const runtimeOrder = [
    'handy-gguf-q8',
    'nvidia-gguf-q8',
    'istupakov-onnx-int8',
    'fluid-coreml-mixed',
    'wasper-metal-int8',
    'mlx-fp32',
    'mlx-int8-local',
  ];

  await runRuntimeBenchmark({
    layout,
    manifest: publicManifest(layout),
    runIdentity: runIdentity(),
    adapterFactory: fakeAdapterFactory(events),
    runtimeOrder,
    now: () => new Date('2026-09-24T12:34:56.000Z'),
  });

  const starts = events.filter(event => event.type === 'start').map(event => event.runtimeId);
  const passLength = RUNTIME_DESCRIPTORS.length;

  assert.deepEqual(
    [
      starts.slice(0, passLength),
      starts.slice(passLength, passLength * 2),
      starts.slice(passLength * 2, passLength * 3),
    ],
    [
      [
        'handy-gguf-q8',
        'nvidia-gguf-q8',
        'istupakov-onnx-int8',
        'fluid-coreml-mixed',
        'wasper-metal-int8',
        'mlx-fp32',
        'mlx-int8-local',
      ],
      [
        'nvidia-gguf-q8',
        'istupakov-onnx-int8',
        'fluid-coreml-mixed',
        'wasper-metal-int8',
        'mlx-fp32',
        'mlx-int8-local',
        'handy-gguf-q8',
      ],
      [
        'istupakov-onnx-int8',
        'fluid-coreml-mixed',
        'wasper-metal-int8',
        'mlx-fp32',
        'mlx-int8-local',
        'handy-gguf-q8',
        'nvidia-gguf-q8',
      ],
    ],
  );
});
