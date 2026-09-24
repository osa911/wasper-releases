'use strict';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

const RUNTIME_BENCHMARK_SCHEMA = 'wasper.parakeet-runtime-benchmark.private-run.v1';
const RUNTIME_BENCHMARK_REVISION = 'parakeet-runtime-benchmark-v1';
const MEASURED_PASSES = 3;
const LANGUAGES = deepFreeze(['de', 'el', 'en', 'es', 'fr', 'it', 'nl', 'pl', 'pt']);
const AUTOMATIC_LANGUAGE_POLICY = deepFreeze({ mode: 'automatic', languageHint: null });
const CACHE_PATHS = deepFreeze({
  root: '.wasper-benchmark-cache/parakeet-runtime-v1',
  corpus: '.wasper-benchmark-cache/parakeet-runtime-v1/corpus',
  models: '.wasper-benchmark-cache/parakeet-runtime-v1/models',
  runs: '.wasper-benchmark-cache/parakeet-runtime-v1/runs',
});

const RUNTIME_DESCRIPTORS = deepFreeze([
  {
    id: 'wasper-metal-int8',
    label: 'Wasper Parakeet GPU',
    holder: 'Wasper',
    artifact: {
      format: 'packaged-metal-encoder',
      identity: 'wasper-parakeet-metal-int8',
      location: 'native-server/build/wasper-parakeet-server',
    },
    quantization: { label: 'int8', bits: 8 },
    languagePolicy: AUTOMATIC_LANGUAGE_POLICY,
  },
  {
    id: 'mlx-fp32',
    label: 'MLX Community F32 weights / BF16 runtime',
    holder: 'MLX Community',
    artifact: {
      format: 'safetensors',
      identity: 'mlx-community/parakeet-tdt-0.6b-v3',
      location: 'models/mlx-community/parakeet-tdt-0.6b-v3',
    },
    quantization: { label: 'f32-weights-bf16-runtime', runtimeBits: 16, weightBits: 32 },
    languagePolicy: AUTOMATIC_LANGUAGE_POLICY,
  },
  {
    id: 'mlx-int8-local',
    label: 'Local MLX int8',
    holder: 'Wasper',
    artifact: {
      format: 'safetensors',
      identity: 'wasper/parakeet-tdt-0.6b-v3-mlx-int8-g64',
      location: 'models/local-mlx-int8/parakeet-tdt-0.6b-v3',
    },
    quantization: { label: 'int8', bits: 8, groupSize: 64 },
    languagePolicy: AUTOMATIC_LANGUAGE_POLICY,
  },
  {
    id: 'handy-gguf-q8',
    label: 'Handy Computer Q8',
    holder: 'Handy Computer',
    artifact: {
      format: 'gguf',
      identity: 'parakeet-tdt-0.6b-v3-Q8_0.gguf',
      location: 'models/handy-computer/parakeet-tdt-0.6b-v3-Q8_0.gguf',
    },
    quantization: { label: 'q8', bits: 8 },
    languagePolicy: AUTOMATIC_LANGUAGE_POLICY,
  },
  {
    id: 'nvidia-gguf-q8',
    label: 'NVIDIA Q8',
    holder: 'NVIDIA',
    artifact: {
      format: 'gguf',
      identity: 'nvidia/parakeet-tdt-0.6b-v3-Q8_0.gguf',
      location: 'models/nvidia/parakeet-tdt-0.6b-v3-Q8_0.gguf',
    },
    quantization: { label: 'q8', bits: 8 },
    languagePolicy: AUTOMATIC_LANGUAGE_POLICY,
  },
  {
    id: 'istupakov-onnx-int8',
    label: 'Istupakov ONNX int8',
    holder: 'Istupakov',
    artifact: {
      format: 'onnx',
      identity: 'istupakov/parakeet-tdt-0.6b-v3-onnx',
      location: 'models/istupakov/parakeet-tdt-0.6b-v3-onnx',
    },
    quantization: { label: 'int8', bits: 8 },
    languagePolicy: AUTOMATIC_LANGUAGE_POLICY,
  },
  {
    id: 'fluid-coreml-mixed',
    label: 'Fluid Core ML',
    holder: 'FluidInference',
    artifact: {
      format: 'coreml',
      identity: 'fluid-inference/parakeet-tdt-0.6b-v3-coreml',
      location: 'models/fluid-coreml/parakeet-tdt-0.6b-v3',
    },
    quantization: { label: 'mixed', encoderPaletteBits: 6, preprocessorOperationBits: 8 },
    languagePolicy: AUTOMATIC_LANGUAGE_POLICY,
  },
]);

module.exports = {
  AUTOMATIC_LANGUAGE_POLICY,
  CACHE_PATHS,
  LANGUAGES,
  MEASURED_PASSES,
  RUNTIME_BENCHMARK_REVISION,
  RUNTIME_BENCHMARK_SCHEMA,
  RUNTIME_DESCRIPTORS,
};
