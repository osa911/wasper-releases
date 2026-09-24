'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DIRECT_INT8_ENV = Object.freeze({
  WASPER_PARAKEET_ENCODER_WORKSPACE: '1',
  WASPER_PARAKEET_ENCODER_WORKSPACE_PRIVATE: '1',
  WASPER_PARAKEET_ENCODER_WORKSPACE_LIMIT_MIB: '512',
  WASPER_PARAKEET_INT8: '1',
  WASPER_PARAKEET_FP16: '0',
  WASPER_PARAKEET_PREWARM: '0',
  PARAKEET_DIRECT_INT8_SILU: '1',
  PARAKEET_DIRECT_INT8_FFN: '1',
  PARAKEET_DIRECT_INT8_QKV: '1',
  PARAKEET_DIRECT_INT8_QKV_HEAD_LAYOUT: '1',
  PARAKEET_DIRECT_F16_LAYERNORM: '1',
  PARAKEET_DIRECT_INT8_RESIDUAL: '1',
  PARAKEET_CACHE_POSITION_PROJECTIONS: '1',
  PARAKEET_CACHE_POSITION_HEAD_LAYOUT: '1',
  PARAKEET_FUSED_INT8_POINTWISE_GLU: '1',
  PARAKEET_DIRECT_DEPTHWISE_CONV_BN_SILU: '1',
  WASPER_PARAKEET_HYBRID_METAL_PROGRAM: '0',
  WASPER_PARAKEET_HYBRID_METAL_GRAPH: '0',
  WASPER_PARAKEET_HYBRID_FINAL_READ_REUSE: '0',
});

const PRODUCT_INT8_ENV = Object.freeze({
  WASPER_PARAKEET_INT8: '1',
  WASPER_PARAKEET_FP16: '0',
  WASPER_PARAKEET_ASYNC_PREPROCESS: '1',
  WASPER_PARAKEET_PREWARM: '0',
  AXIOM_DISK_CACHE_DIR: path.join(
    os.homedir(),
    'Library/Application Support/wasper/cache/parakeet-gpu'
  ),
  AXIOM_FORCE_LAZY_LINEAR: '1',
  PARAKEET_CACHE_POSITION_PROJECTIONS: '1',
  WASPER_LID_USE_GPU: '0',
});

const PRODUCT_BASELINE_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-product-baseline-v1',
  execution: 'product',
  runtimeId: 'wasper-metal-int8-product-baseline-experiment',
  runtimeLabel: 'Wasper Parakeet Metal int8 (product baseline experiment)',
  env: PRODUCT_INT8_ENV,
});

const PRODUCT_REFINED_SHORT_BUCKET_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-product-refined-short-bucket-v1',
  execution: 'product',
  runtimeId: 'wasper-metal-int8-product-refined-short-bucket-experiment',
  runtimeLabel: 'Wasper Parakeet Metal int8 (product refined short bucket experiment)',
  env: Object.freeze({
    ...PRODUCT_INT8_ENV,
    WASPER_PARAKEET_REFINED_SHORT_BUCKET: '1',
  }),
});

function createProductPositionCacheProfile(entries) {
  return Object.freeze({
    id: `wasper-metal-int8-product-position-cache-${entries}-v1`,
    execution: 'product',
    runtimeId: `wasper-metal-int8-product-position-cache-${entries}-experiment`,
    runtimeLabel: `Wasper Parakeet Metal int8 (product position cache ${entries} experiment)`,
    cachePolicy: Object.freeze({
      id: `product-position-cache-${entries}`,
      description: `Product route with ${entries} retained relative-position projections per block.`,
      positionProjectionCacheEntries: entries,
    }),
    env: Object.freeze({
      ...PRODUCT_INT8_ENV,
      PARAKEET_POSITION_PROJECTION_CACHE_ENTRIES: String(entries),
    }),
  });
}

