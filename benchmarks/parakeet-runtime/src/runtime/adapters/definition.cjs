'use strict';

const { AUTOMATIC_LANGUAGE_POLICY } = require('../constants.cjs');
const { resolveLayout } = require('../../config.cjs');
const path = require('node:path');
const { loadRuntimeLock, runtimeFromLock } = require('../locks.cjs');

function roots(options = {}) {
  const layout = options.layout ?? resolveLayout(options);
  return {
    repositoryRoot: options.repositoryRoot ?? layout.packageRoot,
    holderRoot: layout.holdersRoot,
    homeDirectory: options.homeDirectory ?? layout.homeDirectory,
  };
}

function frozenDefinition(value) {
  const freezeProbe = probe =>
    Object.freeze({ ...probe, args: Object.freeze([...probe.args]) });
  return Object.freeze({
    ...value,
    args: Object.freeze([...value.args]),
    env: Object.freeze({ ...value.env }),
    languagePolicy: AUTOMATIC_LANGUAGE_POLICY,
    modelArtifacts: Object.freeze([...value.modelArtifacts]),
    quantization: Object.freeze({ ...value.quantization }),
    runtime: Object.freeze(structuredClone(value.runtime)),
    versionProbes: Object.freeze({
      executable: freezeProbe(value.versionProbes.executable),
      packages: Object.freeze(value.versionProbes.packages.map(freezeProbe)),
    }),
  });
}

function resolveLockedDefinition(runtimeId, options = {}) {
  const layout = options.layout ?? resolveLayout(options);
  const lock = options.lock ?? options.runtimeLock ?? loadRuntimeLock();
  const entry = runtimeFromLock(runtimeId, lock, options.lockAuthority);
  const holder = path.join(layout.holdersRoot, runtimeId);
  const artifactRoot = path.join(layout.artifactsRoot, runtimeId);
  const modelPath = path.join(artifactRoot, entry.modelFile);
  const python = options.python ?? 'python3';
  const substitutions = {
    holder,
    model: modelPath,
    python,
    bridge: path.join(layout.packageRoot, 'src/runtime/bridges'),
    wasperServer: options.wasperRelease?.nativeServerPath,
  };
  const expand = value =>
    value.replace(/\{([a-zA-Z]+)\}/gu, (_, key) => {
      if (!substitutions[key]) throw new Error(`missing locked runtime path: ${key}`);
      return substitutions[key];
    });
  const command = expand(entry.command);
  const packages = entry.pythonPackages.map(pkg => ({
    name: pkg.name,
    command: python,
    args: [
      '-c',
      'import importlib.metadata,sys; print(importlib.metadata.version(sys.argv[1]))',
      pkg.name,
    ],
    expected: pkg.version,
  }));
  if (entry.source)
    packages.push({
      name: entry.runtime.name,
      command: 'git',
      args: ['-C', holder, 'rev-parse', 'HEAD'],
      expected: entry.source.revision,
    });
  return frozenDefinition({
    id: runtimeId,
    command,
    args: entry.args.map(expand),
    env: {
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONNOUSERSITE: '1',
      HF_HUB_OFFLINE: '1',
      ...Object.fromEntries(
        Object.entries(entry.env).map(([key, value]) => [key, expand(value)])
      ),
    },
    transport: entry.request,
    longAudio: entry.longAudio,
    modelPath,
    modelArtifacts:
      runtimeId === 'wasper-metal-int8'
        ? [modelPath]
        : (entry.conversion?.outputs ?? entry.artifacts).map(artifact =>
            path.join(artifactRoot, artifact.path)
          ),
    modelIdentity: `${entry.model.url}@${entry.model.revision}`,
    quantization: entry.quantization,
    runtime: entry.runtime,
    versionProbes: { executable: { command, args: ['--version'] }, packages },
  });
}

module.exports = { frozenDefinition, roots, resolveLockedDefinition };
