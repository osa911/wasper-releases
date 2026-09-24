'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { NORMALIZED_AUDIO_TRANSFORM } = require('./audio-cache.cjs');
const {
  BALANCED_SHORT_PROFILE,
  validateBalancedShortSelection,
  validateSourceRegistry,
} = require('./corpus-builder.cjs');
const { LANGUAGES } = require('./constants.cjs');
const { isManifestFixtureId } = require('./fixture-id.cjs');
const { canonicalJson } = require('./manifest.cjs');
const { characterUnits, wordUnits } = require('./normalization.cjs');
const { loadPreparedLongCorpus } = require('./prepared-long-corpus.cjs');
const { runCorpusHash, validateRunCorpus } = require('./run-corpus.cjs');
const {
  BYTE_LIMITS,
  bindTrustedRoot,
  snapshotRegularFile: boundedSnapshotRegularFile,
} = require('./bounded-file-snapshot.cjs');

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SHORT_SELECTION_SCHEMA = 'asr-quality-short-selection-v1';
const SHORT_WORKSHEET_SCHEMA = 'asr-quality-short-audit-worksheet-v1';
const LONG_WORKSHEET_SCHEMA = 'asr-quality-long-audit-worksheet-v1';
const LONG_CANDIDATES_SCHEMA = 'asr-quality-long-candidates-v1';
const LONG_APPROVALS_SCHEMA = 'asr-quality-long-license-approvals-v1';
const LONG_APPROVAL_IDENTITIES_SCHEMA = 'asr-quality-long-license-approval-identities-v1';
const LONG_REFERENCES_SCHEMA = 'wasper.asr-quality.internal-long-references.v1';
const BENCHMARK_REVISION = 'wasper-asr-quality-v1';
const MIXED_SOURCE_QUALITY_PROFILE = 'mixed-source-quality-v1';
const WAV_DURATION_TOLERANCE_SECONDS = 0.25;
const DEFAULT_LONG_CANDIDATES = path.resolve(
  __dirname,
  '../../docs/benchmarks/asr-quality-v1/long-candidates.json'
);
const DEFAULT_LONG_APPROVALS = path.resolve(
  __dirname,
  '../../docs/benchmarks/asr-quality-v1/long-license-approvals.json'
);
const DEFAULT_LONG_APPROVAL_IDENTITIES = path.resolve(
  __dirname,
  '../../docs/benchmarks/asr-quality-v1/long-license-approval-identities.json'
);
const LONG_LICENSE_URLS = Object.freeze({
  'CC-BY-3.0': 'https://creativecommons.org/licenses/by/3.0/',
  'CC-BY-4.0': 'https://creativecommons.org/licenses/by/4.0/',
  'CC-BY-SA-3.0': 'https://creativecommons.org/licenses/by-sa/3.0/',
  'CC0-1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  'Public-domain-dedication': 'https://creativecommons.org/publicdomain/zero/1.0/',
  'Public-domain-claim-US-jurisdiction-review-required':
    'https://librivox.org/pages/public-domain/',
});

function fail(message) {
  throw new Error(message);
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function cloneJson(value, label) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new TypeError(`${label} must be plain JSON: ${error.message}`, { cause: error });
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function requireObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} is invalid`);
}

function requireExactKeys(value, fields, label) {
  requireObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail(`${label} keys are invalid; expected exactly ${expected.join(', ')}`);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} is invalid`);
}

function requireSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) fail(`${label} is invalid`);
}

