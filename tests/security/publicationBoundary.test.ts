import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ALFRED_AGENT } from "../../src/runtime/specialists.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8"
  })
    .split("\0")
    .filter((file) => file.length > 0 && existsSync(path.join(repoRoot, file)));
}

test("machine-local state is excluded from the public tree", () => {
  const tracked = trackedFiles();
  const forbidden = [
    /^\.claude\//,
    /^\.codex\//,
    /^\.agents\//,
    /^artifacts\//,
    /^workspace\//,
    /(^|\/)\.env$/,
    /com\.[^.]+\.alfred\.plist$/
  ];

  const violations = tracked.filter((file) => forbidden.some((pattern) => pattern.test(file)));
  assert.deepEqual(violations, []);
});

test("the shipped runtime prompt excludes developer instructions and owner-specific data", () => {
  const promptSource = readFileSync(path.join(repoRoot, "src/runtime/specialists.ts"), "utf8");
  const operatingSource = readFileSync(
    path.join(repoRoot, "src/runtime/operatingInstructions.ts"),
    "utf8"
  );
  const toolSource = readFileSync(
    path.join(repoRoot, "src/tools/definitions/logSession.tool.ts"),
    "utf8"
  );
  const shippedSource = `${promptSource}\n${operatingSource}\n${toolSource}`;

  assert.doesNotMatch(ALFRED_AGENT.systemPrompt, /AGENTS\.md/);
  assert.doesNotMatch(shippedSource, /com\.nikhil\.alfred/i);
  assert.doesNotMatch(shippedSource, /\/Users\/[^/\s]+/);
  assert.doesNotMatch(shippedSource, /\bNikhil\b/i);
});

test("generic runtime guidance preserves useful operating knowledge", () => {
  const operatingSource = readFileSync(
    path.join(repoRoot, "src/runtime/operatingInstructions.ts"),
    "utf8"
  );

  assert.match(operatingSource, /MEMORY AND CONTINUITY/);
  assert.match(operatingSource, /TEMPORAL REQUESTS/);
  assert.match(operatingSource, /EFFICIENT TOOL USE/);
  assert.match(operatingSource, /SELF-DEVELOPMENT/);
  assert.match(operatingSource, /src\/tools\/definitions/);
  assert.doesNotMatch(operatingSource, /commit workflow|co-authorship|never commit to main/i);

  assert.match(ALFRED_AGENT.systemPrompt, /MEMORY AND CONTINUITY/);
  assert.match(ALFRED_AGENT.systemPrompt, /SELF-DEVELOPMENT/);
});
