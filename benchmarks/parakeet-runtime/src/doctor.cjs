'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MINIMUM_FREE_DISK_BYTES = 24 * 1024 ** 3;
const MINIMUM_NODE_MAJOR = 22;
const REQUIRED_TOOLS = Object.freeze([
  { id: 'git', command: 'git', remediation: 'xcode-select --install' },
  { id: 'python3', command: 'python3', remediation: 'brew install python@3.12' },
  { id: 'cmake', command: 'cmake', remediation: 'brew install cmake' },
  { id: 'xcrun', command: 'xcrun', remediation: 'xcode-select --install' },
]);

function existingAncestor(candidate) {
  let current = candidate;
  while (true) {
    try {
      fs.lstatSync(current);
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

function defaultFreeDiskBytes(directory) {
  const stats = fs.statfsSync(existingAncestor(directory));
  const available = stats.bavail ?? stats.bfree;
  if (!Number.isSafeInteger(available) || !Number.isSafeInteger(stats.bsize)) {
    throw new Error('filesystem free space is unavailable');
  }
  return available * stats.bsize;
}

function commandOutput(command, arguments_) {
  const result = childProcess.spawnSync(command, arguments_, { encoding: 'utf8' });
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
  const output = result.stdout.trim();
  return output === '' ? null : output;
}

function defaultSystemInfo() {
  return {
    platform: os.platform(),
    arch: process.arch,
    release: os.release(),
    cpuBrand: commandOutput('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']),
    nodeVersion: process.version,
  };
}

function defaultFindTool(name) {
  return commandOutput('/usr/bin/which', [name]);
}

function defaultNetworkAccess() {
  return Object.values(os.networkInterfaces())
    .flat()
    .some(network => network && network.internal === false);
}

function nodeMajor(version) {
  const match = /^v?(\d+)\./u.exec(version ?? '');
  return match ? Number(match[1]) : null;
}

function gibibytes(bytes) {
  return (bytes / 1024 ** 3).toFixed(1);
}

function state(id, ready, detail, remediation) {
  return {
    id,
    state: ready ? 'ready' : 'blocked',
    detail,
    ...(remediation === undefined ? {} : { remediation }),
  };
}

function sourceSummary(sourceManifests) {
  const fixtures = sourceManifests.flatMap(manifest => manifest?.fixtures ?? []);
  const longFixtures = fixtures.filter(fixture => fixture?.cohort === 'long');
  const manualFixtures = longFixtures.filter(
    fixture => fixture?.acquisition?.state === 'manual-authorized-input-required'
  );
  return {
    longFixtureCount: longFixtures.length,
    manualFixtureCount: manualFixtures.length,
  };
}

function doctor(layout, runtimeLock, dependencies = {}) {
  if (layout === null || typeof layout !== 'object' || Array.isArray(layout)) {
    throw new TypeError('doctor requires a resolved layout');
  }
  if (!Array.isArray(runtimeLock?.runtimes)) {
    throw new TypeError('doctor requires a runtime lock');
  }

  const systemInfo = dependencies.systemInfo ?? defaultSystemInfo;
  const freeDiskBytes = dependencies.freeDiskBytes ?? defaultFreeDiskBytes;
  const findTool = dependencies.findTool ?? defaultFindTool;
  const networkAccess = dependencies.networkAccess ?? defaultNetworkAccess;
  const discoverWasperApp =
    dependencies.discoverWasperApp ?? require('./runtime/wasper-app.cjs').discoverWasperApp;
  const sourceManifests =
    dependencies.sourceManifests ?? [
      require('../corpus/short-fleurs.json'),
      require('../corpus/long-sources.json'),
    ];

  const detected = systemInfo();
  const freeBytes = freeDiskBytes(layout.cacheRoot);
  if (!Number.isFinite(freeBytes) || freeBytes < 0) {
    throw new TypeError('doctor free disk check must return a non-negative number');
  }
  const system = {
    platform: detected.platform,
    arch: detected.arch,
    release: detected.release,
    cpuBrand: detected.cpuBrand ?? null,
    nodeVersion: detected.nodeVersion,
    freeDiskBytes: freeBytes,
  };
  const hasNetworkAccess = networkAccess() === true;
  const checks = [
    state(
      'macos',
      system.platform === 'darwin',
      system.platform === 'darwin' ? `macOS kernel ${system.release}` : `found ${system.platform}`,
      'Use a supported Apple Silicon Mac.'
    ),
    state(
      'apple-silicon',
      system.arch === 'arm64' && /^Apple M\d/u.test(system.cpuBrand ?? ''),
      system.arch === 'arm64' && /^Apple M\d/u.test(system.cpuBrand ?? '')
        ? system.cpuBrand
        : 'A full run requires an Apple Silicon Mac.',
      'Use an Apple Silicon Mac.'
    ),
    state(
      'node',
      nodeMajor(system.nodeVersion) !== null && nodeMajor(system.nodeVersion) >= MINIMUM_NODE_MAJOR,
      `found ${system.nodeVersion}`,
      'brew install node@22'
    ),
    state(
      'free-disk',
      freeBytes >= MINIMUM_FREE_DISK_BYTES,
      `${gibibytes(freeBytes)} GiB free; doctor requires at least 24 GiB.`,
      'npm run clean'
    ),
    state(
      'network',
      hasNetworkAccess,
      hasNetworkAccess
        ? 'A non-loopback network interface is available.'
        : 'No non-loopback network interface is available.',
      'Connect to the internet and run npm run doctor again.'
    ),
  ];

  for (const tool of REQUIRED_TOOLS) {
    const executable = findTool(tool.command);
    checks.push(
      state(
        tool.id,
        typeof executable === 'string' && executable !== '',
        typeof executable === 'string' && executable !== ''
          ? executable
          : `${tool.command} is unavailable.`,
        tool.remediation
      )
    );
  }

  let wasper;
  try {
    const release = discoverWasperApp({
      ...(layout.wasperApp === null ? {} : { appPath: layout.wasperApp }),
      runtimeLock,
    });
    wasper = {
      state: 'ready',
      appPath: release.appPath,
      version: release.version,
      baselineKind: release.baselineKind,
      nativeServerSha256: release.nativeServerSha256,
    };
  } catch (error) {
    wasper = {
      state: 'blocked',
      detail: error instanceof Error ? error.message : String(error),
      remediation: 'Install Wasper 1.8.0 or later, then run npm run doctor again.',
    };
  }
  checks.push(
    state(
      'wasper-app',
      wasper.state === 'ready',
      wasper.state === 'ready'
        ? `${wasper.version} (${wasper.baselineKind})`
        : wasper.detail,
      wasper.remediation
    )
  );

  const runtimes = runtimeLock.runtimes.map(runtime => ({
    id: runtime.id,
    label: runtime.label,
    state: runtime.reproduction?.state === 'ready' ? 'ready' : 'blocked',
    limitations: runtime.reproduction?.limitations ?? [],
  }));
  for (const runtime of runtimes) {
    checks.push(
      state(
        `runtime:${runtime.id}`,
        runtime.state === 'ready',
        runtime.state === 'ready'
          ? 'The public runtime lock permits acquisition.'
          : runtime.limitations.join(' '),
        runtime.state === 'ready' ? undefined : 'See the runtime limitation in README.md.'
      )
    );
  }

  const sources = sourceSummary(sourceManifests);
  checks.push(
    state(
      'source-terms',
      true,
      'The long cohort requires --accept-source-terms before any download.',
      'npm run benchmark -- full --accept-source-terms'
    ),
    state(
      'long-corpus',
      sources.manualFixtureCount === 0,
      sources.manualFixtureCount === 0
        ? `${sources.longFixtureCount} long fixtures have automatic public sources.`
        : `${sources.manualFixtureCount} of ${sources.longFixtureCount} long fixtures require rights-holder-authorized input.`,
      sources.manualFixtureCount === 0
        ? undefined
        : 'See the long-audio limitations in README.md.'
    )
  );

  return {
    ok: checks.every(check => check.state === 'ready'),
    system,
    layout: { cacheRoot: layout.cacheRoot, outputRoot: layout.outputRoot },
    checks,
    wasper,
    runtimes,
    sources,
  };
}

function formatDoctor(result) {
  const lines = [
    'Doctor',
    `Hardware: ${result.system.cpuBrand ?? 'unknown'} (${result.system.arch})`,
    `Operating system: ${result.system.platform} ${result.system.release}`,
    `Node: ${result.system.nodeVersion}`,
    `Free disk: ${gibibytes(result.system.freeDiskBytes)} GiB`,
    `Cache: ${result.layout.cacheRoot}`,
    `Output: ${result.layout.outputRoot}`,
    `Wasper.app: ${result.wasper.state}${result.wasper.version ? ` ${result.wasper.version}` : ''}${result.wasper.baselineKind ? ` (${result.wasper.baselineKind})` : ''}`,
    'Runtimes:',
    ...result.runtimes.map(runtime => `- ${runtime.label ?? runtime.id}: ${runtime.state}`),
    'Checks:',
    ...result.checks.map(check =>
      check.state === 'blocked' && check.remediation
        ? `- ${check.id}: ${check.state} — ${check.detail}\n  Remediation: ${check.remediation}`
        : `- ${check.id}: ${check.state} — ${check.detail}`
    ),
    `Full run: ${result.ok ? 'ready' : 'blocked'}`,
  ];
  return lines.join('\n');
}

module.exports = {
  MINIMUM_FREE_DISK_BYTES,
  MINIMUM_NODE_MAJOR,
  REQUIRED_TOOLS,
  doctor,
  formatDoctor,
};
