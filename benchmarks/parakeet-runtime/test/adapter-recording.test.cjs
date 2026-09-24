'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runtimeFixture } = require('./runtime-fixture.cjs');
const { bootstrapRuntime } = require('../src/runtime/bootstrap.cjs');
const { createRuntimeAdapter } = require('../src/runtime/adapters/index.cjs');

test('public adapters reject benchmark chunks and send one complete recording to the runtime', async t => {
  const fixture = await runtimeFixture(t);
  const options = { layout: fixture.layout, lock: fixture.authority };
  await bootstrapRuntime('handy-gguf-q8', options, fixture.dependencies);
  const requests = [];
  const adapter = createRuntimeAdapter('handy-gguf-q8', {
    ...options,
    lockAuthority: fixture.authority,
    createProcessClientImpl: ({ modelIdentityHash }) => {
      const residentIdentity = { processId: 'fixture', modelLoadId: 'one', modelIdentityHash };
      return {
        start: async () => ({ residentIdentity }),
        request: async (type, payload) => {
          requests.push({ type, ...payload });
          return {
            status: 'ok',
            residentIdentity,
            rawTranscript: 'complete recording',
            responseMetadata: {},
          };
        },
        stop: async () => {},
      };
    },
  });
  await adapter.start();
  t.after(() => adapter.stop());
  await adapter.health();
  await adapter.warmup({ audioPath: 'warmup.wav' });
  requests.length = 0;
  for (const audioChunks of [[{ audioPath: 'chunk.wav' }], []]) {
    const result = await adapter.transcribe({ audioPath: 'complete.wav', audioChunks });
    assert.match(result.error?.message ?? '', /complete.recording.*chunk/i);
    assert.deepEqual(requests, [], 'rejected input must not reach the runtime');
  }
  const result = await adapter.transcribe({ audioPath: 'complete.wav' });
  assert.equal(result.rawTranscript, 'complete recording');
  assert.deepEqual(requests, [{ type: 'transcribe', audioPath: 'complete.wav' }]);
  await adapter.stop();
  await adapter.start();
  await adapter.health();
  requests.length = 0;
  const warmup = await adapter.warmup({
    audioPath: 'complete.wav',
    audioChunks: [{ audioPath: 'chunk.wav' }],
  });
  assert.match(warmup.error?.message ?? '', /complete.recording.*chunk/i);
  assert.deepEqual(requests, []);
});
