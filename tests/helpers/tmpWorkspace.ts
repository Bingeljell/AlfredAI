import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function createTempWorkspace(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
  return dir;
}
