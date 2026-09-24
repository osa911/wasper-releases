const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { characterUnits, wordUnits } = require('./normalization.cjs');

const DURATION_TOLERANCE_SECONDS = 0.05;
const MEBIBYTE = 1024 ** 2;
const REFERENCE_MAX_BYTES = MEBIBYTE;
const SOURCE_DOWNLOAD_POLICY = Object.freeze({
  timeoutMs: 60_000,
  minimumBytes: MEBIBYTE,
  bytesPerSecond: 2 * MEBIBYTE,
  maximumBytes: 1024 * MEBIBYTE,
});
const MEDIA_PROCESS_POLICY = Object.freeze({
  probeTimeoutMs: 30_000,
  conversionMinimumTimeoutMs: 2 * 60_000,
  conversionTimeoutMsPerSourceSecond: 5_000,
  conversionMaximumTimeoutMs: 60 * 60_000,
  stdoutMaxBytes: MEBIBYTE,
  stderrMaxBytes: 64 * 1024,
  terminationGraceMs: 2_000,
  killGraceMs: 1_000,
});
const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const REPOSITORY_CACHE_ROOT = path.join(REPOSITORY_ROOT, '.wasper-benchmark-cache');
const GIT_REPOSITORY_LOCAL_ENVIRONMENT_VARIABLES = Object.freeze([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
]);
const NORMALIZED_AUDIO_TRANSFORM = Object.freeze({
  wholeRecording: true,
  sampleRateHz: 16000,
  channels: 1,
  codec: 'pcm_s16le',
  tool: 'ffmpeg',
  arguments: Object.freeze([
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    '{sourcePath}',
    '-map_metadata',
    '-1',
    '-vn',
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    '{temporaryWavPath}',
  ]),
});
const CONVERSION_CONTRACT = NORMALIZED_AUDIO_TRANSFORM.arguments;

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest('hex');
}

function mediaProcessError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isTerminalMediaProcessError(error) {
  return (
    error?.code === 'MEDIA_PROCESS_ABORTED' ||
    error?.code === 'MEDIA_PROCESS_TIMEOUT' ||
    error?.code === 'MEDIA_PROCESS_OUTPUT_LIMIT' ||
    error?.code === 'MEDIA_PROCESS_TERMINATION_FAILED'
  );
}

function normalizedMediaProcessPolicy(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('mediaProcessPolicy must be an object when provided');
  }
  const policy = { ...MEDIA_PROCESS_POLICY, ...overrides };
  for (const name of Object.keys(MEDIA_PROCESS_POLICY)) {
    if (!Number.isSafeInteger(policy[name]) || policy[name] <= 0) {
      throw new TypeError(`mediaProcessPolicy.${name} must be a positive safe integer`);
    }
  }
  if (policy.conversionMinimumTimeoutMs > policy.conversionMaximumTimeoutMs) {
    throw new TypeError(
      'mediaProcessPolicy conversion minimum must not exceed its maximum timeout'
    );
  }
  return Object.freeze(policy);
}

function conversionTimeout(fixture, policy) {
  return Math.min(
    policy.conversionMaximumTimeoutMs,
    Math.max(
      policy.conversionMinimumTimeoutMs,
      Math.ceil(fixture.source.durationSeconds * policy.conversionTimeoutMsPerSourceSecond)
    )
  );
}

