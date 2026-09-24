'use strict';

const fs = require('node:fs');
const path = require('node:path');

function resolvePreparedLongManifestPath({
  cacheRoot,
  explicitManifestPath,
  legacyNasManifestPath,
}) {
  if (typeof explicitManifestPath === 'string' && explicitManifestPath.trim() !== '') {
    return explicitManifestPath.trim();
  }
  const localManifestPath = path.join(
    cacheRoot,
    'corpus',
    'long',
    'prepared',
    'long-prepared.json'
  );
  return fs.existsSync(localManifestPath) ? localManifestPath : legacyNasManifestPath;
}

module.exports = { resolvePreparedLongManifestPath };
