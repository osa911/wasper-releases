'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { createProcessClient } = require('../src/runtime/adapters/process-client.cjs');

function definition() {
  return {
    command: '/private/bin/runtime',
    args: [],
    env: {},
    transport: {
      kind: 'http',
      port: 9999,
      healthPath: '/health',
      transcribePath: '/transcribe',
      fileField: 'audio',
    },
  };
}

function childProcess({ exitsOnKill = true } = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  child.stderr = new EventEmitter();
  child.signals = [];
  child.kill = signal => {
    child.signals.push(signal);
    if (exitsOnKill) {
      child.signalCode = signal;
      queueMicrotask(() => child.emit('exit', null, signal));
    }
    return true;
  };
  return child;
}

function clientFor(children, { fetchImpl, timeouts } = {}) {
  return createProcessClient(
    { definition: definition(), modelIdentityHash: 'model-hash' },
    {
      spawnImpl: () => children.shift(),
      fetchImpl: fetchImpl ?? (async () => ({ ok: true, text: async () => '{"status":"ok"}' })),
      timeouts: { stopMs: 10, ...timeouts },
    }
  );
}

test('stop cleans up an already-exited runtime so the next activation can start', async () => {
  const crashed = childProcess();
  const next = childProcess();
  const client = clientFor([crashed, next]);
  await client.start();
  crashed.exitCode = 1;
  crashed.emit('exit', 1, null);

  await client.stop();
  await client.start();
  await client.stop();
  assert.equal(next.signalCode, 'SIGTERM');
});

test('stop refuses to report cleanup if a running child survives SIGKILL', async () => {
  const child = childProcess({ exitsOnKill: false });
  const client = clientFor([child]);
  await client.start();

  await assert.rejects(client.stop(), error => error.code === 'ETIMEDOUT');
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});

test('failed health startup reports unconfirmed child shutdown', async () => {
  const child = childProcess({ exitsOnKill: false });
  const client = clientFor([child], {
    fetchImpl: async () => ({ ok: false, status: 503, text: async () => 'unavailable' }),
    timeouts: { startupMs: 5, healthPollIntervalMs: 1, stopMs: 5 },
  });

  await assert.rejects(client.start(), error => error.code === 'ETIMEDOUT' && error.operation === 'shutdown');
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
});
