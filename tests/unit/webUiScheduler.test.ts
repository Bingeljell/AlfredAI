import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("scheduled tasks UI keeps its markup, bindings, and owner-scoped API calls aligned", async () => {
  const [html, app] = await Promise.all([
    readFile("webui/index.html", "utf8"),
    readFile("webui/app.js", "utf8")
  ]);

  const ids = [
    "nav-scheduled-tasks",
    "dpane-scheduler",
    "scheduler-summary",
    "scheduler-status-grid",
    "scheduled-task-list",
    "refresh-scheduled-tasks"
  ];

  for (const id of ids) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
    assert.match(app, new RegExp(`getElementById\\(["']${id}["']\\)`));
  }

  assert.match(app, /api\('\/v1\/scheduler\/status'\)/);
  assert.match(app, /\/v1\/scheduled-tasks\?sessionId=\$\{sessionId\}/);
  assert.match(app, /\/v1\/scheduled-tasks\/\$\{encodeURIComponent\(taskId\)\}\/cancel\?sessionId=\$\{sessionId\}&channelKey=\$\{channelKey\}/);
  assert.match(app, /stopOpenAiLoginPolling\(\);[\s\S]*clearInterval\(state\.schedulerTimer\)/);
});
