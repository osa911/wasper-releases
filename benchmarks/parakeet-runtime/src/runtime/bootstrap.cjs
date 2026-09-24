'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');
const childProcess = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { promisify, isDeepStrictEqual } = require('node:util');
const { loadRuntimeLock, runtimeFromLock } = require('./locks.cjs');
const { ownedRuntimeStorage } = require('./owned-runtime-storage.cjs');
const { isInside } = require('../config.cjs');

const execute = promisify(execFile);
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const MAX_ARTIFACT_REDIRECTS = 5;
const RETRY =
  'Install the documented prerequisite, then run npm run benchmark -- full --accept-source-terms again.';

function runtimeArtifacts(runtime) {
  const withRedirectHosts = artifact => {
    const host = new URL(artifact.url).hostname;
    return { ...artifact, redirectHosts: runtime.artifactRedirectHosts?.[host] };
  };
  return [
    ...runtime.artifacts.map(withRedirectHosts),
    ...(runtime.build.binaryDependencies ?? []).map(dependency =>
      withRedirectHosts({ ...dependency, path: `.binary-dependencies/${dependency.sha256}.zip` })
    ),
  ];
}

function processEnvironment(storage) {
  const cache = storage.directory(path.join(storage.layout.holdersRoot, '.tool-cache'));
  const temp = storage.directory(path.join(cache, 'tmp'));
  return {
    PATH: process.env.PATH,
    LANG: 'C',
    TMPDIR: temp,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_ALLOW_PROTOCOL: 'https',
    XDG_CACHE_HOME: cache,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    HF_HUB_OFFLINE: '1',
    HF_HOME: path.join(cache, 'huggingface'),
    CLANG_MODULE_CACHE_PATH: path.join(cache, 'clang'),
  };
}

async function run(storage, command, args, env, cwd = storage.layout.cacheRoot) {
  storage.check();
  storage.directory(cwd, false);
  try {
    const result = await execute(command, args, {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 ** 2,
      timeout: 20 * 60 * 1000,
    });
    storage.check();
    return result.stdout.trim();
  } catch (error) {
    throw new Error(`${path.basename(command)} failed: ${error.stderr || error.message}`, {
      cause: error,
    });
  }
}

async function prerequisites(runtime, python, storage, env, tools) {
  const checks = [];
  if (process.platform === 'darwin' && ['cmake', 'swift'].includes(runtime.build.kind)) {
    checks.push([
      tools.xcodeSelect ?? 'xcode-select',
      ['-p'],
      runtime.build.kind === 'cmake'
        ? 'CMake and Xcode Command Line Tools'
        : 'Swift and Xcode Command Line Tools',
    ]);
  }
  if (runtime.source) checks.push([tools.git ?? 'git', ['--version'], 'Git']);
  if (runtime.build.kind === 'cmake')
    checks.push([tools.cmake ?? 'cmake', ['--version'], 'CMake and Xcode Command Line Tools']);
  if (runtime.build.kind === 'swift')
    checks.push([tools.swift ?? 'swift', ['--version'], 'Swift and Xcode Command Line Tools']);
  checks.push([
    python,
    ['-I', '-B', '-c', 'import os; assert {os.open, os.link, os.unlink} <= os.supports_dir_fd'],
    'the selected Python 3 executable with descriptor-relative file operations',
  ]);
  for (const [command, args, label] of checks) {
    try {
      await run(storage, command, args, env);
    } catch (error) {
      throw new Error(`${runtime.label} requires ${label}.\n${RETRY}`, { cause: error });
    }
  }
  for (const pkg of runtime.pythonPackages) {
    let actual;
    try {
      actual = await run(
        storage,
        python,
        [
          '-c',
          'import importlib.metadata,sys; print(importlib.metadata.version(sys.argv[1]))',
          pkg.name,
        ],
        env
      );
    } catch {
      actual = 'missing';
    }
    if (actual !== pkg.version)
      throw new Error(
        `${runtime.label} requires ${pkg.name}==${pkg.version} in the selected Python; found ${actual}.\n${RETRY}`
      );
  }
}

function trustedArtifactUrl(value, redirectHosts) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('artifact redirect URL is invalid');
  }
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    !Array.isArray(redirectHosts) ||
    !redirectHosts.includes(url.hostname)
  ) {
    throw new Error(`artifact redirect is not a trusted HTTPS host: ${value}`);
  }
  return url;
}

