'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { NORMALIZED_AUDIO_TRANSFORM, sha256File } = require('./audio-cache.cjs');
const {
  BYTE_LIMITS,
  assertDirectoryChain,
  bindTrustedRoot,
  snapshotRegularFile,
} = require('./bounded-file-snapshot.cjs');
const { LANGUAGES } = require('./constants.cjs');
const { isManifestFixtureId } = require('./fixture-id.cjs');
const { canonicalJson } = require('./manifest.cjs');
const { characterUnits, wordUnits } = require('./normalization.cjs');

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const REGISTRY_SCHEMA = 'wasper.asr-quality.long-source-registry.v1';
const BENCHMARK_REVISION = 'wasper-asr-quality-v1';
const PREPARED_SCHEMA = 'wasper.asr-quality.prepared-long-corpus.v1';
// MP3 container duration can differ from the exact decoded PCM duration because
// of encoder delay and timeline metadata. The normalized WAV remains subject to
// the strict quarter-second contract below.
const SOURCE_DURATION_TOLERANCE_SECONDS = 5;
const NORMALIZED_DURATION_TOLERANCE_SECONDS = 0.25;
const REFERENCE_ADAPTERS = new Set([
  'mtedx-vtt-v1',
  'royal-srt-v1',
  'white-house-pdf-v1',
  'wolne-lektury-txt-v1',
]);
const REGISTRY_FIELDS = Object.freeze([
  'fixtureId',
  'language',
  'recordingId',
  'collection',
  'release',
  'title',
  'sourceRelativePath',
  'sourceSha256',
  'sourceBytes',
  'durationSeconds',
  'referenceRelativePath',
  'referenceSha256',
  'referenceBytes',
  'audioPage',
  'referencePage',
  'licenseId',
  'licenseUrl',
  'attribution',
  'referenceAdapter',
  'excludedReferenceCues',
]);