function runProcess(
  command,
  arguments_,
  {
    spawnImpl,
    signal,
    stderrMaxBytes,
    stdoutMaxBytes,
    timeoutMs,
    timer,
    terminationGraceMs,
    killGraceMs,
  }
) {
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    return Promise.reject(
      new TypeError('media process signal must be an AbortSignal when provided')
    );
  }
  if (signal?.aborted) {
    return Promise.reject(
      mediaProcessError(`${command} aborted by caller`, 'MEDIA_PROCESS_ABORTED')
    );
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(command, arguments_, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminating = false;
    let terminationReason;
    let deadlineTimer;
    let terminationTimer;
    let killTimer;

    const removeListener = (emitter, name, listener) => {
      if (typeof emitter?.removeListener === 'function') emitter.removeListener(name, listener);
    };
    const cleanup = () => {
      timer.clearTimeout(deadlineTimer);
      timer.clearTimeout(terminationTimer);
      timer.clearTimeout(killTimer);
      if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      removeListener(child.stdout, 'data', onStdout);
      removeListener(child.stderr, 'data', onStderr);
      removeListener(child, 'error', onError);
      removeListener(child, 'close', onClose);
    };
    const settle = (operation, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      operation(value);
    };
    const terminate = reason => {
      if (settled || terminating) return;
      terminating = true;
      terminationReason = reason;
      removeListener(child.stdout, 'data', onStdout);
      removeListener(child.stderr, 'data', onStderr);
      timer.clearTimeout(deadlineTimer);
      try {
        if (typeof child.kill !== 'function') {
          throw new Error('spawned child does not expose kill()');
        }
        child.kill('SIGTERM');
      } catch (error) {
        settle(
          reject,
          mediaProcessError(
            `${reason.message}; failed to send SIGTERM: ${error.message}`,
            'MEDIA_PROCESS_TERMINATION_FAILED'
          )
        );
        return;
      }
      if (settled) return;
      terminationTimer = timer.setTimeout(() => {
        if (settled) return;
        try {
          child.kill('SIGKILL');
        } catch (error) {
          settle(
            reject,
            mediaProcessError(
              `${reason.message}; failed to send SIGKILL: ${error.message}`,
              'MEDIA_PROCESS_TERMINATION_FAILED'
            )
          );
          return;
        }
        if (settled) return;
        killTimer = timer.setTimeout(() => {
          settle(
            reject,
            mediaProcessError(
              `${reason.message}; process did not close after SIGKILL`,
              'MEDIA_PROCESS_TERMINATION_FAILED'
            )
          );
        }, killGraceMs);
        killTimer?.unref?.();
      }, terminationGraceMs);
      terminationTimer?.unref?.();
    };
    const capture = (chunk, stream, chunks, currentBytes, maximumBytes) => {
      let bytes;
      try {
        bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      } catch {
        terminate(
          mediaProcessError(
            `${command} ${stream} produced a non-byte chunk`,
            'MEDIA_PROCESS_OUTPUT_LIMIT'
          )
        );
        return currentBytes;
      }
      if (bytes.length > maximumBytes - currentBytes) {
        terminate(
          mediaProcessError(
            `${command} ${stream} exceeded the ${maximumBytes}-byte limit`,
            'MEDIA_PROCESS_OUTPUT_LIMIT'
          )
        );
        return currentBytes;
      }
      chunks.push(bytes);
      return currentBytes + bytes.length;
    };
    function onStdout(chunk) {
      stdoutBytes = capture(chunk, 'stdout', stdoutChunks, stdoutBytes, stdoutMaxBytes);
    }
    function onStderr(chunk) {
      stderrBytes = capture(chunk, 'stderr', stderrChunks, stderrBytes, stderrMaxBytes);
    }
    function onAbort() {
      terminate(mediaProcessError(`${command} aborted by caller`, 'MEDIA_PROCESS_ABORTED'));
    }
    function onError(error) {
      if (terminating) {
        settle(reject, terminationReason);
        return;
      }
      settle(reject, error);
    }
    function onClose(code) {
      if (terminating) {
        settle(reject, terminationReason);
        return;
      }
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8');
      if (code === 0) {
        settle(resolve, stdout);
        return;
      }
      const stderr = Buffer.concat(stderrChunks, stderrBytes).toString('utf8').trim();
      settle(
        reject,
        new Error(`${command} exited with ${String(code)}${stderr === '' ? '' : `: ${stderr}`}`)
      );
    }

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('error', onError);
    child.once('close', onClose);
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    deadlineTimer = timer.setTimeout(() => {
      terminate(
        mediaProcessError(`${command} timed out after ${timeoutMs} ms`, 'MEDIA_PROCESS_TIMEOUT')
      );
    }, timeoutMs);
    deadlineTimer?.unref?.();
  });
}

async function inspectAudio(
  audioPath,
  {
    mediaProcessPolicy = MEDIA_PROCESS_POLICY,
    signal,
    spawnImpl = childProcess.spawn,
    timer = { setTimeout, clearTimeout },
  } = {}
) {
  const policy = normalizedMediaProcessPolicy(mediaProcessPolicy);
  const output = await runProcess(
    'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=duration:stream=codec_name,codec_type,sample_rate,channels',
      '-of',
      'json',
      audioPath,
    ],
    {
      spawnImpl,
      signal,
      stderrMaxBytes: policy.stderrMaxBytes,
      stdoutMaxBytes: policy.stdoutMaxBytes,
      timeoutMs: policy.probeTimeoutMs,
      timer,
      terminationGraceMs: policy.terminationGraceMs,
      killGraceMs: policy.killGraceMs,
    }
  );
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(`ffprobe returned invalid JSON for ${audioPath}: ${error.message}`);
  }
  const audioStream = parsed.streams?.find(stream => stream.codec_type === 'audio');
  const durationSeconds = Number(parsed.format?.duration);
  const sampleRateHz = Number(audioStream?.sample_rate);
  const channels = Number(audioStream?.channels);
  const codec = audioStream?.codec_name;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`ffprobe did not report a positive duration for ${audioPath}`);
  }
  if (
    !Number.isInteger(sampleRateHz) ||
    sampleRateHz <= 0 ||
    !Number.isInteger(channels) ||
    channels <= 0
  ) {
    throw new Error(`ffprobe did not report valid audio stream details for ${audioPath}`);
  }
  if (typeof codec !== 'string' || codec === '') {
    throw new Error(`ffprobe did not report an audio codec for ${audioPath}`);
  }
  return { durationSeconds, sampleRateHz, channels, codec };
}

