'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');

const FLUID_AUDIO_PACKAGE_PATH =
  '/Users/osa911/Library/Developer/Xcode/DerivedData/Fluid-aqilhnudwldgeqahjvopdeclcbti/SourcePackages/checkouts/FluidAudio';
const FLUID_AUDIO_SOURCE_IDENTITY = Object.freeze({
  head: 'edee7154e66d2196be896580c6c26ff81c2c528e',
  state: 'dirty',
  uncommittedDiffSha256: '4cc60500448dafbf7b292a5de456381e8a2ee9223c0e8cbc5137e048aa389a19',
});
const GIT = '/usr/bin/git';

function runGit(args, spawnSyncImpl) {
  const result = spawnSyncImpl(GIT, ['-C', FLUID_AUDIO_PACKAGE_PATH, ...args], {
    encoding: null,
  });
  if (result?.error) throw result.error;
  if (result?.signal) throw new Error(`FluidAudio git ${args[0]} exited from ${result.signal}`);
  if (result?.status !== 0) {
    const detail = Buffer.concat([
      result?.stdout ?? Buffer.alloc(0),
      result?.stderr ?? Buffer.alloc(0),
    ])
      .toString('utf8')
      .trim();
    throw new Error(
      `FluidAudio git ${args[0]} failed with status ${String(result?.status)}${detail ? `: ${detail}` : ''}`
    );
  }
  return Buffer.from(result?.stdout ?? Buffer.alloc(0));
}

function assertFluidAudioSourceIdentity(evidence) {
  if (evidence.head !== FLUID_AUDIO_SOURCE_IDENTITY.head) {
    throw new Error(
      `FluidAudio HEAD mismatch: found ${evidence.head}; expected ${FLUID_AUDIO_SOURCE_IDENTITY.head}`
    );
  }
  if (evidence.state !== FLUID_AUDIO_SOURCE_IDENTITY.state) {
    throw new Error(
      `FluidAudio source state mismatch: found ${evidence.state}; expected ${FLUID_AUDIO_SOURCE_IDENTITY.state}`
    );
  }
  if (evidence.uncommittedDiffSha256 !== FLUID_AUDIO_SOURCE_IDENTITY.uncommittedDiffSha256) {
    throw new Error(
      `FluidAudio diff SHA-256 mismatch: found ${evidence.uncommittedDiffSha256}; expected ${FLUID_AUDIO_SOURCE_IDENTITY.uncommittedDiffSha256}`
    );
  }
}

function collectFluidAudioSourceEvidence({ spawnSyncImpl = childProcess.spawnSync } = {}) {
  const headOutput = runGit(['rev-parse', 'HEAD'], spawnSyncImpl);
  const diffOutput = runGit(
    ['diff', '--binary', '--no-ext-diff', '--no-textconv', 'HEAD', '--'],
    spawnSyncImpl
  );
  const evidence = {
    schema: 'wasper.parakeet-runtime-benchmark.private-fluid-audio-source.v1',
    visibility: 'private-evidence',
    packagePath: FLUID_AUDIO_PACKAGE_PATH,
    head: headOutput.toString('utf8').trim(),
    state: diffOutput.length === 0 ? 'clean' : 'dirty',
    uncommittedDiffSha256: crypto.createHash('sha256').update(diffOutput).digest('hex'),
    rawBinaryDiff: diffOutput.toString('utf8'),
  };
  assertFluidAudioSourceIdentity(evidence);
  return Object.freeze(evidence);
}

module.exports = {
  FLUID_AUDIO_PACKAGE_PATH,
  FLUID_AUDIO_SOURCE_IDENTITY,
  assertFluidAudioSourceIdentity,
  collectFluidAudioSourceEvidence,
};
