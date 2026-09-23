const LANGUAGES = Object.freeze(['de', 'el', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt']);
const COHORTS = Object.freeze(['short', 'long']);
const ENGINE_CELLS = Object.freeze([
  Object.freeze({ id: 'cohere-pinned', engineId: 'cohere', backend: 'native', mode: 'pinned' }),
  Object.freeze({ id: 'whisper-pinned', engineId: 'whisper', backend: 'native', mode: 'pinned' }),
  Object.freeze({ id: 'whisper-auto', engineId: 'whisper', backend: 'native', mode: 'auto' }),
  Object.freeze({
    id: 'parakeet-cpu-pinned',
    engineId: 'parakeet',
    backend: 'cpu',
    mode: 'pinned',
  }),
  Object.freeze({ id: 'parakeet-cpu-auto', engineId: 'parakeet', backend: 'cpu', mode: 'auto' }),
  Object.freeze({
    id: 'parakeet-gpu-pinned',
    engineId: 'parakeet-gpu',
    backend: 'gpu',
    mode: 'pinned',
  }),
  Object.freeze({
    id: 'parakeet-gpu-auto',
    engineId: 'parakeet-gpu',
    backend: 'gpu',
    mode: 'auto',
  }),
]);
const MEASURED_PASSES = 3;
const REQUEST_ABORT_GRACE_MS = 100;
const NORMALIZATION_VERSION = 'asr-quality-normalization-v1';
const SCORING_VERSION = 'asr-quality-scoring-v2';

module.exports = {
  LANGUAGES,
  COHORTS,
  ENGINE_CELLS,
  MEASURED_PASSES,
  REQUEST_ABORT_GRACE_MS,
  NORMALIZATION_VERSION,
  SCORING_VERSION,
};
