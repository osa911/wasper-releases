'use strict';

const { resolveLockedDefinition } = require('./definition.cjs');

function resolveNvidiaGgufDefinition(options = {}) {
  return resolveLockedDefinition('nvidia-gguf-q8', options);
}

module.exports = { resolveNvidiaGgufDefinition };