function cacheIdentity(sourceSha256) {
  return crypto
    .createHash('sha256')
    .update(sourceSha256, 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify(CONVERSION_CONTRACT), 'utf8')
    .digest('hex');
}

function isWithin(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}

function resolveThroughExistingAncestors(candidate) {
  const missingSegments = [];
  let existingAncestor = path.resolve(candidate);
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error(`Unable to resolve cache root ${candidate}`);
    }
    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }
  return path.join(fs.realpathSync.native(existingAncestor), ...missingSegments);
}

function nearestExistingDirectory(candidate) {
  let existingAncestor = path.resolve(candidate);
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      throw new Error(`Unable to inspect cache root ${candidate}`);
    }
    existingAncestor = parent;
  }
  if (!fs.statSync(existingAncestor).isDirectory()) {
    existingAncestor = path.dirname(existingAncestor);
  }
  return existingAncestor;
}

function gitProbeEnvironment() {
  const environment = { ...process.env, LC_ALL: 'C' };
  for (const name of GIT_REPOSITORY_LOCAL_ENVIRONMENT_VARIABLES) {
    delete environment[name];
  }
  return environment;
}

function gitRepositoryKindAt(directory) {
  const result = childProcess.spawnSync(
    'git',
    ['-C', directory, 'rev-parse', '--is-inside-work-tree', '--is-bare-repository'],
    {
      encoding: 'utf8',
      env: gitProbeEnvironment(),
      shell: false,
    }
  );
  if (result.error) {
    throw new Error(`Unable to inspect cache Git containment: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status === 0) {
    const [insideWorktree, bareRepository] = result.stdout.trim().split(/\s+/u);
    if (insideWorktree === 'true') return 'Git worktree';
    if (bareRepository === 'true') return 'Git repository';
    return 'Git repository';
  }
  if (/not a git repository/iu.test(result.stderr)) return null;
  throw new Error(
    `Unable to inspect cache Git containment: git exited with ${String(result.status)}${
      result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`
    }`
  );
}

function lexicalSymlinkParents(candidate) {
  const absolute = path.resolve(candidate);
  const root = path.parse(absolute).root;
  let current = root;
  const parents = [];
  for (const segment of path.relative(root, absolute).split(path.sep)) {
    if (segment === '') continue;
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) break;
    if (stat.isSymbolicLink()) parents.push(path.dirname(current));
  }
  return parents;
}

function gitRepositoryKind(candidate) {
  const probes = [nearestExistingDirectory(candidate), ...lexicalSymlinkParents(candidate)].filter(
    (directory, index, directories) => directories.indexOf(directory) === index
  );
  for (const directory of probes) {
    const repositoryKind = gitRepositoryKindAt(directory);
    if (repositoryKind !== null) return repositoryKind;
  }
  return null;
}

function isIgnoredByRepository(candidate, repositoryRoot) {
  const ignoreProbe = path.join(candidate, '.wasper-cache-ignore-probe');
  const result = childProcess.spawnSync(
    'git',
    ['-C', repositoryRoot, 'check-ignore', '--quiet', '--', ignoreProbe],
    {
      encoding: 'utf8',
      env: gitProbeEnvironment(),
      shell: false,
    }
  );
  if (result.error) {
    throw new Error(`Unable to verify the dedicated cache ignore rule: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(
    `Unable to verify the dedicated cache ignore rule: git exited with ${String(result.status)}`
  );
}

function validateCacheRoot(cacheRoot) {
  if (typeof cacheRoot !== 'string' || cacheRoot === '') {
    throw new TypeError('cacheRoot must be a non-empty path');
  }
  const requested = path.resolve(cacheRoot);
  const requestedStat = fs.lstatSync(requested, { throwIfNoEntry: false });
  if (requestedStat?.isSymbolicLink()) {
    throw new Error('Benchmark cache root must not be a symlink');
  }
  const resolved = resolveThroughExistingAncestors(cacheRoot);
  const repositoryRoot = fs.realpathSync.native(REPOSITORY_ROOT);
  const repositoryCacheRoot = path.join(repositoryRoot, path.basename(REPOSITORY_CACHE_ROOT));
  const requestedDedicatedRepositoryCache = requested === REPOSITORY_CACHE_ROOT;
  const isDedicatedRepositoryCache =
    requestedDedicatedRepositoryCache && resolved === repositoryCacheRoot;
  if (isWithin(resolved, repositoryRoot) && !isDedicatedRepositoryCache) {
    throw new Error(`The sole allowed in-repository cache is ${REPOSITORY_CACHE_ROOT}`);
  }
  if (isDedicatedRepositoryCache) {
    if (!isIgnoredByRepository(resolved, repositoryRoot)) {
      throw new Error(`The dedicated repository cache must be ignored by Git`);
    }
    return resolved;
  }
  const containmentCandidates = requestedDedicatedRepositoryCache
    ? [resolved]
    : [requested, resolved];
  for (const candidate of containmentCandidates) {
    const repositoryKind = gitRepositoryKind(candidate);
    if (repositoryKind !== null) {
      throw new Error(`Explicit benchmark cache must not be enclosed by a ${repositoryKind}`);
    }
  }
  return resolved;
}

function assertManagedDirectory(directory, cacheRoot, label) {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) {
    throw new Error(`managed cache directory ${label} must not be a symlink`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`managed cache directory ${label} must be a directory`);
  }
  const resolved = fs.realpathSync.native(directory);
  if (!isWithin(resolved, cacheRoot)) {
    throw new Error(`managed cache directory ${label} must remain inside the cache root`);
  }
  return resolved;
}

function assertManagedArtifact(artifactPath, label) {
  try {
    const stat = fs.lstatSync(artifactPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`managed cache artifact ${label} must not be a symlink`);
    }
    if (!stat.isFile()) {
      throw new Error(`managed cache artifact ${label} must be a regular file`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
}

function initializeManagedStorage(cacheRoot) {
  fs.mkdirSync(cacheRoot, { recursive: true });
  const verifiedRoot = assertManagedDirectory(cacheRoot, cacheRoot, 'root');
  const sourcesDirectory = path.join(verifiedRoot, 'sources');
  const normalizedDirectory = path.join(verifiedRoot, 'normalized');
  const referenceSeedsDirectory = path.join(verifiedRoot, 'reference-seeds');
  const referencesDirectory = path.join(verifiedRoot, 'references');
  fs.mkdirSync(sourcesDirectory, { recursive: true });
  assertManagedDirectory(sourcesDirectory, verifiedRoot, 'sources');
  fs.mkdirSync(normalizedDirectory, { recursive: true });
  assertManagedDirectory(normalizedDirectory, verifiedRoot, 'normalized');
  fs.mkdirSync(referenceSeedsDirectory, { recursive: true });
  assertManagedDirectory(referenceSeedsDirectory, verifiedRoot, 'reference-seeds');
  fs.mkdirSync(referencesDirectory, { recursive: true });
  assertManagedDirectory(referencesDirectory, verifiedRoot, 'references');
  return {
    cacheRoot: verifiedRoot,
    sourcesDirectory,
    normalizedDirectory,
    referenceSeedsDirectory,
    referencesDirectory,
  };
}

function createTemporaryDirectory(destination, storage, parentLabel) {
  const parent = path.dirname(destination);
  assertManagedDirectory(parent, storage.cacheRoot, parentLabel);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const directory = path.join(
      parent,
      `.${path.basename(destination)}.tmp-${process.pid}-${crypto.randomUUID()}`
    );
    try {
      fs.mkdirSync(directory);
      assertManagedDirectory(directory, storage.cacheRoot, `${parentLabel} temporary attempt`);
      return directory;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Unable to allocate a unique temporary directory for ${destination}`);
}

function fsyncFile(filePath) {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function publishTemporaryFile(temporaryPath, destination, storage, parentLabel, artifactLabel) {
  assertManagedDirectory(path.dirname(destination), storage.cacheRoot, parentLabel);
  assertManagedArtifact(destination, artifactLabel);
  fsyncFile(temporaryPath);
  fs.renameSync(temporaryPath, destination);
  fsyncDirectory(path.dirname(destination));
}

function removeOwnedTemporaryDirectory(directory) {
  if (directory !== undefined) fs.rmSync(directory, { recursive: true, force: true });
}

function referenceAuthorizationIdentity(authorizedFetchKey) {
  if (typeof authorizedFetchKey !== 'string' || authorizedFetchKey.length === 0) {
    throw new TypeError('reference authorizedFetchKey must be a non-empty string');
  }
  return crypto.createHash('sha256').update(authorizedFetchKey, 'utf8').digest('hex');
}

function referenceSeedPath(cacheRoot, authorizedFetchKey) {
  const storage = initializeManagedStorage(validateCacheRoot(cacheRoot));
  const seedPath = path.join(
    storage.referenceSeedsDirectory,
    referenceAuthorizationIdentity(authorizedFetchKey)
  );
  assertManagedArtifact(seedPath, 'authorized reference seed');
  return seedPath;
}

function readBoundedRegularFile(filePath, label, { allowMissing = false } = {}) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (allowMissing && error.code === 'ENOENT') return undefined;
    if (error.code === 'ENOENT') throw new Error(`${label} is not preseeded`);
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
  if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
  if (stat.size > REFERENCE_MAX_BYTES) {
    throw new Error(`${label} exceeds the ${REFERENCE_MAX_BYTES}-byte maximum`);
  }

  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) throw new Error(`${label} must be a regular file`);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error(`${label} changed while it was being opened`);
    }
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const capacity = Math.min(64 * 1024, REFERENCE_MAX_BYTES + 1 - totalBytes);
      if (capacity <= 0)
        throw new Error(`${label} exceeds the ${REFERENCE_MAX_BYTES}-byte maximum`);
      const chunk = Buffer.allocUnsafe(capacity);
      const bytesRead = fs.readSync(descriptor, chunk, 0, capacity, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > REFERENCE_MAX_BYTES) {
        throw new Error(`${label} exceeds the ${REFERENCE_MAX_BYTES}-byte maximum`);
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const after = fs.fstatSync(descriptor);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    fs.closeSync(descriptor);
  }
}

