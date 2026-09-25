'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { execFileSync, spawnSync } = childProcess;
const test = require('node:test');
const { resolveLayout, OWNER_FILE } = require('../src/config.cjs');
const { preparePublicCorpus } = require('../src/runtime/corpus/public-corpus.cjs');

const packageRoot = path.resolve(__dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

test('a standalone package runs its HTTP fixture test without an ignored scratch directory', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-standalone-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const standalone = path.join(root, 'benchmarks', 'parakeet-runtime');
  fs.cpSync(packageRoot, standalone, { recursive: true });
  assert.equal(fs.existsSync(path.join(root, '.superpowers')), false);
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-name-pattern=^downloads a short fixture', 'test/public-corpus.test.cjs'],
    {
      cwd: standalone,
      encoding: 'utf8',
      timeout: 30_000,
      env: Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('NODE_TEST_'))
      ),
    }
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /downloads a short fixture/);
});

async function fixtureServer(t, cohort = 'short') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-corpus-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const layout = resolveLayout({ homeDirectory: root });
  // Synthesized silence and text are test material, not corpus material.
  const audioPath = path.join(root, 'synthetic.wav');
  execFileSync('ffmpeg', [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=16000:cl=mono',
    '-t',
    '0.1',
    '-map_metadata',
    '-1',
    '-c:a',
    'pcm_s16le',
    audioPath,
  ]);
  const audio = fs.readFileSync(audioPath);
  const reference = Buffer.from('Synthetic benchmark reference.');
  const routes = new Map([
    ['/audio.wav', audio],
    ['/reference.txt', reference],
  ]);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.url);
    const body = routes.get(req.url);
    if (typeof body === 'function') return body(req, res);
    res.writeHead(body ? 200 : 404);
    res.end(body ?? 'missing');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise(resolve => {
        server.closeAllConnections();
        server.close(resolve);
      })
  );
  const url = `http://127.0.0.1:${server.address().port}`;
  const fixture = {
    fixtureId: `en-${cohort}-synthetic`,
    language: 'en',
    cohort,
    sourceUrl: `${url}/audio.wav`,
    referenceUrl: `${url}/reference.txt`,
    licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'Synthetic test material',
    sourceSha256: hash(audio),
    normalizedWavSha256: hash(audio),
    referenceSha256: hash(reference),
    durationSeconds: 0.1,
    acquisition: {
      state: 'automatic',
      audio: { kind: 'direct' },
      reference: { kind: 'direct', sha256: hash(reference), adapter: 'text-v1' },
    },
  };
  const sourceManifests = [{ schema: 'wasper.public-corpus-sources.v1', fixtures: [fixture] }];
  const prepare = options =>
    preparePublicCorpus({ layout, cohort, ...options }, { sourceManifests });
  return {
    root,
    layout,
    audio,
    reference,
    fixture,
    sourceManifests,
    routes,
    requests,
    prepare,
  };
}

test('an archived HTML transcript recovers the frozen English lexical reference', async t => {
  const f = await fixtureServer(t, 'long');
  const html = Buffer.from('<p>THE PRESIDENT: Fellow citizens: We will succeed. Thank you. (Applause.)</p>');
  const expected = 'Fellow citizens: We will succeed. Thank you.';
  f.routes.set('/reference.txt', html);
  f.fixture.referenceSha256 = hash(expected);
  f.fixture.acquisition.reference = {
    kind: 'direct',
    sha256: hash(html),
    adapter: 'white-house-html-v1',
  };

  const { manifest } = await f.prepare({ acceptSourceTerms: true });
  assert.equal(manifest.fixtures.length, 1);
  assert.equal(manifest.fixtures[0].reference.sha256, hash(expected));
});

