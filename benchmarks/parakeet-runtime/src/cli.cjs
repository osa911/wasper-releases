#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const os = require('node:os');

const { resolveLayout } = require('./config.cjs');
const { MEASURED_PASSES, RUNTIME_DESCRIPTORS } = require('./runtime/constants.cjs');

const COMMANDS = new Set(['audit-public', 'benchmark', 'doctor', 'recover-corpus', 'smoke', 'clean']);
const LAYOUT_OPTIONS = new Map([
  ['--cache-dir', 'cacheDir'],
  ['--output-dir', 'outputDir'],
  ['--wasper-app', 'wasperApp'],
]);
const MAX_PHYSICAL_FOOTPRINT_BYTES = 8 * 1024 ** 3;
const PUBLIC_RUN_SCHEMA = 'wasper.parakeet-runtime-benchmark.public-run.v1';
const READY_SHORT_RUNTIME_COUNT = 7;
const READY_SHORT_VERIFICATION = 'partial-non-comparable';

function digest(value) {
  const { canonicalJson } = require('./asr-quality/manifest.cjs');
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function parseCommandArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError('a runtime benchmark command is required');
  }
  const [command, ...argumentsList] = argv;
  if (!COMMANDS.has(command)) throw new TypeError(`unknown runtime benchmark command: ${command}`);
  if (command === 'audit-public' && argumentsList.length > 0) {
    throw new TypeError('audit-public does not accept arguments');
  }
  const options = {
    mode: null,
    cacheDir: null,
    outputDir: null,
    wasperApp: null,
    audioDir: null,
    cohort: null,
    acceptSourceTerms: false,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--accept-source-terms' && !options.acceptSourceTerms) {
      if (command === 'clean' || command === 'doctor' || command === 'smoke') {
        throw new TypeError(`${command} does not accept --accept-source-terms`);
      }
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
    if (argument === '--audio-dir' && options.audioDir === null) {
      if (!['benchmark', 'recover-corpus', 'smoke'].includes(command)) {
        throw new TypeError(`${command} does not accept --audio-dir`);
      }
      const value = argumentsList[index + 1];
      if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
        throw new TypeError('--audio-dir requires a value');
      }
      options.audioDir = value;
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
  if (command === 'benchmark' && !['full', 'ready-short'].includes(options.mode)) {
    throw new TypeError('benchmark requires the full or ready-short mode');
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
  const { command, cacheDir, outputDir, wasperApp, audioDir, mode, cohort, acceptSourceTerms } =
    parseCommandArguments(argv);
  const layout =
    command === 'audit-public'
      ? null
      : resolveLayout({
          ...(cacheDir === null ? {} : { cacheDir }),
          ...(outputDir === null ? {} : { outputDir }),
          ...(wasperApp === null ? {} : { wasperApp }),
          ...(homeDirectory === undefined ? {} : { homeDirectory }),
        });
  return Object.freeze({ command, layout, audioDir, mode, cohort, acceptSourceTerms, writes: false });
}

function readyShortRuntimeDescriptors(runtimeLock) {
  const readyIds = new Set(
    runtimeLock.runtimes
      .filter(runtime => runtime.reproduction?.state === 'ready')
      .map(runtime => runtime.id)
  );
  const descriptors = RUNTIME_DESCRIPTORS.filter(runtime => readyIds.has(runtime.id));
  if (descriptors.length !== READY_SHORT_RUNTIME_COUNT) {
    throw new Error(`ready-short requires exactly ${READY_SHORT_RUNTIME_COUNT} publicly ready runtimes`);
  }
  return descriptors;
}

function createPublicRunIdentity(manifest, runtimeLock, { mode = 'full', runtimeDescriptors } = {}) {
  if (manifest?.schema !== 'wasper.public-run-corpus.v1') {
    throw new TypeError('a verified public corpus manifest is required');
  }
  const cells = runtimeDescriptors ?? RUNTIME_DESCRIPTORS;
  return Object.freeze({
    schema: PUBLIC_RUN_SCHEMA,
    mode,
    verification: mode === 'ready-short' ? READY_SHORT_VERIFICATION : 'full-comparison',
    cohort: manifest.cohort,
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
        metric: 'post_response_phys_footprint',
        samplePhase: 'after-timed-response',
      },
    },
    schedule: {
      passes: MEASURED_PASSES,
      seed: 'holder-v3-refresh-20260913-r2',
      order: 'three rotated runtime passes with frozen fixture ranking',
    },
    scoring: { scope: 'full references', metrics: ['WER', 'CER'] },
    runtimeCells: cells,
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
  const runtimeDescriptors =
    plan.mode === 'ready-short' ? readyShortRuntimeDescriptors(runtimeLock) : RUNTIME_DESCRIPTORS;
  const cohort = plan.mode === 'ready-short' ? 'short' : 'all';

  for (const runtime of runtimeDescriptors) {
    await bootstrapRuntime(runtime.id, { layout: plan.layout, lock: runtimeLock });
  }
  const prepared = await recoverCorpus({
    layout: plan.layout,
    cohort,
    acceptSourceTerms: plan.acceptSourceTerms,
    ...(plan.audioDir === null ? {} : { audioDir: plan.audioDir }),
  });
  await smokeRuntimeAdapters({
    layout: plan.layout,
    manifest: prepared.manifest,
    runtimeLock,
    runtimeDescriptors,
  });
  return runRuntimeBenchmark({
    layout: plan.layout,
    manifest: prepared.manifest,
    runIdentity: createPublicRunIdentity(prepared.manifest, runtimeLock, {
      mode: plan.mode,
      runtimeDescriptors,
    }),
    maxPhysicalFootprintBytes: MAX_PHYSICAL_FOOTPRINT_BYTES,
    runtimeDescriptors,
    adapterFactory: runtime => createRuntimeAdapter(runtime.id, { layout: plan.layout, runtimeLock }),
  });
}

async function runCli(
  argv,
  {
    stdout = process.stdout,
    auditPublicPackageImpl,
    bootstrapRuntimeImpl,
    cleanImpl,
    createRuntimeAdapterImpl,
    doctorImpl,
    homeDirectory,
    loadRuntimeLockImpl,
    recoverCorpusImpl,
    runRuntimeBenchmarkImpl,
    smokeRuntimeAdaptersImpl,
  } = {}
) {
  const plan = createCommandPlan(argv, { homeDirectory });
  if (plan.command === 'audit-public') {
    const { auditPublicPackage, formatPublicAuditViolation } = require('./public-audit.cjs');
    const violations = (auditPublicPackageImpl ?? auditPublicPackage)(
      require('node:path').resolve(__dirname, '..')
    );
    if (violations.length > 0) {
      for (const violation of violations) {
        stdout.write(`${formatPublicAuditViolation(violation)}\n`);
      }
      throw new Error(`public package audit found ${violations.length} violation(s)`);
    }
    stdout.write('Public package audit: clean\n');
    return Object.freeze({ command: plan.command, violations, writes: false });
  }
  if (plan.command === 'doctor') {
    const doctor = doctorImpl ?? require('./doctor.cjs').doctor;
    const formatDoctor = require('./doctor.cjs').formatDoctor;
    const runtimeLock = (loadRuntimeLockImpl ?? require('./runtime/locks.cjs').loadRuntimeLock)();
    const result = doctor(plan.layout, runtimeLock);
    stdout.write(`${formatDoctor(result)}\n`);
    if (!result.ok) throw new Error('doctor found prerequisites that block a full run');
    return Object.freeze({ command: plan.command, writes: false, ...result });
  }
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
      ...(plan.audioDir === null ? {} : { audioDir: plan.audioDir }),
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
    const bootstrapRuntime =
      bootstrapRuntimeImpl ?? require('./runtime/bootstrap.cjs').bootstrapRuntime;
    const smokeRuntimeAdapters =
      smokeRuntimeAdaptersImpl ?? require('./runtime/smoke.cjs').smokeRuntimeAdapters;
    const runtimeLock = loadRuntimeLock();
    const runtimeDescriptors = readyShortRuntimeDescriptors(runtimeLock);
    for (const runtime of runtimeDescriptors) {
      await bootstrapRuntime(runtime.id, { layout: plan.layout, lock: runtimeLock });
    }
    const prepared = await recoverCorpus({
      layout: plan.layout,
      cohort: 'short',
      acceptSourceTerms: false,
      ...(plan.audioDir === null ? {} : { audioDir: plan.audioDir }),
    });
    const smoke = await smokeRuntimeAdapters({
      layout: plan.layout,
      manifest: prepared.manifest,
      runtimeLock,
      runtimeDescriptors,
    });
    const result = Object.freeze({
      command: plan.command,
      writes: true,
      mode: 'ready-short',
      verification: READY_SHORT_VERIFICATION,
      ...smoke,
    });
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
    mode: plan.mode,
    verification: plan.mode === 'ready-short' ? READY_SHORT_VERIFICATION : 'full-comparison',
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
  readyShortRuntimeDescriptors,
  runBenchmark,
  runCli,
};
