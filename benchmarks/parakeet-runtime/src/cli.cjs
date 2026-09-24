#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  resolvePrivateOutputPath,
  validateRuntimeBenchmarkContract,
} = require('./runtime/contract.cjs');
const { MEASURED_PASSES, RUNTIME_DESCRIPTORS } = require('./runtime/constants.cjs');
const { resolveLayout } = require('./config.cjs');

const COMMANDS = new Set([
  'validate-contract',
  'recover-corpus',
  'smoke',
  'run',
  'report',
  'clean',
]);
const OUTPUT_COMMANDS = new Set(['recover-corpus', 'smoke', 'run', 'report']);
const LAYOUT_OPTIONS = new Map([
  ['--cache-dir', 'cacheDir'],
  ['--output-dir', 'outputDir'],
  ['--wasper-app', 'wasperApp'],
]);
const MAX_PHYSICAL_FOOTPRINT_BYTES = 8 * 1024 ** 3;
const HOLDER_RUN_SCHEMA = 'wasper.parakeet-runtime-benchmark.holder-refresh.v2';
const HOLDER_RUN_ATTEMPT = 'holder-v3-refresh-2026-09-13-r2-timing-isolated';

function parseCommandArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new TypeError('a runtime benchmark command is required');
  }
  const [command, ...argumentsList] = argv;
  if (!COMMANDS.has(command)) throw new TypeError(`unknown runtime benchmark command: ${command}`);
  const options = {
    output: null,
    cacheDir: null,
    outputDir: null,
    wasperApp: null,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    const option = argument === '--output' ? 'output' : LAYOUT_OPTIONS.get(argument);
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
  if (OUTPUT_COMMANDS.has(command) && options.output === null) {
    throw new TypeError(
      `${command} requires an explicit --output under the private benchmark cache`
    );
  }
  if (!OUTPUT_COMMANDS.has(command) && options.output !== null) {
    throw new TypeError(`${command} does not accept --output`);
  }
  const hasLayoutOption = [...LAYOUT_OPTIONS.values()].some(option => options[option] !== null);
  if (command !== 'clean' && hasLayoutOption) {
    throw new TypeError(`${command} does not accept benchmark layout options`);
  }
  return { command, ...options };
}

function createCommandPlan(
  argv,
  { repositoryRoot = path.resolve(__dirname, '..'), homeDirectory } = {}
) {
  validateRuntimeBenchmarkContract();
  const { command, output, cacheDir, outputDir, wasperApp } = parseCommandArguments(argv);
  if (command === 'clean') {
    return Object.freeze({
      command,
      layout: resolveLayout({
        ...(cacheDir === null ? {} : { cacheDir }),
        ...(outputDir === null ? {} : { outputDir }),
        ...(wasperApp === null ? {} : { wasperApp }),
        ...(homeDirectory === undefined ? {} : { homeDirectory }),
      }),
      writes: false,
    });
  }
  return Object.freeze({
    command,
    output: output === null ? null : resolvePrivateOutputPath(output, { repositoryRoot }),
    writes: false,
  });
}

function readRecoveredCorpus(output) {
  const manifestPath = path.join(output, 'selections/recovered-corpus.json');
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read recovered holder corpus at ${manifestPath}`, {
      cause: error,
    });
  }
}

function createHolderRunIdentity(manifest) {
  const corpus = {
    preparedLongManifestSha256: manifest?.preparedLongManifestSha256,
    runCorpusSha256: manifest?.runCorpusSha256,
    sourceProvenanceSha256: manifest?.sourceProvenanceSha256,
  };
  for (const [field, value] of Object.entries(corpus)) {
    if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
      throw new TypeError(`recovered holder corpus ${field} must be a SHA-256 digest`);
    }
  }
  return Object.freeze({
    schema: HOLDER_RUN_SCHEMA,
    attempt: HOLDER_RUN_ATTEMPT,
    corpus,
    hardware: {
      arch: process.arch,
      machine: os.hostname(),
      platform: process.platform,
      release: os.release(),
    },
    measurement: {
      endpoint: 'direct-full-audio-transcribe',
      timing: 'response-only',
      languageDetection: 'skip',
      memory: {
        action: 'exclude-and-stop',
        maximumBytes: MAX_PHYSICAL_FOOTPRINT_BYTES,
        metric: 'phys_footprint_peak',
        samplePhase: 'after-timed-response',
      },
    },
    runtimeCells: RUNTIME_DESCRIPTORS,
    schedule: {
      passes: MEASURED_PASSES,
      seed: 'holder-v3-refresh-20260913-r2',
      order: 'three rotated runtime passes with frozen fixture ranking',
    },
    scoring: {
      module: 'src/asr-quality/scoring.cjs',
      scope: 'full references; pooled and per-language WER/CER',
    },
  });
}

async function runCli(
  argv,
  {
    repositoryRoot,
    stdout = process.stdout,
    recoverCorpusImpl,
    smokeRuntimeAdaptersImpl,
    runRuntimeBenchmarkImpl,
    createRuntimeAdapterImpl,
    cleanImpl,
    homeDirectory,
  } = {}
) {
  const plan = createCommandPlan(argv, { repositoryRoot, homeDirectory });
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
      output: plan.output,
      repositoryRoot,
    });
    const result = Object.freeze({
      ...plan,
      writes: true,
      manifestPath: recovered.manifestPath,
      identityReportPath: recovered.identityReportPath,
    });
    stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  if (plan.command === 'smoke') {
    const smokeRuntimeAdapters =
      smokeRuntimeAdaptersImpl ?? require('./runtime/smoke.cjs').smokeRuntimeAdapters;
    const smoke = await smokeRuntimeAdapters({
      output: plan.output,
      repositoryRoot: repositoryRoot ?? path.resolve(__dirname, '..'),
    });
    const result = Object.freeze({ ...plan, writes: true, ...smoke });
    stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  if (plan.command === 'run') {
    const manifest = readRecoveredCorpus(plan.output);
    const runRuntimeBenchmark =
      runRuntimeBenchmarkImpl ?? require('./runtime/runner.cjs').runRuntimeBenchmark;
    const createRuntimeAdapter =
      createRuntimeAdapterImpl ?? require('./runtime/adapters/index.cjs').createRuntimeAdapter;
    const result = await runRuntimeBenchmark({
      outputRoot: plan.output,
      manifest,
      runIdentity: createHolderRunIdentity(manifest),
      adapterFactory: runtime => createRuntimeAdapter(runtime.id, { repositoryRoot }),
      preparedLongPath: path.join(plan.output, 'corpus/long/prepared/long-prepared.json'),
    });
    const summary = Object.freeze({
      ...plan,
      writes: true,
      runId: result.runId,
      runDirectory: result.runDirectory,
    });
    stdout.write(`${JSON.stringify(summary)}\n`);
    return summary;
  }
  stdout.write(`${JSON.stringify(plan)}\n`);
  return plan;
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createCommandPlan,
  createHolderRunIdentity,
  main: runCli,
  parseCommandArguments,
  runCli,
};
