import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import {
  SCHEDULER_DELIVERIES_FILE,
  SCHEDULER_DELIVERIES_LOCK_FILE,
  SCHEDULER_DIRECTORY,
  SCHEDULER_LOCK_TTL_MS,
} from "./constants.js";
import { canonicalUtc, DeliverySnapshotSchema, ScheduledDeliverySchema } from "./schemas.js";
import type { DeliverySnapshot, NotificationDestination, ScheduledDeliveryV1 } from "./types.js";
import { redactValue } from "../utils/redact.js";

interface DeliveryStoreOptions {
  workspaceDir: string;
  nowMs?: () => number;
  instanceId?: string;
}

export class SchedulerDeliveryStore {
  private readonly directory: string;
  private readonly filePath: string;
  private readonly lockPath: string;
  private readonly nowMs: () => number;
  private readonly instanceId: string;
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(options: DeliveryStoreOptions) {
    this.directory = path.join(options.workspaceDir, SCHEDULER_DIRECTORY);
    this.filePath = path.join(this.directory, SCHEDULER_DELIVERIES_FILE);
    this.lockPath = path.join(this.directory, SCHEDULER_DELIVERIES_LOCK_FILE);
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.instanceId = options.instanceId ?? randomUUID();
  }

  async init(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try {
      await readFile(this.filePath, "utf8");
    } catch (error) {
      if (!isMissing(error)) throw error;
      await this.writeSnapshot({ version: 1, deliveries: [] });
    }
  }

  static deliveryId(taskId: string, cycleId: string, purpose: string): string {
    return `${taskId}:${cycleId}:${purpose}`;
  }

  async get(id: string): Promise<ScheduledDeliveryV1 | undefined> {
    const snapshot = await this.readSnapshot();
    const delivery = snapshot.deliveries.find((candidate) => candidate.id === id);
    return delivery ? structuredClone(delivery) : undefined;
  }

  async ensurePending(input: {
    taskId: string;
    cycleId: string;
    purpose: string;
    destination: NotificationDestination;
  }): Promise<ScheduledDeliveryV1> {
    const id = SchedulerDeliveryStore.deliveryId(input.taskId, input.cycleId, input.purpose);
    return this.mutate((snapshot) => {
      const existing = snapshot.deliveries.find((candidate) => candidate.id === id);
      if (existing) return structuredClone(existing);
      const now = canonicalUtc(this.nowMs());
      const delivery = ScheduledDeliverySchema.parse({
        version: 1,
        id,
        taskId: input.taskId,
        cycleId: input.cycleId,
        purpose: input.purpose,
        destination: input.destination,
        status: "pending",
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      });
      snapshot.deliveries.push(delivery);
      return structuredClone(delivery);
    });
  }

  async claimSending(id: string, retryFailed = false): Promise<ScheduledDeliveryV1 | undefined> {
    return this.mutate((snapshot) => {
      const delivery = snapshot.deliveries.find((candidate) => candidate.id === id);
      if (!delivery) return undefined;
      if (delivery.status === "delivered") return undefined;
      if (delivery.status === "failed" && !retryFailed) return undefined;
      if (delivery.status === "sending") return undefined;
      const now = canonicalUtc(this.nowMs());
      delivery.status = "sending";
      delivery.attempts += 1;
      delivery.sendingAt = now;
      delivery.updatedAt = now;
      delivery.safeErrorCode = undefined;
      return structuredClone(delivery);
    });
  }

  async markDelivered(id: string, externalMessageId?: string): Promise<ScheduledDeliveryV1> {
    return this.mutate((snapshot) => {
      const delivery = requireDelivery(snapshot, id);
      const now = canonicalUtc(this.nowMs());
      delivery.status = "delivered";
      delivery.deliveredAt = now;
      delivery.updatedAt = now;
      delivery.externalMessageId = externalMessageId;
      delivery.safeErrorCode = undefined;
      return structuredClone(delivery);
    });
  }

  async markFailed(id: string, safeErrorCode: string): Promise<ScheduledDeliveryV1> {
    return this.mutate((snapshot) => {
      const delivery = requireDelivery(snapshot, id);
      const now = canonicalUtc(this.nowMs());
      delivery.status = "failed";
      delivery.failedAt = now;
      delivery.updatedAt = now;
      delivery.safeErrorCode = safeErrorCode.slice(0, 128);
      return structuredClone(delivery);
    });
  }

  async listPending(nowMs = this.nowMs()): Promise<ScheduledDeliveryV1[]> {
    const snapshot = await this.readSnapshot();
    return snapshot.deliveries
      .filter((delivery) => delivery.status === "pending" || (delivery.status === "sending" && delivery.sendingAt && Date.parse(delivery.sendingAt) + SCHEDULER_LOCK_TTL_MS < nowMs))
      .map((delivery) => structuredClone(delivery));
  }

  private async readSnapshot(): Promise<DeliverySnapshot> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = DeliverySnapshotSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) throw new Error("delivery snapshot failed validation");
      return structuredClone(parsed.data);
    } catch (error) {
      if (isMissing(error)) return { version: 1, deliveries: [] };
      throw new Error("scheduler delivery snapshot could not be read", { cause: error });
    }
  }

  private async mutate<T>(mutation: (snapshot: DeliverySnapshot) => T): Promise<T> {
    const run = this.mutationTail.then(() => this.withLock(async () => {
      const snapshot = await this.readSnapshot();
      const result = mutation(snapshot);
      const safe = redactDeliverySnapshot(snapshot);
      await this.writeSnapshot(DeliverySnapshotSchema.parse(safe));
      return result;
    }));
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        try {
          const now = this.nowMs();
          await handle.writeFile(JSON.stringify({ ownerId: this.instanceId, pid: process.pid, createdAtMs: now, expiresAtMs: now + SCHEDULER_LOCK_TTL_MS }));
          await handle.sync();
        } finally {
          await handle.close();
        }
        try {
          return await operation();
        } finally {
          await unlink(this.lockPath).catch((error: unknown) => {
            if (!isMissing(error)) throw error;
          });
        }
      } catch (error) {
        if (!isAlreadyExists(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    throw new Error("timed out waiting for scheduler delivery lock");
  }

  private async writeSnapshot(snapshot: DeliverySnapshot): Promise<void> {
    const tempPath = `${this.filePath}.${this.instanceId}.${randomUUID()}.tmp`;
    const handle = await open(tempPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(snapshot, null, 2)}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await chmod(tempPath, 0o600);
    await rename(tempPath, this.filePath);
  }
}

function requireDelivery(snapshot: DeliverySnapshot, id: string): ScheduledDeliveryV1 {
  const delivery = snapshot.deliveries.find((candidate) => candidate.id === id);
  if (!delivery) throw new Error("scheduler delivery was not found");
  return delivery;
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "EEXIST";
}

function redactDeliverySnapshot(snapshot: DeliverySnapshot): DeliverySnapshot {
  const safeErrors = redactValue(snapshot.deliveries.map((delivery) => delivery.safeErrorCode)) as Array<string | undefined>;
  const persisted = structuredClone(snapshot);
  persisted.deliveries.forEach((delivery, index) => {
    delivery.safeErrorCode = safeErrors[index];
  });
  return persisted;
}
