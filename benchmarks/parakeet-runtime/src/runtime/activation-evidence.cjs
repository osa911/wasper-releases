'use strict';

const fs = require('node:fs');
const path = require('node:path');

function writeActivationEvidence({ runDirectory, activation }) {
  const outputPath = path.join(runDirectory, 'activations', `${activation.pass}.json`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputPath, `${JSON.stringify(activation, null, 2)}\n`, { mode: 0o600 });
}

module.exports = { writeActivationEvidence };