function createProductTileInventoryProfile() {
  const positionCacheProfile = createProductPositionCacheProfile(9);
  return Object.freeze({
    ...positionCacheProfile,
    id: 'wasper-metal-int8-product-position-cache-9-tile-profile-v1',
    runtimeId: 'wasper-metal-int8-product-position-cache-9-tile-profile-experiment',
    runtimeLabel: 'Wasper Parakeet Metal int8 (product 9-entry position cache tile inventory)',
    cachePolicy: Object.freeze({
      ...positionCacheProfile.cachePolicy,
      id: 'product-position-cache-9-tile-profile',
      description:
        'Product route with 9 retained relative-position projections and Metal tile inventory counters.',
      metalTileProfile: true,
    }),
    env: Object.freeze({
      ...positionCacheProfile.env,
      AXIOM_METAL_TILE_PROFILE: '1',
    }),
  });
}

const SAFE_DIRECT_MICRO_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-safe-direct-micro-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'safe-direct-micro',
    description: 'Screened direct-Q8 micro-optimization subset with the private workspace cache.',
    highWaterTrim: false,
  }),
  env: Object.freeze({
    ...PRODUCT_INT8_ENV,
    WASPER_PARAKEET_ENCODER_WORKSPACE: '1',
    WASPER_PARAKEET_ENCODER_WORKSPACE_PRIVATE: '1',
    WASPER_PARAKEET_ENCODER_WORKSPACE_LIMIT_MIB: '512',
    WASPER_PARAKEET_ENCODER_WORKSPACE_HIGH_WATER_TRIM: '0',
    PARAKEET_DIRECT_INT8_SILU: '1',
    PARAKEET_DIRECT_INT8_QKV: '1',
    PARAKEET_DIRECT_INT8_QKV_HEAD_LAYOUT: '1',
    PARAKEET_DIRECT_INT8_RESIDUAL: '1',
    PARAKEET_MPSGRAPH_DEPTHWISE_CONVOLUTION: '0',
    PARAKEET_CACHE_POSITION_HEAD_LAYOUT: '1',
    PARAKEET_FUSED_INT8_POINTWISE_GLU: '1',
    WASPER_PARAKEET_HYBRID_METAL_PROGRAM: '0',
    WASPER_PARAKEET_HYBRID_METAL_GRAPH: '0',
    WASPER_PARAKEET_HYBRID_FINAL_READ_REUSE: '0',
  }),
});

function removeProfileFlags(profile, ...keys) {
  const env = { ...profile.env };
  for (const key of keys) {
    delete env[key];
  }
  return Object.freeze(env);
}

function removeSafeDirectFlags(...keys) {
  return removeProfileFlags(SAFE_DIRECT_MICRO_PROFILE, ...keys);
}

const SAFE_DIRECT_MINIMAL_SILU_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-safe-direct-minimal-silu-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'safe-direct-minimal-silu',
    description:
      'Private workspace, direct QKV/layout, direct SiLU, and cached position head-layout tensors.',
    highWaterTrim: false,
  }),
  env: removeSafeDirectFlags('PARAKEET_FUSED_INT8_POINTWISE_GLU', 'PARAKEET_DIRECT_INT8_RESIDUAL'),
});

const SAFE_DIRECT_MINIMAL_NO_WORKSPACE_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-safe-direct-minimal-no-workspace-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'safe-direct-minimal-no-workspace',
    description: 'Minimal Safe Direct without retained encoder-workspace memory.',
    highWaterTrim: false,
  }),
  env: removeProfileFlags(
    SAFE_DIRECT_MINIMAL_SILU_PROFILE,
    'WASPER_PARAKEET_ENCODER_WORKSPACE',
    'WASPER_PARAKEET_ENCODER_WORKSPACE_PRIVATE',
    'WASPER_PARAKEET_ENCODER_WORKSPACE_LIMIT_MIB',
    'WASPER_PARAKEET_ENCODER_WORKSPACE_HIGH_WATER_TRIM'
  ),
});

