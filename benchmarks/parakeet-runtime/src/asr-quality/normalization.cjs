const { LANGUAGES } = require('./constants.cjs');

const LOCALES = Object.freeze({
  de: 'de-DE',
  el: 'el-GR',
  en: 'en-US',
  es: 'es-ES',
  fr: 'fr-FR',
  it: 'it-IT',
  nl: 'nl-NL',
  pl: 'pl-PL',
  pt: 'pt-PT',
});

function assertLanguage(language) {
  if (!LANGUAGES.includes(language)) {
    throw new RangeError(`Unsupported ASR benchmark language: ${String(language)}`);
  }
}

function normalizeTranscript(text, language) {
  assertLanguage(language);
  if (typeof text !== 'string') {
    throw new TypeError('Transcript text must be a string');
  }

  return text
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u02bc]/gu, "'")
    .replace(/[-\u2010-\u2015\u2212]/gu, ' ')
    .toLocaleLowerCase(LOCALES[language])
    .replace(/[^\p{L}\p{N}\p{M}']/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function wordUnits(text, language) {
  const normalized = normalizeTranscript(text, language);
  if (normalized === '') return [];
  return normalized.split(' ');
}

function characterUnits(text, language) {
  return Array.from(normalizeTranscript(text, language).replace(/\s+/gu, ''));
}

module.exports = { LOCALES, normalizeTranscript, wordUnits, characterUnits };
