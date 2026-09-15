import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const cacheDir = mkdtempSync(path.join(os.tmpdir(), "alfred-npm-cache-"));
const result = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
  cwd: new URL("..", import.meta.url),
  encoding: "utf8",
  env: { ...process.env, npm_config_cache: cacheDir }
});
rmSync(cacheDir, { recursive: true, force: true });
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}

const report = JSON.parse(result.stdout)[0];
const files = report.files.map((entry) => entry.path);
const allowed = [
  /^bin\/alfred\.js$/,
  /^dist\//,
  /^webui\//,
  /^templates\//,
  /^README\.md$/,
  /^package\.json$/
];
const forbidden = files.filter((file) => !allowed.some((pattern) => pattern.test(file)));
if (forbidden.length > 0) {
  throw new Error(`Unexpected files in npm package:\n${forbidden.join("\n")}`);
}
for (const required of ["bin/alfred.js", "dist/scripts/alfred-cli.js", "dist/src/gateway/server.js", "webui/index.html", "package.json"]) {
  if (!files.includes(required)) throw new Error(`Required npm package file is missing: ${required}`);
}
process.stdout.write(`${JSON.stringify({ name: report.name, version: report.version, files: files.length, packedBytes: report.size, unpackedBytes: report.unpackedSize }, null, 2)}\n`);
