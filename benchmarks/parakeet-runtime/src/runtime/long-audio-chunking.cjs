'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LONG_CHUNK_SECONDS = 30;
const LONG_CHUNK_OVERLAP_SECONDS = 5;

function readPcm16MonoWav(audioPath) {
  const file = fs.readFileSync(audioPath);
  if (file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WAVE') {
    throw new TypeError(`expected RIFF/WAVE audio: ${audioPath}`);
  }
  let offset = 12;
  let format;
  let pcm;
  while (offset + 8 <= file.length) {
    const chunkId = file.toString('ascii', offset, offset + 4);
    const chunkLength = file.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const bodyEnd = bodyStart + chunkLength;
    if (bodyEnd > file.length) throw new TypeError(`truncated WAV chunk: ${audioPath}`);
    if (chunkId === 'fmt ') {
      format = {
        audioFormat: file.readUInt16LE(bodyStart),
        channels: file.readUInt16LE(bodyStart + 2),
        sampleRate: file.readUInt32LE(bodyStart + 4),
        bitsPerSample: file.readUInt16LE(bodyStart + 14),
      };
    }
    if (chunkId === 'data') pcm = file.subarray(bodyStart, bodyEnd);
    offset = bodyEnd + (chunkLength % 2);
  }
  if (
    format?.audioFormat !== 1 ||
    format.channels !== 1 ||
    format.bitsPerSample !== 16 ||
    !Buffer.isBuffer(pcm)
  ) {
    throw new TypeError(`expected PCM16 mono WAV: ${audioPath}`);
  }
  return { sampleRate: format.sampleRate, pcm };
}

function writePcm16MonoWav(audioPath, { sampleRate, pcm }) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(audioPath, Buffer.concat([header, pcm]));
}

function prepareLongAudioChunks({
  fixtureId,
  audioPath,
  outputRoot,
  chunkSeconds = LONG_CHUNK_SECONDS,
  overlapSeconds = LONG_CHUNK_OVERLAP_SECONDS,
}) {
  if (typeof fixtureId !== 'string' || fixtureId.length === 0)
    throw new TypeError('fixtureId is required');
  if (typeof outputRoot !== 'string' || outputRoot.length === 0)
    throw new TypeError('outputRoot is required');
  if (
    !Number.isFinite(chunkSeconds) ||
    !Number.isFinite(overlapSeconds) ||
    chunkSeconds <= overlapSeconds
  ) {
    throw new TypeError('chunkSeconds must be greater than overlapSeconds');
  }
  const wav = readPcm16MonoWav(audioPath);
  const totalSamples = wav.pcm.length / 2;
  const chunkSamples = Math.round(chunkSeconds * wav.sampleRate);
  const overlapSamples = Math.round(overlapSeconds * wav.sampleRate);
  const directory = path.join(outputRoot, 'long-chunks', fixtureId);
  fs.mkdirSync(directory, { recursive: true });
  const chunks = [];
  for (let startSample = 0, index = 0; startSample < totalSamples; index += 1) {
    const endSample = Math.min(startSample + chunkSamples, totalSamples);
    const chunkPath = path.join(directory, `${String(index).padStart(4, '0')}.wav`);
    writePcm16MonoWav(chunkPath, {
      sampleRate: wav.sampleRate,
      pcm: wav.pcm.subarray(startSample * 2, endSample * 2),
    });
    chunks.push({
      index,
      audioPath: chunkPath,
      startSeconds: startSample / wav.sampleRate,
      endSeconds: endSample / wav.sampleRate,
    });
    if (endSample === totalSamples) break;
    startSample = endSample - overlapSamples;
  }
  return chunks;
}

function normalizedToken(token) {
  return token
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/^\p{P}+|\p{P}+$/gu, '');
}

function mergeOverlappingTranscripts(transcripts) {
  const merged = [];
  for (const transcript of transcripts) {
    const tokens = String(transcript ?? '')
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    if (tokens.length === 0) continue;
    const maximumOverlap = Math.min(merged.length, tokens.length, 64);
    let overlap = 0;
    for (let candidate = maximumOverlap; candidate > 0; candidate -= 1) {
      if (
        merged
          .slice(-candidate)
          .map(normalizedToken)
          .every((token, index) => token !== '' && token === normalizedToken(tokens[index]))
      ) {
        overlap = candidate;
        break;
      }
    }
    merged.push(...tokens.slice(overlap));
  }
  return merged.join(' ');
}

module.exports = {
  LONG_CHUNK_OVERLAP_SECONDS,
  LONG_CHUNK_SECONDS,
  mergeOverlappingTranscripts,
  prepareLongAudioChunks,
};
