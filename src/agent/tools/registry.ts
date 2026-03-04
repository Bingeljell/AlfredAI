import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LeadAgentToolDefinition } from "../types.js";

interface ToolModule {
  toolDefinition?: LeadAgentToolDefinition;
}

function definitionsDir(): string {
  const filePath = fileURLToPath(import.meta.url);
  return path.join(path.dirname(filePath), "definitions");
}

export async function discoverLeadAgentTools(): Promise<Map<string, LeadAgentToolDefinition>> {
  const toolMap = new Map<string, LeadAgentToolDefinition>();
  const dirPath = definitionsDir();
  const entries = await readdir(dirPath);

  const toolFiles = entries
    .filter((entry) => /\.tool\.(ts|js)$/.test(entry))
    .sort((a, b) => a.localeCompare(b));

  for (const file of toolFiles) {
    const modulePath = path.join(dirPath, file);
    const moduleUrl = pathToFileURL(modulePath).href;
    const loaded = (await import(moduleUrl)) as ToolModule;
    const definition = loaded.toolDefinition;
    if (!definition) {
      continue;
    }
    toolMap.set(definition.name, definition);
  }

  return toolMap;
}
