"use strict";

const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");

const execute = promisify(execFile);

function samePaths(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function outputPaths(conversion) {
  return conversion.outputs.map((output) => output.path).sort();
}

function verifyOutput(storage, root, output) {
  const actual = storage.hashFile(path.join(root, output.path));
  if (
    actual.sha256 !== output.sha256 ||
    actual.sizeBytes !== output.sizeBytes
  ) {
    throw new Error(
      `Local MLX INT8 conversion output mismatch: ${output.path}`,
    );
  }
}

function verifyExistingOutputs(storage, artifactRoot, conversion) {
  const expected = outputPaths(conversion);
  const present = expected.filter((output) =>
    fs.existsSync(path.join(artifactRoot, output)),
  );
  if (present.length === 0) return false;
  if (!samePaths(present, expected)) {
    throw new Error("Local MLX INT8 conversion output is incomplete");
  }
  for (const output of conversion.outputs)
    verifyOutput(storage, artifactRoot, output);
  return true;
}

async function executeLocalMlxInt8Conversion({
  script,
  baseArtifactRoot,
  stageRoot,
  bits,
  groupSize,
  python,
  env,
}) {
  try {
    await execute(
      python,
      [
        "-I",
        "-B",
        script,
        "--input-dir",
        baseArtifactRoot,
        "--output-dir",
        stageRoot,
        "--bits",
        String(bits),
        "--group-size",
        String(groupSize),
      ],
      {
        cwd: stageRoot,
        env,
        encoding: "utf8",
        maxBuffer: 64 * 1024,
        timeout: 30 * 60 * 1000,
      },
    );
  } catch (error) {
    throw new Error(
      `Local MLX INT8 conversion failed: ${error.stderr || error.message}`,
      {
        cause: error,
      },
    );
  }
}

function cleanKnownStageOutputs(storage, stageRoot, conversion) {
  for (const output of conversion.outputs) {
    const file = path.join(stageRoot, output.path);
    if (!fs.existsSync(file)) continue;
    storage.track(file);
    storage.remove(file);
  }
  if (fs.readdirSync(stageRoot).length === 0)
    storage.removeDirectory(stageRoot);
}

async function materializeLocalMlxInt8({
  conversion,
  baseArtifactRoot,
  artifactRoot,
  holderRoot,
  storage,
  python,
  env,
  script,
  executeConversion = executeLocalMlxInt8Conversion,
}) {
  if (verifyExistingOutputs(storage, artifactRoot, conversion)) {
    return conversion.outputs.map((output) =>
      path.join(artifactRoot, output.path),
    );
  }
  if (fs.readdirSync(artifactRoot).length !== 0) {
    throw new Error("refusing a nonempty Local MLX INT8 artifact directory");
  }

  const stageRoot = storage.createTempDirectory(holderRoot, "mlx-int8-");
  try {
    await executeConversion({
      script,
      baseArtifactRoot,
      stageRoot,
      bits: conversion.bits,
      groupSize: conversion.groupSize,
      python,
      env,
    });
    storage.directory(stageRoot, false);
    const expected = outputPaths(conversion);
    const produced = fs.readdirSync(stageRoot).sort();
    if (!samePaths(produced, expected)) {
      throw new Error(
        "Local MLX INT8 conversion produced an unexpected artifact set",
      );
    }
    for (const output of conversion.outputs) {
      verifyOutput(storage, stageRoot, output);
      storage.track(path.join(stageRoot, output.path));
    }
    for (const output of conversion.outputs) {
      storage.promote(
        path.join(stageRoot, output.path),
        path.join(artifactRoot, output.path),
      );
    }
    storage.removeDirectory(stageRoot);
  } catch (error) {
    try {
      storage.directory(stageRoot, false);
      cleanKnownStageOutputs(storage, stageRoot, conversion);
    } catch {
      // Keep an unsafe or unexpected staging directory for the guarded cache clean command.
    }
    throw error;
  }
  return conversion.outputs.map((output) =>
    path.join(artifactRoot, output.path),
  );
}

module.exports = { executeLocalMlxInt8Conversion, materializeLocalMlxInt8 };