const SAFE_DIRECT_MINIMAL_BOOST_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-safe-direct-minimal-boost-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'safe-direct-minimal-boost',
    description: 'Minimal Safe Direct with the normal Boost encoder memory mode.',
    highWaterTrim: false,
  }),
  env: SAFE_DIRECT_MINIMAL_SILU_PROFILE.env,
  serverArgs: Object.freeze(['--encoder-memory-mode', 'boost']),
});

const SAFE_DIRECT_DEFERRED_POINTWISE_VIEW_LAB_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-safe-direct-deferred-pointwise-view-lab-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'safe-direct-deferred-pointwise-view-lab',
    description:
      'Safe-direct profile that defers the unreachable pointwise-candidate view; not a shipping profile.',
    highWaterTrim: false,
  }),
  env: Object.freeze({
    ...SAFE_DIRECT_MICRO_PROFILE.env,
    PARAKEET_DEFER_UNREACHABLE_POINTWISE_VIEW: '1',
  }),
});

const SAFE_DIRECT_F16_GLU_LAB_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-safe-direct-f16-glu-lab-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'safe-direct-f16-glu-lab',
    description:
      'Safe-direct profile with a direct FP16 GLU after the established MPSGraph pointwise projection; not a shipping profile.',
    highWaterTrim: false,
  }),
  env: Object.freeze({
    ...SAFE_DIRECT_MICRO_PROFILE.env,
    PARAKEET_DIRECT_F16_GLU: '1',
  }),
});

const SAFE_DIRECT_MPSGRAPH_LEVEL1_LAB_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-safe-direct-mpsgraph-level1-lab-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'safe-direct-mpsgraph-level1-lab',
    description:
      'Safe-direct profile with MPSGraph extended optimization enabled; lab-only pending timing and WER evidence.',
    highWaterTrim: false,
  }),
  env: Object.freeze({
    ...SAFE_DIRECT_MICRO_PROFILE.env,
    PARAKEET_MPSGRAPH_OPTIMIZATION_LEVEL: '1',
  }),
});

const SAFE_DIRECT_DEPTHWISE_CONV_BN_SILU_LAB_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-safe-direct-depthwise-conv-bn-silu-lab-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'safe-direct-depthwise-conv-bn-silu-lab',
    description:
      'Safe-direct profile with the repeated direct depthwise convolution, batch-norm, and SiLU group; lab-only pending full-corpus parity evidence.',
    highWaterTrim: false,
  }),
  env: Object.freeze({
    ...SAFE_DIRECT_MICRO_PROFILE.env,
    PARAKEET_DIRECT_DEPTHWISE_CONV_BN_SILU: '1',
  }),
});

const SAFE_DIRECT_MPSGRAPH_DEPTHWISE_LAB_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-safe-direct-mpsgraph-depthwise-lab-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'safe-direct-mpsgraph-depthwise-lab',
    description:
      'Safe-direct profile using the exact-output-gated MPSGraph depthwise-convolution primitive; lab-only pending latency and corpus evidence.',
    highWaterTrim: false,
  }),
  env: Object.freeze({
    ...SAFE_DIRECT_MICRO_PROFILE.env,
    PARAKEET_MPSGRAPH_DEPTHWISE_CONVOLUTION: '1',
  }),
});

