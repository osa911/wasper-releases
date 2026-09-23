'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const packageRoot = path.resolve(__dirname, '..');

const requiredPaths = [
  'package.json',
  'package-lock.json',
  'bin/benchmark.cjs',
  'src/cli.cjs',
  'src/prepare-corpus.cjs',
  'schema/manifest.schema.json',
  'locks/runtimes.json',
  'corpus/short-fleurs.json',
  'corpus/long-sources.json',
  'src/asr-quality/audio-cache.cjs',
  'src/asr-quality/bounded-file-snapshot.cjs',
  'src/asr-quality/constants.cjs',
  'src/asr-quality/corpus-builder.cjs',
  'src/asr-quality/fixture-id.cjs',
  'src/asr-quality/internal-corpus.cjs',
  'src/asr-quality/long-corpus-preparation.cjs',
  'src/asr-quality/manifest.cjs',
  'src/asr-quality/normalization.cjs',
  'src/asr-quality/prepared-long-corpus.cjs',
  'src/asr-quality/run-corpus.cjs',
  'src/asr-quality/scoring.cjs',
  'src/runtime/activation-evidence.cjs',
  'src/runtime/adapter-protocol.cjs',
  'src/runtime/aggregation.cjs',
  'src/runtime/cache-evidence-state.cjs',
  'src/runtime/constants.cjs',
  'src/runtime/contract.cjs',
  'src/runtime/corpus-manifest.cjs',
  'src/runtime/corpus-path.cjs',
  'src/runtime/corpus-recovery.cjs',
  'src/runtime/evidence-store.cjs',
  'src/runtime/fluid-audio-source.cjs',
  'src/runtime/footprint.cjs',
  'src/runtime/language-policy.cjs',
  'src/runtime/long-audio-chunking.cjs',
  'src/runtime/model-identity.cjs',
  'src/runtime/report.cjs',
  'src/runtime/runner.cjs',
  'src/runtime/runtime-version.cjs',
  'src/runtime/smoke.cjs',
  'src/runtime/timing-summary.cjs',
  'src/runtime/workspace-evidence-profile.cjs',
  'src/runtime/adapters/definition.cjs',
  'src/runtime/adapters/fluid-coreml.cjs',
  'src/runtime/adapters/handy-gguf.cjs',
  'src/runtime/adapters/index.cjs',
  'src/runtime/adapters/istupakov-onnx.cjs',
  'src/runtime/adapters/mlx.cjs',
  'src/runtime/adapters/nvidia-gguf.cjs',
  'src/runtime/adapters/process-client.cjs',
  'src/runtime/adapters/wasper-metal.cjs',
  'src/runtime/bridges/handy_server.py',
  'src/runtime/bridges/istupakov_server.py',
  'src/runtime/bridges/mlx_server.py',
  'src/runtime/bridges/fluid-coreml-server/.gitignore',
  'src/runtime/bridges/fluid-coreml-server/Package.resolved',
  'src/runtime/bridges/fluid-coreml-server/Package.swift',
  'src/runtime/bridges/fluid-coreml-server/Sources/fluid-coreml-server/main.swift',
];

test('the public package contains the complete extracted module set', () => {
  for (const relativePath of requiredPaths) {
    assert.equal(fs.existsSync(path.join(packageRoot, relativePath)), true, relativePath);
  }
});
