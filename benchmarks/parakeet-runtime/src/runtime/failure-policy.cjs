'use strict';

function describeError(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    code: typeof error?.code === 'string' ? error.code : null,
    ...(typeof error?.operation === 'string' ? { operation: error.operation } : {}),
  };
}

function stopsBenchmark(error) {
  const visited = new Set();
  for (let current = error; current && !visited.has(current); current = current.cause) {
    visited.add(current);
    if (
      current.operation === 'shutdown' ||
      ['EVIDENCE_WRITE_FAILED', 'ENOSPC', 'EDQUOT', 'EIO'].includes(current.code)
    )
      return true;
  }
  return false;
}

module.exports = { describeError, stopsBenchmark };