function fail(message) {
  throw new Error(message);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function exactObject(value, fields, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail(`${label} keys are invalid`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is invalid`);
}

function safeRelativePath(value, label) {
  nonEmptyString(value, label);
  if (path.posix.isAbsolute(value) || value.includes('\\'))
    fail(`${label} relative path is invalid`);
  const parts = value.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) {
    fail(`${label} relative path is invalid`);
  }
}

function httpsUrl(value, label) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname === '' ||
      url.username !== '' ||
      url.password !== ''
    ) {
      throw new Error('invalid URL');
    }
  } catch {
    fail(`${label} must be an HTTPS URL without credentials`);
  }
}

function isParenthesizedOnlyCue(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  let index = 0;
  let groups = 0;
  const skipWhitespace = () => {
    while (index < value.length && value[index].trim() === '') index += 1;
  };
  skipWhitespace();
  while (index < value.length) {
    if (value[index] !== '(') return false;
    index += 1;
    const contentStart = index;
    while (index < value.length && value[index] !== ')') {
      if (value[index] === '(') return false;
      index += 1;
    }
    if (index === contentStart || index >= value.length) return false;
    index += 1;
    groups += 1;
    skipWhitespace();
  }
  return groups > 0;
}

function validateExcludedReferenceCues(value, label) {
  if (!Array.isArray(value) || value.length > 128) {
    fail(`${label} must be a bounded array`);
  }
  const seen = new Set();
  for (const [index, entry] of value.entries()) {
    exactObject(entry, ['text', 'occurrences'], `${label}[${index}]`);
    if (
      typeof entry.text !== 'string' ||
      entry.text.length > 256 ||
      !isParenthesizedOnlyCue(entry.text) ||
      !Number.isSafeInteger(entry.occurrences) ||
      entry.occurrences <= 0 ||
      seen.has(entry.text)
    ) {
      fail(`${label}[${index}] is invalid`);
    }
    seen.add(entry.text);
  }
  return value;
}

function validateLongSourceRegistry(value) {
  exactObject(
    value,
    ['schema', 'benchmarkRevision', 'expectedFixtureCount', 'redistribution', 'items'],
    'long source registry'
  );
  if (
    value.schema !== REGISTRY_SCHEMA ||
    value.benchmarkRevision !== BENCHMARK_REVISION ||
    value.expectedFixtureCount !== 21 ||
    value.redistribution !== 'prohibited' ||
    !Array.isArray(value.items) ||
    value.items.length !== 21
  ) {
    fail('long source registry must contain exactly 21 fixtures with redistribution prohibited');
  }
  const fixtureIds = new Set();
  const languages = new Set();
  for (const [index, item] of value.items.entries()) {
    exactObject(item, REGISTRY_FIELDS, `long source registry item ${index}`);
    if (
      !LANGUAGES.includes(item.language) ||
      !isManifestFixtureId(item.fixtureId) ||
      !item.fixtureId.startsWith(`${item.language}-long-`) ||
      fixtureIds.has(item.fixtureId)
    ) {
      fail(`long source registry item ${index} identity is invalid`);
    }
    fixtureIds.add(item.fixtureId);
    languages.add(item.language);
    for (const field of [
      'recordingId',
      'collection',
      'release',
      'title',
      'licenseId',
      'attribution',
    ]) {
      nonEmptyString(item[field], `long source registry item ${index}.${field}`);
    }
    safeRelativePath(
      item.sourceRelativePath,
      `long source registry item ${index}.sourceRelativePath`
    );
    safeRelativePath(
      item.referenceRelativePath,
      `long source registry item ${index}.referenceRelativePath`
    );
    if (
      !SHA256_PATTERN.test(item.sourceSha256) ||
      !SHA256_PATTERN.test(item.referenceSha256) ||
      !Number.isSafeInteger(item.sourceBytes) ||
      item.sourceBytes <= 0 ||
      !Number.isSafeInteger(item.referenceBytes) ||
      item.referenceBytes <= 0 ||
      !Number.isFinite(item.durationSeconds) ||
      item.durationSeconds < 120 ||
      item.durationSeconds > 1800 ||
      !REFERENCE_ADAPTERS.has(item.referenceAdapter)
    ) {
      fail(`long source registry item ${index} media contract is invalid`);
    }
    httpsUrl(item.audioPage, `long source registry item ${index}.audioPage`);
    httpsUrl(item.referencePage, `long source registry item ${index}.referencePage`);
    httpsUrl(item.licenseUrl, `long source registry item ${index}.licenseUrl`);
    validateExcludedReferenceCues(
      item.excludedReferenceCues,
      `long source registry item ${index}.excludedReferenceCues`
    );
    if (item.referenceAdapter !== 'mtedx-vtt-v1' && item.excludedReferenceCues.length !== 0) {
      fail(`long source registry item ${index}.excludedReferenceCues is only valid for mTEDx`);
    }
  }
  if (languages.size !== LANGUAGES.length || LANGUAGES.some(language => !languages.has(language))) {
    fail('long source registry must cover all nine languages');
  }
  return deepFreeze(JSON.parse(JSON.stringify(value)));
}

function stripMarkup(value) {
  return value
    .replace(/<[^>]*>/gu, ' ')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>');
}

function collapseLines(value) {
  return stripMarkup(value)
    .replace(/\r\n?/gu, '\n')
    .replace(/-\n(?=\p{L})/gu, '-')
    .replace(/\s+/gu, ' ')
    .trim();
}

function timedTextBlocks(source, kind) {
  const blocks = source
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .split(/\n{2,}/u)
    .map(block => block.trim())
    .filter(Boolean);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex(line => line.includes('-->'));
    if (timingIndex === -1) continue;
    const text = collapseLines(lines.slice(timingIndex + 1).join('\n'));
    if (text !== '') cues.push(text);
  }
  if (cues.length === 0) fail(`${kind} reference has no timed cue`);
  return cues;
}

function deriveMtedxReference(source, excludedReferenceCues) {
  if (typeof source !== 'string' || !/^WEBVTT(?:\r?\n|$)/u.test(source)) {
    fail('mTEDx reference is not WebVTT');
  }
  validateExcludedReferenceCues(excludedReferenceCues, 'mTEDx excludedReferenceCues');
  const cues = timedTextBlocks(source, 'mTEDx');
  const credit = cues[0];
  if (
    !/(?:transkrib|lektora|lektorat|tradutt|revisor|μετάφραση|επιμέλεια|transcri|relect|revis|tradu)/iu.test(
      credit
    )
  ) {
    fail('mTEDx reference first cue is not the editorial credit');
  }
  const exclusions = new Map(
    excludedReferenceCues.map(entry => [entry.text, { expected: entry.occurrences, observed: 0 }])
  );
  const lexical = [];
  for (const cue of cues.slice(1)) {
    const exclusion = exclusions.get(cue);
    if (exclusion) {
      exclusion.observed += 1;
      continue;
    }
    if (isParenthesizedOnlyCue(cue)) {
      fail(`mTEDx reference contains unaudited non-speech cue: ${cue}`);
    }
    lexical.push(cue);
  }
  for (const [text, count] of exclusions) {
    if (count.observed !== count.expected) {
      fail(
        `mTEDx excluded cue occurrence count drifted for ${text}: expected ${count.expected}, observed ${count.observed}`
      );
    }
  }
  if (lexical.length === 0) fail('mTEDx reference has no lexical cue');
  return lexical.join(' ');
}

function deriveWhiteHouseReference(source) {
  if (typeof source !== 'string') fail('White House reference boundary is missing');
  const start = 'THE PRESIDENT:';
  const end = 'Thank you.';
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (
    startIndex === -1 ||
    endIndex === -1 ||
    source.includes(start, startIndex + start.length) ||
    source.includes(end, endIndex + end.length)
  ) {
    fail('White House reference boundary is missing or duplicated');
  }
  return collapseLines(source.slice(startIndex + start.length, endIndex + end.length));
}

function deriveRoyalSrtReference(source) {
  if (typeof source !== 'string') fail('Royal Household reference has no timed cue');
  const blocks = source
    .replace(/^\uFEFF/u, '')
    .replace(/\r\n?/gu, '\n')
    .split(/\n{2,}/u)
    .map(block => block.trim())
    .filter(Boolean);
  if (blocks.length !== 88) {
    fail(`Royal Household reference must contain exactly 88 cues, observed ${blocks.length}`);
  }
  const timestamp = /^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/u;
  const milliseconds = groups => {
    const values = groups.map(Number);
    const [hours, minutes, seconds, millis] = values;
    if (minutes > 59 || seconds > 59) return null;
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
  };
  let previousEnd = -1;
  const cues = blocks.map((block, index) => {
    const expectedCue = index + 1;
    const lines = block.split('\n');
    if (lines[0] !== String(expectedCue)) {
      fail(`Royal Household cue ${expectedCue} is missing, duplicated, or out of order`);
    }
    const match = timestamp.exec(lines[1] || '');
    if (match === null) fail(`Royal Household cue ${expectedCue} timestamp is invalid`);
    const start = milliseconds(match.slice(1, 5));
    const end = milliseconds(match.slice(5, 9));
    if (start === null || end === null || start < previousEnd || end <= start) {
      fail(`Royal Household cue ${expectedCue} timestamps are not monotonic`);
    }
    previousEnd = end;
    const text = collapseLines(lines.slice(2).join('\n'));
    if (text === '') fail(`Royal Household cue ${expectedCue} text is empty`);
    return text;
  });
  return cues
    .join(' ')
    .replace(/\.{3}\s+\.{3}/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function deriveWolneLekturyReference(source) {
  if (typeof source !== 'string') fail('Wolne Lektury reference footer is missing');
  const matches = [...source.matchAll(/^-----\s*$/gmu)];
  if (matches.length !== 1) fail('Wolne Lektury reference footer is missing or duplicated');
  const text = collapseLines(source.slice(0, matches[0].index));
  if (text === '') fail('Wolne Lektury reference body is empty');
  return text;
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

function resolveRegisteredFile(root, relative, label) {
  const absolute = path.resolve(root.realPath, ...relative.split('/'));
  if (!absolute.startsWith(`${root.realPath}${path.sep}`)) fail(`${label} escapes source root`);
  let current = root.realPath;
  for (const segment of relative.split('/').slice(0, -1)) {
    current = path.join(current, segment);
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail(`${label} contains a symlink or non-directory ancestor`);
    }
  }
  return absolute;
}

function inspectRegisteredSource(root, fixture) {
  const label = `${fixture.fixtureId} source`;
  const sourcePath = resolveRegisteredFile(root, fixture.sourceRelativePath, label);
  const namedBefore = fs.lstatSync(sourcePath);
  if (namedBefore.isSymbolicLink() || !namedBefore.isFile()) {
    fail(`${label} integrity requires a non-symlink regular file`);
  }
  if (namedBefore.size !== fixture.sourceBytes) fail(`${label} integrity byte size drifted`);
  const descriptor = fs.openSync(
    sourcePath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
  );
  try {
    const openedBefore = fs.fstatSync(descriptor);
    if (!sameFileIdentity(namedBefore, openedBefore)) fail(`${label} integrity changed on open`);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (total <= fixture.sourceBytes) {
      const length = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (length === 0) break;
      total += length;
      if (total > fixture.sourceBytes) fail(`${label} integrity grew while hashing`);
      hash.update(buffer.subarray(0, length));
    }
    const openedAfter = fs.fstatSync(descriptor);
    const namedAfter = fs.lstatSync(sourcePath);
    if (
      total !== fixture.sourceBytes ||
      !sameFileIdentity(openedBefore, openedAfter) ||
      !sameFileIdentity(openedAfter, namedAfter)
    ) {
      fail(`${label} integrity changed while hashing`);
    }
    if (hash.digest('hex') !== fixture.sourceSha256) fail(`${label} integrity hash drifted`);
  } finally {
    fs.closeSync(descriptor);
  }
  return sourcePath;
}

function runTool(command, arguments_, label, { maxBuffer = 1024 * 1024 } = {}) {
  const result = childProcess.spawnSync(command, arguments_, {
    encoding: 'utf8',
    maxBuffer,
    timeout: 60 * 60 * 1000,
  });
  if (result.error) fail(`${label} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = String(result.stderr || '')
      .trim()
      .slice(0, 4096);
    fail(`${label} exited with ${String(result.status)}${detail === '' ? '' : `: ${detail}`}`);
  }
  return result.stdout;
}

function defaultProbeDuration({ inputPath }) {
  const output = runTool(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', inputPath],
    `ffprobe ${path.basename(inputPath)}`
  );
  const durationSeconds = Number(output.trim());
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    fail(`ffprobe returned an invalid duration for ${path.basename(inputPath)}`);
  }
  return durationSeconds;
}