const MPSGRAPH_TOPOLOGY_LAB_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-mpsgraph-topology-lab-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'mpsgraph-topology-lab',
    description: 'MPSGraph-dominant whole-encoder topology control; not a shipping profile.',
    highWaterTrim: false,
  }),
  env: Object.freeze({
    ...PRODUCT_INT8_ENV,
    WASPER_PARAKEET_ENCODER_WORKSPACE: '1',
    WASPER_PARAKEET_ENCODER_WORKSPACE_PRIVATE: '1',
    WASPER_PARAKEET_ENCODER_WORKSPACE_LIMIT_MIB: '512',
    WASPER_PARAKEET_ENCODER_WORKSPACE_HIGH_WATER_TRIM: '0',
    WASPER_PARAKEET_CAPTURE_EXECUTION_SCHEDULE: '1',
    PARAKEET_DIRECT_INT8_SILU: '0',
    PARAKEET_DIRECT_INT8_FFN: '0',
    PARAKEET_DIRECT_INT8_QKV: '0',
    PARAKEET_DIRECT_INT8_QKV_HEAD_LAYOUT: '0',
    PARAKEET_DIRECT_INT8_RESIDUAL: '0',
    PARAKEET_DIRECT_F16_LAYERNORM: '0',
    PARAKEET_DIRECT_F16_GLU: '0',
    PARAKEET_DIRECT_F16_POINTWISE: '0',
    PARAKEET_FUSED_INT8_POINTWISE_GLU: '0',
    PARAKEET_FUSED_F16_POINTWISE_GLU: '0',
    PARAKEET_DIRECT_DEPTHWISE_CONV_BN_SILU: '0',
    PARAKEET_CACHE_POSITION_HEAD_LAYOUT: '0',
    WASPER_PARAKEET_HYBRID_METAL_PROGRAM: '0',
    WASPER_PARAKEET_HYBRID_METAL_GRAPH: '0',
    WASPER_PARAKEET_HYBRID_FINAL_READ_REUSE: '0',
    WASPER_PARAKEET_PLANNED_QKV_PROGRAM: '0',
    WASPER_PARAKEET_SAFE_DIRECT_QKV_PERSISTENT_SLOTS: '0',
    WASPER_PARAKEET_PERSISTENT_BUCKET_SLOTS: '0',
  }),
});

const PERSISTENT_BUCKET_SLOTS_LAB_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-persistent-bucket-slots-lab-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'persistent-bucket-slots-lab',
    description:
      'Hybrid MPSGraph completion-fenced persistent slot-table experiment; not a shipping profile.',
    highWaterTrim: false,
  }),
  env: Object.freeze({
    ...SAFE_DIRECT_MICRO_PROFILE.env,
    PARAKEET_DIRECT_F16_LAYERNORM: '1',
    WASPER_PARAKEET_HYBRID_METAL_PROGRAM: '1',
    WASPER_PARAKEET_HYBRID_METAL_GRAPH: '1',
    WASPER_PARAKEET_PERSISTENT_BUCKET_SLOTS: '1',
  }),
});

const SAFE_DIRECT_QKV_PERSISTENT_SLOTS_LAB_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-safe-direct-qkv-persistent-slots-lab-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'safe-direct-qkv-persistent-slots-lab',
    description: 'Safe-direct QKV persistent-slot ownership experiment; not a shipping profile.',
    highWaterTrim: false,
  }),
  env: Object.freeze({
    ...SAFE_DIRECT_MICRO_PROFILE.env,
    WASPER_PARAKEET_SAFE_DIRECT_QKV_PERSISTENT_SLOTS: '1',
  }),
});

const SAFE_DIRECT_PREBOUND_MPSGRAPH_TENSOR_DATA_LAB_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-safe-direct-prebound-mpsgraph-tensor-data-lab-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'safe-direct-prebound-mpsgraph-tensor-data-lab',
    description:
      'Safe-direct profile with cached MPSGraph tensor-data wrappers for prebound whole-schedule results; lab-only pending latency, memory, and corpus evidence.',
    highWaterTrim: false,
  }),
  env: Object.freeze({
    ...SAFE_DIRECT_MICRO_PROFILE.env,
    WASPER_PARAKEET_CAPTURE_EXECUTION_SCHEDULE: '1',
    WASPER_PARAKEET_WHOLE_SCHEDULE_REPLAY: '1',
    WASPER_PARAKEET_WHOLE_SCHEDULE_STORAGE: '1',
    WASPER_PARAKEET_WHOLE_SCHEDULE_PREBOUND_VIEWS: '1',
    PARAKEET_MPSGRAPH_PREBOUND_TENSOR_DATA: '1',
  }),
});