function isWithin(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function safeDirectory(directory, label) {
  return bindTrustedRoot(directory, label, fs);
}

function snapshotRegularFile(filePath, label, root, kind) {
  if (!Object.hasOwn(BYTE_LIMITS, kind)) fail(`${label} has an invalid snapshot input kind`);
  const containment =
    root ?? safeDirectory(path.dirname(path.resolve(filePath)), `${label} containment root`);
  return boundedSnapshotRegularFile(filePath, {
    label,
    root: containment,
    maxBytes: BYTE_LIMITS[kind],
  });
}

function readJsonSnapshot(filePath, label, root) {
  const snapshot = snapshotRegularFile(filePath, label, root, 'json');
  try {
    return { ...snapshot, value: JSON.parse(snapshot.bytes.toString('utf8')) };
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
}

function requireSafeRelativePath(relativePath, label) {
  requireString(relativePath, label);
  if (path.isAbsolute(relativePath) || relativePath.includes('\\')) fail(`${label} is invalid`);
  const parts = relativePath.split('/');
  if (parts.some(part => part === '' || part === '.' || part === '..')) fail(`${label} is invalid`);
}

function resolveRelativeSnapshot(worksheetSnapshot, relativePath, label) {
  requireSafeRelativePath(relativePath, `${label} path`);
  const root = safeDirectory(path.dirname(worksheetSnapshot.realPath), `${label} worksheet root`);
  const candidate = path.resolve(root.realPath, relativePath);
  if (!isWithin(root.realPath, candidate)) fail(`${label} path escapes its worksheet`);
  return snapshotRegularFile(candidate, label, root, 'wav');
}

function parsePcm16MonoWav(snapshot, label) {
  const bytes = snapshot.bytes;
  if (
    bytes.length < 12 ||
    bytes.subarray(0, 4).toString('ascii') !== 'RIFF' ||
    bytes.subarray(8, 12).toString('ascii') !== 'WAVE' ||
    bytes.readUInt32LE(4) !== bytes.length - 8
  ) {
    fail(`${label} is invalid PCM16 mono 16 kHz WAV`);
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) fail(`${label} WAV chunk header is invalid`);
    const type = bytes.subarray(offset, offset + 4).toString('ascii');
    const length = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const paddedEnd = dataEnd + (length % 2);
    if (dataEnd > bytes.length || paddedEnd > bytes.length) fail(`${label} WAV chunk is invalid`);
    if (type === 'fmt ') {
      if (format !== null || length !== 16) fail(`${label} WAV format chunk is invalid`);
      format = {
        audioFormat: bytes.readUInt16LE(dataStart),
        channels: bytes.readUInt16LE(dataStart + 2),
        sampleRateHz: bytes.readUInt32LE(dataStart + 4),
        byteRate: bytes.readUInt32LE(dataStart + 8),
        blockAlign: bytes.readUInt16LE(dataStart + 12),
        bitsPerSample: bytes.readUInt16LE(dataStart + 14),
      };
    }
    if (type === 'data') {
      if (data !== null) fail(`${label} WAV data chunk is invalid`);
      data = { bytes: length };
    }
    offset = paddedEnd;
  }
  if (offset !== bytes.length || format === null || data === null) {
    fail(`${label} is invalid PCM16 mono 16 kHz WAV`);
  }
  if (
    format.audioFormat !== 1 ||
    format.channels !== 1 ||
    format.sampleRateHz !== 16_000 ||
    format.byteRate !== 32_000 ||
    format.blockAlign !== 2 ||
    format.bitsPerSample !== 16 ||
    data.bytes % format.blockAlign !== 0
  ) {
    fail(`${label} is invalid PCM16 mono 16 kHz WAV`);
  }
  return { durationSeconds: data.bytes / format.byteRate, wavSha256: snapshot.sha256 };
}

function isFixtureIdFor(value, language, cohort) {
  return isManifestFixtureId(value) && value.startsWith(`${language}-${cohort}-`);
}

function selectionEntries(selection) {
  requireObject(selection, 'short selection');
  if (
    selection.schemaVersion !== SHORT_SELECTION_SCHEMA &&
    selection.schemaVersion !== 'asr-quality-short-selection-v2'
  ) {
    fail(`short selection schema mismatch: expected ${SHORT_SELECTION_SCHEMA}`);
  }
  requireObject(selection.languages, 'short selection languages');
  const entries = [];
  const ids = new Set();
  for (const [language, cohort] of Object.entries(selection.languages)) {
    if (!LANGUAGES.includes(language) || !Array.isArray(cohort?.fixtures)) {
      fail(`short selection language ${language} is invalid`);
    }
    for (const fixture of cohort.fixtures) {
      requireObject(fixture, `short selection ${language} fixture`);
      if (!isFixtureIdFor(fixture.fixtureId, language, 'short') || fixture.language !== language) {
        fail(`short selection fixture identity is invalid for ${fixture.fixtureId}`);
      }
      if (ids.has(fixture.fixtureId))
        fail(`short selection fixture duplicates ${fixture.fixtureId}`);
      ids.add(fixture.fixtureId);
      entries.push(fixture);
    }
  }
  if (entries.length === 0) fail('short selection is invalid: no fixtures');
  return entries.sort((left, right) => left.fixtureId.localeCompare(right.fixtureId));
}

function validateShortSelectionDocument(selection) {
  const balanced = selection?.schemaVersion === 'asr-quality-short-selection-v2';
  if (balanced) validateBalancedShortSelection(selection, { languages: LANGUAGES });
  const entries = selectionEntries(selection);
  return {
    entries,
    benchmarkProfile: balanced ? BALANCED_SHORT_PROFILE : MIXED_SOURCE_QUALITY_PROFILE,
    expectedShortCount: balanced ? 243 : 234,
  };
}

function loadSourceIndexes(directory) {
  const root = safeDirectory(directory, 'source indexes directory');
  const rows = new Map();
  const snapshots = [];
  for (const name of fs.readdirSync(root.realPath).sort()) {
    if (!name.endsWith('.jsonl')) continue;
    const snapshot = snapshotRegularFile(
      path.join(root.realPath, name),
      `source index ${name}`,
      root,
      'jsonl'
    );
    snapshots.push({ name, sha256: snapshot.sha256 });
    for (const [line, text] of snapshot.bytes.toString('utf8').split('\n').entries()) {
      if (text === '') continue;
      let row;
      try {
        row = JSON.parse(text);
      } catch {
        fail(`source index ${name}:${line + 1} is invalid JSON`);
      }
      requireObject(row, `source index ${name}:${line + 1}`);
      requireString(row.sourceId, 'source index sourceId');
      requireString(row.sourceItemId, 'source index sourceItemId');
      const key = `${row.sourceId}:${row.sourceItemId}`;
      if (rows.has(key)) fail(`source index duplicates ${key}`);
      rows.set(key, row);
    }
  }
  if (rows.size === 0) fail('source indexes are invalid: no rows');
  return { rows, snapshots };
}

function validateIndexRow(row, selectionFixture, source) {
  const label = `source index ${selectionFixture.sourceId}:${selectionFixture.sourceItemId}`;
  for (const key of [
    'language',
    'partition',
    'reference',
    'sourceId',
    'sourceItemId',
    'speakerKey',
  ]) {
    requireString(row[key], `${label}.${key}`);
  }
  for (const key of ['referenceSha256', 'sourceSha256']) requireSha256(row[key], `${label}.${key}`);
  if (!Number.isFinite(row.durationSeconds) || row.durationSeconds <= 0)
    fail(`${label}.durationSeconds is invalid`);
  if (!Number.isSafeInteger(row.sourceBytes) || row.sourceBytes <= 0)
    fail(`${label}.sourceBytes is invalid`);
  if (!Number.isSafeInteger(row.referenceWordCount) || row.referenceWordCount < 0)
    fail(`${label}.referenceWordCount is invalid`);
  if (!['test', 'validation'].includes(row.partition) || row.wholeRecording !== true) {
    fail(`${label} has invalid partition or whole-recording status`);
  }
  if (
    row.referenceSha256 !== sha256(row.reference) ||
    row.referenceWordCount !== wordUnits(row.reference, row.language).length
  ) {
    fail(`${label} reference mismatch`);
  }
  if (
    row.container === null ||
    typeof row.container !== 'object' ||
    row.container.id !== source?.container.id ||
    row.container.format !== source?.container.format ||
    row.container.sha256 !== source?.container.sha256
  ) {
    fail(`${label} registered source container mismatch`);
  }
  const selectedRow = { ...selectionFixture };
  delete selectedRow.fixtureId;
  if (canonicalJson(selectedRow) !== canonicalJson(row)) fail(`${label} selection mismatch`);
  if (
    source === undefined ||
    source.language !== row.language ||
    source.partition !== row.partition ||
    source.license.id !== row.licenseId ||
    source.license.benchmarkUse !== 'approved'
  ) {
    fail(`${label} source or license mismatch`);
  }
}

function worksheetItems(worksheet, schema, label) {
  requireObject(worksheet, label);
  if (worksheet.schemaVersion !== schema || worksheet.benchmarkRevision !== BENCHMARK_REVISION) {
    fail(`${label} schema mismatch`);
  }
  if (!Array.isArray(worksheet.items)) fail(`${label} items are invalid`);
  return worksheet.items;
}

function verifyWorksheetMembership(selection, worksheet) {
  const selected = new Map(selection.map(item => [item.fixtureId, item]));
  const rows = new Map();
  for (const item of worksheet) {
    requireObject(item, 'short worksheet item');
    requireString(item.fixtureId, 'short worksheet fixtureId');
    if (rows.has(item.fixtureId)) fail(`short worksheet fixture duplicates ${item.fixtureId}`);
    rows.set(item.fixtureId, item);
    if (
      !selected.has(item.fixtureId) &&
      (item.excluded !== true || !item.exclusionReason?.trim())
    ) {
      fail(
        `short worksheet contains unselected fixture ${item.fixtureId} without an exclusion reason`
      );
    }
  }
  for (const fixture of selection) {
    const item = rows.get(fixture.fixtureId);
    if (item === undefined)
      fail(`short worksheet is missing selected fixture ${fixture.fixtureId}`);
    if (item.excluded !== false)
      fail(`short worksheet selected fixture ${fixture.fixtureId} is excluded`);
  }
  return rows;
}

function buildShortFixtures({ selection, worksheetRows, indexes, registry, worksheetSnapshot }) {
  return selection.map(selectionFixture => {
    const key = `${selectionFixture.sourceId}:${selectionFixture.sourceItemId}`;
    const index = indexes.get(key);
    if (index === undefined) fail(`source index selection mismatch: missing selected ${key}`);
    const source = registry.sourcesById[index.sourceId];
    validateIndexRow(index, selectionFixture, source);
    const worksheet = worksheetRows.get(selectionFixture.fixtureId);
    if (
      worksheet.language !== index.language ||
      worksheet.sourceId !== index.sourceId ||
      worksheet.sourceItemId !== index.sourceItemId ||
      worksheet.sourceSha256 !== index.sourceSha256 ||
      worksheet.reference !== index.reference ||
      worksheet.durationSeconds !== index.durationSeconds
    ) {
      fail(`short worksheet mismatch for ${selectionFixture.fixtureId}`);
    }
    const playback = resolveRelativeSnapshot(
      worksheetSnapshot,
      worksheet.playbackFile,
      `short playback ${selectionFixture.fixtureId}`
    );
    const audio = parsePcm16MonoWav(playback, `short playback ${selectionFixture.fixtureId}`);
    if (worksheet.playbackSha256 !== audio.wavSha256)
      fail(`short playback SHA-256 mismatch for ${selectionFixture.fixtureId}`);
    if (audio.durationSeconds !== index.durationSeconds) {
      fail(
        `short playback duration for ${selectionFixture.fixtureId} must equal the exact measured source duration`
      );
    }
    return {
      fixture: {
        id: selectionFixture.fixtureId,
        language: index.language,
        cohort: 'short',
        speakerKey: index.speakerKey,
        source: {
          collection: source.publisher,
          release: source.release,
          partition: index.partition,
          recordingId: index.sourceItemId,
          mediaType: source.container.format,
          sha256: index.sourceSha256,
          durationSeconds: index.durationSeconds,
          url: source.homepage,
        },
        normalizedAudio: {
          sha256: audio.wavSha256,
          durationSeconds: audio.durationSeconds,
          transform: NORMALIZED_AUDIO_TRANSFORM,
        },
        reference: {
          status: 'available',
          sha256: index.referenceSha256,
          wordCount: index.referenceWordCount,
          characterCount: characterUnits(index.reference, index.language).length,
          storagePolicy: 'restricted-local-cache',
          provisional: true,
          provenance: 'source-index-published-reference',
          text: index.reference,
        },
        excluded: false,
      },
      prepared: {
        audio: {
          wavPath: playback.realPath,
          durationSeconds: audio.durationSeconds,
          sourceSha256: index.sourceSha256,
          wavSha256: audio.wavSha256,
        },
        referenceText: index.reference,
      },
    };
  });
}

function requireHttps(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname === '') {
      throw new Error('URL must use HTTPS and include a hostname');
    }
  } catch {
    fail(`${label} is invalid`);
  }
}