function verifyReferenceBytes(bytes, fixture, label) {
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== fixture.reference.sha256) {
    throw new Error(`Fixture ${fixture.id} reference SHA-256 mismatch`);
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`Fixture ${fixture.id} reference must be valid UTF-8`);
  }
  const actualWordCount = wordUnits(text, fixture.language).length;
  const actualCharacterCount = characterUnits(text, fixture.language).length;
  if (actualWordCount !== fixture.reference.wordCount) {
    throw new Error(
      `${label} normalized word count ${actualWordCount} must match the manifest ${fixture.reference.wordCount}`
    );
  }
  if (actualCharacterCount !== fixture.reference.characterCount) {
    throw new Error(
      `${label} normalized character count ${actualCharacterCount} must match the manifest ${fixture.reference.characterCount}`
    );
  }
  return text;
}

function materializeReference(fixture, storage) {
  if (fixture.reference.storagePolicy === 'redistributable') {
    return verifyReferenceBytes(
      Buffer.from(fixture.reference.text, 'utf8'),
      fixture,
      `Fixture ${fixture.id} embedded reference`
    );
  }
  if (fixture.reference.storagePolicy !== 'restricted-local-cache') {
    throw new Error(`Fixture ${fixture.id} reference storage policy is unsupported`);
  }

  const verifiedPath = path.join(storage.referencesDirectory, fixture.reference.sha256);
  assertManagedArtifact(verifiedPath, 'verified reference');
  const cachedBytes = readBoundedRegularFile(verifiedPath, 'verified reference', {
    allowMissing: true,
  });
  if (cachedBytes !== undefined) {
    return verifyReferenceBytes(cachedBytes, fixture, `Fixture ${fixture.id} cached reference`);
  }

  const seedPath = path.join(
    storage.referenceSeedsDirectory,
    referenceAuthorizationIdentity(fixture.reference.authorizedFetchKey)
  );
  const seedBytes = readBoundedRegularFile(
    seedPath,
    `Fixture ${fixture.id} authorized reference seed`
  );
  const referenceText = verifyReferenceBytes(
    seedBytes,
    fixture,
    `Fixture ${fixture.id} authorized reference seed`
  );
  let attemptDirectory;
  try {
    attemptDirectory = createTemporaryDirectory(verifiedPath, storage, 'references');
    const temporaryReferencePath = path.join(attemptDirectory, 'reference');
    fs.writeFileSync(temporaryReferencePath, seedBytes, { flag: 'wx', mode: 0o600 });
    publishTemporaryFile(
      temporaryReferencePath,
      verifiedPath,
      storage,
      'references',
      'verified reference'
    );
  } finally {
    removeOwnedTemporaryDirectory(attemptDirectory);
  }
  return referenceText;
}