test('publisher subtitles recover the frozen Dutch lexical reference', async t => {
  const f = await fixtureServer(t, 'long');
  const srt = Buffer.from(
    Array.from({ length: 88 }, (_, index) => {
      const minute = String(Math.floor(index / 60)).padStart(2, '0');
      const second = String(index % 60).padStart(2, '0');
      const nextMinute = String(Math.floor((index + 1) / 60)).padStart(2, '0');
      const nextSecond = String((index + 1) % 60).padStart(2, '0');
      return `${index + 1}\n00:${minute}:${second},000 --> 00:${nextMinute}:${nextSecond},000\nwoord`;
    }).join('\n\n')
  );
  const expected = `${'woord '.repeat(87)}woord`;
  f.routes.set('/reference.txt', srt);
  f.fixture.language = 'nl';
  f.fixture.fixtureId = 'nl-long-synthetic';
  f.fixture.referenceSha256 = hash(expected);
  f.fixture.acquisition.reference = {
    kind: 'direct',
    sha256: hash(srt),
    adapter: 'royal-srt-v1',
  };

  const { manifest } = await f.prepare({ acceptSourceTerms: true });
  assert.equal(manifest.fixtures.length, 1);
  assert.equal(manifest.fixtures[0].reference.sha256, hash(expected));
});

async function failAfterFfmpegOutput(f, { replaceWithSymlink = false } = {}) {
  const realFfmpeg = execFileSync('which', ['ffmpeg'], { encoding: 'utf8' }).trim();
  const bin = path.join(f.root, 'failure-bin');
  fs.mkdirSync(bin);
  const witness = path.join(f.root, 'normalization-failure.json');
  const external = path.join(f.root, 'external-sentinel.wav');
  fs.writeFileSync(external, 'external data');
  // The real encoder writes a WAV header, then -abort_on empty_output makes
  // FFmpeg itself fail. The wrapper records its real status/output and forwards
  // the original diagnostic; it does not synthesize a subprocess failure.
  fs.writeFileSync(
    path.join(bin, 'ffmpeg'),
    `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const output = args.pop();
const source = args[args.indexOf('-i') + 1];
const outputPath = path.join(path.dirname(source), 'normalized.wav');
const outputDescriptor = Number(path.basename(output));
const descriptorOutput = output.startsWith('/dev/fd/') && Number.isInteger(outputDescriptor);
const result = spawnSync(
  ${JSON.stringify(realFfmpeg)},
  [...args, '-t', '0', '-abort_on', 'empty_output', descriptorOutput ? 'pipe:1' : output],
  descriptorOutput ? { stdio: ['ignore', 'pipe', 'pipe'] } : { encoding: 'utf8' }
);
if (descriptorOutput) fs.writeSync(outputDescriptor, result.stdout);
const bytes = fs.statSync(outputPath).size;
const stderr = descriptorOutput ? result.stderr.toString() : result.stderr;
fs.writeFileSync(${JSON.stringify(witness)}, JSON.stringify({ status: result.status, stderr, bytes }));
if (${replaceWithSymlink}) {
  fs.renameSync(outputPath, outputPath + '.displaced');
  fs.symlinkSync(${JSON.stringify(external)}, outputPath);
}
process.stderr.write(stderr);
process.exit(result.status);
`,
    { mode: 0o700 }
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  let failure;
  try {
    await f.prepare();
  } catch (error) {
    failure = error;
  } finally {
    process.env.PATH = previousPath;
  }
  const observed = JSON.parse(fs.readFileSync(witness, 'utf8'));
  assert.notEqual(observed.status, 0);
  assert.ok(
    observed.bytes > 0,
    `real FFmpeg created a nonempty normalized.wav before failing: ${JSON.stringify(observed)}`
  );
  assert.match(observed.stderr, /Output file is empty/);
  assert.ok(failure, 'normalization must reject');
  return { failure, observed, external };
}

async function failWithOversizedFfmpegOutput(f) {
  const bin = path.join(f.root, 'oversized-output-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'ffmpeg'),
    `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const output = process.argv.at(-1);
const descriptor = Number(path.basename(output));
fs.writeSync(descriptor, Buffer.alloc(1024 * 1024));
`,
    { mode: 0o700 }
  );
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
  try {
    await assert.rejects(f.prepare(), /normalized WAV.*(?:byte cap|too large|exceeds)/i);
  } finally {
    process.env.PATH = previousPath;
  }
}

test('post-output FFmpeg failure removes its partial WAV and preserves the encoder diagnostic', async t => {
  const f = await fixtureServer(t);
  const { failure } = await failAfterFfmpegOutput(f);
  assert.deepEqual(
    {
      diagnostic: /Output file is empty/.test(failure.message),
      cleanupMaskedError: /ENOTEMPTY/.test(failure.message),
      downloads: fs.readdirSync(path.join(f.layout.corpusRoot, 'downloads')),
      fixtures: fs.readdirSync(path.join(f.layout.corpusRoot, 'fixtures')),
    },
    { diagnostic: true, cleanupMaskedError: false, downloads: [], fixtures: [] }
  );
  assert.ok(failure.message.includes(f.fixture.fixtureId));
  assert.ok(failure.message.includes(f.fixture.sourceUrl));
  assert.ok(fs.readdirSync(f.layout.corpusRoot).every(name => !name.startsWith('verified')));
});

test('a controlled oversized FFmpeg result hits the WAV byte cap and leaves no published fixture', async t => {
  const f = await fixtureServer(t);

  await failWithOversizedFfmpegOutput(f);

  assert.deepEqual(fs.readdirSync(path.join(f.layout.corpusRoot, 'fixtures')), []);
  assert.deepEqual(fs.readdirSync(path.join(f.layout.corpusRoot, 'downloads')), []);
});

test('corpus acquisition rejects a local HTTP redirect before it can download or publish a fixture', async t => {
  const f = await fixtureServer(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    assert.equal(options.redirect, 'manual');
    return {
      status: 302,
      ok: false,
      headers: { get: name => (name === 'location' ? 'http://127.0.0.1/attacker.wav' : null) },
    };
  });

  await assert.rejects(f.prepare(), /redirect URL.*public HTTPS/i);

  assert.deepEqual(requests.map(request => request.url), [f.fixture.sourceUrl]);
  assert.deepEqual(fs.readdirSync(path.join(f.layout.corpusRoot, 'downloads')), []);
  assert.deepEqual(fs.readdirSync(path.join(f.layout.corpusRoot, 'fixtures')), []);
});

