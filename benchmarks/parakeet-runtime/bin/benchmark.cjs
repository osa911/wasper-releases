#!/usr/bin/env node
'use strict';
require('../src/cli.cjs').main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
