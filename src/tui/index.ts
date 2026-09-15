import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "dotenv";
import { GatewayClient } from "./client.js";
import { runTerminal } from "./app.js";
import { resolveAlfredPaths } from "../config/paths.js";

export function parseTuiArgs(args: string[]): { url?: string; sessionId?: string; help?: boolean } {
  const result: { url?: string; sessionId?: string; help?: boolean } = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help" || flag === "-h") { result.help = true; continue; }
    if (flag !== "--url" && flag !== "--session") throw new Error(`Unknown TUI option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--url") result.url = value;
    else result.sessionId = value;
  }
  return result;
}

export async function runTui(args: string[]): Promise<number> {
  const options = parseTuiArgs(args);
  if (options.help) {
    console.log("Usage: pnpm alfred tui [--session ID] [--url URL]\nConnect to the running Alfred gateway. Ctrl-P selects conversations; Ctrl-Q detaches.\nCredentials: ALFRED_API_KEY, or the local ALFRED_WORKSPACE_DIR/api-key file.");
    return 0;
  }
  config({ quiet: true });
  const paths = resolveAlfredPaths();
  const url = new URL(options.url ?? process.env.ALFRED_GATEWAY_URL ?? `http://127.0.0.1:${process.env.PORT ?? "3000"}`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Gateway URL must be an HTTP(S) origin without credentials, path, query, or fragment.");
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (!local && url.protocol !== "https:") throw new Error("Remote gateways require HTTPS; use a localhost tunnel for HTTP.");
  let key = process.env.ALFRED_API_KEY?.trim() ?? "";
  if (!key && local) key = await readFile(path.join(paths.workspaceDir, "api-key"), "utf8").then((value) => value.trim()).catch(() => "");
  if (!key && !local) throw new Error("Set ALFRED_API_KEY for the remote gateway.");
  await runTerminal(new GatewayClient(url.origin, key), options.sessionId);
  console.log("Detached. Alfred continues running in the gateway.");
  return 0;
}
