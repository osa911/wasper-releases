'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { canonicalJson } = require('../asr-quality/manifest.cjs');
const { assertCanonicalScore, scoreTranscript } = require('../asr-quality/scoring.cjs');
const { isInside, resolveLayout } = require('../config.cjs');
const { MEASURED_PASSES, RUNTIME_DESCRIPTORS } = require('./constants.cjs');
const { createEvidenceStore } = require('./evidence-store.cjs');
const { aggregateRuntimeEvidence } = require('./aggregation.cjs');
const { writePublicReport } = require('./report.cjs');
const { projectPublicEvidence } = require('./reporting/public-projection.cjs');

const DEFAULT_MAX_PHYSICAL_FOOTPRINT_BYTES = 8 * 1024 ** 3;
const FOOTPRINT_SAMPLE_ATTEMPTS = 2;
const FOOTPRINT_SAMPLE_RETRY_DELAY_MS = 20;

class PhysicalFootprintCapError extends Error {
  constructor({
    capBytes,
    footprint,
    metric = 'phys_footprint_peak',
    observedBytes = footprint?.physFootprintPeakBytes ?? footprint?.phys_footprint_peak,
    code = 'PHYSICAL_FOOTPRINT_CAP_EXCEEDED',
    name = 'PhysicalFootprintCapError',
  }) {
    super(`Runtime ${metric} exceeded the ${capBytes} byte cap: observed ${observedBytes} bytes`);
    this.name = name;
    this.code = code;
    this.capBytes = capBytes;
    this.footprint = footprint;
    this.metric = metric;
    this.observedBytes = observedBytes;
    this.adapterStopped = false;
  }
}

