import { appendFile, chmod, mkdir } from "node:fs/promises";
import path from "node:path";
import { SCHEDULER_TASK_RUNS_DIRECTORY } from "./constants.js";
import { TaskRunEventSchema } from "./schemas.js";
import type { TaskRunEvent } from "./types.js";
import { redactValue } from "../utils/redact.js";

export class SchedulerTaskRunLog {
  private readonly directory: string;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(workspaceDir: string) {
    this.directory = path.join(workspaceDir, "scheduler", SCHEDULER_TASK_RUNS_DIRECTORY);
  }

  async append(event: TaskRunEvent): Promise<void> {
    const redacted = redactValue({
      outcome: event.outcome,
      errorCode: event.errorCode,
      observationDigest: event.observationDigest,
    }) as Pick<TaskRunEvent, "outcome" | "errorCode" | "observationDigest">;
    const parsed = TaskRunEventSchema.parse({ ...event, ...redacted });
    const previous = this.queues.get(parsed.taskId) ?? Promise.resolve();
    const next = previous.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await chmod(this.directory, 0o700);
      const filePath = path.join(this.directory, `${parsed.taskId}.jsonl`);
      await appendFile(filePath, `${JSON.stringify(parsed)}\n`, { encoding: "utf8", mode: 0o600 });
      await chmod(filePath, 0o600);
    });
    this.queues.set(parsed.taskId, next.then(() => undefined, () => undefined));
    await next;
  }
}
