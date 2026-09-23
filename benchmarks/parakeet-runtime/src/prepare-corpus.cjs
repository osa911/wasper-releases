#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { NORMALIZED_AUDIO_TRANSFORM, sha256File } = require('./asr-quality/audio-cache.cjs');
const {
  normalizeCandidate,
  selectBalancedShortCohort,
  selectShortCohort,
  validateBalancedShortSelection,
  validateSourceRegistry,
} = require('./asr-quality/corpus-builder.cjs');
const { LANGUAGES } = require('./asr-quality/constants.cjs');

const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const ARCHIVE_READER = path.join(__dirname, 'asr-quality', 'archive-reader.py');
const MAX_JSON_BYTES = 256 * 1024 * 1024;
const MAX_JSON_LINE_BYTES = 8 * 1024 * 1024;
const COMMANDS = Object.freeze({
  import: Object.freeze(['sources', 'cache', 'python']),
  select: Object.freeze(['sources', 'cache', 'output']),
  'select-balanced-speed': Object.freeze(['sources', 'cache', 'output']),
  worksheet: Object.freeze(['selection', 'cache', 'python', 'output']),
  'long-worksheet': Object.freeze(['candidates', 'cache', 'output']),
});

function fail(message) {
  throw new Error(message);
}

function isFixtureIdentifier(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return false;
  if (value.startsWith('-') || value.endsWith('-') || value.includes('--')) return false;
  for (const character of value) {
    const isLowercaseLetter = character >= 'a' && character <= 'z';
    const isDigit = character >= '0' && character <= '9';
    if (!isLowercaseLetter && !isDigit && character !== '-') return false;
  }
  return true;
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  const required = COMMANDS[command];
  if (required === undefined) fail(`unknown corpus command ${String(command)}`);
  const allowed = new Set(required);
  const values = Object.create(null);
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (typeof flag !== 'string' || !flag.startsWith('--')) {
      fail(`expected a --flag at argument ${index + 2}`);
    }
    const name = flag.slice(2);
    if (!allowed.has(name)) fail(`unknown flag ${flag} for ${command}`);
    if (Object.hasOwn(values, name)) fail(`duplicate flag ${flag}`);
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
      fail(`flag ${flag} requires one value`);
    }
    values[name] = value;
  }
  for (const name of required) {
    if (!Object.hasOwn(values, name)) fail(`missing required flag --${name}`);
  }
  return { command, values };
}

function regularFile(filePath, label, maximumBytes = MAX_JSON_BYTES) {
  const info = fs.lstatSync(filePath);
  if (info.isSymbolicLink() || !info.isFile()) fail(`${label} must be a non-symlink regular file`);
  if (info.size > maximumBytes) fail(`${label} exceeds the ${maximumBytes}-byte limit`);
  return info;
}

function managedDirectory(directory, label, { create = false } = {}) {
  if (create) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const info = fs.lstatSync(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail(`${label} must be a non-symlink directory`);
  }
  return directory;
}

function readJson(filePath, label) {
  regularFile(filePath, label);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`${label} must contain valid JSON: ${error.message}`);
  }
  return parsed;
}

function atomicWrite(filePath, bytes) {
  const parent = managedDirectory(path.dirname(filePath), 'output parent', { create: true });
  if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
    fail(`output must not replace a symlink: ${filePath}`);
  }
  const temporary = path.join(
    parent,
    `.${path.basename(filePath)}.tmp-${process.pid}-${crypto.randomUUID()}`
  );
  try {
    fs.writeFileSync(temporary, bytes, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, filePath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function archiveFiles(root) {
  managedDirectory(root, 'source archive directory');
  const files = [];
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const info = fs.lstatSync(entryPath);
      if (info.isSymbolicLink())
        fail(`source archive tree must not contain symlinks: ${entry.name}`);
      if (info.isDirectory()) visit(entryPath);
      else if (info.isFile()) files.push({ bytes: info.size, path: entryPath });
    }
  };
  visit(root);
  return files;
}

