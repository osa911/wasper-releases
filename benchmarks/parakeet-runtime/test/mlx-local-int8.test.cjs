"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { resolveLayout } = require("../src/config.cjs");
const {
  materializeLocalMlxInt8,
} = require("../src/runtime/mlx-local-int8.cjs");
const {
  ownedRuntimeStorage,
} = require("../src/runtime/owned-runtime-storage.cjs");

const artifact = (name, contents) => ({
  path: name,
  sha256: crypto.createHash("sha256").update(contents).digest("hex"),
  sizeBytes: Buffer.byteLength(contents),
});

test("materializes the locked Local MLX derivative from the locked base model", async (t) => {
  const homeDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "mlx-int8-local-")),
  );
  t.after(() => fs.rmSync(homeDirectory, { recursive: true, force: true }));
  const layout = resolveLayout({ homeDirectory });
  const storage = ownedRuntimeStorage(layout);
  const baseArtifactRoot = storage.directory(
    path.join(layout.artifactsRoot, "mlx-fp32"),
  );
  const artifactRoot = storage.directory(
    path.join(layout.artifactsRoot, "mlx-int8-local"),
  );
  const holderRoot = storage.directory(
    path.join(layout.holdersRoot, "mlx-int8-local"),
  );
  const baseFiles = {
    "config.json": '{"base":true}\n',
    "model.safetensors": "fp32-weights\n",
    "vocab.txt": "vocabulary\n",
  };
  for (const [name, contents] of Object.entries(baseFiles)) {
    storage.writeExclusive(path.join(baseArtifactRoot, name), contents);
  }

  const expectedFiles = {
    "config.json": '{"quantization":{"bits":8,"group_size":64}}\n',
    "model.safetensors": "int8-weights\n",
    "vocab.txt": baseFiles["vocab.txt"],
  };
  const conversion = {
    state: "ready",
    baseRuntimeId: "mlx-fp32",
    bits: 8,
    groupSize: 64,
    script: {
      path: "src/runtime/convert-local-mlx-int8.py",
      sha256: "a".repeat(64),
    },
    outputs: Object.entries(expectedFiles).map(([name, contents]) =>
      artifact(name, contents),
    ),
  };
  const calls = [];

  await materializeLocalMlxInt8({
    conversion,
    baseArtifactRoot,
    artifactRoot,
    holderRoot,
    storage,
    python: "/selected/python",
    executeConversion: async (request) => {
      calls.push(request);
      assert.equal(request.baseArtifactRoot, baseArtifactRoot);
      assert.equal(request.bits, 8);
      assert.equal(request.groupSize, 64);
      for (const [name, contents] of Object.entries(expectedFiles)) {
        fs.writeFileSync(path.join(request.stageRoot, name), contents);
      }
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(
    fs.readdirSync(artifactRoot).sort(),
    Object.keys(expectedFiles).sort(),
  );
  for (const [name, contents] of Object.entries(expectedFiles)) {
    assert.equal(
      fs.readFileSync(path.join(artifactRoot, name), "utf8"),
      contents,
    );
  }
  assert.deepEqual(fs.readdirSync(holderRoot), []);
});
