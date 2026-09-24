'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { loadRuntimeLock, validateRuntimeLock } = require('../src/runtime/locks.cjs');
const { expectedWasperNativeServerSha256 } = require('../src/runtime/wasper-app.cjs');
const { resolveLayout } = require('../src/config.cjs');
const { resolveRuntimeAdapterDefinition } = require('../src/runtime/adapters/index.cjs');

const ids = [
  'wasper-metal-int8',
  'mlx-fp32',
  'mlx-int8-local',
  'handy-gguf-q8',
  'nvidia-gguf-q8',
  'istupakov-onnx-int8',
  'fluid-coreml-mixed',
];
const HUGGING_FACE_CDN_EDGE_HOST = 'us.aws.cdn.hf.co';

test('loads seven ordered public runtimes and the released Wasper binary identity', () => {
  const lock = loadRuntimeLock();
  assert.deepEqual(
    lock.runtimes.map(runtime => runtime.id),
    ids
  );
  assert.equal(
    expectedWasperNativeServerSha256(lock),
    'b4afc58d5a5995b9a8785cfdd6d1379e7384a4c87b6e178443a23aeea01a51a9'
  );
  for (const runtime of lock.runtimes) {
    assert.deepEqual(runtime.languagePolicy, { mode: 'automatic', languageHint: null });
    assert.equal(runtime.longAudio.input, 'complete-recording');
    assert.equal(runtime.longAudio.benchmarkChunking, false);
    for (const artifact of runtime.artifacts) {
      assert.equal(new URL(artifact.url).protocol, 'https:');
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
    }
  }
  assert.deepEqual(lock.runtimes[1].longAudio.internalWindow, {
    seconds: 120,
    overlapSeconds: 15,
  });
  for (const runtime of lock.runtimes.filter(runtime => runtime.artifactRedirectHosts['huggingface.co'])) {
    assert.ok(
      runtime.artifactRedirectHosts['huggingface.co'].includes(HUGGING_FACE_CDN_EDGE_HOST),
      `${runtime.id} must permit the documented Hugging Face CDN edge`
    );
  }
});

test('load rejects changed public URLs, revisions, hashes, IDs and language policy', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-lock-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'runtimes.json');
  const mutations = [
    lock => {
      lock.runtimes[0].artifacts[0].url += '?changed=1';
    },
    lock => {
      lock.runtimes[3].source.revision = '1'.repeat(40);
    },
    lock => {
      lock.runtimes[0].artifacts[0].sha256 = '1'.repeat(64);
    },
    lock => {
      lock.runtimes[1].id = lock.runtimes[0].id;
    },
    lock => {
      lock.runtimes[0].request.formFields.language = 'en';
    },
    lock => {
      lock.runtimes[2].languagePolicy.languageHint = 'en';
    },
    lock => {
      lock.runtimes[1].longAudio.benchmarkChunking = true;
    },
  ];
  for (const mutate of mutations) {
    const lock = structuredClone(loadRuntimeLock());
    mutate(lock);
    fs.writeFileSync(file, JSON.stringify(lock));
    assert.throws(() => loadRuntimeLock(file), /lock|automatic language|seven|long.audio/i);
  }
});

test('rejects a Wasper descriptor with a language hint', () => {
  const lock = structuredClone(loadRuntimeLock());
  lock.runtimes[0].request.formFields.language = 'en';
  assert.throws(() => validateRuntimeLock(lock), /automatic language/);
});

test('rejects malformed URLs, short revisions and invalid hashes even when authority matches', () => {
  const cases = [
    [
      lock => {
        lock.runtimes[0].artifacts[0].url = 'not-a-url';
      },
      /Invalid URL/,
    ],
    [
      lock => {
        lock.runtimes[0].artifacts[0].url = 'http://github.com/fixture/model';
      },
      /public HTTPS/,
    ],
    [
      lock => {
        lock.runtimes[0].model.revision = 'abc1234';
      },
      /model lock revision/,
    ],
    [
      lock => {
        lock.runtimes[3].source.revision = 'abc1234';
      },
      /source lock revision/,
    ],
    [
      lock => {
        lock.runtimes[0].artifacts[0].sha256 = 'invalid';
      },
      /runtime lock artifact/,
    ],
    [
      lock => {
        lock.runtimes[6].build.binaryDependencies[0].sha256 = 'invalid';
      },
      /binary dependency SHA-256/,
    ],
  ];
  for (const [mutate, expected] of cases) {
    const lock = structuredClone(loadRuntimeLock());
    mutate(lock);
    assert.throws(() => validateRuntimeLock(lock, lock), expected);
  }
});

test('requires each artifact redirect host to be a checked-in public family member', () => {
  const cases = [
    lock => {
      lock.runtimes[0].artifactRedirectHosts['huggingface.co'].push('127.0.0.1');
    },
    lock => {
      delete lock.runtimes[0].artifactRedirectHosts['huggingface.co'];
    },
  ];
  for (const mutate of cases) {
    const lock = structuredClone(loadRuntimeLock());
    mutate(lock);
    assert.throws(() => validateRuntimeLock(lock, lock), /artifact redirect host/i);
  }
});

test('pins NVIDIA’s official macOS Metal runtime archive', () => {
  const nvidia = loadRuntimeLock().runtimes.find(runtime => runtime.id === 'nvidia-gguf-q8');

  assert.deepEqual(
    nvidia.build,
    {
      kind: 'archive',
      directory: 'release',
      archive: {
        path: 'nemo-speech-0.1.0-macos-aarch64-metal.tar.gz',
        url: 'https://github.com/NVIDIA/NeMo-Speech.cpp/releases/download/v0.1.0/nemo-speech-0.1.0-macos-aarch64-metal.tar.gz',
        sha256: 'f1dff4f9dd9c96214f8cb78b982812459132df8a4ad1a42409fd94de4a366244',
        sizeBytes: 3465028,
        root: 'nemo-speech',
      },
      outputs: ['release/nemo-speech/bin/nemo-speech'],
    }
  );
  assert.equal(nvidia.source, undefined);
});

test('adapters derive public artifact and holder paths and selected Python from the lock', () => {
  const layout = resolveLayout();
  const lock = loadRuntimeLock();
  for (const id of ['mlx-fp32', 'handy-gguf-q8', 'nvidia-gguf-q8', 'istupakov-onnx-int8']) {
    const definition = resolveRuntimeAdapterDefinition(id, {
      layout,
      lock,
      python: '/selected/python',
    });
    assert.ok(definition.modelPath.startsWith(path.join(layout.artifactsRoot, id)));
    assert.ok(
      definition.modelArtifacts.every(file =>
        file.startsWith(path.join(layout.artifactsRoot, id))
      )
    );
    if (id !== 'nvidia-gguf-q8') assert.equal(definition.command, '/selected/python');
    else assert.ok(definition.command.startsWith(path.join(layout.holdersRoot, id)));
    assert.deepEqual(definition.longAudio, lock.runtimes.find(row => row.id === id).longAudio);
  }
  for (const id of ['mlx-int8-local', 'fluid-coreml-mixed']) {
    assert.throws(() => resolveRuntimeAdapterDefinition(id, { layout, lock }), /blocked/);
  }
});