function hash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function rotate(values, offset) {
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function resolveRuntimeDescriptors(runtimeDescriptors = RUNTIME_DESCRIPTORS) {
  if (!Array.isArray(runtimeDescriptors) || runtimeDescriptors.length === 0) {
    throw new TypeError('runtimeDescriptors must contain canonical runtime descriptors');
  }
  const descriptorsById = new Map(
    RUNTIME_DESCRIPTORS.map(descriptor => [descriptor.id, descriptor])
  );
  const resolved = runtimeDescriptors.map(runtime => descriptorsById.get(runtime?.id));
  if (resolved.includes(undefined) || new Set(resolved.map(runtime => runtime.id)).size !== resolved.length) {
    throw new TypeError('runtimeDescriptors must contain unique canonical runtime descriptors');
  }
  return resolved;
}

function resolveRuntimeOrder(runtimeOrder, runtimeDescriptors) {
  if (runtimeOrder === undefined) return null;
  if (!Array.isArray(runtimeOrder) || runtimeOrder.length !== runtimeDescriptors.length) {
    throw new TypeError('runtimeOrder must contain every selected runtime exactly once');
  }
  const descriptorsById = new Map(runtimeDescriptors.map(descriptor => [descriptor.id, descriptor]));
  const resolved = runtimeOrder.map(runtimeId => descriptorsById.get(runtimeId));
  if (resolved.includes(undefined) || new Set(runtimeOrder).size !== runtimeOrder.length) {
    throw new TypeError('runtimeOrder must contain every selected runtime exactly once');
  }
  return resolved;
}

function resolveCorpusFile(layout, relativePath, label) {
  if (
    typeof relativePath !== 'string' ||
    relativePath === '' ||
    path.isAbsolute(relativePath) ||
    relativePath.split(/[\\/]/u).some(part => part === '..' || part === '')
  ) {
    throw new TypeError(`${label} must be a safe corpus-relative path`);
  }
  const filePath = path.resolve(layout.corpusRoot, ...relativePath.split('/'));
  if (!isInside(layout.corpusRoot, filePath)) {
    throw new Error(`${label} must stay under the verified corpus root`);
  }
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a verified regular file`);
  }
  return filePath;
}

function hydratePublicFixtures(manifest, layout) {
  if (manifest?.schema !== 'wasper.public-run-corpus.v1' || !Array.isArray(manifest.fixtures)) {
    throw new TypeError('manifest must be a verified public run corpus');
  }
  const fixtures = manifest.fixtures.map(fixture => {
    if (fixture?.status === 'no-qualified-fixture') {
      return {
        id: `no-qualified-long:${fixture.language}`,
        language: fixture.language,
        cohort: 'long',
        unavailable: true,
        reason: fixture.reason,
      };
    }
    if (
      !['short', 'long'].includes(fixture?.cohort) ||
      typeof fixture.fixtureId !== 'string' ||
      typeof fixture.language !== 'string'
    ) {
      throw new TypeError('verified public fixture must identify its cohort, language, and fixture id');
    }
    const audioPath = resolveCorpusFile(
      layout,
      fixture.normalizedAudio?.path,
      `${fixture.fixtureId} normalized audio`
    );
    const referencePath = resolveCorpusFile(
      layout,
      fixture.reference?.path,
      `${fixture.fixtureId} reference`
    );
    const text = fs.readFileSync(referencePath, 'utf8');
    if (text === '') throw new Error(`${fixture.fixtureId} reference is empty`);
    return {
      id: fixture.fixtureId,
      language: fixture.language,
      cohort: fixture.cohort,
      audioPath,
      normalizedAudio: {
        durationSeconds: fixture.normalizedAudio?.durationSeconds,
        sha256: fixture.normalizedAudio?.sha256,
      },
      reference: { sha256: fixture.reference?.sha256, text },
      source: { sha256: fixture.source?.sha256 },
    };
  });
  if (fixtures.length === 0) throw new TypeError('verified public corpus has no fixtures');
  const warmupSource = fixtures
    .filter(fixture => fixture.cohort === 'short' && !fixture.unavailable)
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (!warmupSource) throw new Error('verified public corpus has no short fixture for warm-up');
  return {
    warmup: { ...warmupSource, id: `${warmupSource.id}-warmup`, cohort: 'warmup' },
    fixtures,
    requestBalancedFixtureIds: fixtures
      .filter(fixture => fixture.cohort === 'short' && !fixture.unavailable)
      .map(fixture => fixture.id),
  };
}

function buildRuntimeSchedule({ manifest, seed, runtimeDescriptors = RUNTIME_DESCRIPTORS }) {
  const fixtures = manifest?.runCorpus?.fixtures;
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new TypeError('hydrated runtime corpus fixtures are required');
  }
  const rankedFixtures = fixtures
    .map(fixture => ({ fixture, rank: hash({ fixtureId: fixture.id, seed }) }))
    .sort((left, right) => left.rank.localeCompare(right.rank));
  const selectedRuntimeDescriptors = resolveRuntimeDescriptors(runtimeDescriptors);
  const schedule = [];
  let order = 0;
  for (let pass = 1; pass <= MEASURED_PASSES; pass += 1) {
    for (const cell of rotate(selectedRuntimeDescriptors, pass - 1)) {
      for (const { fixture } of rotate(rankedFixtures, pass - 1)) {
        schedule.push({
          order: order++,
          cellId: cell.id,
          pass,
          fixtureId: fixture.id,
          language: fixture.language,
          cohort: fixture.cohort,
        });
      }
    }
  }
  return schedule;
}

function errorRecord(item, fixture, error) {
  return {
    ...item,
    outcome: 'error',
    audioSeconds: fixture.normalizedAudio?.durationSeconds ?? null,
    wallSeconds: null,
    score: null,
    footprint: null,
    fixtureEvidence: fixtureEvidence(fixture),
    raw: {
      error: {
        name: error?.name ?? 'Error',
        message: error?.message ?? String(error),
        code: error?.code ?? null,
      },
    },
  };
}

function memoryExcludedRecord(item, fixture, error) {
  return {
    ...item,
    outcome: 'memory-excluded',
    audioSeconds: fixture.normalizedAudio?.durationSeconds ?? null,
    wallSeconds: null,
    score: null,
    footprint: error.footprint ?? null,
    fixtureEvidence: fixtureEvidence(fixture),
    raw: {
      memoryExclusion: {
        code: error.code,
        message: error.message,
        metric: error.metric,
        maxPhysicalFootprintBytes: error.capBytes,
        observedMemoryBytes: error.observedBytes,
        observedPhysicalFootprintBytes:
          error.footprint?.physFootprintPeakBytes ?? error.footprint?.phys_footprint_peak ?? null,
      },
    },
  };
}

function unavailableRecord(item, fixture) {
  return {
    ...item,
    outcome: 'unavailable-long',
    audioSeconds: null,
    wallSeconds: null,
    score: null,
    footprint: null,
    fixtureEvidence: fixtureEvidence(fixture),
    raw: { unavailableReason: fixture.reason },
  };
}

function fixtureEvidence(fixture) {
  return {
    sourceSha256: fixture.source?.sha256 ?? null,
    normalizedWavSha256: fixture.normalizedAudio?.sha256 ?? null,
    referenceSha256: fixture.reference?.sha256 ?? null,
    durationSeconds: fixture.normalizedAudio?.durationSeconds ?? null,
  };
}

function isPhysicalFootprintCapError(error) {
  return error instanceof PhysicalFootprintCapError;
}

function physicalFootprintBytes(footprint) {
  const bytes = footprint?.physFootprintPeakBytes ?? footprint?.phys_footprint_peak;
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new TypeError('physical footprint evidence must include a positive byte value');
  }
  return bytes;
}

function assertPhysicalFootprintCap(footprint, capBytes) {
  if (physicalFootprintBytes(footprint) > capBytes) {
    throw new PhysicalFootprintCapError({ capBytes, footprint });
  }
  return footprint;
}

function metalAllocationCapError(error, capBytes, footprint) {
  const message = error?.message ?? String(error);
  const marker = 'failed to allocate buffer, size =';
  const allocationStart = message.toLowerCase().indexOf(marker);
  if (!message.toLowerCase().includes('insufficient memory') || allocationStart === -1) return null;
  const allocationText = message
    .slice(allocationStart + marker.length)
    .split('\n', 1)[0]
    .trim();
  if (!allocationText.endsWith('MiB')) return null;
  const observedBytes = Math.round(Number(allocationText.slice(0, -3).trim()) * 1024 ** 2);
  if (!Number.isFinite(observedBytes) || observedBytes <= capBytes) return null;
  return new PhysicalFootprintCapError({
    capBytes,
    footprint,
    metric: 'Metal buffer allocation request',
    observedBytes,
    code: 'METAL_ALLOCATION_CAP_EXCEEDED',
    name: 'MetalAllocationCapError',
  });
}

function priorMemoryExclusionErrors(priorMemoryExclusions, capBytes) {
  if (priorMemoryExclusions === undefined) return new Map();
  if (
    priorMemoryExclusions === null ||
    typeof priorMemoryExclusions !== 'object' ||
    Array.isArray(priorMemoryExclusions)
  ) {
    throw new TypeError('priorMemoryExclusions must be an object keyed by runtime cell id');
  }
  const knownCellIds = new Set(RUNTIME_DESCRIPTORS.map(cell => cell.id));
  const exclusions = new Map();
  for (const [cellId, observation] of Object.entries(priorMemoryExclusions)) {
    if (!knownCellIds.has(cellId))
      throw new TypeError(`unknown prior memory exclusion cell: ${cellId}`);
    const footprint = observation?.footprint;
    const allocationBytes = observation?.allocationBytes;
    if (Number.isFinite(allocationBytes) && allocationBytes > capBytes) {
      exclusions.set(
        cellId,
        new PhysicalFootprintCapError({
          capBytes,
          footprint,
          metric: observation.metric ?? 'runtime memory allocation request',
          observedBytes: allocationBytes,
          code: observation.code ?? 'RUNTIME_ALLOCATION_CAP_EXCEEDED',
          name: 'RuntimeAllocationCapError',
        })
      );
      continue;
    }
    try {
      assertPhysicalFootprintCap(footprint, capBytes);
    } catch (error) {
      if (isPhysicalFootprintCapError(error)) exclusions.set(cellId, error);
      else throw error;
    }
  }
  return exclusions;
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function sampleFootprintAfterTiming(adapter) {
  let lastError;
  for (let attempt = 1; attempt <= FOOTPRINT_SAMPLE_ATTEMPTS; attempt += 1) {
    try {
      return await adapter.sampleFootprint();
    } catch (error) {
      lastError = error;
      if (attempt < FOOTPRINT_SAMPLE_ATTEMPTS) await delay(FOOTPRINT_SAMPLE_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

async function transcribeThenSamplePhysicalFootprint({ adapter, fixture, capBytes, requestOptions }) {
  let lastFootprint = null;
  try {
    // `sampleFootprint()` invokes macOS `top`, which perturbs short-request
    // timing. The timing response must resolve before this unscored memory
    // observation begins.
    const response = await adapter.transcribe(fixture, requestOptions);
    lastFootprint = await sampleFootprintAfterTiming(adapter);
    assertPhysicalFootprintCap(lastFootprint, capBytes);
    return { response, footprint: lastFootprint };
  } catch (error) {
    const allocationError = metalAllocationCapError(error, capBytes, lastFootprint);
    if (allocationError) throw allocationError;
    throw error;
  }
}

async function runRuntimeBenchmark({
  layout,
  manifest,
  runIdentity,
  adapterFactory,
  resume = false,
  maxPhysicalFootprintBytes = DEFAULT_MAX_PHYSICAL_FOOTPRINT_BYTES,
  priorMemoryExclusions,
  runtimeOrder,
  runtimeDescriptors,
  now,
}) {
  if (typeof adapterFactory !== 'function')
    throw new TypeError('adapterFactory must be a function');
  const seed = runIdentity?.schedule?.seed;
  if (typeof seed !== 'string' || seed === '')
    throw new TypeError('runIdentity.schedule.seed is required');
  if (!Number.isFinite(maxPhysicalFootprintBytes) || maxPhysicalFootprintBytes <= 0) {
    throw new TypeError('maxPhysicalFootprintBytes must be a positive finite number');
  }
  const resolvedLayout = resolveLayout({
    cacheDir: layout?.cacheRoot,
    outputDir: layout?.outputRoot,
    ...(layout?.homeDirectory === undefined ? {} : { homeDirectory: layout.homeDirectory }),
    ...(layout?.wasperApp == null ? {} : { wasperApp: layout.wasperApp }),
  });
  if (
    resolvedLayout.cacheRoot !== layout?.cacheRoot ||
    resolvedLayout.outputRoot !== layout?.outputRoot
  ) {
    throw new Error('runtime benchmark layout changed or is forged');
  }
  const hydrated = hydratePublicFixtures(manifest, resolvedLayout);
  const hydratedManifest = {
    runCorpus: {
      warmup: hydrated.warmup,
      fixtures: hydrated.fixtures,
    },
  };
  const selectedRuntimeDescriptors = resolveRuntimeDescriptors(runtimeDescriptors);
  const schedule = buildRuntimeSchedule({
    manifest: hydratedManifest,
    seed,
    runtimeDescriptors: selectedRuntimeDescriptors,
  });
  const orderedRuntimeDescriptors = resolveRuntimeOrder(runtimeOrder, selectedRuntimeDescriptors);
  const baseRuntimeOrder = orderedRuntimeDescriptors ?? selectedRuntimeDescriptors;
  const fixtures = new Map(
    hydratedManifest.runCorpus.fixtures.map(fixture => [fixture.id, fixture])
  );
  const store = createEvidenceStore({
    layout: resolvedLayout,
    runIdentity,
    resume,
    ...(now === undefined ? {} : { clock: now }),
  });
  const persisted = store.readRequests();
  const byOrder = new Map(persisted.map(record => [record.order, record]));
  let activationSequence = 0;
  const memoryExcludedCells = priorMemoryExclusionErrors(
    priorMemoryExclusions,
    maxPhysicalFootprintBytes
  );

  for (let pass = 1; pass <= MEASURED_PASSES; pass += 1) {
    for (const cell of rotate(baseRuntimeOrder, pass - 1)) {
      const items = schedule.filter(item => item.pass === pass && item.cellId === cell.id);
      const pending = items.filter(item => !byOrder.has(item.order));
      for (const item of pending.filter(item => fixtures.get(item.fixtureId).unavailable)) {
        const record = unavailableRecord(item, fixtures.get(item.fixtureId));
        store.writeRequest(record);
        byOrder.set(item.order, record);
      }
      const measured = pending.filter(item => !fixtures.get(item.fixtureId).unavailable);
      if (measured.length === 0) continue;
      const priorExclusion = memoryExcludedCells.get(cell.id);
      if (priorExclusion) {
        for (const item of measured) {
          const record = memoryExcludedRecord(item, fixtures.get(item.fixtureId), priorExclusion);
          store.writeRequest(record);
          byOrder.set(item.order, record);
        }
        continue;
      }
      const adapter = adapterFactory(cell);
      const activation = { sequence: activationSequence++, cellId: cell.id, pass, lifecycle: [] };
      try {
        activation.start = await adapter.start();
        activation.health = await adapter.health();
        activation.identity = await adapter.identity();
        activation.afterHealthFootprint = assertPhysicalFootprintCap(
          await adapter.sampleFootprint(),
          maxPhysicalFootprintBytes
        );
        activation.warmup = await adapter.warmup(hydratedManifest.runCorpus.warmup, {
          languagePolicy: { mode: 'automatic', languageHint: null },
        });
        activation.afterWarmupFootprint = assertPhysicalFootprintCap(
          await adapter.sampleFootprint(),
          maxPhysicalFootprintBytes
        );
        activation.lifecycle.push('start', 'health', 'identity', 'footprint', 'warmup');
        store.writeActivation(activation);
        for (let index = 0; index < measured.length; index += 1) {
          const item = measured[index];
          const fixture = fixtures.get(item.fixtureId);
          try {
            const { response, footprint } = await transcribeThenSamplePhysicalFootprint({
              adapter,
              fixture,
              capBytes: maxPhysicalFootprintBytes,
              requestOptions: { languagePolicy: { mode: 'automatic', languageHint: null } },
            });
            const score = scoreTranscript(
              fixture.reference.text,
              response.rawTranscript,
              fixture.language
            );
            assertCanonicalScore(
              score,
              fixture.reference.text,
              response.rawTranscript,
              fixture.language
            );
            const record = {
              ...item,
              outcome: 'success',
              audioSeconds: fixture.normalizedAudio.durationSeconds,
              wallSeconds: response.wallSeconds,
              score,
              footprint,
              fixtureEvidence: fixtureEvidence(fixture),
              raw: { response },
            };
            store.writeRequest(record);
            byOrder.set(item.order, record);
          } catch (error) {
            const record = isPhysicalFootprintCapError(error)
              ? memoryExcludedRecord(item, fixture, error)
              : errorRecord(item, fixture, error);
            store.writeRequest(record);
            byOrder.set(item.order, record);
            if (isPhysicalFootprintCapError(error)) {
              activation.memoryExclusion = {
                ...record.raw.memoryExclusion,
                adapterStopped: error.adapterStopped,
              };
              store.writeActivation(activation);
              memoryExcludedCells.set(cell.id, error);
              for (const remaining of measured.slice(index + 1)) {
                const excluded = memoryExcludedRecord(
                  remaining,
                  fixtures.get(remaining.fixtureId),
                  error
                );
                store.writeRequest(excluded);
                byOrder.set(remaining.order, excluded);
              }
              break;
            }
          }
        }
      } catch (error) {
        activation.error = isPhysicalFootprintCapError(error)
          ? {
              name: error.name,
              message: error.message,
              code: error.code,
              memoryExclusion: {
                maxPhysicalFootprintBytes: error.capBytes,
                metric: error.metric,
                observedMemoryBytes: error.observedBytes,
                observedPhysicalFootprintBytes:
                  error.footprint?.physFootprintPeakBytes ?? error.footprint?.phys_footprint_peak,
              },
            }
          : {
              name: error?.name ?? 'Error',
              message: error?.message ?? String(error),
            };
        store.writeActivation(activation);
        for (const item of measured) {
          const record = isPhysicalFootprintCapError(error)
            ? memoryExcludedRecord(item, fixtures.get(item.fixtureId), error)
            : errorRecord(item, fixtures.get(item.fixtureId), error);
          store.writeRequest(record);
          byOrder.set(item.order, record);
        }
        if (isPhysicalFootprintCapError(error)) memoryExcludedCells.set(cell.id, error);
      } finally {
        if (!activation.memoryExclusion?.adapterStopped) {
          try {
            await adapter.stop();
          } catch (error) {
            if (error?.message !== 'stop requires an active adapter') {
              activation.stopError = {
                name: error?.name ?? 'Error',
                message: error?.message ?? String(error),
              };
              store.writeActivation(activation);
            }
          }
        }
      }
    }
  }

  const records = store.readRequests().sort((left, right) => left.order - right.order);
  const aggregate = aggregateRuntimeEvidence({
    records,
    schedule,
    requestBalancedFixtureIds: hydrated.requestBalancedFixtureIds,
  });
  const summary = { runId: store.runId, evidenceHash: store.evidenceHash(records), aggregate };
  store.writeArtifact('local-summary.json', summary);
  store.writeArtifact('local-review-queue.json', {
    errors: records
      .filter(record => record.outcome === 'error')
      .map(record => ({ order: record.order, raw: record.raw })),
  });
  const activations = store.readActivations();
  const localRun = {
    runId: store.runId,
    runIdentity,
    schedule,
    records,
    activations,
    aggregate,
  };
  const publicEvidence = projectPublicEvidence(localRun);
  store.writeArtifact('public-evidence.json', publicEvidence);
  writePublicReport({ store, evidence: publicEvidence });
  return { ...localRun, runDirectory: store.runDirectory, publicEvidence };
}

module.exports = {
  DEFAULT_MAX_PHYSICAL_FOOTPRINT_BYTES,
  PhysicalFootprintCapError,
  buildRuntimeSchedule,
  runRuntimeBenchmark,
};
