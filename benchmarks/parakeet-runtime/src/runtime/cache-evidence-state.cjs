'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CACHE_STATES = Object.freeze({
  'cold-cache': Object.freeze({
    id: 'cold-cache',
    label: 'cold graph cache after generic decoder warm-up',
    serverEnv: Object.freeze({
      WASPER_PARAKEET_PREWARM: '0',
      WASPER_PARAKEET_PREWARM_MODE: 'off',
    }),
    serverPriming: Object.freeze({
      kind: 'none',
      buckets: Object.freeze([]),
    }),
  }),
  'bucket-primed': Object.freeze({
    id: 'bucket-primed',
    label: 'bucket-primed graph cache after generic decoder warm-up',
    serverEnv: Object.freeze({
      WASPER_PARAKEET_PREWARM: '1',
      WASPER_PARAKEET_PREWARM_MODE: 'blocking',
    }),
    serverPriming: Object.freeze({
      kind: 'native-blocking-all-buckets',
      buckets: 'server-default-all',
    }),
  }),
});

function resolveBenchmarkCacheState(value) {
  const cacheState = CACHE_STATES[value];
  if (!cacheState) {
    throw new Error('WASPER_EVIDENCE_CACHE_STATE must be one of: cold-cache, bucket-primed');
  }
  return cacheState;
}

function createEmptyPassGraphCacheDirectory({ cacheRoot, runId, pass, cacheState }) {
  const directory = path.join(
    cacheRoot,
    'single-runtime-graph-caches',
    runId,
    `pass-${String(pass).padStart(2, '0')}`,
    cacheState.id
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(directory).length !== 0) {
    throw new Error(`benchmark graph-cache directory must be empty: ${directory}`);
  }
  return directory;
}

function requireCounter(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function fullGraphStats(cacheStats) {
  if (cacheStats === null || typeof cacheStats !== 'object' || Array.isArray(cacheStats)) {
    throw new TypeError('cache statistics must be an object');
  }
  const stats = cacheStats.full_graph;
  if (stats === null || typeof stats !== 'object' || Array.isArray(stats)) {
    throw new TypeError('cache statistics require the full_graph v2 snapshot');
  }
  return {
    completedCompilations: requireCounter(
      stats.completed_compilations,
      'full_graph.completed_compilations'
    ),
    memoryMisses: requireCounter(stats.memory_misses, 'full_graph.memory_misses'),
    diskHits: requireCounter(stats.disk_hits, 'full_graph.disk_hits'),
    diskMisses: requireCounter(stats.disk_misses, 'full_graph.disk_misses'),
    rejectedEntries: requireCounter(stats.rejected_entries, 'full_graph.rejected_entries'),
  };
}

function prewarmBucketCount(completion) {
  if (typeof completion !== 'string') {
    throw new TypeError('native blocking prewarm completion must be a string');
  }
  const match =
    /\[parakeet\] prewarm completed mode=blocking target_buckets=(\d+)\/(\d+) total_completed=(\d+)\/(\d+)/u.exec(
      completion
    );
  if (!match || match[1] !== match[2] || match[1] !== match[3] || match[1] !== match[4]) {
    throw new Error('native blocking prewarm did not complete every target bucket');
  }
  const count = Number(match[1]);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error('native blocking prewarm did not report a positive target bucket count');
  }
  return count;
}

function assertBucketPrimedCacheEvidence({
  blockingPrewarmCompletion,
  cacheStatsAfterNativePrewarm,
  cacheStatsAfterGenericWarmup,
  cacheStatsAfterScoring,
}) {
  const expectedBuckets = prewarmBucketCount(blockingPrewarmCompletion);
  const prewarm = fullGraphStats(cacheStatsAfterNativePrewarm);
  const warm = fullGraphStats(cacheStatsAfterGenericWarmup);
  const scoring = fullGraphStats(cacheStatsAfterScoring);

  if (prewarm.completedCompilations + prewarm.diskHits < expectedBuckets) {
    throw new Error('native blocking prewarm did not compile or restore every target bucket');
  }

  const scoringDelta = {
    completedCompilations: scoring.completedCompilations - warm.completedCompilations,
    memoryMisses: scoring.memoryMisses - warm.memoryMisses,
    diskMisses: scoring.diskMisses - warm.diskMisses,
    rejectedEntries: scoring.rejectedEntries - warm.rejectedEntries,
  };
  if (Object.values(scoringDelta).some(value => value !== 0)) {
    throw new Error('scoring added cache work; bucket-primed latency evidence is not valid');
  }

  return {
    expectedBuckets,
    observedPrewarm: {
      completedCompilations: prewarm.completedCompilations,
      diskHits: prewarm.diskHits,
    },
    scoringDelta,
  };
}

module.exports = {
  assertBucketPrimedCacheEvidence,
  createEmptyPassGraphCacheDirectory,
  resolveBenchmarkCacheState,
};
