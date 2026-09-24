'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { resolveLayout } = require('../src/config.cjs');
const { loadRuntimeLock } = require('../src/runtime/locks.cjs');

async function runtimeFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-fixture-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'upstream');
  fs.mkdirSync(source);
  fs.writeFileSync(
    path.join(source, 'CMakeLists.txt'),
    'cmake_minimum_required(VERSION 3.16)\nproject(fixture C)\nadd_executable(probe main.c)\n'
  );
  fs.writeFileSync(
    path.join(source, 'main.c'),
    '#include <stdio.h>\nint main(void) { puts("fixture-built"); return 0; }\n'
  );
  const git = args => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' }).trim();
  git(['init', '-q']);
  git(['add', '.']);
  git([
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'fixture',
  ]);
  const bytes = Buffer.from('synthetic model fixture\n');
  const state = { body: bytes, requests: 0, onRequest: null };
  const server = http.createServer((request, response) => {
    state.requests++;
    state.onRequest?.();
    response.end(state.body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  const authority = structuredClone(loadRuntimeLock());
  const runtime = authority.runtimes[3];
  runtime.source = {
    url: 'https://github.com/fixture/runtime.git',
    revision: git(['rev-parse', 'HEAD']),
    submodules: [],
  };
  runtime.artifacts = [
    {
      path: 'model.bin',
      url: 'https://huggingface.co/fixture/model/resolve/' + 'a'.repeat(40) + '/model.bin',
      sizeBytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    },
  ];
  runtime.modelFile = 'model.bin';
  runtime.command = '{holder}/build-shared/probe';
  runtime.args = [];
  runtime.env = {};
  runtime.build = {
    kind: 'cmake',
    directory: 'build-shared',
    configureArgs: ['-DCMAKE_BUILD_TYPE=Release'],
    outputs: ['build-shared/probe'],
  };
  return {
    root,
    source,
    state,
    runtime,
    authority,
    layout: resolveLayout({ homeDirectory: root }),
    dependencies: {
      authority,
      sourceTransport: () => source,
      fetchImpl: () => fetch(`http://127.0.0.1:${server.address().port}/model`),
    },
  };
}

module.exports = { runtimeFixture };