function discoverObjects(registry, cacheRoot) {
  const archiveRoot = path.join(cacheRoot, 'source-archives');
  const files = archiveFiles(archiveRoot);
  const claimed = new Set();
  const result = Object.create(null);
  for (const object of Object.values(registry.objectsById)) {
    const sizeMatches = files.filter(file => file.bytes === object.bytes);
    const matches = sizeMatches.filter(file => sha256File(file.path) === object.sha256);
    if (matches.length !== 1) {
      fail(`source object ${object.id} must match exactly one cached regular file`);
    }
    const match = matches[0];
    if (claimed.has(match.path)) fail(`cached source file is ambiguously registered: ${object.id}`);
    claimed.add(match.path);
    result[object.id] = {
      bytes: object.bytes,
      relativePath: path.relative(cacheRoot, match.path),
      sha256: object.sha256,
    };
    process.stderr.write(`verified source object ${object.id}\n`);
  }
  return result;
}

function sanitizedEnvironment() {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    PYTHONNOUSERSITE: '1',
  };
}

function readerArguments(source, objects, cacheRoot) {
  const media = objects[source.container.id];
  const container = path.join(cacheRoot, media.relativePath);
  const common = [
    '--container',
    container,
    '--sha256',
    source.container.sha256,
    '--partition',
    source.partition,
    '--source-id',
    source.id,
    '--language',
    source.language,
  ];
  if (source.indexKind === 'fleurs-tar-tsv') {
    const metadata = objects[source.metadata.id];
    return [
      'index-tar',
      ...common.slice(0, 4),
      '--metadata',
      path.join(cacheRoot, metadata.relativePath),
      '--metadata-sha256',
      source.metadata.sha256,
      ...common.slice(4),
    ];
  }
  if (source.indexKind === 'common-voice-tar-tsv') {
    return [
      'index-common-voice',
      ...common.slice(0, 4),
      '--locale',
      source.language,
      ...common.slice(4),
    ];
  }
  if (source.indexKind === 'librispeech-tar') return ['index-librispeech', ...common];
  if (source.indexKind === 'mls-parquet') {
    return [
      'index-parquet',
      ...common,
      '--expected-schema-json',
      JSON.stringify(source.container.parquet.schema),
      '--expected-row-count',
      String(source.container.parquet.rows),
    ];
  }
  fail(`unsupported source index kind ${source.indexKind}`);
}

function parseJsonLines(output, sourceId) {
  const rows = [];
  for (const [index, line] of output.split('\n').entries()) {
    if (line === '') continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_JSON_LINE_BYTES) {
      fail(`source ${sourceId} index line ${index} exceeds the JSON line limit`);
    }
    try {
      rows.push(JSON.parse(line));
    } catch (error) {
      fail(`source ${sourceId} index line ${index} is invalid JSON: ${error.message}`);
    }
  }
  if (rows.length === 0) fail(`source ${sourceId} produced an empty candidate index`);
  return rows;
}

