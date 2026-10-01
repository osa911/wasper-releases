#!/usr/bin/env node
'use strict';
require('../src/cli.cjs')
  .main(process.argv.slice(2))
  .catch(error => {
    process.stderr.write(`${error.message}\n`);
    if (error.runDirectory) process.stderr.write(`Partial results: ${error.runDirectory}\n`);
    if (error.reportError)
      process.stderr.write(`Could not update the partial report: ${error.reportError.message}\n`);
    process.exitCode = 1;
  });
