#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const os = require('node:os');

const { canonicalJson } = require('./asr-quality/manifest.cjs');
const { resolveLayout } = require('./config.cjs');
const { MEASURED_PASSES, RUNTIME_DESCRIPTORS } = require('./runtime/constants.cjs');

const COMMANDS = new Set(['benchmark', 'recover-corpus', 'smoke', 'clean']);
const LAYOUT_OPTIONS = new Map([
  ['--cache-dir', 'cacheDir'],
  ['--output-dir', 'outputDir'],
  ['--wasper-app', 'wasperApp'],
]);
const MAX_PHYSICAL_FOOTPRINT_BYTES = 8 * 1024 ** 3;
const PUBLIC_RUN_SCHEMA = 'wasper.parakeet-runtime-benchmark.public-run.v1';

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function parseCommandArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError('a runtime benchmark command is required');
  }
  const [command, ...argumentsList] = argv;
  if (!COMMANDS.has(command)) throw new TypeError(`unknown runtime benchmark command: ${command}`);
  const options = {
    mode: null,
    cacheDir: null,
    outputDir: null,
    wasperApp: null,
    cohort: null,
    acceptSourceTerms: false,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--accept-source-terms' && !options.acceptSourceTerms) {
      if (command === 'clean') throw new TypeError('clean does not accept --accept-source-terms');
      options.acceptSourceTerms = true;
      continue;
    }
    if (command === 'benchmark' && options.mode === null && !argument.startsWith('--')) {
      options.mode = argument;
      continue;
    }
    if (command === 'recover-corpus' && argument === '--cohort' && options.cohort === null) {
      const value = argumentsList[index + 1];
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        throw new TypeError('--cohort requires a value');
      }
      options.cohort = value;
      index += 1;
      continue;
    }
    const option = LAYOUT_OPTIONS.get(argument);
    if (!option || options[option] !== null) {
      throw new TypeError(`invalid arguments for runtime benchmark command ${command}`);
    }
    const value = argumentsList[index + 1];
    if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
      throw new TypeError(`${argument} requires a value`);
    }
    options[option] = value;
    index += 1;
  }
  if (command === 'benchmark' && options.mode !== 'full') {
    throw new TypeError('benchmark requires the full mode');
  }
  if (command !== 'benchmark' && options.mode !== null) {
    throw new TypeError(`${command} does not accept a benchmark mode`);
  }
  if (command === 'recover-corpus' && !['short', 'long', 'all'].includes(options.cohort)) {
    throw new TypeError('--cohort must be short, long, or all');
  }
  return { command, ...options };
}

function createCommandPlan(argv, { homeDirectory } = {}) {
  const { command, cacheDir, outputDir, wasperApp, mode, cohort, acceptSourceTerms } =
    parseCommandArguments(argv);
  const layout = resolveLayout({
    ...(cacheDir === null ? {} : { cacheDir }),
    ...(outputDir === null ? {} : { outputDir }),
    ...(wasperApp === null ? {} : { wasperApp }),
    ...(homeDirectory === undefined ? {} : { homeDirectory }),
  });
  return Object.freeze({ command, layout, mode, cohort, acceptSourceTerms, writes: false });
}

function createPublicRunIdentity(manifest, runtimeLock) {
  if (manifest?.schema !== 'wasper.public-run-corpus.v1') {
    throw new TypeError('a verified public corpus manifest is required');
  }
  return Object.freeze({
    schema: PUBLIC_RUN_SCHEMA,
    runtimeLockSha256: digest(runtimeLock),
    corpusSha256: digest(manifest),
    hardware: {
      arch: process.arch,
      machine: os.hostname(),
      platform: process.platform,
      release: os.release(),
    },
    measurement: {
      input: 'complete-recording',
      languagePolicy: { mode: 'automatic', languageHint: null },
      timing: 'response-only',
      warmup: 'discarded',
      memory: {
        action: 'exclude-and-stop',
        maximumBytes: MAX_PHYSICAL_FOOTPRINT_BYTES,
        metric: 'phys_footprint_peak',
        samplePhase: 'after-timed-response',
      },
    },
    schedule: {
      passes: MEASURED_PASSES,
      seed: 'public-parakeet-runtime-v1',
      order: 'three sequential rotated runtime passes',
    },
    scoring: { scope: 'full references', metrics: ['WER', 'CER'] },
    runtimeCells: RUNTIME_DESCRIPTORS,
  });
}

