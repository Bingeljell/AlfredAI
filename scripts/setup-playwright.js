import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const baseDir = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(os.homedir(), ".cache", "ms-playwright");

function hasBrowsersInstalled(directory) {
  if (!fs.existsSync(directory)) {
    return false;
  }
  const entries = fs.readdirSync(directory).filter((entry) => !entry.startsWith("."));
  return entries.length > 0;
}

try {
  if (hasBrowsersInstalled(baseDir)) {
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