test('post-output FFmpeg failure preserves its diagnostic when unsafe output cleanup is refused', async t => {
  const f = await fixtureServer(t);
  const { failure, external } = await failAfterFfmpegOutput(f, { replaceWithSymlink: true });
  assert.match(failure.message, /Output file is empty/);
  assert.match(failure.message, /cleanup/);
  assert.equal(fs.readFileSync(external, 'utf8'), 'external data');
  const [attempt] = fs.readdirSync(path.join(f.layout.corpusRoot, 'downloads'));
  assert.equal(
    fs
      .lstatSync(path.join(f.layout.corpusRoot, 'downloads', attempt, 'normalized.wav'))
      .isSymbolicLink(),
    true
  );
  assert.deepEqual(fs.readdirSync(path.join(f.layout.corpusRoot, 'fixtures')), []);
});

test('normalization does not write through a stage path swapped immediately before FFmpeg launches', async t => {
  const f = await fixtureServer(t);
  const external = path.join(f.root, 'external-stage');
  fs.mkdirSync(external);
  const sentinel = path.join(external, 'sentinel');
  fs.writeFileSync(sentinel, 'unchanged');
  let swapped = false;
  const spawn = childProcess.spawn;
  t.mock.method(childProcess, 'spawn', function swapStageBeforeFfmpeg(command, args, options) {
    if (args.some(argument => argument.endsWith('run-normalized-audio.py')) && !swapped) {
      swapped = true;
      assert.equal(args.at(-1), '__WASPER_NORMALIZED_WAV_DESCRIPTOR__');
      const stage = path.dirname(args[args.indexOf('-i') + 1]);
      fs.renameSync(stage, `${stage}.owned-before-swap`);
      fs.symlinkSync(external, stage);
    }
    return spawn.call(this, command, args, options);
  });

  await assert.rejects(f.prepare(), /changed|symlink|cleanup/i);

  assert.equal(swapped, true, 'the stage replacement must run at the FFmpeg launch boundary');
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'unchanged');
  assert.equal(fs.existsSync(path.join(external, 'normalized.wav')), false);
});

