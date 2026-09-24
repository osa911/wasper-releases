'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { samplePostResponsePhysicalFootprint } = require('../src/runtime/footprint.cjs');

test('records a single post-response physical-footprint sample without calling it a peak', () => {
  const sample = samplePostResponsePhysicalFootprint(42, {
    clock: () => new Date('2026-09-24T12:34:56.000Z'),
    spawnSyncImpl(command, arguments_) {
      assert.equal(command, '/usr/bin/top');
      assert.deepEqual(arguments_, ['-l', '1', '-pid', '42', '-stats', 'pid,mem']);
      return { status: 0, stdout: 'PID MEM\n42 512M\n', stderr: '' };
    },
  });

  assert.deepEqual(sample, {
    pid: 42,
    timestamp: '2026-09-24T12:34:56.000Z',
    command: '/usr/bin/top -l 1 -pid 42 -stats pid,mem',
    rawOutput: 'PID MEM\n42 512M\n',
    post_response_phys_footprint: 512 * 1024 ** 2,
    post_response_phys_footprint_unit: 'bytes',
    postResponsePhysicalFootprintBytes: 512 * 1024 ** 2,
  });
});