const SAFE_DIRECT_WHOLE_SCHEDULE_INT8_GEMM_BINDINGS_LAB_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-safe-direct-whole-schedule-int8-gemm-bindings-lab-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'safe-direct-whole-schedule-int8-gemm-bindings-lab',
    description:
      'Safe-direct profile with plan-owned outputs for legacy Q8 GEMMs; lab-only pending exact latency and memory evidence.',
    highWaterTrim: false,
  }),
  env: Object.freeze({
    ...SAFE_DIRECT_MICRO_PROFILE.env,
    WASPER_PARAKEET_CAPTURE_EXECUTION_SCHEDULE: '1',
    WASPER_PARAKEET_WHOLE_SCHEDULE_REPLAY: '1',
    WASPER_PARAKEET_WHOLE_SCHEDULE_STORAGE: '1',
    WASPER_PARAKEET_WHOLE_SCHEDULE_PREBOUND_VIEWS: '1',
    PARAKEET_WHOLE_SCHEDULE_DIRECT_INT8_GEMM: '1',
  }),
});

const PLANNED_QKV_PROGRAM_LAB_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-planned-qkv-program-lab-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'planned-qkv-program-lab',
    description: 'Dedicated lazy fused-QKV ordered-program experiment; not a shipping profile.',
    highWaterTrim: false,
  }),
  env: Object.freeze({
    ...SAFE_DIRECT_MICRO_PROFILE.env,
    WASPER_PARAKEET_PLANNED_QKV_PROGRAM: '1',
  }),
});

const SAFE_DIRECT_QKV_PERSISTENT_SLOTS_GEMM_COALESCING_LAB_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-safe-direct-qkv-persistent-slots-gemm-coalescing-lab-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'safe-direct-qkv-persistent-slots-gemm-coalescing-lab',
    description:
      'Safe-direct QKV profile with opt-in adjacent legacy INT8 GEMM encoder coalescing; not a shipping profile.',
    highWaterTrim: false,
  }),
  env: Object.freeze({
    ...SAFE_DIRECT_QKV_PERSISTENT_SLOTS_LAB_PROFILE.env,
    AXIOM_LEGACY_INT8_GEMM_COALESCING: '1',
  }),
});

const SAFE_DIRECT_QKV_PERSISTENT_SLOTS_3200_LAB_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-safe-direct-qkv-persistent-slots-3200-lab-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'safe-direct-qkv-persistent-slots-3200-lab',
    description:
      'Safe-direct QKV persistent-slot ownership experiment with an explicit 3200-frame table; not a shipping profile.',
    highWaterTrim: false,
  }),
  env: Object.freeze({
    ...SAFE_DIRECT_QKV_PERSISTENT_SLOTS_LAB_PROFILE.env,
    WASPER_PARAKEET_SAFE_DIRECT_QKV_PERSISTENT_SLOTS_3200: '1',
  }),
});

const SAFE_DIRECT_QKV_PERSISTENT_SLOTS_F16_POINTWISE_PROJECTION_LAB_PROFILE = Object.freeze({
  id: 'wasper-metal-int8-safe-direct-qkv-persistent-slots-f16-pointwise-projection-lab-v1',
  execution: 'workspace-direct',
  cachePolicy: Object.freeze({
    id: 'safe-direct-qkv-persistent-slots-f16-pointwise-projection-lab',
    description:
      'Safe-direct QKV profile with the isolated FP16 first-pointwise projection experiment; not a shipping profile.',
    highWaterTrim: false,
  }),
  env: Object.freeze({
    ...SAFE_DIRECT_QKV_PERSISTENT_SLOTS_LAB_PROFILE.env,
    PARAKEET_DIRECT_F16_POINTWISE: '1',
  }),
});