function runReader(python, arguments_) {
  regularFile(ARCHIVE_READER, 'archive reader');
  const result = spawnSync(python, [ARCHIVE_READER, ...arguments_], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: sanitizedEnvironment(),
    maxBuffer: MAX_JSON_BYTES,
  });
  if (result.error) fail(`archive reader failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`archive reader failed with ${String(result.status)}: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function importCommand(values) {
  const cacheRoot = path.resolve(values.cache);
  managedDirectory(cacheRoot, 'cache root', { create: true });
  const registry = validateSourceRegistry(
    readJson(path.resolve(values.sources), 'source registry')
  );
  const objects = discoverObjects(registry, cacheRoot);
  const indexDirectory = managedDirectory(
    path.join(cacheRoot, 'source-indexes'),
    'index directory',
    {
      create: true,
    }
  );
  const summaries = [];
  for (const source of Object.values(registry.sourcesById)) {
    if (source.metadata !== null) {
      const metadataPath = path.join(cacheRoot, objects[source.metadata.id].relativePath);
      if (sha256File(metadataPath) !== source.metadata.sha256) {
        fail(`source ${source.id} metadata SHA-256 mismatch`);
      }
    }
    const output = runReader(values.python, readerArguments(source, objects, cacheRoot));
    const candidates = parseJsonLines(output, source.id)
      .map(row => normalizeCandidate(row, source))
      .sort((left, right) => left.sourceItemId.localeCompare(right.sourceItemId));
    const serialized = `${candidates.map(row => JSON.stringify(row)).join('\n')}\n`;
    atomicWrite(path.join(indexDirectory, `${source.id}.jsonl`), serialized);
    summaries.push({ candidates: candidates.length, sourceId: source.id });
    process.stderr.write(`indexed ${source.id}: ${candidates.length} candidates\n`);
  }
  atomicWrite(
    path.join(cacheRoot, 'source-objects.json'),
    `${JSON.stringify({ schemaVersion: 'asr-quality-source-objects-v1', objects }, null, 2)}\n`
  );
  process.stdout.write(`${JSON.stringify({ imported: summaries })}\n`);
}

function readPrivateIndexes(registry, cacheRoot) {
  const candidates = [];
  for (const source of Object.values(registry.sourcesById)) {
    const indexPath = path.join(cacheRoot, 'source-indexes', `${source.id}.jsonl`);
    regularFile(indexPath, `private index ${source.id}`);
    const contents = fs.readFileSync(indexPath, 'utf8');
    for (const row of parseJsonLines(contents, source.id)) candidates.push(row);
  }
  return candidates;
}

function fixtureId(candidate) {
  const suffix = crypto
    .createHash('sha256')
    .update(`${candidate.sourceId}\0${candidate.sourceItemId}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `${candidate.language}-short-${suffix}`;
}

function selectCommand(values, { balancedSpeed = false } = {}) {
  const cacheRoot = path.resolve(values.cache);
  managedDirectory(cacheRoot, 'cache root');
  const registry = validateSourceRegistry(
    readJson(path.resolve(values.sources), 'source registry')
  );
  const candidates = readPrivateIndexes(registry, cacheRoot);
  const selection = balancedSpeed
    ? selectBalancedShortCohort(candidates, { languages: LANGUAGES })
    : selectShortCohort(candidates, {
        languages: LANGUAGES,
        requireConditions: false,
      });
  if (balancedSpeed) validateBalancedShortSelection(selection, { languages: LANGUAGES });
  const output = {
    ...selection,
    languages: Object.fromEntries(
      Object.entries(selection.languages).map(([language, cohort]) => [
        language,
        {
          ...cohort,
          fixtures: cohort.fixtures.map(candidate => ({
            ...candidate,
            fixtureId: fixtureId(candidate),
          })),
        },
      ])
    ),
  };
  if (balancedSpeed) validateBalancedShortSelection(output, { languages: LANGUAGES });
  atomicWrite(path.resolve(values.output), `${JSON.stringify(output, null, 2)}\n`);
  const summary = Object.fromEntries(
    Object.entries(output.languages).map(([language, cohort]) => [
      language,
      { fixtures: cohort.fixtures.length, seconds: cohort.durationSeconds },
    ])
  );
  process.stdout.write(`${JSON.stringify({ selected: summary })}\n`);
}

function selectionFixtures(selection) {
  if (
    !['asr-quality-short-selection-v1', 'asr-quality-short-selection-v2'].includes(
      selection?.schemaVersion
    ) ||
    selection.languages === null ||
    typeof selection.languages !== 'object' ||
    Array.isArray(selection.languages)
  ) {
    fail('selection must use a supported short-selection schema');
  }
  if (selection.schemaVersion === 'asr-quality-short-selection-v2') {
    validateBalancedShortSelection(selection, { languages: LANGUAGES });
  }
  const fixtures = [];
  const seen = new Set();
  for (const [language, cohort] of Object.entries(selection.languages)) {
    if (!LANGUAGES.includes(language) || !Array.isArray(cohort?.fixtures)) {
      fail(`selection language ${language} is invalid`);
    }
    for (const fixture of cohort.fixtures) {
      if (
        fixture?.language !== language ||
        !isFixtureIdentifier(fixture.fixtureId) ||
        seen.has(fixture.fixtureId)
      ) {
        fail(`selection fixture identity is invalid for ${language}`);
      }
      if (
        typeof fixture.sourceSha256 !== 'string' ||
        !/^[a-f0-9]{64}$/u.test(fixture.sourceSha256) ||
        !Number.isSafeInteger(fixture.sourceBytes) ||
        fixture.sourceBytes <= 0 ||
        !['tar', 'parquet'].includes(fixture.container?.format)
      ) {
        fail(`selection fixture source contract is invalid for ${fixture.fixtureId}`);
      }
      seen.add(fixture.fixtureId);
      fixtures.push(fixture);
    }
  }
  if (fixtures.length === 0) fail('selection must contain at least one fixture');
  return fixtures.sort((left, right) => left.fixtureId.localeCompare(right.fixtureId));
}

function sourceObjectMap(cacheRoot) {
  const document = readJson(path.join(cacheRoot, 'source-objects.json'), 'source object map');
  if (
    document?.schemaVersion !== 'asr-quality-source-objects-v1' ||
    document.objects === null ||
    typeof document.objects !== 'object' ||
    Array.isArray(document.objects)
  ) {
    fail('source object map schema is invalid');
  }
  return document.objects;
}

function containerPath(cacheRoot, objectId, expectedSha256, objectMap) {
  const entry = objectMap[objectId];
  if (
    entry === null ||
    typeof entry !== 'object' ||
    typeof entry.relativePath !== 'string' ||
    entry.sha256 !== expectedSha256 ||
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes <= 0
  ) {
    fail(`source object map entry is invalid for ${objectId}`);
  }
  const resolved = path.resolve(cacheRoot, entry.relativePath);
  if (!resolved.startsWith(`${cacheRoot}${path.sep}`)) {
    fail(`source object map entry escapes the cache for ${objectId}`);
  }
  const info = fs.lstatSync(resolved);
  if (info.isSymbolicLink() || !info.isFile() || info.size !== entry.bytes) {
    fail(`source container is not the registered regular file for ${objectId}`);
  }
  if (sha256File(resolved) !== expectedSha256) {
    fail(`source container SHA-256 mismatch for ${objectId}`);
  }
  return resolved;
}

function verifyPreseed(filePath, fixture) {
  const info = regularFile(filePath, `source preseed ${fixture.fixtureId}`);
  if (info.size !== fixture.sourceBytes || sha256File(filePath) !== fixture.sourceSha256) {
    fail(`source preseed integrity mismatch for ${fixture.fixtureId}`);
  }
}

function preseedSelectedSources(fixtures, cacheRoot, python) {
  const objectMap = sourceObjectMap(cacheRoot);
  const sourceDirectory = managedDirectory(path.join(cacheRoot, 'sources'), 'source directory', {
    create: true,
  });
  const requestDirectory = managedDirectory(
    path.join(cacheRoot, 'batch-requests'),
    'batch request directory',
    { create: true }
  );
  const groups = new Map();
  for (const fixture of fixtures) {
    const group = groups.get(fixture.container.id) || [];
    group.push(fixture);
    groups.set(fixture.container.id, group);
  }
  for (const [objectId, group] of groups) {
    const [first] = group;
    const container = containerPath(cacheRoot, objectId, first.container.sha256, objectMap);
    for (const fixture of group) {
      if (
        fixture.container.sha256 !== first.container.sha256 ||
        fixture.container.format !== first.container.format
      ) {
        fail(`selection container identity drift for ${objectId}`);
      }
    }
    const missing = group.filter(fixture => {
      const output = path.join(sourceDirectory, fixture.sourceSha256);
      if (!fs.existsSync(output)) return true;
      verifyPreseed(output, fixture);
      return false;
    });
    if (missing.length > 0) {
      const requests = missing.map(fixture => ({
        bytes: fixture.sourceBytes,
        locator: fixture.container.locator,
        outputName: fixture.sourceSha256,
        sha256: fixture.sourceSha256,
      }));
      const requestPath = path.join(requestDirectory, `${objectId}.json`);
      atomicWrite(requestPath, `${JSON.stringify(requests, null, 2)}\n`);
      runReader(python, [
        'extract-batch',
        '--container',
        container,
        '--sha256',
        first.container.sha256,
        '--format',
        first.container.format,
        '--requests',
        requestPath,
        '--output-directory',
        sourceDirectory,
      ]);
    }
    for (const fixture of group) {
      verifyPreseed(path.join(sourceDirectory, fixture.sourceSha256), fixture);
    }
    process.stderr.write(`preseeded ${objectId}: ${group.length} selected recordings\n`);
  }
}

function normalizePlayback(sourcePath, outputPath) {
  if (fs.existsSync(outputPath))
    fail(`playback output already exists: ${path.basename(outputPath)}`);
  const arguments_ = NORMALIZED_AUDIO_TRANSFORM.arguments.map(argument => {
    if (argument === '{sourcePath}') return sourcePath;
    if (argument === '{temporaryWavPath}') return outputPath;
    return argument;
  });
  const result = spawnSync(NORMALIZED_AUDIO_TRANSFORM.tool, arguments_, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    env: sanitizedEnvironment(),
    maxBuffer: 64 * 1024,
  });
  if (result.error) fail(`ffmpeg failed to start: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`ffmpeg failed with ${String(result.status)}: ${result.stderr.trim()}`);
  }
  regularFile(outputPath, `playback ${path.basename(outputPath)}`);
}

