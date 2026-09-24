'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { RUNTIME_DESCRIPTORS } = require('./constants.cjs');

const LOCK_PATH = path.resolve(__dirname, '../../locks/runtimes.json');
const readAuthority = () => JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function publicUrl(value) {
  const url = new URL(value);
  const hosts = ['huggingface.co', 'github.com', 'pypi.org', 'files.pythonhosted.org'];
  if (
    url.protocol !== 'https:' ||
    !hosts.includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    /^\/osa911\/wasper(?:\/|\.git|$)/u.test(url.pathname)
  ) {
    throw new Error('runtime lock requires a public HTTPS URL without credentials');
  }
}

function relativePath(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').some(part => part === '..' || !part) ||
    value.split('/').includes('.git')
  )
    throw new Error('unsafe runtime lock relative path');
}

// The checked-in JSON is the authority, not a second hardcoded set of hashes.
// The optional authority is an explicit fixture seam; no CLI accepts one.
function validateRuntimeLock(value, authority = readAuthority()) {
  if (
    value?.schema !== 'wasper.public-runtime-lock.v1' ||
    !isDeepStrictEqual(
      value?.runtimes?.map(runtime => runtime.id),
      RUNTIME_DESCRIPTORS.map(runtime => runtime.id)
    )
  ) {
    throw new Error('runtime lock must contain exactly seven ordered runtime IDs');
  }
  for (const runtime of value.runtimes) {
    if (
      !isDeepStrictEqual(runtime.languagePolicy, { mode: 'automatic', languageHint: null }) ||
      (runtime.id === 'wasper-metal-int8' &&
        !isDeepStrictEqual(runtime.request.formFields, {
          language: 'auto',
          language_detection: 'skip',
        }))
    ) {
      throw new Error('runtime lock requires automatic language with no language hint');
    }
    if (
      runtime.longAudio?.input !== 'complete-recording' ||
      runtime.longAudio.benchmarkChunking !== false
    ) {
      throw new Error('runtime lock forbids benchmark-owned long-audio chunking');
    }
    publicUrl(runtime.model.url);
    if (!/^[a-f0-9]{40}$/u.test(runtime.model.revision))
      throw new Error('invalid model lock revision');
    const paths = new Set();
    for (const artifact of runtime.artifacts) {
      publicUrl(artifact.url);
      relativePath(artifact.path);
      if (
        paths.has(artifact.path) ||
        !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
        !Number.isSafeInteger(artifact.sizeBytes) ||
        artifact.sizeBytes <= 0
      ) {
        throw new Error('invalid or duplicate runtime lock artifact');
      }
      paths.add(artifact.path);
    }
    if (runtime.source) {
      for (const source of [runtime.source, ...runtime.source.submodules]) {
        publicUrl(source.url);
        if (!/^[a-f0-9]{40}$/u.test(source.revision))
          throw new Error('invalid source lock revision');
        if (source.path) relativePath(source.path);
      }
    }
    if (
      !['ready', 'blocked'].includes(runtime.reproduction?.state) ||
      (runtime.reproduction.state === 'blocked' && !runtime.reproduction.limitations.length)
    ) {
      throw new Error('runtime lock must name each reproduction blocker');
    }
    relativePath(runtime.modelFile);
    if (runtime.build.directory) relativePath(runtime.build.directory);
    for (const output of runtime.build.outputs ?? []) relativePath(output);
    for (const pkg of runtime.pythonPackages) publicUrl(pkg.url);
    for (const file of [...(runtime.bridgeFiles ?? []), ...(runtime.build.bridgeFiles ?? [])]) {
      relativePath(file.path);
      if (!/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error('invalid bridge lock SHA-256');
    }
    for (const file of runtime.build.binaryDependencies ?? []) {
      publicUrl(file.url);
      if (!/^[a-f0-9]{64}$/u.test(file.sha256))
        throw new Error('invalid Swift binary dependency SHA-256');
    }
    if (runtime.release) {
      publicUrl(runtime.release.url);
      if (
        runtime.release.version !== '1.8.0' ||
        !/^[a-f0-9]{64}$/u.test(runtime.release.nativeServerSha256) ||
        !/^[a-f0-9]{64}$/u.test(runtime.release.sha256)
      )
        throw new Error('invalid Wasper release lock');
    }
  }
  if (!isDeepStrictEqual(value, authority)) {
    throw new Error('runtime lock differs from locks/runtimes.json authority');
  }
  return deepFreeze(structuredClone(value));
}

function loadRuntimeLock(file = LOCK_PATH) {
  return validateRuntimeLock(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function runtimeFromLock(runtimeId, lock, authority) {
  const validated = validateRuntimeLock(lock, authority);
  const runtime = validated.runtimes.find(entry => entry.id === runtimeId);
  if (!runtime) throw new Error(`unknown runtime: ${runtimeId}`);
  if (runtime.reproduction.state === 'blocked') {
    throw new Error(`${runtime.label} blocked: ${runtime.reproduction.limitations.join(' ')}`);
  }
  return runtime;
}

module.exports = { LOCK_PATH, loadRuntimeLock, validateRuntimeLock, runtimeFromLock };