const CACHE_POLICIES = Object.freeze({
  'default-512': Object.freeze({
    id: 'default-512',
    description: 'Bounded 512 MiB retained workspace cache without bucket trimming.',
    highWaterTrim: false,
  }),
  'high-water-512': Object.freeze({
    id: 'high-water-512',
    description:
      'Bounded 512 MiB retained workspace cache that preserves only the largest bucket pool.',
    highWaterTrim: true,
  }),
  'position-cache-3-512': Object.freeze({
    id: 'position-cache-3-512',
    description:
      'Bounded 512 MiB retained workspace cache with three relative-position projections per block.',
    highWaterTrim: false,
    positionProjectionCacheEntries: 3,
  }),
  'position-cache-4-512': Object.freeze({
    id: 'position-cache-4-512',
    description:
      'Bounded 512 MiB retained workspace cache with four relative-position projections per block.',
    highWaterTrim: false,
    positionProjectionCacheEntries: 4,
  }),
  'position-cache-5-512': Object.freeze({
    id: 'position-cache-5-512',
    description:
      'Bounded 512 MiB retained workspace cache with five relative-position projections per block.',
    highWaterTrim: false,
    positionProjectionCacheEntries: 5,
  }),
  'position-cache-9-512': Object.freeze({
    id: 'position-cache-9-512',
    description:
      'Bounded 512 MiB retained workspace cache with all nine relative-position projections per block.',
    highWaterTrim: false,
    positionProjectionCacheEntries: 9,
  }),
  'int8-position-projection-512': Object.freeze({
    id: 'int8-position-projection-512',
    description:
      'Bounded 512 MiB retained workspace cache with experimental int8 relative-position projections.',
    highWaterTrim: false,
    int8PositionProjections: true,
  }),
});

