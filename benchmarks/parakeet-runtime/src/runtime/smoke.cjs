'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { isInside, resolveLayout, writeOwnershipMarker } = require('../config.cjs');
const { createRuntimeAdapter } = require('./adapters/index.cjs');
const { RUNTIME_DESCRIPTORS } = require('./constants.cjs');
const { createEvidenceStore } = require('./evidence-store.cjs');

function smokeFixture(manifest, layout) {
  const fixture = manifest?.fixtures?.find(item => item.cohort === 'short');
  if (!fixture) throw new Error('verified public corpus has no short smoke fixture');
  const relativePath = fixture.normalizedAudio?.path;
  if (
    typeof relativePath !== 'string' ||
    relativePath === '' ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/u).some(part => part === '..' || part === '')
  ) {
    throw new Error('verified smoke fixture audio path is unsafe');
  }
  const audioPath = path.resolve(layout.corpusRoot, ...relativePath.split('/'));
  if (!isInside(layout.corpusRoot, audioPath)) {
    throw new Error('verified smoke fixture must stay under the corpus root');
  }
  const stat = fs.lstatSync(audioPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`verified smoke fixture is missing: ${audioPath}`);
  }
  return { id: fixture.fixtureId, audioPath };
}

function outcomeError(outcome, phase) {
  if (outcome?.error) throw new Error(`${phase}: ${outcome.error.type}: ${outcome.error.message}`);
  if (typeof outcome?.rawTranscript !== 'string' || outcome.rawTranscript.trim() === '') {
    throw new Error(`${phase}: runtime returned no transcript`);
  }
}

function serializeError(error, phase) {
  const serialized = {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message:
      typeof error?.message === 'string' && error.message !== '' ? error.message : String(error),
  };
  for (const field of ['code', 'operation', 'timeoutMs']) {
    if (error?.[field] !== undefined) serialized[field] = error[field];
  }
  if (phase) serialized.phase = phase;
  return serialized;
}

async function smokeRuntimeAdapters({
  layout = resolveLayout(),
  manifest,
  runtimeLock,
  runtimeDescriptors = RUNTIME_DESCRIPTORS,
  createRuntimeAdapterImpl = createRuntimeAdapter,
  now,
}) {
  const resolvedLayout = resolveLayout({
    cacheDir: layout.cacheRoot,
    outputDir: layout.outputRoot,
    ...(layout.homeDirectory === undefined ? {} : { homeDirectory: layout.homeDirectory }),
    ...(layout.wasperApp == null ? {} : { wasperApp: layout.wasperApp }),
  });
  if (
    resolvedLayout.cacheRoot !== layout.cacheRoot ||
    resolvedLayout.outputRoot !== layout.outputRoot
  ) {
    throw new Error('smoke layout changed or is forged');
  }
  writeOwnershipMarker(resolvedLayout);
  const fixture = smokeFixture(manifest, resolvedLayout);
  const store = createEvidenceStore({
    layout: resolvedLayout,
    runIdentity: {
      schema: 'wasper.parakeet-runtime-benchmark.local-smoke.v1',
      schedule: { seed: 'smoke' },
    },
    ...(now === undefined ? {} : { clock: now }),
  });
  const evidencePath = path.join(store.runDirectory, 'smoke-evidence.json');
  const evidence = {
    schema: 'wasper.parakeet-runtime-benchmark.local-smoke.v1',
    runId: store.runId,
    status: 'running',
    fixture: { id: fixture.id },
    cells: [],
  };
  const persist = () => store.writeArtifact('smoke-evidence.json', evidence);
  persist();

  for (const runtime of runtimeDescriptors) {
    const cell = { runtimeId: runtime.id, status: 'running' };
    evidence.cells.push(cell);
    persist();
    let adapter = null;
    let active = false;
    let phase = 'create-adapter';
    let failure = null;
    try {
      adapter = createRuntimeAdapterImpl(runtime.id, {
        layout: resolvedLayout,
        ...(runtimeLock === undefined ? {} : { runtimeLock }),
      });
      phase = 'start';
      cell.started = await adapter.start();
      active = true;
      persist();
      phase = 'health';
      cell.health = await adapter.health();
      persist();
      phase = 'warmup';
      cell.warmup = await adapter.warmup(fixture, {
        languagePolicy: { mode: 'automatic', languageHint: null },
      });
      outcomeError(cell.warmup, phase);
      persist();
      phase = 'transcribe';
      cell.transcription = await adapter.transcribe(fixture, {
        languagePolicy: { mode: 'automatic', languageHint: null },
      });
      outcomeError(cell.transcription, phase);
      persist();
      phase = 'footprint';
      cell.footprint = await adapter.sampleFootprint();
      persist();
      phase = 'identity';
      cell.identity = await adapter.identity();
      persist();
    } catch (error) {
      failure = error;
      cell.error = serializeError(error, phase);
    } finally {
      if (active) {
        try {
          phase = 'stop';
          await adapter.stop();
          cell.stopped = true;
        } catch (error) {
          cell.stopError = serializeError(error, phase);
          if (!failure) {
            failure = error;
            cell.error = cell.stopError;
          }
        }
      }
    }
    cell.status = failure ? 'failed' : 'ok';
    if (failure) {
      evidence.status = 'failed';
      persist();
      failure.evidencePath = evidencePath;
      throw failure;
    }
    persist();
  }

  evidence.status = 'passed';
  persist();
  return {
    evidencePath,
    cells: evidence.cells.map(({ runtimeId, status }) => ({ runtimeId, status })),
  };
}

module.exports = { smokeRuntimeAdapters };
