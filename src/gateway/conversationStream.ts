import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import type { RunStore } from "../runs/runStore.js";
import type { SessionStore } from "../memory/sessionStore.js";
import type { ConversationSnapshot } from "../types.js";
import type { FileWebActivitySink } from "../scheduler/notifier.js";

/** Durable bounded replay; stale/unknown cursors recover through a full snapshot. */
export async function conversationStream(c: Context, sessions: SessionStore, runs: RunStore, activity?: FileWebActivitySink): Promise<Response> {
  const sessionId = c.req.param("sessionId")!;
  if (!await sessions.getSession(sessionId)) return c.json({ error: "Session not found" }, 404);
  const requested = c.req.header("Last-Event-ID");
  if (requested !== undefined && !/^\d+$/.test(requested)) return c.json({ error: "Invalid event cursor" }, 400);
  let cursor = requested === undefined ? 0 : Number(requested);
  if (!Number.isSafeInteger(cursor)) return c.json({ error: "Invalid event cursor" }, 400);
  c.header("Cache-Control", "no-cache, no-transform");
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream) => {
    let initial = true;
    let previousMetadata = "";
    let ticks = 0;
    while (!stream.aborted) {
      const changes = await runs.changesSince(sessionId, cursor);
      if (changes.reset || initial && requested === undefined) {
        // Capture the watermark before reading state. Concurrent changes may
        // appear twice, but can never fall between the snapshot and replay.
        cursor = changes.cursor;
        const session = await sessions.getSession(sessionId);
        if (!session) break;
        const snapshot: ConversationSnapshot = {
          cursor, session, runs: (await runs.listHistory(sessionId, { limit: 100 })).runs,
          notifications: await activity?.readForSession(sessionId, "api") ?? []
        };
        await stream.writeSSE({ event: "snapshot", id: String(cursor), data: JSON.stringify(snapshot) });
      } else {
        // Coalesce multiple revisions of a run into its latest authoritative state.
        const latest = [...new Map(changes.changes.map((change) => [change.runId, change])).values()].sort((a, b) => a.id - b.id);
        for (const change of latest) {
          const run = await runs.getRun(change.runId);
          if (run) await stream.writeSSE({ event: "run", id: String(change.id), data: JSON.stringify({ run }) });
        }
        cursor = changes.cursor;
      }
      if (initial || ticks % 4 === 0) {
        const session = await sessions.getSession(sessionId);
        if (!session) break;
        const metadata = JSON.stringify({ session, notifications: await activity?.readForSession(sessionId, "api") ?? [] });
        if (metadata !== previousMetadata) {
          await stream.writeSSE({ event: "session", id: String(cursor), data: metadata });
          previousMetadata = metadata;
        }
      }
      if (++ticks % 60 === 0) await stream.writeSSE({ event: "heartbeat", data: "{}" });
      initial = false;
      await stream.sleep(250);
    }
  });
}
