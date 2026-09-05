import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { AssistantTextStream } from "../../src/runtime/assistantTextStream.js";

test("streaming publishes cumulative text before completion and redacts split credentials", async () => {
  const received: string[] = [];
  const stream = new AssistantTextStream(async (text) => { received.push(text); }, 5);
  stream.append("Hello there. sk-");
  await delay(20);
  assert.deepEqual(received, ["Hello there. "]);
  stream.append("abcdefghijklmnop");
  await delay(20);
  assert.equal(received.length, 1);
  stream.append(" next");
  await delay(20);
  await stream.close();
  assert.equal(received.at(-1), "Hello there. [REDACTED_KEY] next");
  assert.equal(received.some((text) => text.includes("sk-")), false);
});

test("stream close waits for pending writes and preserves the final unfinished word", async () => {
  const received: string[] = [];
  const stream = new AssistantTextStream(async (text) => { await delay(10); received.push(text); }, 5);
  stream.append("partial ");
  await delay(15);
  stream.append("answer");
  await stream.close();
  assert.deepEqual(received, ["partial ", "partial answer"]);
});