test('downloads a short fixture without accepting long-source terms and publishes verified WAV metadata', async t => {
  const f = await fixtureServer(t);
  const result = await f.prepare({ acceptSourceTerms: false });
  assert.deepEqual(f.requests, ['/audio.wav', '/reference.txt']);
  assert.equal(fs.existsSync(path.join(f.layout.cacheRoot, OWNER_FILE)), true);
  assert.equal(result.manifest.fixtures.length, 1);
  const entry = result.manifest.fixtures[0];
  assert.equal(entry.fixtureId, f.fixture.fixtureId);
  assert.equal(entry.normalizedAudio.sha256, f.fixture.normalizedWavSha256);
  assert.equal(entry.normalizedAudio.durationSeconds, 0.1);
  assert.equal(entry.normalizedAudio.sampleRateHz, 16000);
  assert.equal(entry.normalizedAudio.channels, 1);
  assert.equal(entry.normalizedAudio.codec, 'pcm_s16le');
  assert.equal(
    hash(fs.readFileSync(path.join(f.layout.corpusRoot, entry.normalizedAudio.path))),
    f.fixture.normalizedWavSha256
  );
  assert.equal(
    fs.readFileSync(path.join(f.layout.corpusRoot, entry.reference.path), 'utf8'),
    f.reference.toString()
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(result.manifestPath)), result.manifest);
  assert.ok(result.manifestPath.startsWith(`${f.layout.corpusRoot}/`));
  assert.equal(JSON.stringify(result.manifest).includes(f.reference.toString()), false);
  assert.equal(
    fs.existsSync(path.join(f.layout.corpusRoot, 'downloads', `${f.fixture.fixtureId}.part`)),
    false
  );
});

test('does not request a long source until terms are explicitly accepted', async t => {
  const f = await fixtureServer(t, 'long');
  for (const acceptSourceTerms of [undefined, false, 'true', 1]) {
    await assert.rejects(f.prepare({ acceptSourceTerms }), /--accept-source-terms/);
  }
  assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(f.layout.cacheRoot), false);
});

test('a mismatched source hash removes its partial download and names the fixture and source', async t => {
  const f = await fixtureServer(t);
  f.fixture.sourceSha256 = '0'.repeat(64);
  await assert.rejects(f.prepare(), error => {
    assert.match(error.message, /source.*SHA-256/i);
    assert.ok(error.message.includes(f.fixture.fixtureId));
    assert.ok(error.message.includes(f.fixture.sourceUrl));
    return true;
  });
  assert.deepEqual(fs.readdirSync(path.join(f.layout.corpusRoot, 'downloads')), []);
  assert.deepEqual(fs.readdirSync(path.join(f.layout.corpusRoot, 'fixtures')), []);
});

test('a missing reference URL rejects before fetching source audio', async t => {
  const f = await fixtureServer(t);
  delete f.fixture.referenceUrl;
  await assert.rejects(f.prepare(), /en-short-synthetic.*referenceUrl/);
  assert.equal(f.requests.length, 0);
});

