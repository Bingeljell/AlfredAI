import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { SchedulerDeliveryStore } from "../../src/scheduler/deliveryStore.js";
import { createTempWorkspace } from "../helpers/tmpWorkspace.js";

test("delivery ledger is deterministic and idempotent", async () => {
  const workspace = await createTempWorkspace("scheduler-delivery");
  const store = new SchedulerDeliveryStore({
    workspaceDir: workspace,
    instanceId: "delivery-a",
    nowMs: () => Date.parse("2026-08-17T10:00:00.000Z"),
  });
  await store.init();
  const input = {
    taskId: "550e8400-e29b-41d4-a716-446655440000",
    cycleId: "550e8400-e29b-41d4-a716-446655440000:1",
    purpose: "reminder",
    destination: { channelKey: "telegram:123", principalId: "123" },
  };
  const first = await store.ensurePending(input);
  const second = await store.ensurePending(input);
  assert.equal(first.id, second.id);
  const sending = await store.claimSending(first.id);
  assert.equal(sending?.attempts, 1);
  assert.equal(await store.claimSending(first.id), undefined);
  const delivered = await store.markDelivered(first.id, "external-1");
  assert.equal(delivered.status, "delivered");
  assert.equal((await store.claimSending(first.id)), undefined);
  const raw = await readFile(`${workspace}/scheduler/deliveries.json`, "utf8");
  assert.match(raw, /external-1/);
});