function loadLongCandidates(snapshot) {
  const document = snapshot.value;
  if (
    document?.schemaVersion !== LONG_CANDIDATES_SCHEMA ||
    document.benchmarkRevision !== BENCHMARK_REVISION ||
    !Array.isArray(document.candidates) ||
    document.candidates.length === 0 ||
    document.candidates.length > LANGUAGES.length
  ) {
    fail('long candidate registry schema is invalid');
  }
  const keys = [
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
  ];
  const candidates = new Map();
  let overThreeHundred = 0;
  for (const candidate of document.candidates) {
    requireObject(candidate, 'long candidate');
    if (
      Object.keys(candidate).length !== keys.length ||
      keys.some(key => !Object.hasOwn(candidate, key))
    )
      fail('long candidate keys are invalid');
    if (
      !LANGUAGES.includes(candidate.language) ||
      !isFixtureIdFor(candidate.fixtureId, candidate.language, 'long') ||
      candidates.has(candidate.fixtureId)
    )
      fail(`long candidate identity is invalid for ${candidate.fixtureId}`);
    if (
      !/^source\.(?:mp3|ogg|wav)$/u.test(candidate.mediaFileName) ||
      !Number.isSafeInteger(candidate.bytes) ||
      candidate.bytes <= 0 ||
      !Number.isFinite(candidate.durationSeconds) ||
      candidate.durationSeconds < 120 ||
      candidate.durationSeconds > 600
    )
      fail(`long candidate media policy is invalid for ${candidate.fixtureId}`);
    requireSha256(candidate.sha256, `long candidate SHA-256 for ${candidate.fixtureId}`);
    requireString(candidate.title, `long candidate title for ${candidate.fixtureId}`);
    requireString(candidate.licenseId, `long candidate license for ${candidate.fixtureId}`);
    requireHttps(candidate.audioPage, `long candidate audio provenance for ${candidate.fixtureId}`);
    requireHttps(
      candidate.referencePage,
      `long candidate reference provenance for ${candidate.fixtureId}`
    );
    if (candidate.durationSeconds > 300) overThreeHundred += 1;
    candidates.set(candidate.fixtureId, candidate);
  }
  if (overThreeHundred > 1)
    fail('long candidate media policy permits at most one recording over 300 seconds');
  return candidates;
}

