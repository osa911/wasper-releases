'use strict';

const ALLOWED_DETECTED_LANGUAGE_KEYS = new Set(['detectedlanguage', 'detectedlocale']);
const DECODER_SELECTION_KEYS = new Set(['id', 'model', 'selected', 'selection']);

function requirePlainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function normalizeKey(key) {
  return key.replace(/[-_]/gu, '').toLocaleLowerCase('en-US');
}

function languageOverrideCommandToken(token) {
  return /^(?:--?)(?:(?:source|target|requested|forced)[-_])?(?:language|lang|locale)(?:[-_](?:hint|override|code))?(?:=|$)/iu.test(
    token
  );
}

function validateAutomaticLanguageCommand(command) {
  const tokens = Array.isArray(command)
    ? command
    : typeof command === 'string'
      ? command.trim().split(/\s+/u)
      : null;
  if (
    !tokens ||
    tokens.length === 0 ||
    tokens.some(token => typeof token !== 'string' || token === '')
  ) {
    throw new TypeError('launch command must be a non-empty string or string array');
  }
  for (const token of tokens) {
    if (languageOverrideCommandToken(token)) {
      throw new TypeError(`launch command contains a language override: ${token}`);
    }
  }
  return Object.freeze([...tokens]);
}

function isLanguageControlKey(key, hasDecoderAncestor) {
  if (ALLOWED_DETECTED_LANGUAGE_KEYS.has(key)) return false;
  if (key === 'lang' || key.includes('language') || key.includes('locale')) return true;
  return hasDecoderAncestor && DECODER_SELECTION_KEYS.has(key);
}

function validateMetadataValue(value, path, hasDecoderAncestor = false) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      validateMetadataValue(child, `${path}[${index}]`, hasDecoderAncestor);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    const childPath = path === '' ? key : `${path}.${key}`;
    if (ALLOWED_DETECTED_LANGUAGE_KEYS.has(normalized)) {
      if (typeof child !== 'string' || child.trim() === '') {
        throw new TypeError(
          `Runtime response detected-language metadata must be a non-empty string at ${childPath}`
        );
      }
      continue;
    }
    if (isLanguageControlKey(normalized, hasDecoderAncestor)) {
      throw new TypeError(
        `Runtime response automatic-language metadata is not allowed at ${childPath}`
      );
    }
    validateMetadataValue(child, childPath, hasDecoderAncestor || normalized === 'decoder');
  }
}

function validateAutomaticLanguageResponseMetadata(responseMetadata) {
  requirePlainObject(responseMetadata, 'responseMetadata');
  validateMetadataValue(responseMetadata, '');
  return responseMetadata;
}

module.exports = {
  validateAutomaticLanguageCommand,
  validateAutomaticLanguageResponseMetadata,
};
