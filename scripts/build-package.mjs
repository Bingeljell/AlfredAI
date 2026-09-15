import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";

await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
const result = spawnSync(
  process.execPath,
  ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
  { cwd: new URL("..", import.meta.url), stdio: "inherit" }
);
process.exitCode = result.status ?? 1;