function expectedNoticeSemantics(candidate) {
  const kind =
    candidate.licenseId === 'Public-domain-dedication'
      ? 'public-domain-dedication'
      : candidate.licenseId === 'CC0-1.0'
        ? 'cc0-public-domain-dedication'
        : candidate.licenseId === 'Public-domain-claim-US-jurisdiction-review-required'
          ? 'public-domain-claim-us-jurisdiction'
          : 'attribution-required';
  return { kind, sourceTitle: candidate.title, sourceUrl: candidate.audioPage };
}

function expectedCaveatSemantics(candidate) {
  return {
    legalAdvice: 'not-provided',
    redistribution: 'not-authorized',
    canonicalAudit: 'not-completed',
    localUse: 'Portugal-internal-only',
    ...(candidate.licenseId === 'Public-domain-claim-US-jurisdiction-review-required'
      ? {
          sourceClaimJurisdiction: 'US',
          sourceClaimStatus: 'not-upgraded',
          localStatusReview: 'required',
        }
      : {}),
  };
}

function parseReviewDate(value, label) {
  if (typeof value !== 'string') fail(`${label} is invalid`);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) fail(`${label} is invalid`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const instant = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() !== month - 1 ||
    instant.getUTCDate() !== day ||
    value > new Date().toISOString().slice(0, 10)
  ) {
    fail(`${label} is invalid`);
  }
  return value;
}