function resolveWorkspaceEvidenceProfile(value = 'default-512') {
  if (value === 'product-baseline') {
    return PRODUCT_BASELINE_PROFILE;
  }
  if (value === 'product-refined-short-bucket') {
    return PRODUCT_REFINED_SHORT_BUCKET_PROFILE;
  }
  const productPositionCacheMatch = /^product-position-cache-([3459])$/u.exec(value);
  if (productPositionCacheMatch) {
    return createProductPositionCacheProfile(Number(productPositionCacheMatch[1]));
  }
  if (value === 'product-position-cache-9-tile-profile') {
    return createProductTileInventoryProfile();
  }
  if (value === 'safe-direct-micro') {
    return SAFE_DIRECT_MICRO_PROFILE;
  }
  if (value === 'safe-direct-minimal-silu') {
    return SAFE_DIRECT_MINIMAL_SILU_PROFILE;
  }
  if (value === 'safe-direct-minimal-no-workspace') {
    return SAFE_DIRECT_MINIMAL_NO_WORKSPACE_PROFILE;
  }
  if (value === 'safe-direct-minimal-boost') {
    return SAFE_DIRECT_MINIMAL_BOOST_PROFILE;
  }
  if (value === 'safe-direct-deferred-pointwise-view-lab') {
    return SAFE_DIRECT_DEFERRED_POINTWISE_VIEW_LAB_PROFILE;
  }
  if (value === 'safe-direct-f16-glu-lab') {
    return SAFE_DIRECT_F16_GLU_LAB_PROFILE;
  }
  if (value === 'safe-direct-mpsgraph-level1-lab') {
    return SAFE_DIRECT_MPSGRAPH_LEVEL1_LAB_PROFILE;
  }
  if (value === 'safe-direct-depthwise-conv-bn-silu-lab') {
    return SAFE_DIRECT_DEPTHWISE_CONV_BN_SILU_LAB_PROFILE;
  }
  if (value === 'safe-direct-mpsgraph-depthwise-lab') {
    return SAFE_DIRECT_MPSGRAPH_DEPTHWISE_LAB_PROFILE;
  }
  if (value === 'mpsgraph-topology-lab') {
    return MPSGRAPH_TOPOLOGY_LAB_PROFILE;
  }
  if (value === 'persistent-bucket-slots-lab') {
    return PERSISTENT_BUCKET_SLOTS_LAB_PROFILE;
  }
  if (value === 'safe-direct-qkv-persistent-slots-lab') {
    return SAFE_DIRECT_QKV_PERSISTENT_SLOTS_LAB_PROFILE;
  }
  if (value === 'safe-direct-prebound-mpsgraph-tensor-data-lab') {
    return SAFE_DIRECT_PREBOUND_MPSGRAPH_TENSOR_DATA_LAB_PROFILE;
  }
  if (value === 'safe-direct-whole-schedule-int8-gemm-bindings-lab') {
    return SAFE_DIRECT_WHOLE_SCHEDULE_INT8_GEMM_BINDINGS_LAB_PROFILE;
  }
  if (value === 'planned-qkv-program-lab') {
    return PLANNED_QKV_PROGRAM_LAB_PROFILE;
  }
  if (value === 'safe-direct-qkv-persistent-slots-gemm-coalescing-lab') {
    return SAFE_DIRECT_QKV_PERSISTENT_SLOTS_GEMM_COALESCING_LAB_PROFILE;
  }
  if (value === 'safe-direct-qkv-persistent-slots-3200-lab') {
    return SAFE_DIRECT_QKV_PERSISTENT_SLOTS_3200_LAB_PROFILE;
  }
  if (value === 'safe-direct-qkv-persistent-slots-f16-pointwise-projection-lab') {
    return SAFE_DIRECT_QKV_PERSISTENT_SLOTS_F16_POINTWISE_PROJECTION_LAB_PROFILE;
  }
  const cachePolicy = CACHE_POLICIES[value];
  if (!cachePolicy) {
    throw new Error(`unsupported WASPER_WORKSPACE_EVIDENCE_PROFILE: ${String(value)}`);
  }
  return Object.freeze({
    id: `wasper-metal-int8-private-workspace-${cachePolicy.id}-v1`,
    execution: 'workspace-direct',
    cachePolicy,
    env: Object.freeze({
      ...DIRECT_INT8_ENV,
      WASPER_PARAKEET_ENCODER_WORKSPACE_HIGH_WATER_TRIM: cachePolicy.highWaterTrim ? '1' : '0',
      ...(cachePolicy.positionProjectionCacheEntries
        ? {
            PARAKEET_POSITION_PROJECTION_CACHE_ENTRIES: String(
              cachePolicy.positionProjectionCacheEntries
            ),
          }
        : {}),
      ...(cachePolicy.int8PositionProjections ? { PARAKEET_INT8_POSITION_PROJECTIONS: '1' } : {}),
    }),
  });
}

function resolveWorkspaceEvidenceModel({ environment = process.env, homeDirectory } = {}) {
  const override = environment.WASPER_SINGLE_RUNTIME_MODEL_DIR?.trim();
  const modelPath = path.resolve(
    override ?? path.join(homeDirectory, 'Library/Application Support/wasper/models/parakeet-gpu')
  );
  let stat;
  try {
    stat = fs.statSync(modelPath);
  } catch {
    const setting = override ? 'WASPER_SINGLE_RUNTIME_MODEL_DIR' : 'the default model path';
    throw new Error(`${setting} must name an existing model directory: ${modelPath}`);
  }
  if (!stat.isDirectory()) {
    const setting = override ? 'WASPER_SINGLE_RUNTIME_MODEL_DIR' : 'the default model path';
    throw new Error(`${setting} must name a model directory: ${modelPath}`);
  }
  return Object.freeze({ modelPath, source: override ? 'explicit' : 'default' });
}

module.exports = {
  resolveWorkspaceEvidenceModel,
  resolveWorkspaceEvidenceProfile,
};