test('the public manifests preserve all frozen fixtures with automatic acquisition', () => {
  const short = require('../corpus/short-fleurs.json');
  const long = require('../corpus/long-sources.json');
  assert.equal(short.fixtures.length, 243);
  assert.equal(long.fixtures.length, 21);
  assert.equal(new Set([...short.fixtures, ...long.fixtures].map(f => f.fixtureId)).size, 264);
  assert.ok(long.fixtures.every(f => f.acquisition.state === 'automatic'));
  const english = long.fixtures.find(f => f.language === 'en');
  const dutch = long.fixtures.find(f => f.language === 'nl');
  assert.equal(english.acquisition.reference.adapter, 'white-house-html-v1');
  assert.equal(english.referenceSha256, 'd4d1395438325da7e26d964950cd9fa1d2d637648d49273e56b6920e6bb76499');
  assert.equal(dutch.sourceUrl, 'https://www.rovid.nl/kh/ckh/2015/kh-ckh-20151225-idp0552r8-audio.mp3');
  assert.equal(dutch.sourceSha256, 'd97bd43812ff17da6954f46ed273c63fa10f8d2c9a4274205ef223a44b570c56');
  assert.equal(dutch.acquisition.reference.adapter, 'royal-srt-v1');
  assert.equal(
    long.fixtures.filter(f => f.acquisition.audio?.kind === 'tar-member').length,
    18
  );
  assert.ok(short.fixtures.every(f => f.acquisition.reference.kind === 'fleurs-tsv'));
  const de = long.fixtures.find(f => f.fixtureId === 'de-long-mtedx-pr8ssedsli');
  assert.equal(de.sourceUrl, 'https://www.openslr.org/resources/100/mtedx_de.tgz');
  assert.equal(de.acquisition.audio.member, 'de-de/data/test/wav/pR_8SsedSLI.flac');
  assert.equal(
    de.acquisition.audio.archiveSha256,
    '85ba1be12f1fe91d1e14f0c33b29c3b8ca93d0214218ef4f046969c157d87f59'
  );
  assert.equal(
    de.normalizedWavSha256,
    'a345a7dce2fe917c5ee294c76d7912dbe02bdb75ee1541a665512689b75c42f8'
  );
  assert.equal(de.licenseUrl, 'https://creativecommons.org/licenses/by-nc-nd/4.0/');
  // Independently projected from the frozen selection: IDs, language, cohort,
  // source/WAV/reference hashes and exact normalized durations for all 264 rows.
  const identities = [...short.fixtures, ...long.fixtures]
    .map(
      ({
        fixtureId,
        language,
        cohort,
        sourceSha256,
        normalizedWavSha256,
        referenceSha256,
        durationSeconds,
      }) => ({
        fixtureId,
        language,
        cohort,
        sourceSha256,
        normalizedWavSha256,
        referenceSha256,
        durationSeconds,
      })
    )
    .sort((a, b) => a.fixtureId.localeCompare(b.fixtureId));
  assert.equal(
    hash(JSON.stringify(identities)),
    '8e4bdd5ebd6f56ef430afe8f35924bb94a6b78d8e21abd682a9629f90d52ad52'
  );
});

test('manual input states fail closed before any request and name every blocked fixture and source', async t => {
  const f = await fixtureServer(t, 'long');
  f.fixture.acquisition = {
    state: 'manual-authorized-input-required',
    reason: 'Exact reference has no public locator',
  };
  f.fixture.referenceUrl = null;
  const second = {
    ...f.fixture,
    fixtureId: 'nl-long-synthetic',
    language: 'nl',
    sourceUrl: f.fixture.sourceUrl + '?second',
  };
  f.sourceManifests[0].fixtures.push(second);
  await assert.rejects(f.prepare({ acceptSourceTerms: true }), error => {
    assert.match(error.message, /manual-authorized-input-required/);
    for (const fixture of [f.fixture, second]) {
      assert.ok(error.message.includes(fixture.fixtureId));
      assert.ok(error.message.includes(fixture.sourceUrl));
    }
    return true;
  });
  assert.equal(f.requests.length, 0);
  assert.equal(fs.existsSync(f.layout.cacheRoot), false);
});

test('the Dutch public record uses the original MP3 and matching subtitle source', () => {
  const dutch = require('../corpus/long-sources.json').fixtures.find(
    fixture => fixture.fixtureId === 'nl-long-royal-household-2015'
  );
  const frozen = 'd97bd43812ff17da6954f46ed273c63fa10f8d2c9a4274205ef223a44b570c56';
  assert.equal(dutch.sourceSha256, frozen);
  assert.equal(dutch.acquisition.state, 'automatic');
  assert.equal(dutch.acquisition.audio.kind, 'direct');
  assert.equal(dutch.acquisition.reference.sha256, '3d5546911b48c1ed2a62da9806ee79df6a21ae2dc9ff74591816c9ff509b5e5a');
});