function loadLongApprovalIdentities(snapshot, candidates) {
  const document = snapshot.value;
  if (
    document?.schemaVersion !== LONG_APPROVAL_IDENTITIES_SCHEMA ||
    document.benchmarkRevision !== BENCHMARK_REVISION ||
    !Array.isArray(document.identities) ||
    document.identities.length !== candidates.size
  ) {
    fail('long license approval identity registry schema is invalid');
  }
  const keys = [
    'fixtureId',
    'licenseUrl',
    'attributionOrPublicDomainNotice',
    'caveat',
    'reviewDate',
    'noticeSemantics',
    'caveatSemantics',
  ];
  const identities = new Map();
  for (const identity of document.identities) {
    requireObject(identity, 'long license approval identity');
    if (
      Object.keys(identity).length !== keys.length ||
      keys.some(key => !Object.hasOwn(identity, key))
    ) {
      fail('long license approval identity keys are invalid');
    }
    const candidate = candidates.get(identity.fixtureId);
    if (candidate === undefined || identities.has(identity.fixtureId)) {
      fail(`long license approval identity is invalid for ${identity.fixtureId}`);
    }
    if (identity.licenseUrl !== LONG_LICENSE_URLS[candidate.licenseId]) {
      fail(`long license approval license URL mismatch for ${identity.fixtureId}`);
    }
    if (
      canonicalJson(identity.noticeSemantics) !== canonicalJson(expectedNoticeSemantics(candidate))
    ) {
      fail(`long license approval notice semantics mismatch for ${identity.fixtureId}`);
    }
    if (
      canonicalJson(identity.caveatSemantics) !== canonicalJson(expectedCaveatSemantics(candidate))
    ) {
      fail(`long license approval caveat semantics mismatch for ${identity.fixtureId}`);
    }
    requireString(
      identity.attributionOrPublicDomainNotice,
      `long license approval attribution for ${identity.fixtureId}`
    );
    requireString(identity.caveat, `long license approval caveat for ${identity.fixtureId}`);
    parseReviewDate(
      identity.reviewDate,
      `long license approval review date is invalid for ${identity.fixtureId}`
    );
    identities.set(identity.fixtureId, identity);
  }
  for (const fixtureId of candidates.keys()) {
    if (!identities.has(fixtureId)) {
      fail(`long license approval identity is missing for ${fixtureId}`);
    }
  }
  return identities;
}

function loadLongApprovals(snapshot, candidates, identities) {
  const document = snapshot.value;
  if (
    document?.schemaVersion !== LONG_APPROVALS_SCHEMA ||
    document.benchmarkRevision !== BENCHMARK_REVISION ||
    !Array.isArray(document.approvals) ||
    document.approvals.length !== candidates.size
  ) {
    fail('long license approval registry schema is invalid');
  }
  const keys = [
    'fixtureId',
    'language',
    'mediaFileName',
    'sourceSha256',
    'sourceTitle',
    'sourceUrl',
    'licenseId',
    'licenseUrl',
    'attributionOrPublicDomainNotice',
    'jurisdiction',
    'benchmarkUse',
    'redistribution',
    'approvalBasis',
    'reviewDate',
    'status',
    'caveat',
  ];
  const approvals = new Map();
  for (const approval of document.approvals) {
    requireObject(approval, 'long license approval');
    if (
      Object.keys(approval).length !== keys.length ||
      keys.some(key => !Object.hasOwn(approval, key))
    ) {
      fail('long license approval keys are invalid');
    }
    const candidate = candidates.get(approval.fixtureId);
    if (candidate === undefined || approvals.has(approval.fixtureId)) {
      fail(`long license approval source mismatch for ${approval.fixtureId}`);
    }
    const identity = identities.get(approval.fixtureId);
    if (identity === undefined) {
      fail(`long license approval identity is missing for ${approval.fixtureId}`);
    }
    if (
      approval.language !== candidate.language ||
      approval.mediaFileName !== candidate.mediaFileName ||
      approval.sourceSha256 !== candidate.sha256 ||
      approval.sourceUrl !== candidate.audioPage
    ) {
      fail(`long license approval source mismatch for ${approval.fixtureId}`);
    }
    if (approval.licenseId !== candidate.licenseId) {
      fail(`long license approval license mismatch for ${approval.fixtureId}`);
    }
    if (approval.sourceTitle !== candidate.title) {
      fail(`long license approval attribution mismatch for ${approval.fixtureId}`);
    }
    requireHttps(approval.licenseUrl, `long license approval URL for ${approval.fixtureId}`);
    if (approval.licenseUrl !== identity.licenseUrl) {
      fail(`long license approval license URL mismatch for ${approval.fixtureId}`);
    }
    if (approval.attributionOrPublicDomainNotice !== identity.attributionOrPublicDomainNotice) {
      fail(`long license approval attribution mismatch for ${approval.fixtureId}`);
    }
    if (approval.jurisdiction !== 'PT') {
      fail(`long license approval jurisdiction is invalid for ${approval.fixtureId}`);
    }
    if (
      approval.benchmarkUse !== 'local-internal-asr-benchmark' ||
      approval.redistribution !== 'prohibited' ||
      approval.approvalBasis !== 'explicit-user-authorization'
    ) {
      fail(`long license approval scope is invalid for ${approval.fixtureId}`);
    }
    if (approval.status !== 'approved') {
      fail(`long license approval status is invalid for ${approval.fixtureId}`);
    }
    parseReviewDate(
      approval.reviewDate,
      `long license approval review date is invalid for ${approval.fixtureId}`
    );
    if (approval.reviewDate !== identity.reviewDate) {
      fail(`long license approval review date mismatch for ${approval.fixtureId}`);
    }
    if (approval.caveat !== identity.caveat) {
      fail(`long license approval caveat mismatch for ${approval.fixtureId}`);
    }
    approvals.set(approval.fixtureId, approval);
  }
  for (const fixtureId of candidates.keys()) {
    if (!approvals.has(fixtureId)) fail(`long license approval is missing for ${fixtureId}`);
  }
  return approvals;
}