function defaultExtractPdfText({ inputPath }) {
  return runTool('pdftotext', ['-raw', inputPath, '-'], `pdftotext ${path.basename(inputPath)}`, {
    maxBuffer: BYTE_LIMITS.text,
  });
}

function defaultNormalizeAudio({ fixture, inputPath, outputPath }) {
  const arguments_ = NORMALIZED_AUDIO_TRANSFORM.arguments.map(argument => {
    if (argument === '{sourcePath}') return inputPath;
    if (argument === '{temporaryWavPath}') return outputPath;
    return argument;
  });
  runTool(NORMALIZED_AUDIO_TRANSFORM.tool, arguments_, `normalize ${fixture.fixtureId}`, {
    maxBuffer: 64 * 1024,
  });
  const info = fs.lstatSync(outputPath);
  if (info.isSymbolicLink() || !info.isFile() || info.size <= 0) {
    fail(`${fixture.fixtureId} normalized WAV is invalid`);
  }
  return {
    durationSeconds: defaultProbeDuration({ inputPath: outputPath }),
    wavSha256: sha256File(outputPath),
    wavBytes: info.size,
  };
}

function referenceText(fixture, bytes, extractPdfText, referencePath) {
  const source =
    fixture.referenceAdapter === 'white-house-pdf-v1'
      ? extractPdfText({ fixture, inputPath: referencePath })
      : bytes.toString('utf8');
  switch (fixture.referenceAdapter) {
    case 'mtedx-vtt-v1':
      return deriveMtedxReference(source, fixture.excludedReferenceCues);
    case 'royal-srt-v1':
      return deriveRoyalSrtReference(source);
    case 'white-house-pdf-v1':
      return deriveWhiteHouseReference(source);
    case 'wolne-lektury-txt-v1':
      return deriveWolneLekturyReference(source);
    default:
      fail(`Unknown long reference adapter ${fixture.referenceAdapter}`);
  }
}

