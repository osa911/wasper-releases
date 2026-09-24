'use strict';

const { loadRuntimeLock } = require('./locks.cjs');

// Public metadata only. No local checkout, diff, or private source is an input.
function fluidAudioSourceIdentity(lock = loadRuntimeLock()) {
  const source = lock.runtimes.find(runtime => runtime.id === 'fluid-coreml-mixed').source;
  return Object.freeze({ head: source.revision, state: 'clean', url: source.url });
}

module.exports = { fluidAudioSourceIdentity };