test('synthetic integrity conflicts validate both hashes and remain exclusive to blocked acquisition', async t => {
  const f = await fixtureServer(t, 'long');
  const conflicted = structuredClone(f.fixture);
  conflicted.acquisition = {
    state: 'manual-authorized-input-required',
    reason: 'The source identity is unresolved.',
    integrityConflict: {
      reason: 'The downloaded bytes differ from the frozen source.',
      frozenSourceSha256: f.fixture.sourceSha256,
      registrySourceSha256: '0'.repeat(64),
      sourceLocatorStatus: 'unverified-against-frozen-identity',
    },
  };
  const fixtures = f.sourceManifests[0].fixtures;
  fixtures[0] = structuredClone(conflicted);
  await assert.rejects(f.prepare({ acceptSourceTerms: true }), /integrity-conflict/);
  for (const mutate of [
    fixture => {
      fixture.acquisition.integrityConflict.frozenSourceSha256 = '0'.repeat(64);
    },
    fixture => {
      fixture.acquisition.integrityConflict.registrySourceSha256 = fixture.sourceSha256;
    },
    fixture => {
      delete fixture.acquisition.integrityConflict.registrySourceSha256;
    },
    fixture => {
      fixture.acquisition.integrityConflict.sourceLocatorStatus = 'verified';
    },
    fixture => {
      fixture.acquisition.integrityConflict.privateNotes = 'not publishable';
    },
    fixture => {
      fixture.acquisition.state = 'automatic';
    },
  ]) {
    fixtures[0] = structuredClone(conflicted);
    mutate(fixtures[0]);
    await assert.rejects(
      f.prepare({ acceptSourceTerms: true }),
      /invalid public source metadata/
    );
  }
  assert.equal(fs.existsSync(f.layout.cacheRoot), false);
  assert.equal(f.requests.length, 0);
});

test('verifies the archive and both members and derives the exact mTEDx reference after acceptance', async t => {
  const f = await fixtureServer(t, 'long');
  const vtt =
    'WEBVTT\n\n00:00.000 --> 00:00.010\nTranscription: synthetic\n\n00:00.010 --> 00:00.090\nSynthetic benchmark reference.\n\n00:00.090 --> 00:00.100\n(Applause)\n';
  fs.writeFileSync(path.join(f.root, 'synthetic.vtt'), vtt);
  const archive = execFileSync(
    'tar',
    ['-czf', '-', '-C', f.root, 'synthetic.wav', 'synthetic.vtt'],
    { env: { ...process.env, LC_ALL: 'C' } }
  );
  f.fixture.sourceUrl = f.fixture.sourceUrl.replace('audio.wav', 'archive.tgz');
  f.fixture.referenceUrl = f.fixture.sourceUrl;
  f.routes.set('/archive.tgz', archive);
  f.fixture.acquisition.audio = {
    kind: 'tar-member',
    archiveSha256: hash(archive),
    member: 'synthetic.wav',
  };
  f.fixture.acquisition.reference = {
    kind: 'tar-member',
    archiveSha256: hash(archive),
    member: 'synthetic.vtt',
    sha256: hash(vtt),
    adapter: 'mtedx-vtt-v1',
    excludedCues: [{ sha256: hash('(Applause)'), occurrences: 1 }],
  };
  const result = await f.prepare({ acceptSourceTerms: true });
  assert.deepEqual(f.requests, ['/archive.tgz']);
  assert.equal(
    fs.readFileSync(
      path.join(f.layout.corpusRoot, result.manifest.fixtures[0].reference.path),
      'utf8'
    ),
    f.reference.toString()
  );
});

test('FLEURS uses the literal raw TSV reference for the exact selected filename', async t => {
  const f = await fixtureServer(t);
  const raw = 'Literal "quoted" test reference.';
  const tsv = `5\tsynthetic.wav\t${raw}\tother normalized text\t4\t1600\t0\n`;
  f.routes.set('/reference.txt', Buffer.from(tsv));
  f.fixture.referenceSha256 = hash(raw);
  f.fixture.acquisition.reference = {
    kind: 'fleurs-tsv',
    sha256: hash(tsv),
    itemId: 'synthetic.wav',
    adapter: 'fleurs-tsv-v1',
  };
  const result = await f.prepare();
  assert.equal(
    fs.readFileSync(
      path.join(f.layout.corpusRoot, result.manifest.fixtures[0].reference.path),
      'utf8'
    ),
    raw
  );
});

