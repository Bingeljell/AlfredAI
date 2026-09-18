import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("npm manifest uses an explicit private package boundary", async () => {
  const manifest = JSON.parse(await readFile("package.json", "utf8")) as {
    private?: boolean;
    bin?: Record<string, string>;
    files?: string[];
    scripts?: Record<string, string>;
    engines?: Record<string, string>;
  };

  assert.equal(manifest.private, true);
  assert.equal(manifest.bin?.alfred, "bin/alfred.js");
  assert.deepEqual(manifest.files, [
    "bin/",
    "dist/",
    "webui/",
    "templates/",
    "docs/getting-started.md",
    "docs/architecture/tui.md",
    "docs/operations/alfred-home-migration.md",
    "docs/operations/chatgpt_subscription.md",
    "docs/operations/extensions.md"
  ]);
  assert.equal("postinstall" in (manifest.scripts ?? {}), false);
  assert.equal(manifest.scripts?.["smoke:package"], "npm run build && node scripts/smoke-package.mjs");
  assert.match(manifest.engines?.node ?? "", /^>=22/);
});