function readLongReferences(snapshot, worksheet) {
  const inventory = snapshot.value;
  requireExactKeys(inventory, ['schema', 'items'], 'long reference inventory');
  if (inventory.schema !== LONG_REFERENCES_SCHEMA || !Array.isArray(inventory.items))
    fail('long reference inventory schema mismatch');
  const worksheetIds = new Set(worksheet.map(item => item.fixtureId));
  const entries = new Map();
  for (const item of inventory.items) {
    requireObject(item, 'long reference inventory item');
    requireString(item.fixtureId, 'long reference inventory fixtureId');
    const commonFields = [
      'fixtureId',
      'status',
      'referencePage',
      'referenceProvenance',
      'retrievedAt',
      'provisional',
    ];
    if (item.status === 'available') {
      requireExactKeys(
        item,
        [...commonFields, 'text', 'sha256', 'wordCount', 'characterCount'],
        `long reference inventory available item ${item.fixtureId}`
      );
    } else if (item.status === 'reference-unavailable') {
      requireExactKeys(
        item,
        [...commonFields, 'reason'],
        `long reference inventory unavailable item ${item.fixtureId}`
      );
    } else {
      fail(`long reference inventory status is invalid for ${item.fixtureId}`);
    }
    parseReviewDate(item.retrievedAt, `long reference retrievedAt for ${item.fixtureId}`);
    if (!worksheetIds.has(item.fixtureId)) {
      fail(
        `long reference inventory contains a fixture outside the worksheet set: ${item.fixtureId}`
      );
    }
    if (entries.has(item.fixtureId)) fail(`long reference inventory duplicates ${item.fixtureId}`);
    entries.set(item.fixtureId, item);
  }
  for (const fixtureId of worksheetIds) {
    if (!entries.has(fixtureId)) {
      fail(`long reference inventory is missing worksheet fixture ${fixtureId}`);
    }
  }
  return entries;
}

function longReference(item, inventoryItem) {
  if (inventoryItem === undefined) fail(`long reference inventory is missing ${item.fixtureId}`);
  const candidate = inventoryItem;
  if (
    candidate.referencePage !== item.referencePage ||
    candidate.referenceProvenance !== 'pinned-page-derived' ||
    candidate.provisional !== true
  )
    fail(`long reference mismatch for ${item.fixtureId}`);
  if (candidate.status === 'reference-unavailable') {
    requireString(candidate.reason, `long reference reason for ${item.fixtureId}`);
    if (Object.hasOwn(candidate, 'text'))
      fail(`long unavailable reference contains text for ${item.fixtureId}`);
    return {
      status: 'unavailable',
      reason: candidate.reason,
      provisional: true,
      provenance: candidate.referenceProvenance,
    };
  }
  if (candidate.status !== 'available')
    fail(`long reference status is invalid for ${item.fixtureId}`);
  requireString(candidate.text, `long reference text for ${item.fixtureId}`);
  requireSha256(candidate.sha256, `long reference SHA-256 for ${item.fixtureId}`);
  if (
    candidate.sha256 !== sha256(candidate.text) ||
    candidate.wordCount !== wordUnits(candidate.text, item.language).length ||
    candidate.characterCount !== characterUnits(candidate.text, item.language).length
  )
    fail(`long reference mismatch for ${item.fixtureId}`);
  return {
    status: 'available',
    sha256: candidate.sha256,
    wordCount: candidate.wordCount,
    characterCount: candidate.characterCount,
    storagePolicy: 'restricted-local-cache',
    provisional: true,
    provenance: candidate.referenceProvenance,
    text: candidate.text,
  };
}

function buildLongFixtures({
  worksheet,
  references,
  candidates,
  approvals,
  longSources,
  worksheetSnapshot,
}) {
  const candidateFields = [
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
  ];
  const seenIds = new Set();
  const sourceSnapshots = [];
  const entries = worksheet.map(item => {
    requireObject(item, 'long worksheet item');
    const candidate = candidates.get(item.fixtureId);
    if (
      candidate === undefined ||
      seenIds.has(item.fixtureId) ||
      candidateFields.some(field => item[field] !== candidate[field])
    )
      fail(`long worksheet frozen candidate mismatch for ${item.fixtureId}`);
    seenIds.add(item.fixtureId);
    if (item.excluded !== false) fail(`long worksheet item is invalid for ${item.fixtureId}`);
    const original = snapshotRegularFile(
      path.join(longSources.realPath, candidate.language, candidate.mediaFileName),
      `long source ${candidate.fixtureId}`,
      longSources,
      'source'
    );
    if (original.sha256 !== candidate.sha256 || original.bytes.length !== candidate.bytes)
      fail(`long source integrity mismatch for ${candidate.fixtureId}`);
    sourceSnapshots.push({ fixtureId: candidate.fixtureId, sha256: original.sha256 });
    if (!approvals.has(candidate.fixtureId)) {
      fail(`long license approval is missing for ${candidate.fixtureId}`);
    }
    const playback = resolveRelativeSnapshot(
      worksheetSnapshot,
      item.playbackFile,
      `long playback ${item.fixtureId}`
    );
    const audio = parsePcm16MonoWav(playback, `long playback ${item.fixtureId}`);
    if (item.playbackSha256 !== audio.wavSha256)
      fail(`long playback SHA-256 mismatch for ${item.fixtureId}`);
    if (
      Math.abs(audio.durationSeconds - candidate.durationSeconds) > WAV_DURATION_TOLERANCE_SECONDS
    )
      fail(`long playback duration mismatch for ${item.fixtureId}`);
    const reference = longReference(item, references.get(item.fixtureId));
    return {
      fixture: {
        id: candidate.fixtureId,
        language: candidate.language,
        cohort: 'long',
        speakerKey: `spk_${sha256(candidate.fixtureId).slice(0, 16)}`,
        source: {
          collection: 'pinned-long-recording',
          release: candidate.referencePage,
          partition: 'standalone-recording',
          recordingId: candidate.fixtureId,
          mediaType: path.extname(candidate.mediaFileName).slice(1),
          sha256: candidate.sha256,
          durationSeconds: candidate.durationSeconds,
          url: candidate.audioPage,
        },
        normalizedAudio: {
          sha256: audio.wavSha256,
          durationSeconds: audio.durationSeconds,
          transform: NORMALIZED_AUDIO_TRANSFORM,
        },
        reference,
        excluded: false,
      },
      prepared: {
        audio: {
          wavPath: playback.realPath,
          durationSeconds: audio.durationSeconds,
          sourceSha256: candidate.sha256,
          wavSha256: audio.wavSha256,
        },
        referenceText: reference.status === 'available' ? reference.text : null,
      },
    };
  });
  for (const fixtureId of candidates.keys())
    if (!seenIds.has(fixtureId)) fail(`long worksheet is missing frozen candidate ${fixtureId}`);
  return { entries, sourceSnapshots };
}

