'use strict';

const { resolveLockedDefinition } = require('./definition.cjs');

function resolveHandyGgufDefinition(options = {}) {
  return resolveLockedDefinition('handy-gguf-q8', options);
}

module.exports = { resolveHandyGgufDefinition };
