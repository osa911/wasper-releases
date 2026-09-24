'use strict';

const { preparePublicCorpus } = require('./corpus/public-corpus.cjs');

// Public recovery has no fallback to a checkout, private evidence, or local media.
async function recoverCorpus(options, dependencies) {
  return preparePublicCorpus(options, dependencies);
}

module.exports = { recoverCorpus };
