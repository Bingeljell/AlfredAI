import test from "node:test";
import assert from "node:assert/strict";
import { discoverLeadAgentTools } from "../../src/agent/tools/registry.js";

test("auto-discovers lead agent tools from definitions folder", async () => {
  const tools = await discoverLeadAgentTools();

  assert.ok(tools.has("lead_pipeline"));
  assert.ok(tools.has("recover_search"));
  assert.ok(tools.has("search"));
  assert.ok(tools.has("search_status"));
  assert.ok(tools.has("write_csv"));

  const searchTool = tools.get("search");
  assert.ok(searchTool);
  const parsed = searchTool!.inputSchema.parse({ query: "top msp usa", maxResults: 10 }) as {
    query: string;
    maxResults?: number;
  };
  assert.equal(parsed.maxResults, 10);
});
