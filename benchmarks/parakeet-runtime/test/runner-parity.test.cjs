'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveLayout, writeOwnershipMarker } = require('../src/config.cjs');
const { runCli } = require('../src/cli.cjs');
const { RUNTIME_DESCRIPTORS } = require('../src/runtime/constants.cjs');
const { loadRuntimeLock } = require('../src/runtime/locks.cjs');
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

function fakeAdapterFactory(events, { transcribeFailure } = {}) {
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
        events.push({ type: 'footprint', runtimeId: runtime.id });
        return {
          post_response_phys_footprint: 1024,
          postResponsePhysicalFootprintBytes: 1024,
        };
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
        const failure = transcribeFailure?.({ runtime, fixture });
        if (failure !== undefined) return failure;
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

test('runner preserves structured adapter diagnostics before sampling or scoring', async t => {
  const layout = temporaryLayout(t);
  const events = [];
  let injected = false;

  const run = await runRuntimeBenchmark({
    layout,
    manifest: publicManifest(layout),
    runIdentity: runIdentity(),
    adapterFactory: fakeAdapterFactory(events, {
      transcribeFailure({ runtime }) {
        if (injected || runtime.id !== 'wasper-metal-int8') return undefined;
        injected = true;
        return {
          error: {
            type: 'runtime-error',
            message: 'adapter kept the original failure diagnostic',
            activationId: 'wasper-metal-int8-activation',
          },
        };
      },
    }),
    now: () => new Date('2026-09-24T12:34:56.000Z'),
  });

  const record = run.records.find(
    candidate => candidate.cellId === 'wasper-metal-int8' && candidate.outcome === 'error'
  );
  assert.ok(record);
  assert.equal(record.raw.error.message, 'adapter kept the original failure diagnostic');
  assert.equal(record.raw.error.code, 'RUNTIME_RESPONSE_ERROR');
  assert.equal(record.raw.error.type, 'runtime-error');
});

test('runner excludes a runtime after a structured over-cap Metal allocation failure', async t => {
  const layout = temporaryLayout(t);
  const events = [];
  const diagnostic = 'Metal error: insufficient memory; failed to allocate buffer, size = 9000 MiB';
  let injected = false;

  const run = await runRuntimeBenchmark({
    layout,
    manifest: publicManifest(layout),
    runIdentity: runIdentity(),
    adapterFactory: fakeAdapterFactory(events, {
      transcribeFailure({ runtime }) {
        if (injected || runtime.id !== 'wasper-metal-int8') return undefined;
        injected = true;
        return {
          error: {
            type: 'runtime-error',
            message: diagnostic,
            activationId: 'wasper-metal-int8-activation',
          },
        };
      },
    }),
    now: () => new Date('2026-09-24T12:34:56.000Z'),
  });

  const wasperRecords = run.records.filter(record => record.cellId === 'wasper-metal-int8');
  assert.equal(wasperRecords.length, 6);
  assert.ok(wasperRecords.every(record => record.outcome === 'memory-excluded'));
  assert.ok(
    wasperRecords.every(
      record => record.raw.memoryExclusion.runtimeDiagnostic.message === diagnostic
    )
  );
  assert.equal(
    events.filter(event => event.type === 'transcribe' && event.runtimeId === 'wasper-metal-int8')
      .length,
    1
  );
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

test('ready-short uses only ready runtime IDs and the automatic short cohort', async t => {
  const layout = temporaryLayout(t);
  const runtimeLock = loadRuntimeLock();
  const expectedRuntimeIds = runtimeLock.runtimes
    .filter(runtime => runtime.reproduction.state === 'ready')
    .map(runtime => runtime.id);
  const bootstrapped = [];
  let recovered;
  let smoke;
  let benchmark;
  const writes = [];

  const result = await runCli(['benchmark', 'ready-short'], {
    homeDirectory: layout.homeDirectory,
    stdout: { write(value) { writes.push(value); } },
    loadRuntimeLockImpl: () => runtimeLock,
    async bootstrapRuntimeImpl(runtimeId) {
      bootstrapped.push(runtimeId);
    },
    async recoverCorpusImpl(options) {
      recovered = options;
      return {
        manifest: {
          schema: 'wasper.public-run-corpus.v1',
          cohort: 'short',
          fixtures: [{ fixtureId: 'en-short-synthetic', cohort: 'short' }],
        },
      };
    },
    async smokeRuntimeAdaptersImpl(options) {
      smoke = options;
      return { cells: [] };
    },
    async runRuntimeBenchmarkImpl(options) {
      benchmark = options;
      return { runId: 'ready-short-run', runDirectory: path.join(layout.outputRoot, 'ready-short-run') };
    },
  });

  assert.deepEqual(bootstrapped, expectedRuntimeIds);
  assert.equal(recovered.cohort, 'short');
  assert.equal(recovered.acceptSourceTerms, false);
  assert.deepEqual(smoke.runtimeDescriptors.map(runtime => runtime.id), expectedRuntimeIds);
  assert.deepEqual(benchmark.runtimeDescriptors.map(runtime => runtime.id), expectedRuntimeIds);
  assert.equal(benchmark.runIdentity.mode, 'ready-short');
  assert.equal(benchmark.runIdentity.verification, 'partial-non-comparable');
  assert.equal(result.mode, 'ready-short');
  assert.equal(result.verification, 'partial-non-comparable');
  assert.match(writes.join(''), /ready-short.*partial-non-comparable/);
});

test('smoke bootstraps only ready runtimes against the automatic short corpus', async t => {
  const layout = temporaryLayout(t);
  const runtimeLock = loadRuntimeLock();
  const expectedRuntimeIds = runtimeLock.runtimes
    .filter(runtime => runtime.reproduction.state === 'ready')
    .map(runtime => runtime.id);
  const bootstrapped = [];
  let recovered;
  let smoke;

  const result = await runCli(['smoke'], {
    homeDirectory: layout.homeDirectory,
    loadRuntimeLockImpl: () => runtimeLock,
    async bootstrapRuntimeImpl(runtimeId) {
      bootstrapped.push(runtimeId);
    },
    async recoverCorpusImpl(options) {
      recovered = options;
      return {
        manifest: {
          schema: 'wasper.public-run-corpus.v1',
          cohort: 'short',
          fixtures: [{ fixtureId: 'en-short-synthetic', cohort: 'short' }],
        },
      };
    },
    async smokeRuntimeAdaptersImpl(options) {
      smoke = options;
      return { cells: [{ runtimeId: 'wasper-metal-int8', status: 'ok' }] };
    },
  });

  assert.deepEqual(bootstrapped, expectedRuntimeIds);
  assert.equal(recovered.cohort, 'short');
  assert.equal(recovered.acceptSourceTerms, false);
  assert.deepEqual(smoke.runtimeDescriptors.map(runtime => runtime.id), expectedRuntimeIds);
  assert.equal(result.mode, 'ready-short');
  assert.equal(result.verification, 'partial-non-comparable');
});

test('full mode bootstraps every runtime before corpus recovery', async t => {
  const layout = temporaryLayout(t);
  const bootstrapped = [];
  let recovered = false;
  const audioDir = path.join(layout.homeDirectory, 'local-audio');

  await assert.rejects(
    runCli(['benchmark', 'full', '--audio-dir', audioDir], {
      homeDirectory: layout.homeDirectory,
      loadRuntimeLockImpl: loadRuntimeLock,
      async bootstrapRuntimeImpl(runtimeId) {
        bootstrapped.push(runtimeId);
      },
      async recoverCorpusImpl(options) {
        assert.equal(options.audioDir, audioDir);
        recovered = true;
        throw new Error('manual long sources required');
      },
    }),
    /manual long sources required/
  );

  assert.deepEqual(bootstrapped, [
    'wasper-metal-int8',
    'mlx-fp32',
    'mlx-int8-local',
    'handy-gguf-q8',
    'nvidia-gguf-q8',
    'istupakov-onnx-int8',
    'fluid-coreml-mixed',
  ]);
  assert.equal(recovered, true);
});

test('public full-run identity uses the original three-pass fixture ordering seed', t => {
  const { createPublicRunIdentity } = require('../src/cli.cjs');
  const manifest = { schema: 'wasper.public-run-corpus.v1', cohort: 'all', fixtures: [] };
  const runtimeLock = loadRuntimeLock();

  const identity = createPublicRunIdentity(manifest, runtimeLock);

  assert.equal(identity.schedule.passes, 3);
  assert.equal(identity.schedule.seed, 'holder-v3-refresh-20260913-r2');
});
