'use strict';

const os = require('node:os');
const path = require('node:path');

const { AUTOMATIC_LANGUAGE_POLICY } = require('../constants.cjs');

const DEFAULT_HOLDER_ROOT = '/Users/osa911/Models/wasper-parakeet-tdt-v3-bench';

function roots(options = {}) {
  return {
    repositoryRoot: options.repositoryRoot ?? path.resolve(__dirname, '../../..'),
    holderRoot: options.holderRoot ?? DEFAULT_HOLDER_ROOT,
    homeDirectory: options.homeDirectory ?? os.homedir(),
  };
}

function frozenDefinition(value) {
  const freezeProbe = probe => Object.freeze({ ...probe, args: Object.freeze([...probe.args]) });
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

module.exports = { frozenDefinition, roots };