function existingPreparedManifest(outputRoot) {
  const manifestPath = path.join(outputRoot, 'long-prepared.json');
  if (!fs.existsSync(manifestPath)) return { manifestPath, value: null };
  const snapshot = snapshotRegularFile(manifestPath, {
    label: 'existing prepared long manifest',
    root: bindTrustedRoot(outputRoot, 'prepared long output root'),
    maxBytes: BYTE_LIMITS.json,
  });
  let value;
  try {
    value = JSON.parse(snapshot.bytes.toString('utf8'));
  } catch (error) {
    fail(`existing prepared long manifest is invalid JSON: ${error.message}`);
  }
  return { manifestPath, value };
}

function prepareLongCorpus(options, dependencies = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('long corpus preparation options must be an object');
  }
  const registry = validateLongSourceRegistry(options.registry);
  nonEmptyString(options.sourceRoot, 'sourceRoot');
  nonEmptyString(options.outputRoot, 'outputRoot');
  nonEmptyString(options.generatedAt, 'generatedAt');
  if (Number.isNaN(Date.parse(options.generatedAt))) fail('generatedAt must be an ISO timestamp');
  const sourceRoot = bindTrustedRoot(options.sourceRoot, 'long source root');
  fs.mkdirSync(options.outputRoot, { recursive: true, mode: 0o700 });
  const outputRoot = bindTrustedRoot(options.outputRoot, 'prepared long output root');
  const playbackPath = path.join(outputRoot.realPath, 'playback');
  try {
    fs.mkdirSync(playbackPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = fs.lstatSync(playbackPath);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      fail('prepared long playback root must be a non-symlink directory');
    }
  }
  const playbackRoot = bindTrustedRoot(playbackPath, 'prepared long playback root');
  assertDirectoryChain(outputRoot.ancestors, 'prepared long output root', fs);
  if (path.dirname(playbackRoot.realPath) !== outputRoot.realPath) {
    fail('prepared long playback root escaped its output root');
  }
  const previous = existingPreparedManifest(outputRoot.realPath);
  const previousById = new Map((previous.value?.items || []).map(item => [item.fixtureId, item]));
  const normalizeAudio = dependencies.normalizeAudio || defaultNormalizeAudio;
  const probeDuration = dependencies.probeDuration || defaultProbeDuration;
  const extractPdfText = dependencies.extractPdfText || defaultExtractPdfText;
  const items = [];

  for (const fixture of registry.items) {
    const sourcePath = inspectRegisteredSource(sourceRoot, fixture);
    const observedSourceDuration = probeDuration({ fixture, inputPath: sourcePath });
    if (
      !Number.isFinite(observedSourceDuration) ||
      Math.abs(observedSourceDuration - fixture.durationSeconds) > SOURCE_DURATION_TOLERANCE_SECONDS
    ) {
      fail(`${fixture.fixtureId} source duration drifted`);
    }
    const referencePath = resolveRegisteredFile(
      sourceRoot,
      fixture.referenceRelativePath,
      `${fixture.fixtureId} reference`
    );
    const reference = snapshotRegularFile(referencePath, {
      label: `${fixture.fixtureId} reference`,
      root: sourceRoot,
      maxBytes: BYTE_LIMITS.text,
    });
    if (
      reference.bytes.length !== fixture.referenceBytes ||
      reference.sha256 !== fixture.referenceSha256
    ) {
      fail(`${fixture.fixtureId} reference integrity drifted`);
    }
    const text = referenceText(fixture, reference.bytes, extractPdfText, referencePath);
    const playbackRelativePath = `playback/${fixture.fixtureId}.wav`;
    const outputPath = path.join(playbackRoot.realPath, `${fixture.fixtureId}.wav`);
    let audio;
    if (fs.existsSync(outputPath)) {
      const prior = previousById.get(fixture.fixtureId);
      if (!prior || prior.playbackRelativePath !== playbackRelativePath) {
        fail(`${fixture.fixtureId} existing playback WAV is not bound by the prepared manifest`);
      }
      const info = fs.lstatSync(outputPath);
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        info.size !== prior.playbackBytes ||
        sha256File(outputPath) !== prior.playbackSha256
      ) {
        fail(`${fixture.fixtureId} existing playback WAV integrity drifted`);
      }
      audio = {
        durationSeconds: probeDuration({ fixture, inputPath: outputPath }),
        wavSha256: prior.playbackSha256,
        wavBytes: prior.playbackBytes,
      };
    } else {
      audio = normalizeAudio({ fixture, inputPath: sourcePath, outputPath });
    }
    if (
      !Number.isFinite(audio.durationSeconds) ||
      Math.abs(audio.durationSeconds - fixture.durationSeconds) >
        NORMALIZED_DURATION_TOLERANCE_SECONDS ||
      !SHA256_PATTERN.test(audio.wavSha256) ||
      !Number.isSafeInteger(audio.wavBytes) ||
      audio.wavBytes <= 0
    ) {
      fail(`${fixture.fixtureId} normalized WAV integrity is invalid`);
    }
    items.push({
      fixtureId: fixture.fixtureId,
      language: fixture.language,
      recordingId: fixture.recordingId,
      collection: fixture.collection,
      release: fixture.release,
      title: fixture.title,
      sourceRelativePath: fixture.sourceRelativePath,
      sourceSha256: fixture.sourceSha256,
      sourceBytes: fixture.sourceBytes,
      durationSeconds: audio.durationSeconds,
      audioPage: fixture.audioPage,
      referencePage: fixture.referencePage,
      licenseId: fixture.licenseId,
      licenseUrl: fixture.licenseUrl,
      attribution: fixture.attribution,
      referenceAdapter: fixture.referenceAdapter,
      excludedReferenceCues: fixture.excludedReferenceCues,
      playbackRelativePath,
      playbackSha256: audio.wavSha256,
      playbackBytes: audio.wavBytes,
      reference: {
        status: 'available',
        text,
        sha256: sha256Text(text),
        wordCount: wordUnits(text, fixture.language).length,
        characterCount: characterUnits(text, fixture.language).length,
        storagePolicy: 'restricted-local-cache',
        provenance: fixture.referencePage,
        provisional: false,
      },
    });
  }

  const prepared = deepFreeze({
    schema: PREPARED_SCHEMA,
    benchmarkRevision: registry.benchmarkRevision,
    generatedAt: options.generatedAt,
    redistribution: 'prohibited',
    sourceRegistrySha256: sha256Text(canonicalJson(registry)),
    expectedFixtureCount: registry.items.length,
    items,
  });
  const serialized = `${canonicalJson(prepared)}\n`;
  if (previous.value === null) {
    fs.writeFileSync(previous.manifestPath, serialized, { flag: 'wx', mode: 0o600 });
  } else if (`${canonicalJson(previous.value)}\n` !== serialized) {
    fail('existing prepared long manifest does not match the deterministic preparation result');
  }
  return deepFreeze({ prepared, manifestPath: previous.manifestPath });
}

module.exports = {
  deriveMtedxReference,
  deriveRoyalSrtReference,
  deriveWhiteHouseReference,
  deriveWolneLekturyReference,
  inspectRegisteredSource,
  prepareLongCorpus,
  validateLongSourceRegistry,
};
