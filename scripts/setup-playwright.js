import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const platformCacheDir = process.platform === "darwin"
  ? path.join(os.homedir(), "Library", "Caches", "ms-playwright")
  : path.join(os.homedir(), ".cache", "ms-playwright");
const baseDir = process.env.PLAYWRIGHT_BROWSERS_PATH || platformCacheDir;

function hasBrowsersInstalled() {
  const chromiumExecutable = chromium.executablePath();
  if (!fs.existsSync(chromiumExecutable)) return false;
  const revisionDir = chromiumExecutable
    .split(path.sep)
    .find((segment) => /^chromium-\d+$/.test(segment));
  if (!revisionDir) return false;
  const revision = revisionDir.slice("chromium-".length);
  return fs.existsSync(path.join(baseDir, `chromium_headless_shell-${revision}`));
}

try {
  if (hasBrowsersInstalled()) {
    console.log("Playwright browsers already installed.");
    process.exit(0);
  }

  console.log("Playwright browsers missing. Installing chromium (one-time setup)...");
  execSync("pnpm exec playwright install chromium --with-deps", { stdio: "inherit" });
  console.log("Playwright setup complete.");
} catch (error) {
  console.warn("Playwright browser setup skipped or failed. Run `pnpm run setup:browsers` manually.");
  if (process.env.CI === "true") {
    process.exit(1);
  }
}
