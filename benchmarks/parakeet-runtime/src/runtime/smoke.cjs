'use strict';

const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const path = require('node:path');

const { createRuntimeAdapter } = require('./adapters/index.cjs');
const { RUNTIME_DESCRIPTORS } = require('./constants.cjs');

function smokeFixture(output) {
  const audioPath = path.join(output, 'corpus/short/playback/de-short-041268eb385d980f.wav');
  if (!fs.existsSync(audioPath)) throw new Error(`verified smoke fixture is missing: ${audioPath}`);
  return { id: 'de-short-041268eb385d980f', audioPath };
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

function resolvePackagedRepositoryRoot(repositoryRoot) {
  const executable = 'dist/mac-arm64/Wasper.app/Contents/Resources/bin/wasper-parakeet-server';
  const candidates = [repositoryRoot, path.resolve(repositoryRoot, '../..')];
  return (
    candidates.find(candidate => fs.existsSync(path.join(candidate, executable))) ?? repositoryRoot
  );
}

function createEvidence(output, fixture) {
  const createdAt = new Date().toISOString();
  const runId = `smoke-${createdAt.replace(/[^0-9A-Za-z]/gu, '')}-${randomUUID()}`;
  const runDirectory = path.join(output, 'runs', 'smoke', runId);
  fs.mkdirSync(path.dirname(runDirectory), { recursive: true });
  fs.mkdirSync(runDirectory);
  const evidencePath = path.join(runDirectory, 'smoke.json');
  const evidence = {
    schema: 'wasper.parakeet-runtime-benchmark.private-smoke.v1',
    visibility: 'private-evidence',
    runId,
    status: 'running',
    createdAt,
    fixture,
    cells: [],
  };
  const persist = () => fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  persist();
  return { evidence, evidencePath, persist };
}

async function smokeRuntimeAdapters({
  output,
  repositoryRoot = path.resolve(__dirname, '../..'),
  packagedRepositoryRoot = resolvePackagedRepositoryRoot(repositoryRoot),
}) {
  const fixture = smokeFixture(output);
  const { evidence, evidencePath, persist } = createEvidence(output, fixture);

  for (const runtime of RUNTIME_DESCRIPTORS) {
    const cell = { runtimeId: runtime.id, status: 'running' };
    evidence.cells.push(cell);
    persist();
    let adapter = null;
    let active = false;
    let phase = 'create-adapter';
    let failure = null;
    try {
      adapter = createRuntimeAdapter(runtime.id, {
        repositoryRoot,
        packagedRepositoryRoot,
      });
      phase = 'start';
      cell.started = await adapter.start();
      active = true;
      persist();
      phase = 'health';
      cell.health = await adapter.health();
      persist();
      phase = 'warmup';
      cell.warmup = await adapter.warmup(fixture);
      outcomeError(cell.warmup, phase);
      persist();
      cell.transcriptions = [];
      for (const index of [1, 2]) {
        phase = `transcribe-${index}`;
        const transcription = await adapter.transcribe(fixture);
        cell.transcriptions.push(transcription);
        outcomeError(transcription, phase);
        persist();
      }
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
      evidence.completedAt = new Date().toISOString();
      persist();
      failure.evidencePath = evidencePath;
      throw failure;
    }
    persist();
  }

  evidence.status = 'passed';
  evidence.completedAt = new Date().toISOString();
  persist();
  return {
    evidencePath,
    cells: evidence.cells.map(({ runtimeId, status }) => ({ runtimeId, status })),
  };
}

module.exports = { smokeRuntimeAdapters };