test('the Polish source adapter preserves the frozen text preparation', async t => {
  const f = await fixtureServer(t, 'long');
  const text = 'Synthetic benchmark\nreference.\n-----\nSynthetic publisher footer';
  f.routes.set('/reference.txt', Buffer.from(text));
  f.fixture.acquisition.reference = {
    kind: 'direct',
    sha256: hash(text),
    adapter: 'wolne-lektury-txt-v1',
  };
  const result = await f.prepare({ acceptSourceTerms: true });
  assert.equal(result.manifest.fixtures[0].reference.sha256, f.fixture.referenceSha256);
});

test('invalid acquisition metadata fails before any network request', async t => {
  for (const mutate of [
    f => {
      f.acquisition.state = 'automatic-typo';
    },
    f => {
      f.acquisition.audio.kind = 'unknown';
    },
    f => {
      f.acquisition.audio = {
        kind: 'tar-member',
        member: '../escape',
        archiveSha256: 'a'.repeat(64),
      };
    },
    f => {
      f.acquisition.reference.adapter = 'unknown';
    },
    f => {
      f.acquisition.reference.sha256 = 'invalid';
    },
    f => {
      f.privateNotes = 'not publishable';
    },
  ]) {
    const f = await fixtureServer(t);
    mutate(f.fixture);
    await assert.rejects(f.prepare(), /en-short-synthetic/);
    assert.equal(f.requests.length, 0);
  }
});

test('reference, normalized hash, and duration failures never promote a fixture or manifest', async t => {
  for (const mutate of [
    f => {
      f.fixture.acquisition.reference.sha256 = '0'.repeat(64);
    },
    f => {
      f.fixture.referenceSha256 = '0'.repeat(64);
    },
    f => {
      f.fixture.normalizedWavSha256 = '0'.repeat(64);
    },
    f => {
      f.fixture.durationSeconds = 5;
    },
    f => {
      f.routes.delete('/reference.txt');
    },
  ]) {
    const f = await fixtureServer(t);
    mutate(f);
    await assert.rejects(f.prepare(), /en-short-synthetic.*(SHA-256|duration|HTTP 404)/);
    assert.deepEqual(fs.readdirSync(path.join(f.layout.corpusRoot, 'fixtures')), []);
    assert.deepEqual(fs.readdirSync(path.join(f.layout.corpusRoot, 'downloads')), []);
    assert.ok(fs.readdirSync(f.layout.corpusRoot).every(name => !name.startsWith('verified')));
  }
});

test('an interrupted HTTP body removes only this attempt partials and can be retried', async t => {
  const f = await fixtureServer(t);
  f.routes.set('/audio.wav', (_req, res) => {
    res.writeHead(200, { 'Content-Length': f.audio.length });
    res.write(f.audio.subarray(0, 100));
    setImmediate(() => res.destroy());
  });
  await assert.rejects(f.prepare(), /en-short-synthetic/);
  assert.deepEqual(fs.readdirSync(path.join(f.layout.corpusRoot, 'downloads')), []);
  f.routes.set('/audio.wav', f.audio);
  assert.equal((await f.prepare()).manifest.fixtures.length, 1);
});

test('existing partial downloads are neither overwritten nor removed', async t => {
  const f = await fixtureServer(t);
  const { writeOwnershipMarker } = require('../src/config.cjs');
  writeOwnershipMarker(f.layout);
  fs.mkdirSync(path.join(f.layout.corpusRoot, 'downloads'), { recursive: true });
  const part = path.join(f.layout.corpusRoot, 'downloads', `${f.fixture.fixtureId}.part`);
  fs.writeFileSync(part, 'another acquisition owns this');
  await assert.rejects(f.prepare(), /en-short-synthetic.*EEXIST/);
  assert.equal(fs.readFileSync(part, 'utf8'), 'another acquisition owns this');
  assert.equal(f.requests.length, 0);
});

test('a symlinked corpus directory cannot redirect acquisition outside the owned cache', async t => {
  const f = await fixtureServer(t);
  const { writeOwnershipMarker } = require('../src/config.cjs');
  writeOwnershipMarker(f.layout);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, f.layout.corpusRoot);
  await assert.rejects(f.prepare(), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(f.requests.length, 0);
});

