#!/usr/bin/env node

import { runCli } from "../dist/scripts/alfred-cli.js";

try {
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Alfred CLI failed");
  process.exitCode = 1;
}