function requireFixtureCounts(short, long, { expectedShortCount, expectedLongCount }) {
  if (short.length !== expectedShortCount || long.length !== expectedLongCount)
    fail(
      `internal corpus count mismatch: expected ${expectedShortCount} short and ${expectedLongCount} long fixtures`
    );
  if ([234, 243].includes(expectedShortCount) && expectedLongCount > 0) {
    const shortLanguages = new Set(short.map(entry => entry.fixture.language));
    const longLanguages = new Set(long.map(entry => entry.fixture.language));
    if (
      shortLanguages.size !== LANGUAGES.length ||
      longLanguages.size !== LANGUAGES.length ||
      LANGUAGES.some(language => !shortLanguages.has(language) || !longLanguages.has(language))
    )
      fail('internal corpus planned language coverage mismatch');
    if (
      expectedLongCount === 9 &&
      long.some(
        entry =>
          long.filter(other => other.fixture.language === entry.fixture.language).length !== 1
      )
    )
      fail('internal corpus long fixture language coverage mismatch');
  }
}

function buildInputBundle(snapshots, corpus) {
  if (snapshots.preparedLong) {
    return {
      corpusSha256: runCorpusHash(corpus),
      selectionSha256: snapshots.selection.sha256,
      shortWorksheetSha256: snapshots.shortWorksheet.sha256,
      sourceRegistrySha256: snapshots.sourceRegistry.sha256,
      sourceIndexes: snapshots.sourceIndexes,
      preparedLong: snapshots.preparedLong,
    };
  }
  return {
    corpusSha256: runCorpusHash(corpus),
    selectionSha256: snapshots.selection.sha256,
    shortWorksheetSha256: snapshots.shortWorksheet.sha256,
    longWorksheetSha256: snapshots.longWorksheet.sha256,
    sourceRegistrySha256: snapshots.sourceRegistry.sha256,
    longCandidatesSha256: snapshots.longCandidates.sha256,
    longApprovalsSha256: snapshots.longApprovals.sha256,
    longApprovalIdentitiesSha256: snapshots.longApprovalIdentities.sha256,
    longReferencesSha256: snapshots.longReferences.sha256,
    sourceIndexes: snapshots.sourceIndexes,
    longSources: snapshots.longSources,
  };
}

function buildWarnings(corpus) {
  return corpus.fixtures
    .filter(item => item.cohort === 'long' && item.reference.status === 'unavailable')
    .map(item => `Long fixture ${item.id} is reference-unavailable and will not be scored.`);
}

function defaultLongSources(options) {
  return path.resolve(path.dirname(options.longWorksheet), '..', '..', 'long-candidates');
}

