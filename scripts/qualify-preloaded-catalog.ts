#!/usr/bin/env node
/** Qualification-only catalog generator; production session admission never reads its output. */

import { runBuildPreloadedCatalogCommand } from '../src/docker/build-preloaded-catalog-command.js';

runBuildPreloadedCatalogCommand(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`catalog qualification failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
