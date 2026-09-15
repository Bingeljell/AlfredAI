#!/usr/bin/env node

try {
  process.env.ALFRED_PACKAGE_MODE = "true";
  const { runCli } = await import("../dist/scripts/alfred-cli.js");
  process.exitCode = await runCli(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Alfred CLI failed");
  process.exitCode = 1;
}