function loadInternalCorpus(options, dependencies = {}) {
  requireObject(options, 'internal corpus options');
  const v3Fields = ['longSourceRegistry', 'longPrepared', 'longSources'];
  const legacyFields = ['longWorksheet', 'longReferences'];
  const usesV3 = ['longSourceRegistry', 'longPrepared'].some(
    field => typeof options[field] === 'string'
  );
  const v3Count = usesV3 ? v3Fields.filter(field => typeof options[field] === 'string').length : 0;
  const legacyCount = legacyFields.filter(field => typeof options[field] === 'string').length;
  if (v3Count !== 0 && v3Count !== v3Fields.length) {
    fail('v3 long corpus requires registry, prepared manifest, and source root');
  }
  if (v3Count === v3Fields.length && legacyCount !== 0) {
    fail('v3 and legacy long corpus inputs cannot be mixed');
  }
  if (!usesV3 && legacyCount !== legacyFields.length) {
    if (typeof options.longReferences !== 'string') {
      fail('long reference inventory path is required');
    }
    fail('legacy long corpus requires worksheet and reference inventory');
  }
  const snapshots = {
    selection: readJsonSnapshot(options.selection, 'short selection'),
    shortWorksheet: readJsonSnapshot(options.worksheet, 'short worksheet'),
    sourceRegistry: readJsonSnapshot(options.sourceRegistry, 'source registry'),
  };
  const selectionContract = validateShortSelectionDocument(snapshots.selection.value);
  const selection = selectionContract.entries;
  const shortWorksheet = worksheetItems(
    snapshots.shortWorksheet.value,
    SHORT_WORKSHEET_SCHEMA,
    'short worksheet'
  );
  let registry;
  try {
    registry = validateSourceRegistry(snapshots.sourceRegistry.value);
  } catch (error) {
    fail(`source registry is invalid: ${error.message}`);
  }
  const indexBundle = loadSourceIndexes(options.sourceIndexes);
  snapshots.sourceIndexes = indexBundle.snapshots;
  const worksheetRows = verifyWorksheetMembership(selection, shortWorksheet);
  const short = buildShortFixtures({
    selection,
    worksheetRows,
    indexes: indexBundle.rows,
    registry,
    worksheetSnapshot: snapshots.shortWorksheet,
  });
  let longEntries;
  let expectedLongCount;
  if (usesV3) {
    const longRegistry = readJsonSnapshot(options.longSourceRegistry, 'v3 long source registry');
    const longPrepared = readJsonSnapshot(options.longPrepared, 'v3 prepared long corpus');
    const longBundle = loadPreparedLongCorpus({
      registry: longRegistry.value,
      prepared: longPrepared.value,
      sourceRoot: options.longSources,
      preparedRoot: path.dirname(longPrepared.realPath),
    });
    longEntries = longBundle.entries;
    expectedLongCount = longEntries.length;
    snapshots.preparedLong = {
      registryFileSha256: longRegistry.sha256,
      preparedFileSha256: longPrepared.sha256,
      ...longBundle.inputBundle,
    };
  } else {
    snapshots.longWorksheet = readJsonSnapshot(options.longWorksheet, 'long worksheet');
    snapshots.longCandidates = readJsonSnapshot(
      options.longCandidates || DEFAULT_LONG_CANDIDATES,
      'long candidate registry'
    );
    snapshots.longApprovals = readJsonSnapshot(
      options.longApprovals || DEFAULT_LONG_APPROVALS,
      'long license approval registry'
    );
    snapshots.longApprovalIdentities = readJsonSnapshot(
      options.longApprovalIdentities || DEFAULT_LONG_APPROVAL_IDENTITIES,
      'long license approval identity registry'
    );
    snapshots.longReferences = readJsonSnapshot(options.longReferences, 'long reference inventory');
    const longWorksheet = worksheetItems(
      snapshots.longWorksheet.value,
      LONG_WORKSHEET_SCHEMA,
      'long worksheet'
    );
    const candidates = loadLongCandidates(snapshots.longCandidates);
    const approvalIdentities = loadLongApprovalIdentities(
      snapshots.longApprovalIdentities,
      candidates
    );
    const approvals = loadLongApprovals(snapshots.longApprovals, candidates, approvalIdentities);
    const longSources = safeDirectory(
      options.longSources || defaultLongSources(options),
      'long source directory'
    );
    const references = readLongReferences(snapshots.longReferences, longWorksheet);
    const longBundle = buildLongFixtures({
      worksheet: longWorksheet,
      references,
      candidates,
      approvals,
      longSources,
      worksheetSnapshot: snapshots.longWorksheet,
    });
    snapshots.longSources = longBundle.sourceSnapshots;
    for (const referenceId of references.keys())
      if (!longBundle.entries.some(entry => entry.fixture.id === referenceId))
        fail(`long reference inventory contains unapproved fixture ${referenceId}`);
    longEntries = longBundle.entries;
    expectedLongCount = dependencies.expectedLongCount ?? 9;
  }
  const expectedShortCount =
    dependencies.expectedShortCount ?? selectionContract.expectedShortCount;
  requireFixtureCounts(short, longEntries, { expectedShortCount, expectedLongCount });
  const warmup = {
    ...cloneJson(short[0].fixture, 'warm-up fixture'),
    id: `${short[0].fixture.id}-warmup`,
    cohort: 'warmup',
  };
  const corpus = validateRunCorpus({
    schema: 'wasper.asr-quality.run-corpus.v1',
    benchmarkRevision: BENCHMARK_REVISION,
    evidenceTier: 'source-trusted-internal',
    humanAudited: false,
    warmup,
    fixtures: [...short, ...longEntries].map(entry => entry.fixture),
  });
  const preparedById = new Map(
    [...short, ...longEntries].map(entry => [entry.fixture.id, entry.prepared])
  );
  preparedById.set(corpus.warmup.id, short[0].prepared);
  return deepFreeze({
    benchmarkProfile: selectionContract.benchmarkProfile,
    corpus,
    preparedFixture(fixture) {
      const prepared = preparedById.get(fixture?.id);
      if (prepared === undefined) fail(`Prepared internal fixture is missing: ${fixture?.id}`);
      return cloneJson(prepared, 'prepared internal fixture');
    },
    inputBundle: buildInputBundle(snapshots, corpus),
    warnings: buildWarnings(corpus),
  });
}

module.exports = { loadInternalCorpus, validateShortSelectionDocument };
