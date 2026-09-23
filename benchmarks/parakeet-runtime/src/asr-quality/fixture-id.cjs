'use strict';

const { LANGUAGES } = require('./constants.cjs');

const MANIFEST_FIXTURE_ID_MAX_LENGTH = 128;
const MANIFEST_FIXTURE_ID_PATTERN_SOURCE =
  '^(?!(?:no-qualified-long(?:-|$)|__proto__$|prototype$|constructor$))[a-z0-9]+(?:-[a-z0-9]+)*$';
const MANIFEST_FIXTURE_ID_PATTERN = new RegExp(MANIFEST_FIXTURE_ID_PATTERN_SOURCE, 'u');
const NO_QUALIFIED_FIXTURE_ID_PREFIX = 'no-qualified-long:';
const NO_QUALIFIED_FIXTURE_ID_PATTERN = new RegExp(
  `^${NO_QUALIFIED_FIXTURE_ID_PREFIX}(${LANGUAGES.join('|')})$`,
  'u'
);

function isManifestFixtureId(value) {
  return (
    typeof value === 'string' &&
    value.length <= MANIFEST_FIXTURE_ID_MAX_LENGTH &&
    MANIFEST_FIXTURE_ID_PATTERN.test(value)
  );
}

function classifyScheduledFixtureId(value) {
  if (isManifestFixtureId(value)) return Object.freeze({ kind: 'manifest', language: null });
  if (typeof value === 'string') {
    const match = NO_QUALIFIED_FIXTURE_ID_PATTERN.exec(value);
    if (match) return Object.freeze({ kind: 'no-qualified-long', language: match[1] });
  }
  throw new TypeError(
    'fixtureId must use the bounded manifest identifier grammar or the reserved no-qualified-long:<language> synthetic identifier'
  );
}

module.exports = {
  classifyScheduledFixtureId,
  isManifestFixtureId,
  MANIFEST_FIXTURE_ID_MAX_LENGTH,
  MANIFEST_FIXTURE_ID_PATTERN_SOURCE,
  NO_QUALIFIED_FIXTURE_ID_PREFIX,
};