function worksheetCommand(values) {
  const cacheRoot = path.resolve(values.cache);
  managedDirectory(cacheRoot, 'cache root');
  const selection = readJson(path.resolve(values.selection), 'short selection');
  const fixtures = selectionFixtures(selection);
  preseedSelectedSources(fixtures, cacheRoot, values.python);

  const outputDirectory = path.resolve(values.output);
  const playbackDirectory = managedDirectory(
    path.join(outputDirectory, 'playback'),
    'playback directory',
    { create: true }
  );
  const sourceDirectory = path.join(cacheRoot, 'sources');
  const items = [];
  for (const fixture of fixtures) {
    const playbackName = `${fixture.fixtureId}.wav`;
    const playbackPath = path.join(playbackDirectory, playbackName);
    normalizePlayback(path.join(sourceDirectory, fixture.sourceSha256), playbackPath);
    items.push({
      fixtureId: fixture.fixtureId,
      language: fixture.language,
      sourceId: fixture.sourceId,
      sourceItemId: fixture.sourceItemId,
      durationSeconds: fixture.durationSeconds,
      reference: fixture.reference,
      sourceSha256: fixture.sourceSha256,
      playbackFile: `playback/${playbackName}`,
      playbackSha256: sha256File(playbackPath),
      completeAudio: null,
      exactReference: null,
      condition: null,
      licenseConfirmed: null,
      auditor: '',
      date: '',
      excluded: false,
      exclusionReason: '',
    });
  }
  const worksheet = {
    schemaVersion: 'asr-quality-short-audit-worksheet-v1',
    benchmarkRevision: 'wasper-asr-quality-v1',
    instructions:
      'Listen from first sample to last, compare the complete reference, classify the recording condition, and confirm the source license.',
    items,
  };
  atomicWrite(
    path.join(outputDirectory, 'worksheet.json'),
    `${JSON.stringify(worksheet, null, 2)}\n`
  );
  atomicWrite(
    path.join(outputDirectory, 'playlist.m3u8'),
    `#EXTM3U\n${items.map(item => item.playbackFile).join('\n')}\n`
  );
  process.stdout.write(`${JSON.stringify({ worksheetItems: items.length })}\n`);
}

function httpsUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${label} must be an absolute HTTPS URL`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.length === 0) {
    fail(`${label} must be an absolute HTTPS URL`);
  }
}

function longCandidates(document) {
  if (
    document?.schemaVersion !== 'asr-quality-long-candidates-v1' ||
    document.benchmarkRevision !== 'wasper-asr-quality-v1' ||
    !Array.isArray(document.candidates) ||
    document.candidates.length === 0 ||
    document.candidates.length > LANGUAGES.length
  ) {
    fail('long candidate registry schema is invalid');
  }
  const exactKeys = new Set([
    'fixtureId',
    'language',
    'mediaFileName',
    'sha256',
    'bytes',
    'durationSeconds',
    'title',
    'audioPage',
    'referencePage',
    'licenseId',
  ]);
  const seenLanguages = new Set();
  let overFiveMinutes = 0;
  for (const [index, candidate] of document.candidates.entries()) {
    if (
      candidate === null ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      Object.keys(candidate).length !== exactKeys.size ||
      Object.keys(candidate).some(key => !exactKeys.has(key))
    ) {
      fail(`long candidate ${index} keys are invalid`);
    }
    if (
      !LANGUAGES.includes(candidate.language) ||
      seenLanguages.has(candidate.language) ||
      !isFixtureIdentifier(candidate.fixtureId) ||
      !candidate.fixtureId.startsWith(`${candidate.language}-long-`)
    ) {
      fail(`long candidate ${index} identity is invalid`);
    }
    if (
      typeof candidate.mediaFileName !== 'string' ||
      !/^source\.(?:mp3|ogg|wav)$/u.test(candidate.mediaFileName) ||
      typeof candidate.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(candidate.sha256) ||
      !Number.isSafeInteger(candidate.bytes) ||
      candidate.bytes <= 0 ||
      !Number.isFinite(candidate.durationSeconds) ||
      candidate.durationSeconds < 120 ||
      candidate.durationSeconds > 600
    ) {
      fail(`long candidate ${index} media contract is invalid`);
    }
    for (const key of ['title', 'licenseId']) {
      if (typeof candidate[key] !== 'string' || candidate[key].length === 0) {
        fail(`long candidate ${index} ${key} is invalid`);
      }
    }
    httpsUrl(candidate.audioPage, `long candidate ${index} audioPage`);
    httpsUrl(candidate.referencePage, `long candidate ${index} referencePage`);
    if (candidate.durationSeconds > 300) overFiveMinutes += 1;
    seenLanguages.add(candidate.language);
  }
  if (overFiveMinutes > 1) fail('long candidates may contain only one recording over five minutes');
  return [...document.candidates].sort((left, right) =>
    left.language.localeCompare(right.language)
  );
}

function longWorksheetCommand(values) {
  const cacheRoot = path.resolve(values.cache);
  managedDirectory(cacheRoot, 'cache root');
  const candidates = longCandidates(readJson(path.resolve(values.candidates), 'long candidates'));
  const outputDirectory = path.resolve(values.output);
  const playbackDirectory = managedDirectory(
    path.join(outputDirectory, 'long-playback'),
    'long playback directory',
    { create: true }
  );
  const items = [];
  for (const candidate of candidates) {
    const sourcePath = path.join(
      cacheRoot,
      'long-candidates',
      candidate.language,
      candidate.mediaFileName
    );
    const info = regularFile(sourcePath, `long candidate ${candidate.fixtureId}`);
    if (info.size !== candidate.bytes || sha256File(sourcePath) !== candidate.sha256) {
      fail(`long candidate integrity mismatch for ${candidate.fixtureId}`);
    }
    const playbackName = `${candidate.fixtureId}.wav`;
    const playbackPath = path.join(playbackDirectory, playbackName);
    normalizePlayback(sourcePath, playbackPath);
    items.push({
      ...candidate,
      playbackFile: `long-playback/${playbackName}`,
      playbackSha256: sha256File(playbackPath),
      completeAudio: null,
      exactReference: null,
      licenseConfirmed: null,
      predominantlyOneSpeaker: null,
      referenceText: '',
      auditor: '',
      date: '',
      excluded: false,
      exclusionReason: '',
    });
  }
  const worksheet = {
    schemaVersion: 'asr-quality-long-audit-worksheet-v1',
    benchmarkRevision: 'wasper-asr-quality-v1',
    instructions:
      'Listen from first sample to last, bind an exact complete reference, verify predominantly one speaker, and confirm license use in the benchmark jurisdiction.',
    items,
  };
  atomicWrite(
    path.join(outputDirectory, 'long-worksheet.json'),
    `${JSON.stringify(worksheet, null, 2)}\n`
  );
  atomicWrite(
    path.join(outputDirectory, 'long-playlist.m3u8'),
    `#EXTM3U\n${items.map(item => item.playbackFile).join('\n')}\n`
  );
  process.stdout.write(`${JSON.stringify({ longWorksheetItems: items.length })}\n`);
}

function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArguments(argv);
  if (command === 'import') importCommand(values);
  else if (command === 'select') selectCommand(values);
  else if (command === 'select-balanced-speed') selectCommand(values, { balancedSpeed: true });
  else if (command === 'worksheet') worksheetCommand(values);
  else if (command === 'long-worksheet') longWorksheetCommand(values);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`bench-asr-quality-corpus: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { main, parseArguments };
