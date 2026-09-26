'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { validateAutomaticLanguageCommand } = require('./language-policy.cjs');

const MODEL_IDENTITY_SCHEMA = 'wasper.parakeet-runtime-benchmark.model-identity.v2';
const PRIVATE_MODEL_IDENTITY_EVIDENCE_SCHEMA =
  'wasper.parakeet-runtime-benchmark.private-model-identity-evidence.v2';

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function requireNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function requirePlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function collectVersionEvidence(value, label) {
  requirePlainObject(value, label);
  if (!Array.isArray(value.command) || value.command.length === 0) {
    throw new TypeError(`${label}.command must be a non-empty array`);
  }
  for (const [index, part] of value.command.entries()) {
    requireNonEmptyString(part, `${label}.command[${index}]`);
  }
  requireNonEmptyString(value.rawOutput, `${label}.rawOutput`);
  return {
    command: [...value.command],
    rawOutput: value.rawOutput,
  };
}

function collectSourceEvidence(value, label) {
  requirePlainObject(value, label);
  if (
    value.schema !== 'wasper.parakeet-runtime-benchmark.private-fluid-audio-source.v1' ||
    value.visibility !== 'private-evidence'
  ) {
    throw new TypeError(`${label} must be private FluidAudio source evidence`);
  }
  requireNonEmptyString(value.packagePath, `${label}.packagePath`);
  requireNonEmptyString(value.head, `${label}.head`);
  requireNonEmptyString(value.state, `${label}.state`);
  requireNonEmptyString(value.uncommittedDiffSha256, `${label}.uncommittedDiffSha256`);
  if (typeof value.rawBinaryDiff !== 'string') {
    throw new TypeError(`${label}.rawBinaryDiff must be a string`);
  }
  const observedHash = crypto.createHash('sha256').update(value.rawBinaryDiff).digest('hex');
  if (observedHash !== value.uncommittedDiffSha256) {
    throw new TypeError(`${label} raw binary diff does not match its SHA-256`);
  }
  return structuredClone(value);
}

function collectReleaseIdentity(value) {
  requirePlainObject(value, 'release');
  requireNonEmptyString(value.version, 'release.version');
  if (
    typeof value.nativeServerSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.nativeServerSha256)
  ) {
    throw new TypeError('release.nativeServerSha256 must be a SHA-256 digest');
  }
  if (
    !new Set([
      'published-exact',
      'different-build',
      'older-release',
      'newer-release',
      'local-build',
    ]).has(value.baselineKind)
  ) {
    throw new TypeError('release.baselineKind must identify the measured build');
  }
  if (value.baselineKind === 'local-build' && !/^[a-f0-9]{7}([a-f0-9]{33})?$/u.test(value.buildCommit)) {
    throw new TypeError('release.buildCommit must identify the local source commit');
  }
  return {
    version: value.version,
    nativeServerSha256: value.nativeServerSha256,
    baselineKind: value.baselineKind,
    ...(value.baselineKind === 'local-build' ? { buildCommit: value.buildCommit } : {}),
  };
}

function collectArtifactFiles(artifactPath, files) {
  requireNonEmptyString(artifactPath, 'model artifact path');
  const resolved = path.resolve(artifactPath);
  const info = fs.lstatSync(resolved);
  if (info.isSymbolicLink())
    throw new Error(`model artifact must not be a symbolic link: ${resolved}`);
  if (info.isFile()) {
    files.push(resolved);
    return;
  }
  if (!info.isDirectory())
    throw new Error(`model artifact must be a regular file or directory: ${resolved}`);
  for (const name of fs.readdirSync(resolved).sort())
    collectArtifactFiles(path.join(resolved, name), files);
}

function hashArtifact(filePath) {
  const info = fs.statSync(filePath);
  if (!info.isFile()) throw new Error(`model artifact must be a regular file: ${filePath}`);
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    let offset = 0;
    while (offset < info.size) {
      const bytesRead = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, info.size - offset),
        offset
      );
      if (bytesRead === 0) throw new Error(`model artifact ended before stat size: ${filePath}`);
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    path: filePath,
    bytes: info.size,
    sha256: hash.digest('hex'),
  };
}