async function fetchArtifact(artifact, fetchImpl) {
  let url = trustedArtifactUrl(artifact.url, artifact.redirectHosts);
  for (let redirectCount = 0; redirectCount <= MAX_ARTIFACT_REDIRECTS; redirectCount += 1) {
    const response = await fetchImpl(url.href, {
      signal: AbortSignal.timeout(30 * 60 * 1000),
      redirect: 'manual',
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers?.get('location');
      await response.body?.cancel?.();
      if (typeof location !== 'string' || location === '') {
        throw new Error(`artifact redirect has no destination: ${url.href}`);
      }
      url = trustedArtifactUrl(new URL(location, url).href, artifact.redirectHosts);
      continue;
    }
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}: ${url.href}`);
    return response;
  }
  throw new Error(`artifact redirect limit exceeded: ${artifact.url}`);
}

async function download(artifact, root, storage, fetchImpl, python, env) {
  const target = path.join(root, artifact.path);
  storage.directory(path.dirname(target));
  if (fs.existsSync(target)) {
    const actual = storage.hashFile(target);
    if (
      actual.sha256 !== artifact.sha256 ||
      (artifact.sizeBytes !== undefined && actual.sizeBytes !== artifact.sizeBytes)
    )
      throw new Error(`SHA-256 or size mismatch: ${artifact.path}`);
    return target;
  }
  const response = await fetchArtifact(artifact, fetchImpl);
  // Node has no openat/linkat API. Pass a verified directory descriptor to a
  // stdlib-only Python writer; it never resolves a destination parent path.
  const fd = storage.openDirectory(path.dirname(target));
  try {
    const writer = childProcess.spawn(
      python,
      [
        '-I',
        '-B',
        path.join(__dirname, 'owned-download.py'),
        path.basename(target),
        artifact.sha256,
        artifact.sizeBytes === undefined ? '-' : String(artifact.sizeBytes),
      ],
      {
        env,
        cwd: storage.layout.cacheRoot,
        stdio: ['pipe', 'ignore', 'pipe', fd],
        timeout: 30 * 60 * 1000,
      }
    );
    let detail = '';
    writer.stderr.on('data', chunk => {
      detail = (detail + chunk).slice(-65536);
    });
    const finished = new Promise((resolve, reject) => {
      writer.once('error', reject);
      writer.once('close', code =>
        code === 0 ? resolve() : reject(new Error(`download failed: ${detail.trim()}`))
      );
    });
    const transfer = pipeline(Readable.from(response.body), writer.stdin).catch(error => {
      writer.kill();
      throw error;
    });
    const results = await Promise.allSettled([finished, transfer]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  } finally {
    fs.closeSync(fd);
  }
  storage.check();
  storage.regular(target);
  return target;
}

async function verifySource(source, root, runtime, storage, env, tools) {
  storage.directory(root, false);
  storage.directory(path.join(root, '.git'), false);
  const git = args => run(storage, tools.git ?? 'git', ['-C', root, ...args], env);
  if ((await git(['rev-parse', 'HEAD'])) !== source.revision)
    throw new Error('source revision mismatch');
  if (await git(['diff', '--name-only', 'HEAD', '--']))
    throw new Error('source checkout is dirty');
  const status = await git(['ls-files', '--others']);
  const allowed = [
    runtime.build.directory,
    ...(source.submodules?.map(entry => entry.path) ?? []),
  ].filter(Boolean);
  if (
    status
      .split('\n')
      .filter(Boolean)
      .some(file => !allowed.some(prefix => file.startsWith(`${prefix}/`)))
  ) {
    throw new Error('source checkout has unexpected untracked files');
  }
}

async function clone(source, root, runtime, storage, env, tools, sourceTransport) {
  if (!fs.existsSync(path.join(root, '.git'))) {
    storage.directory(root);
    if (fs.readdirSync(root).length)
      throw new Error('refusing a nonempty holder without verified Git source');
    const url = sourceTransport(source.url);
    await run(
      storage,
      tools.git ?? 'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        'clone',
        '--no-checkout',
        '--no-local',
        '--',
        url,
        root,
      ],
      env
    );
    await run(
      storage,
      tools.git ?? 'git',
      ['-C', root, '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', source.revision],
      env
    );
  }
  await verifySource(source, root, runtime, storage, env, tools);
  for (const submodule of source.submodules ?? []) {
    const entry = await run(
      storage,
      tools.git ?? 'git',
      ['-C', root, 'ls-tree', 'HEAD', '--', submodule.path],
      env
    );
    if (!entry.startsWith(`160000 commit ${submodule.revision}\t`))
      throw new Error('submodule lock differs from pinned Git tree');
    await clone(
      { ...submodule, submodules: [] },
      path.join(root, submodule.path),
      { build: { kind: 'none' } },
      storage,
      env,
      tools,
      sourceTransport
    );
  }
}

function outputHash(file, holderRoot, storage) {
  const canonical = fs.realpathSync(file);
  if (!isInside(holderRoot, canonical)) throw new Error('build output escapes owned holder');
  return storage.hashFile(canonical).sha256;
}

function buildInventory(runtime, holderRoot, storage) {
  if (runtime.build.kind === 'none') return [];
  const found = new Map();
  const visited = new Set();
  const walk = directory => {
    const canonical = fs.realpathSync(directory);
    if (!isInside(holderRoot, canonical)) throw new Error('build inventory escapes holder');
    if (visited.has(canonical)) return;
    visited.add(canonical);
    storage.directory(canonical, false);
    for (const name of fs.readdirSync(canonical).sort()) {
      if (['.git', 'checkouts', 'repositories', 'ModuleCache', 'index'].includes(name))
        continue;
      const entry = path.join(canonical, name);
      const real = fs.realpathSync(entry);
      if (!isInside(holderRoot, real))
        throw new Error('build inventory symlink escapes holder');
      const stat = fs.statSync(real);
      if (stat.isDirectory()) walk(real);
      else if (stat.mode & 0o111 || /\.(dylib|so|metallib)(\.\d+)*$/u.test(name)) {
        found.set(path.relative(holderRoot, real), storage.hashFile(real).sha256);
      }
    }
  };
  walk(path.join(holderRoot, runtime.build.directory));
  return [...found].sort(([a], [b]) => a.localeCompare(b));
}

function verifyPackageBridges(runtime, layout) {
  for (const entry of runtime.bridgeFiles ?? []) {
    const file = path.join(layout.packageRoot, entry.path);
    const info = fs.lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== entry.sha256
    ) {
      throw new Error('package bridge source SHA-256 mismatch');
    }
  }
}

function verifyStagedBridge(runtime, holderRoot, storage) {
  if (runtime.build.kind !== 'swift') return;
  for (const entry of runtime.build.bridgeFiles) {
    const file = path.join(holderRoot, runtime.build.directory, entry.path);
    if (storage.hashFile(file).sha256 !== entry.sha256)
      throw new Error('staged bridge source SHA-256 mismatch');
  }
}

async function buildSwift(runtime, holderRoot, storage, python, env, tools, dependencies) {
  const bridge = storage.directory(path.join(holderRoot, runtime.build.directory));
  const input =
    dependencies.bridgeRoot ??
    path.join(storage.layout.packageRoot, 'src/runtime/bridges/fluid-coreml-server');
  for (const entry of runtime.build.bridgeFiles) {
    const bytes = fs.readFileSync(path.join(input, entry.path));
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256)
      throw new Error('bridge source SHA-256 mismatch');
    const destination = path.join(bridge, entry.path);
    if (!fs.existsSync(destination))
      storage.writeExclusive(destination, bytes, { python, env });
    if (storage.hashFile(destination).sha256 !== entry.sha256)
      throw new Error('staged bridge source SHA-256 mismatch');
  }
  const cache = storage.directory(path.join(storage.layout.holdersRoot, '.tool-cache/swift'));
  const mirror = storage.directory(
    path.join(cache, runtime.id, path.basename(new URL(runtime.source.url).pathname))
  );
  const mirrorEnv = { ...env, GIT_ALLOW_PROTOCOL: 'https:file' };
  if (!fs.existsSync(path.join(mirror, 'HEAD'))) {
    await run(
      storage,
      tools.git ?? 'git',
      ['clone', '--bare', '--no-local', '--', holderRoot, mirror],
      mirrorEnv
    );
  }
  if (
    (await run(storage, tools.git ?? 'git', ['-C', mirror, 'rev-parse', 'HEAD'], mirrorEnv)) !==
    runtime.source.revision
  )
    throw new Error('Swift mirror revision mismatch');
  const common = [
    '--package-path',
    bridge,
    '--cache-path',
    cache,
    '--config-path',
    storage.directory(path.join(cache, 'config')),
    '--security-path',
    storage.directory(path.join(cache, 'security')),
    '--scratch-path',
    storage.directory(path.join(bridge, '.build')),
  ];
  // Resolve the public dependency from the already verified clean clone.
  // The generated mirror configuration is local cache data, never a lock input.
  await run(
    storage,
    tools.swift ?? 'swift',
    [
      'package',
      ...common,
      'config',
      'set-mirror',
      '--original',
      runtime.source.url,
      '--mirror',
      mirror,
    ],
    env,
    bridge
  );
  await run(
    storage,
    tools.swift ?? 'swift',
    [
      'build',
      ...common,
      '--force-resolved-versions',
      '--disable-dependency-cache',
      '--manifest-cache',
      'local',
      '--configuration',
      'release',
    ],
    {
      ...env,
      GIT_ALLOW_PROTOCOL: 'https:file',
      SWIFTPM_MODULECACHE_OVERRIDE: path.join(cache, 'modules'),
    },
    bridge
  );
  const resolved = JSON.parse(fs.readFileSync(path.join(bridge, 'Package.resolved'), 'utf8'));
  if (resolved.pins.length !== 1 || resolved.pins[0].state.revision !== runtime.source.revision)
    throw new Error('Swift resolved source differs from lock');
}

async function bootstrapRuntime(
  runtimeId,
  { layout, lock = loadRuntimeLock(), python = 'python3' } = {},
  dependencies = {}
) {
  const runtime = runtimeFromLock(runtimeId, lock, dependencies.authority);
  const storage = ownedRuntimeStorage(layout);
  verifyPackageBridges(runtime, layout);
  const env = processEnvironment(storage);
  // Transport injection is restricted to the programmatic fixture seam.
  if (dependencies.sourceTransport) env.GIT_ALLOW_PROTOCOL = 'https:file';
  const tools = dependencies.tools ?? {};
  const holderRoot = path.join(layout.holdersRoot, runtimeId);
  const artifactRoot = path.join(layout.artifactsRoot, runtimeId);
  const lockSha256 = digest(lock);
  try {
    await prerequisites(runtime, python, storage, env, tools);
    storage.directory(artifactRoot);
    storage.directory(holderRoot);
    const artifacts = [];
    for (const artifact of runtimeArtifacts(runtime))
      artifacts.push(
        await download(
          artifact,
          artifactRoot,
          storage,
          dependencies.fetchImpl ?? fetch,
          python,
          env
        )
      );
    if (runtime.source)
      await clone(
        runtime.source,
        holderRoot,
        runtime,
        storage,
        env,
        tools,
        dependencies.sourceTransport ?? (url => url)
      );
    const outputs = (runtime.build.outputs ?? []).map(file => path.join(holderRoot, file));
    const receiptPath = path.join(layout.artifactsRoot, runtimeId, '.bootstrap.json');
    if (fs.existsSync(receiptPath)) {
      storage.regular(receiptPath);
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      if (receipt.lockSha256 !== lockSha256) throw new Error('bootstrap receipt lock mismatch');
      for (let index = 0; index < outputs.length; index++) {
        if (outputHash(outputs[index], holderRoot, storage) !== receipt.outputHashes[index])
          throw new Error('built output SHA-256 mismatch');
      }
      verifyStagedBridge(runtime, holderRoot, storage);
      if (
        !isDeepStrictEqual(buildInventory(runtime, holderRoot, storage), receipt.buildInventory)
      )
        throw new Error('build inventory mismatch');
    } else {
      if (runtime.build.kind !== 'none') {
        const buildDirectory = storage.directory(
          path.join(holderRoot, runtime.build.directory)
        );
        if (fs.readdirSync(buildDirectory).length) {
          throw new Error('refusing a nonempty build directory without a verified receipt');
        }
      }
      if (runtime.build.kind === 'cmake') {
        const build = storage.directory(path.join(holderRoot, runtime.build.directory));
        await run(
          storage,
          tools.cmake ?? 'cmake',
          ['-S', holderRoot, '-B', build, ...runtime.build.configureArgs],
          env,
          holderRoot
        );
        await run(
          storage,
          tools.cmake ?? 'cmake',
          ['--build', build, '--config', 'Release', '--parallel', '2'],
          env,
          holderRoot
        );
      }
      if (runtime.build.kind === 'swift')
        await buildSwift(runtime, holderRoot, storage, python, env, tools, dependencies);
      const outputHashes = outputs.map(file => outputHash(file, holderRoot, storage));
      storage.writeExclusive(
        receiptPath,
        JSON.stringify({
          lockSha256,
          outputHashes,
          python,
          buildInventory: buildInventory(runtime, holderRoot, storage),
        }),
        { python, env }
      );
    }
    storage.check();
    verifyRuntimeInstallation(runtimeId, { layout, lock, python }, dependencies);
    return Object.freeze({
      runtimeId,
      holderRoot,
      artifactRoot,
      artifacts,
      outputs,
      lockSha256,
      python,
    });
  } catch (error) {
    throw new Error(`${runtimeId}: ${error.message}`, { cause: error });
  }
}

function verifyRuntimeInstallation(
  runtimeId,
  { layout, lock = loadRuntimeLock(), python = 'python3' },
  dependencies = {}
) {
  const runtime = runtimeFromLock(runtimeId, lock, dependencies.authority);
  const storage = ownedRuntimeStorage(layout, { create: false });
  verifyPackageBridges(runtime, layout);
  const artifactRoot = path.join(layout.artifactsRoot, runtimeId);
  const holderRoot = path.join(layout.holdersRoot, runtimeId);
  storage.directory(artifactRoot, false);
  const allowed = new Set([
    ...runtimeArtifacts(runtime).map(artifact => artifact.path),
    '.bootstrap.json',
  ]);
  const walk = directory => {
    storage.directory(directory, false);
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(file);
      else {
        storage.regular(file);
        if (!allowed.has(path.relative(artifactRoot, file)))
          throw new Error('unlocked artifact in runtime model directory');
      }
    }
  };
  walk(artifactRoot);
  for (const artifact of runtimeArtifacts(runtime)) {
    const actual = storage.hashFile(path.join(artifactRoot, artifact.path));
    if (
      actual.sha256 !== artifact.sha256 ||
      (artifact.sizeBytes !== undefined && actual.sizeBytes !== artifact.sizeBytes)
    )
      throw new Error(`artifact SHA-256 mismatch: ${artifact.path}`);
  }
  const receiptPath = path.join(artifactRoot, '.bootstrap.json');
  storage.regular(receiptPath);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  if (receipt.lockSha256 !== digest(lock) || receipt.python !== python)
    throw new Error('bootstrap receipt lock or Python mismatch');
  const outputs = (runtime.build.outputs ?? []).map(file => path.join(holderRoot, file));
  for (let index = 0; index < outputs.length; index++) {
    if (outputHash(outputs[index], holderRoot, storage) !== receipt.outputHashes[index])
      throw new Error('built output SHA-256 mismatch');
  }
  verifyStagedBridge(runtime, holderRoot, storage);
  if (!isDeepStrictEqual(buildInventory(runtime, holderRoot, storage), receipt.buildInventory))
    throw new Error('build inventory mismatch');
  const verifyGit = (source, root) => {
    storage.directory(path.join(root, '.git'), false);
    const git = args =>
      execFileSync(dependencies.tools?.git ?? 'git', ['-C', root, ...args], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      }).trim();
    if (git(['rev-parse', 'HEAD']) !== source.revision)
      throw new Error('source revision mismatch');
    if (git(['diff', '--name-only', 'HEAD', '--'])) throw new Error('source checkout is dirty');
    const allowed = [
      runtime.build.directory,
      ...(source.submodules ?? []).map(entry => entry.path),
    ].filter(Boolean);
    if (
      git(['ls-files', '--others'])
        .split('\n')
        .filter(Boolean)
        .some(file => !allowed.some(prefix => file.startsWith(`${prefix}/`)))
    )
      throw new Error('source checkout has unexpected untracked files');
    for (const submodule of source.submodules ?? [])
      verifyGit(submodule, path.join(root, submodule.path));
  };
  if (runtime.source) verifyGit(runtime.source, holderRoot);
  storage.check();
  return { runtimeId, holderRoot, artifactRoot, outputs, lockSha256: receipt.lockSha256 };
}

module.exports = { bootstrapRuntime, verifyRuntimeInstallation };