function durationMatches(actual, expected) {
  return Math.abs(actual - expected) <= DURATION_TOLERANCE_SECONDS;
}

function verifyDuration(actual, expected, label) {
  if (!durationMatches(actual, expected)) {
    throw new Error(
      `${label} duration ${actual} seconds must match the manifest ${expected} seconds within ${DURATION_TOLERANCE_SECONDS} seconds`
    );
  }
}

function sourceByteLimit(fixture) {
  return Math.min(
    SOURCE_DOWNLOAD_POLICY.maximumBytes,
    Math.max(
      SOURCE_DOWNLOAD_POLICY.minimumBytes,
      Math.ceil(fixture.source.durationSeconds * SOURCE_DOWNLOAD_POLICY.bytesPerSecond)
    )
  );
}

function validateDeclaredSourceSize(response, fixture, maximumBytes) {
  const value =
    response.headers && typeof response.headers.get === 'function'
      ? response.headers.get('content-length')
      : null;
  if (value === null) return;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
    throw new Error(`Fixture ${fixture.id} download returned an invalid Content-Length`);
  }
  if (BigInt(value) > BigInt(maximumBytes)) {
    throw new Error(
      `Fixture ${fixture.id} declared source size exceeds the ${maximumBytes}-byte maximum`
    );
  }
}

