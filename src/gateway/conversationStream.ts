import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { RunStore } from "../runs/runStore.js";
import type { SessionStore } from "../memory/sessionStore.js";
import type { ConversationSnapshot } from "../types.js";
import type { FileWebActivitySink } from "../scheduler/notifier.js";

/** Complete snapshots allow reconnect without a lossy replay/live handoff. */
export async function conversationStream(c: Context, sessions: SessionStore, runs: RunStore, activity?: FileWebActivitySink): Promise<Response> {
  const sessionId = c.req.param("sessionId")!;
  if (!await sessions.getSession(sessionId)) return c.json({ error: "Session not found" }, 404);
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    let previous = "";
    let ticks = 0;
    while (!stream.aborted) {
      const session = await sessions.getSession(sessionId);
      if (!session) break;
      const snapshot: ConversationSnapshot = {
        session,
        runs: await runs.listRuns(sessionId, 100),
        notifications: await activity?.readForSession(sessionId, "api") ?? []
      };
      const data = JSON.stringify(snapshot);
      if (data !== previous) {
        await stream.writeSSE({ event: "snapshot", data });
        previous = data;
      } else if (++ticks % 15 === 0) {
        await stream.writeSSE({ event: "heartbeat", data: "{}" });
      }
      await stream.sleep(1_000);
    }
  });
}
