'use strict';

const childProcess = require('node:child_process');

const VERSION_PROBE_TIMEOUT_MS = 5_000;

function requireProbe(probe, label) {
  if (probe === null || typeof probe !== 'object' || Array.isArray(probe)) {
    throw new TypeError(`${label} must be an object`);
  }
  if (typeof probe.command !== 'string' || probe.command.trim() === '') {
    throw new TypeError(`${label}.command must be a non-empty string`);
  }
  if (!Array.isArray(probe.args) || probe.args.some(value => typeof value !== 'string')) {
    throw new TypeError(`${label}.args must be an array of strings`);
  }
}

function runVersionProbe(
  probe,
  { env, spawnSyncImpl = childProcess.spawnSync, label = 'version probe' }
) {
  requireProbe(probe, label);
  const result = spawnSyncImpl(probe.command, probe.args, {
    encoding: 'utf8',
    env,
    timeout: VERSION_PROBE_TIMEOUT_MS,
  });
  if (result?.error?.code === 'ETIMEDOUT') throw new Error(`${label} timed out`);
  if (result?.signal) throw new Error(`${label} exited from signal ${result.signal}`);
  if (result?.status !== 0) {
    const detail = `${result?.stdout ?? ''}${result?.stderr ?? ''}`.trim();
    throw new Error(
      `${label} failed with status ${String(result?.status)}${detail ? `: ${detail}` : ''}`
    );
  }
  const rawOutput = `${result?.stdout ?? ''}${result?.stderr ?? ''}`;
  const version = rawOutput.trim();
  if (version === '') throw new Error(`${label} returned empty version output`);
  if (probe.expected !== undefined && version !== probe.expected) {
    throw new Error(`${label} returned ${version}; expected ${probe.expected}`);
  }
  return {
    version,
    versionEvidence: {
      command: [probe.command, ...probe.args],
      rawOutput,
    },
  };
}

function collectRuntimeVersionEvidence(
  definition,
  { spawnSyncImpl = childProcess.spawnSync, environment = process.env } = {}
) {
  if (definition === null || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new TypeError('runtime definition must be an object');
  }
  if (
    definition.versionProbes === null ||
    typeof definition.versionProbes !== 'object' ||
    Array.isArray(definition.versionProbes)
  ) {
    throw new TypeError('runtime definition must include versionProbes');
  }
  const env = { ...environment, ...definition.env };
  const executable = runVersionProbe(definition.versionProbes.executable, {
    env,
    spawnSyncImpl,
    label: `${definition.id ?? definition.command} executable version probe`,
  });
  const packageProbes = definition.versionProbes.packages ?? [];
  if (!Array.isArray(packageProbes)) {
    throw new TypeError('runtime definition versionProbes.packages must be an array');
  }
  return {
    executable: { path: definition.command, ...executable },
    packages: packageProbes.map((probe, index) => {
      if (typeof probe?.name !== 'string' || probe.name.trim() === '') {
        throw new TypeError(
          `runtime package version probe ${index}.name must be a non-empty string`
        );
      }
      const packageIdentity = {
        name: probe.name,
        ...runVersionProbe(probe, {
          env,
          spawnSyncImpl,
          label: `${probe.name} package version probe`,
        }),
      };
      if (typeof probe.collectSourceEvidence === 'function') {
        packageIdentity.sourceEvidence = probe.collectSourceEvidence();
      }
      return packageIdentity;
    }),
  };
}

module.exports = {
  VERSION_PROBE_TIMEOUT_MS,
  collectRuntimeVersionEvidence,
  runVersionProbe,
};
