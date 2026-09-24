'use strict';

const { AUTOMATIC_LANGUAGE_POLICY } = require('../constants.cjs');
const { resolveLayout } = require('../../config.cjs');

function roots(options = {}) {
  const layout = options.layout ?? resolveLayout(options);
  return {
    repositoryRoot: options.repositoryRoot ?? layout.packageRoot,
    holderRoot: layout.holdersRoot,
    homeDirectory: options.homeDirectory ?? layout.homeDirectory,
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
