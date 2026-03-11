import test from "node:test";
import assert from "node:assert/strict";
import type { RunEvent } from "../../src/types.js";
import { RunEventChannel } from "../../src/runs/eventChannel.js";

function makeEvent(index: number): RunEvent {
  return {
    runId: "run-1",
    sessionId: "session-1",
    phase: "observe",
    eventType: `event_${index}`,
    payload: { index },
    timestamp: new Date(1_700_000_000_000 + index).toISOString()
  };
}

test("RunEventChannel preserves event order and flushes queue", async () => {
  const seen: string[] = [];
  const channel = new RunEventChannel(async (event) => {
    seen.push(event.eventType);
  });

  await Promise.all([channel.push(makeEvent(1)), channel.push(makeEvent(2)), channel.push(makeEvent(3))]);
  await channel.flush();

  assert.deepEqual(seen, ["event_1", "event_2", "event_3"]);
});

test("RunEventChannel applies backpressure without dropping events", async () => {
  const seen: string[] = [];
  const channel = new RunEventChannel(
    async (event) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      seen.push(event.eventType);
    },
    {
      maxBufferedEvents: 8,
      lowWatermark: 3
    }
  );

  const pushes: Array<Promise<void>> = [];
  for (let index = 0; index < 30; index += 1) {
    pushes.push(channel.push(makeEvent(index)));
  }
  await Promise.all(pushes);
  await channel.flush();

  assert.equal(seen.length, 30);
  assert.equal(seen[0], "event_0");
  assert.equal(seen[29], "event_29");
});