test('the CLI routes public corpus preparation and source acceptance through the public layout', async t => {
  const f = await fixtureServer(t, 'long');
  const { runCli } = require('../src/cli.cjs');
  const output = [];
  const result = await runCli(
    [
      'recover-corpus',
      '--cohort',
      'long',
      '--accept-source-terms',
      '--cache-dir',
      f.layout.cacheRoot,
    ],
    {
      homeDirectory: f.root,
      stdout: { write: value => output.push(value) },
      recoverCorpusImpl: options =>
        preparePublicCorpus(options, { sourceManifests: f.sourceManifests }),
    }
  );
  assert.ok(result.manifestPath.startsWith(f.layout.corpusRoot));
  assert.equal(JSON.parse(output.join('')).manifestPath, result.manifestPath);
  assert.equal(f.requests.length, 2);
});

test('a cache directory replaced during HTTP transfer leaves the external target intact and names the fixture', async t => {
  const f = await fixtureServer(t);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  const sentinel = path.join(outside, `${f.fixture.fixtureId}.part`);
  fs.writeFileSync(sentinel, 'external data');
  let swapped = false;
  f.routes.set('/audio.wav', (_req, res) => {
    const downloads = path.join(f.layout.corpusRoot, 'downloads');
    fs.renameSync(downloads, `${downloads}-displaced`);
    fs.symlinkSync(outside, downloads);
    swapped = true;
    res.end(f.audio);
  });
  await assert.rejects(f.prepare(), /en-short-synthetic.*changed/);
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external data');
  assert.deepEqual(fs.readdirSync(outside), [`${f.fixture.fixtureId}.part`]);
});

test('archive links, duplicate members, traversal paths, missing members, and changed archive bytes fail closed', async t => {
  for (const variant of ['link', 'duplicate', 'traversal', 'missing', 'wrong-hash']) {
    const f = await fixtureServer(t);
    const archive = execFileSync(
      'python3',
      [
        '-c',
        [
          'import io,sys,tarfile',
          'data=sys.stdin.buffer.read()',
          'out=io.BytesIO()',
          'with tarfile.open(fileobj=out,mode="w:gz") as t:',
          ' for n in range(2 if sys.argv[1]=="duplicate" else 1):',
          '  name="../escape" if sys.argv[1]=="traversal" else "absent.wav" if sys.argv[1]=="missing" else "synthetic.wav"',
          '  m=tarfile.TarInfo(name)',
          '  if sys.argv[1]=="link": m.type=tarfile.SYMTYPE; m.linkname="../escape"',
          '  else: m.size=len(data)',
          '  t.addfile(m,io.BytesIO(data))',
          'sys.stdout.buffer.write(out.getvalue())',
        ].join('\n'),
        variant,
      ],
      { input: f.audio }
    );
    f.routes.set('/audio.wav', archive);
    f.fixture.acquisition.audio = {
      kind: 'tar-member',
      archiveSha256: variant === 'wrong-hash' ? '0'.repeat(64) : hash(archive),
      member: 'synthetic.wav',
    };
    await assert.rejects(f.prepare(), /en-short-synthetic.*(archive|member)/s);
    assert.deepEqual(fs.readdirSync(path.join(f.layout.corpusRoot, 'fixtures')), []);
    assert.ok(
      fs
        .readdirSync(path.join(f.layout.corpusRoot, 'downloads'))
        .every(name => name.endsWith('.archive'))
    );
  }
});

test('invalid audio with a matching source hash cannot leave normalization partials', async t => {
  const f = await fixtureServer(t);
  const invalid = Buffer.from('not audio');
  f.routes.set('/audio.wav', invalid);
  f.fixture.sourceSha256 = hash(invalid);
  await assert.rejects(f.prepare(), /en-short-synthetic/);
  assert.deepEqual(fs.readdirSync(path.join(f.layout.corpusRoot, 'downloads')), []);
  assert.deepEqual(fs.readdirSync(path.join(f.layout.corpusRoot, 'fixtures')), []);
});
