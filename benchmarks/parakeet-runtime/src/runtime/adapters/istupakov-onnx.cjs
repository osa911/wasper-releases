'use strict';

const { resolveLockedDefinition } = require('./definition.cjs');

function resolveIstupakovOnnxDefinition(options = {}) {
  return resolveLockedDefinition('istupakov-onnx-int8', options);
}

module.exports = { resolveIstupakovOnnxDefinition };
