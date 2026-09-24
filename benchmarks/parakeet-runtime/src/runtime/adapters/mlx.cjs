'use strict';

const { resolveLockedDefinition } = require('./definition.cjs');

function resolveMlxDefinition(runtimeId, options = {}) {
  if (!['mlx-fp32', 'mlx-int8-local'].includes(runtimeId))
    throw new Error(`unknown MLX runtime: ${runtimeId}`);
  return resolveLockedDefinition(runtimeId, options);
}

module.exports = { resolveMlxDefinition };
