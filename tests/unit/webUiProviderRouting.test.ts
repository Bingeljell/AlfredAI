import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("provider settings distinguish active routing from a standby ChatGPT account", async () => {
  const [html, app] = await Promise.all([
    readFile("webui/index.html", "utf8"),
    readFile("webui/app.js", "utf8")
  ]);

  assert.match(html, /id=["']settings-provider-card["']/);
  assert.match(app, /settingsProviderCard: document\.getElementById\(["']settings-provider-card["']\)/);
  assert.match(app, /Automatic LLM fallback: not configured/);
  assert.match(app, /This account is available if you explicitly switch to the Codex provider; it is not an automatic fallback\./);
  assert.match(app, /codexIsActive \? 'Active' : 'Standby'/);
  assert.match(app, /if \(state\.drawerTab === 'settings'\) renderSettingsPage\(\)/);
  assert.match(app, /state\.openAiUsageError = error\?\.message/);
  assert.match(app, /Usage details unavailable: \$\{escapeHtml\(state\.openAiUsageError\)\}/);
});