function conversionArguments(sourcePath, temporaryWavPath) {
  return CONVERSION_CONTRACT.map(argument => {
    if (argument === '{sourcePath}') return sourcePath;
    if (argument === '{temporaryWavPath}') return temporaryWavPath;
    return argument;
  });
}

function matchesNormalizedAudioContract(audio, fixture) {
  return (
    durationMatches(audio.durationSeconds, fixture.normalizedAudio.durationSeconds) &&
    audio.sampleRateHz === 16000 &&
    audio.channels === 1 &&
    audio.codec === 'pcm_s16le'
  );
}

function matchesMetadataAudio(audio, metadataAudio) {
  return (
    durationMatches(audio.durationSeconds, metadataAudio.durationSeconds) &&
    audio.sampleRateHz === metadataAudio.sampleRateHz &&
    audio.channels === metadataAudio.channels &&
    audio.codec === metadataAudio.codec
  );
}

async function readVerifiedMetadata(
  metadataPath,
  paths,
  fixture,
  identity,
  { mediaProcessPolicy, signal, spawnImpl, timer }
) {
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    if (
      metadata.version !== 1 ||
      metadata.cacheIdentity !== identity ||
      metadata.sourceSha256 !== fixture.source.sha256 ||
      metadata.wavSha256 !== fixture.normalizedAudio.sha256 ||
      JSON.stringify(metadata.conversionContract) !== JSON.stringify(CONVERSION_CONTRACT) ||
      sha256File(paths.sourcePath) !== fixture.source.sha256 ||
      sha256File(paths.wavPath) !== fixture.normalizedAudio.sha256
    ) {
      return undefined;
    }
    const { durationSeconds, sampleRateHz, channels, codec } = metadata.audio ?? {};
    const metadataAudio = { durationSeconds, sampleRateHz, channels, codec };
    if (!matchesNormalizedAudioContract(metadataAudio, fixture)) {
      return undefined;
    }
    const observedAudio = await inspectAudio(paths.wavPath, {
      mediaProcessPolicy,
      signal,
      spawnImpl,
      timer,
    });
    if (
      !matchesNormalizedAudioContract(observedAudio, fixture) ||
      !matchesMetadataAudio(observedAudio, metadataAudio)
    ) {
      return undefined;
    }
    return {
      sourcePath: paths.sourcePath,
      wavPath: paths.wavPath,
      sourceSha256: metadata.sourceSha256,
      wavSha256: metadata.wavSha256,
      ...observedAudio,
    };
  } catch (error) {
    if (isTerminalMediaProcessError(error)) throw error;
    return undefined;
  }
}

function assertExclusiveSourceAcquisitionRoute(fixture) {
  const source = fixture?.source;
  const hasUrl =
    source !== null &&
    typeof source === 'object' &&
    Object.prototype.hasOwnProperty.call(source, 'url');
  const hasAuthorizedFetchKey =
    source !== null &&
    typeof source === 'object' &&
    Object.prototype.hasOwnProperty.call(source, 'authorizedFetchKey');
  if (hasUrl === hasAuthorizedFetchKey) {
    throw new Error(
      `Fixture ${fixture?.id ?? '<unknown>'} must declare exactly one source acquisition route: url or authorizedFetchKey`
    );
  }
  return hasUrl ? 'url' : 'authorizedFetchKey';
}