async function runBenchmark({
  plan,
  bootstrapRuntimeImpl,
  createRuntimeAdapterImpl,
  loadRuntimeLockImpl,
  recoverCorpusImpl,
  runRuntimeBenchmarkImpl,
  smokeRuntimeAdaptersImpl,
}) {
  const loadRuntimeLock = loadRuntimeLockImpl ?? require('./runtime/locks.cjs').loadRuntimeLock;
  const bootstrapRuntime =
    bootstrapRuntimeImpl ?? require('./runtime/bootstrap.cjs').bootstrapRuntime;
  const recoverCorpus =
    recoverCorpusImpl ?? require('./runtime/corpus-recovery.cjs').recoverCorpus;
  const smokeRuntimeAdapters =
    smokeRuntimeAdaptersImpl ?? require('./runtime/smoke.cjs').smokeRuntimeAdapters;
  const runRuntimeBenchmark =
    runRuntimeBenchmarkImpl ?? require('./runtime/runner.cjs').runRuntimeBenchmark;
  const createRuntimeAdapter =
    createRuntimeAdapterImpl ?? require('./runtime/adapters/index.cjs').createRuntimeAdapter;
  const runtimeLock = loadRuntimeLock();

  for (const runtime of RUNTIME_DESCRIPTORS) {
    await bootstrapRuntime(runtime.id, { layout: plan.layout, lock: runtimeLock });
  }
  const prepared = await recoverCorpus({
    layout: plan.layout,
    cohort: 'all',
    acceptSourceTerms: plan.acceptSourceTerms,
  });
  await smokeRuntimeAdapters({ layout: plan.layout, manifest: prepared.manifest, runtimeLock });
  return runRuntimeBenchmark({
    layout: plan.layout,
    manifest: prepared.manifest,
    runIdentity: createPublicRunIdentity(prepared.manifest, runtimeLock),
    maxPhysicalFootprintBytes: MAX_PHYSICAL_FOOTPRINT_BYTES,
    adapterFactory: runtime => createRuntimeAdapter(runtime.id, { layout: plan.layout, runtimeLock }),
  });
}

async function runCli(
  argv,
  {
    stdout = process.stdout,
    bootstrapRuntimeImpl,
    cleanImpl,
    createRuntimeAdapterImpl,
    homeDirectory,
    loadRuntimeLockImpl,
    recoverCorpusImpl,
    runRuntimeBenchmarkImpl,
    smokeRuntimeAdaptersImpl,
  } = {}
) {
  const plan = createCommandPlan(argv, { homeDirectory });
  if (plan.command === 'clean') {
    const clean = cleanImpl ?? require('./clean.cjs').clean;
    const removed = await clean(plan.layout, {
      beforeRemove(cleanupPath) {
        stdout.write(`${cleanupPath}\n`);
      },
    });
    return Object.freeze({ command: plan.command, writes: true, removed });
  }
  if (plan.command === 'recover-corpus') {
    const recoverCorpus =
      recoverCorpusImpl ?? require('./runtime/corpus-recovery.cjs').recoverCorpus;
    const recovered = await recoverCorpus({
      layout: plan.layout,
      cohort: plan.cohort,
      acceptSourceTerms: plan.acceptSourceTerms,
    });
    const result = Object.freeze({
      command: plan.command,
      writes: true,
      manifestPath: recovered.manifestPath,
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  if (plan.command === 'smoke') {
    const recoverCorpus =
      recoverCorpusImpl ?? require('./runtime/corpus-recovery.cjs').recoverCorpus;
    const loadRuntimeLock = loadRuntimeLockImpl ?? require('./runtime/locks.cjs').loadRuntimeLock;
    const smokeRuntimeAdapters =
      smokeRuntimeAdaptersImpl ?? require('./runtime/smoke.cjs').smokeRuntimeAdapters;
    const prepared = await recoverCorpus({
      layout: plan.layout,
      cohort: 'all',
      acceptSourceTerms: plan.acceptSourceTerms,
    });
    const smoke = await smokeRuntimeAdapters({
      layout: plan.layout,
      manifest: prepared.manifest,
      runtimeLock: loadRuntimeLock(),
    });
    const result = Object.freeze({ command: plan.command, writes: true, ...smoke });
    stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  const result = await runBenchmark({
    plan,
    bootstrapRuntimeImpl,
    createRuntimeAdapterImpl,
    loadRuntimeLockImpl,
    recoverCorpusImpl,
    runRuntimeBenchmarkImpl,
    smokeRuntimeAdaptersImpl,
  });
  const summary = Object.freeze({
    command: plan.command,
    writes: true,
    runId: result.runId,
    runDirectory: result.runDirectory,
  });
  stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

module.exports = {
  createCommandPlan,
  createPublicRunIdentity,
  main: runCli,
  parseCommandArguments,
  runBenchmark,
  runCli,
};