function collectModelIdentity({
  artifacts,
  executable,
  packages = [],
  launchCommand,
  release,
} = {}) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    throw new TypeError('model identity requires every consumed artifact');
  }
  requirePlainObject(executable, 'executable');
  requireNonEmptyString(executable.path, 'executable.path');
  requireNonEmptyString(executable.version, 'executable.version');
  const executableVersionEvidence = collectVersionEvidence(
    executable.versionEvidence,
    'executable.versionEvidence'
  );
  if (!Array.isArray(packages)) throw new TypeError('packages must be an array');
  for (const [index, packageIdentity] of packages.entries()) {
    requirePlainObject(packageIdentity, `packages[${index}]`);
    requireNonEmptyString(packageIdentity.name, `packages[${index}].name`);
    requireNonEmptyString(packageIdentity.version, `packages[${index}].version`);
    collectVersionEvidence(packageIdentity.versionEvidence, `packages[${index}].versionEvidence`);
    if (packageIdentity.sourceEvidence !== undefined) {
      collectSourceEvidence(packageIdentity.sourceEvidence, `packages[${index}].sourceEvidence`);
    }
  }
  validateAutomaticLanguageCommand(launchCommand);

  const files = [];
  for (const artifact of artifacts) collectArtifactFiles(artifact, files);
  files.sort();
  if (new Set(files).size !== files.length)
    throw new TypeError('model artifact paths must be unique');

  return deepFreeze({
    schema: MODEL_IDENTITY_SCHEMA,
    artifacts: files.map(hashArtifact),
    executable: {
      path: executable.path,
      version: executable.version,
      versionEvidence: executableVersionEvidence,
    },
    packages: packages.map(packageIdentity => {
      const collected = {
        name: packageIdentity.name,
        version: packageIdentity.version,
        versionEvidence: collectVersionEvidence(
          packageIdentity.versionEvidence,
          `${packageIdentity.name}.versionEvidence`
        ),
      };
      if (packageIdentity.sourceEvidence !== undefined) {
        collected.sourceEvidence = collectSourceEvidence(
          packageIdentity.sourceEvidence,
          `${packageIdentity.name}.sourceEvidence`
        );
      }
      return collected;
    }),
    launchCommand: Array.isArray(launchCommand) ? [...launchCommand] : launchCommand,
    ...(release === undefined ? {} : { release: collectReleaseIdentity(release) }),
  });
}

function modelIdentityHash(identity) {
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function createPrivateModelIdentityEvidence(input) {
  const identity = collectModelIdentity(input);
  return deepFreeze({
    schema: PRIVATE_MODEL_IDENTITY_EVIDENCE_SCHEMA,
    visibility: 'private-evidence',
    identityHash: modelIdentityHash(identity),
    identity,
  });
}

function validatePrivateModelIdentityEvidence(evidence) {
  requirePlainObject(evidence, 'private model identity evidence');
  if (
    evidence.schema !== PRIVATE_MODEL_IDENTITY_EVIDENCE_SCHEMA ||
    evidence.visibility !== 'private-evidence' ||
    typeof evidence.identityHash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(evidence.identityHash)
  ) {
    throw new TypeError('private model identity evidence is invalid');
  }
  requirePlainObject(evidence.identity, 'private model identity evidence.identity');
  if (evidence.identity.schema !== MODEL_IDENTITY_SCHEMA) {
    throw new TypeError('private model identity evidence schema is invalid');
  }
  if (modelIdentityHash(evidence.identity) !== evidence.identityHash) {
    throw new TypeError('private model identity evidence hash does not match its identity');
  }
  return deepFreeze(structuredClone(evidence));
}

function projectPublicModelIdentity(value) {
  const evidence = value?.identity && value?.identityHash ? value : { identity: value };
  const identity = evidence.identity;
  requirePlainObject(identity, 'model identity');
  const projected = {
    schema: identity.schema,
    artifacts: (identity.artifacts ?? []).map(artifact => ({
      bytes: artifact.bytes,
      sha256: artifact.sha256,
    })),
    executable: { version: identity.executable?.version },
    packages: (identity.packages ?? []).map(packageIdentity => ({
      name: packageIdentity.name,
      version: packageIdentity.version,
    })),
  };
  if (identity.release !== undefined) {
    projected.release = {
      version: identity.release.version,
      nativeServerSha256: identity.release.nativeServerSha256,
      baselineKind: identity.release.baselineKind,
      ...(identity.release.buildCommit === undefined
        ? {}
        : { buildCommit: identity.release.buildCommit }),
    };
  }
  return deepFreeze({
    ...(typeof evidence.identityHash === 'string' ? { identityHash: evidence.identityHash } : {}),
    identity: projected,
  });
}

module.exports = {
  MODEL_IDENTITY_SCHEMA,
  PRIVATE_MODEL_IDENTITY_EVIDENCE_SCHEMA,
  collectModelIdentity,
  createPrivateModelIdentityEvidence,
  projectPublicModelIdentity,
  validatePrivateModelIdentityEvidence,
};