async function downloadSource(fixture, destination, fetchImpl, timer, signal) {
  const acquisitionRoute = assertExclusiveSourceAcquisitionRoute(fixture);
  if (acquisitionRoute !== 'url') {
    throw new Error(
      `Fixture ${fixture.id}: restricted asset must be preseeded through its authorized route before benchmarking`
    );
  }
  if (typeof fixture.source.url !== 'string' || fixture.source.url.length === 0) {
    throw new Error(`Fixture ${fixture.id} source URL must be a non-empty string`);
  }
  let sourceUrl;
  try {
    sourceUrl = new URL(fixture.source.url);
  } catch {
    throw new Error(`Fixture ${fixture.id} source URL is invalid`);
  }
  if (sourceUrl.protocol !== 'https:') {
    throw new Error(`Fixture ${fixture.id} source URL must use HTTPS`);
  }
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError('source download signal must be an AbortSignal when provided');
  }
  if (signal?.aborted) {
    throw new Error(`Fixture ${fixture.id} source download aborted`);
  }
  const controller = new AbortController();
  let timeoutId;
  let abortListener;
  const termination = new Promise((_, reject) => {
    timeoutId = timer.setTimeout(() => {
      controller.abort();
      reject(
        new Error(
          `Fixture ${fixture.id} source download timed out after ${SOURCE_DOWNLOAD_POLICY.timeoutMs} ms`
        )
      );
    }, SOURCE_DOWNLOAD_POLICY.timeoutMs);
    timeoutId?.unref?.();
    if (signal !== undefined) {
      abortListener = () => {
        controller.abort();
        reject(new Error(`Fixture ${fixture.id} source download aborted`));
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }
  });
  const bounded = operation => Promise.race([Promise.resolve(operation), termination]);
  let reader;
  let descriptor;
  const maximumBytes = sourceByteLimit(fixture);
  let downloadedBytes = 0;
  const hash = crypto.createHash('sha256');
  try {
    const response = await bounded(fetchImpl(sourceUrl.href, { signal: controller.signal }));
    const finalUrl = new URL(response.url || sourceUrl.href);
    if (finalUrl.protocol !== 'https:') {
      throw new Error(`Fixture ${fixture.id} download redirected to a non-HTTPS URL`);
    }
    if (!response.ok) {
      throw new Error(`Fixture ${fixture.id} download failed with HTTP ${response.status}`);
    }
    validateDeclaredSourceSize(response, fixture, maximumBytes);
    if (!response.body || typeof response.body.getReader !== 'function') {
      throw new Error(
        `Fixture ${fixture.id} download response must provide a readable byte stream`
      );
    }
    reader = response.body.getReader();
    descriptor = fs.openSync(destination, 'wx', 0o600);
    while (true) {
      const { done, value } = await bounded(reader.read());
      if (done) break;
      if (!(value instanceof Uint8Array) || value.byteLength === 0) {
        throw new Error(`Fixture ${fixture.id} download produced an invalid byte chunk`);
      }
      if (value.byteLength > maximumBytes - downloadedBytes) {
        throw new Error(
          `Fixture ${fixture.id} source download exceeded the ${maximumBytes}-byte maximum`
        );
      }
      downloadedBytes += value.byteLength;
      const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
      hash.update(chunk);
      fs.writeFileSync(descriptor, chunk);
    }
    if (hash.digest('hex') !== fixture.source.sha256) {
      throw new Error(`Fixture ${fixture.id} source SHA-256 mismatch`);
    }
  } catch (error) {
    controller.abort();
    if (reader && typeof reader.cancel === 'function') {
      try {
        Promise.resolve(reader.cancel()).catch(() => {});
      } catch {}
    }
    throw error;
  } finally {
    timer.clearTimeout(timeoutId);
    if (abortListener !== undefined) signal.removeEventListener('abort', abortListener);
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function audioCachePaths(cacheRoot, fixture) {
  const identity = cacheIdentity(fixture.source.sha256);
  return {
    identity,
    sourcePath: path.join(cacheRoot, 'sources', fixture.source.sha256),
    wavPath: path.join(cacheRoot, 'normalized', `${identity}.wav`),
    metadataPath: path.join(cacheRoot, 'normalized', `${identity}.json`),
  };
}

async function materializeFixture(
  fixture,
  {
    cacheRoot,
    fetchImpl = fetch,
    signal,
    spawnImpl = childProcess.spawn,
    timer = { setTimeout, clearTimeout },
    mediaProcessPolicy = MEDIA_PROCESS_POLICY,
  } = {}
) {
  assertExclusiveSourceAcquisitionRoute(fixture);
  const processPolicy = normalizedMediaProcessPolicy(mediaProcessPolicy);
  const resolvedCacheRoot = validateCacheRoot(cacheRoot);
  const storage = initializeManagedStorage(resolvedCacheRoot);
  const referenceText = materializeReference(fixture, storage);
  const paths = audioCachePaths(storage.cacheRoot, fixture);
  assertManagedArtifact(paths.sourcePath, 'source');
  assertManagedArtifact(paths.wavPath, 'normalized audio');
  assertManagedArtifact(paths.metadataPath, 'metadata');
  const cacheHit = await readVerifiedMetadata(paths.metadataPath, paths, fixture, paths.identity, {
    mediaProcessPolicy: processPolicy,
    signal,
    spawnImpl,
    timer,
  });
  if (cacheHit !== undefined) {
    const sourceAudio = await inspectAudio(paths.sourcePath, {
      mediaProcessPolicy: processPolicy,
      signal,
      spawnImpl,
      timer,
    });
    verifyDuration(sourceAudio.durationSeconds, fixture.source.durationSeconds, 'source');
    return { ...cacheHit, referenceText };
  }

  if (!fs.existsSync(paths.sourcePath) || sha256File(paths.sourcePath) !== fixture.source.sha256) {
    let sourceAttemptDirectory;
    try {
      sourceAttemptDirectory = createTemporaryDirectory(paths.sourcePath, storage, 'sources');
      const temporarySourcePath = path.join(sourceAttemptDirectory, 'source');
      await downloadSource(fixture, temporarySourcePath, fetchImpl, timer, signal);
      publishTemporaryFile(temporarySourcePath, paths.sourcePath, storage, 'sources', 'source');
    } finally {
      removeOwnedTemporaryDirectory(sourceAttemptDirectory);
    }
  }
  assertManagedDirectory(storage.sourcesDirectory, storage.cacheRoot, 'sources');
  assertManagedArtifact(paths.sourcePath, 'source');
  const sourceAudio = await inspectAudio(paths.sourcePath, {
    mediaProcessPolicy: processPolicy,
    signal,
    spawnImpl,
    timer,
  });
  verifyDuration(sourceAudio.durationSeconds, fixture.source.durationSeconds, 'source');

  let wavAttemptDirectory;
  try {
    wavAttemptDirectory = createTemporaryDirectory(paths.wavPath, storage, 'normalized');
    const temporaryWavPath = path.join(wavAttemptDirectory, 'normalized.wav');
    await runProcess(
      NORMALIZED_AUDIO_TRANSFORM.tool,
      conversionArguments(paths.sourcePath, temporaryWavPath),
      {
        spawnImpl,
        signal,
        stderrMaxBytes: processPolicy.stderrMaxBytes,
        stdoutMaxBytes: processPolicy.stdoutMaxBytes,
        timeoutMs: conversionTimeout(fixture, processPolicy),
        timer,
        terminationGraceMs: processPolicy.terminationGraceMs,
        killGraceMs: processPolicy.killGraceMs,
      }
    );
    if (!fs.existsSync(temporaryWavPath)) {
      throw new Error(`ffmpeg did not create normalized audio for fixture ${fixture.id}`);
    }
    const normalizedAudio = await inspectAudio(temporaryWavPath, {
      mediaProcessPolicy: processPolicy,
      signal,
      spawnImpl,
      timer,
    });
    verifyDuration(
      normalizedAudio.durationSeconds,
      fixture.normalizedAudio.durationSeconds,
      'normalized'
    );
    if (!matchesNormalizedAudioContract(normalizedAudio, fixture)) {
      throw new Error(`Fixture ${fixture.id} normalized audio must be 16 kHz mono PCM s16le`);
    }
    if (sha256File(temporaryWavPath) !== fixture.normalizedAudio.sha256) {
      throw new Error(`Fixture ${fixture.id} normalized audio SHA-256 mismatch`);
    }
    publishTemporaryFile(
      temporaryWavPath,
      paths.wavPath,
      storage,
      'normalized',
      'normalized audio'
    );
    const metadata = {
      version: 1,
      cacheIdentity: paths.identity,
      sourceSha256: fixture.source.sha256,
      wavSha256: fixture.normalizedAudio.sha256,
      conversionContract: CONVERSION_CONTRACT,
      audio: normalizedAudio,
    };
    const temporaryMetadataPath = path.join(wavAttemptDirectory, 'metadata.json');
    fs.writeFileSync(temporaryMetadataPath, `${JSON.stringify(metadata)}\n`, { flag: 'wx' });
    publishTemporaryFile(
      temporaryMetadataPath,
      paths.metadataPath,
      storage,
      'normalized',
      'metadata'
    );
    return {
      sourcePath: paths.sourcePath,
      wavPath: paths.wavPath,
      sourceSha256: fixture.source.sha256,
      wavSha256: fixture.normalizedAudio.sha256,
      referenceText,
      ...normalizedAudio,
    };
  } finally {
    removeOwnedTemporaryDirectory(wavAttemptDirectory);
  }
}

module.exports = {
  audioCachePaths,
  inspectAudio,
  materializeFixture,
  MEDIA_PROCESS_POLICY,
  NORMALIZED_AUDIO_TRANSFORM,
  referenceSeedPath,
  sha256File,
  sourceByteLimit,
};
