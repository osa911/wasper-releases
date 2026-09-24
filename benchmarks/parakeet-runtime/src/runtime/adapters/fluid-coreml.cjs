'use strict';

const { resolveLockedDefinition } = require('./definition.cjs');

function resolveFluidCoreMlDefinition(options = {}) {
  return resolveLockedDefinition('fluid-coreml-mixed', options);
}

module.exports = { resolveFluidCoreMlDefinition };
