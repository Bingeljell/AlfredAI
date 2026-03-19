import type { InMemoryQueue } from "../workers/inMemoryQueue.js";
import { TurnRuntime, type TurnOp, type TurnRuntimeDispatchResult } from "./turnRuntime.js";

type ThreadWatcherEventType = "op_queued" | "op_started" | "op_completed" | "op_failed";

export interface ThreadWatcherEvent {
  runId: string;
  sessionId: string;
  type: ThreadWatcherEventType;
  opType: TurnOp["type"];
  queuedDepth: number;
  timestamp: string;
  detail?: string;
}

type ThreadWatcher = (event: ThreadWatcherEvent) => void;

interface QueuedOp {
  op: TurnOp;
  resolve: (value: TurnRuntimeDispatchResult | PromiseLike<TurnRuntimeDispatchResult>) => void;
  reject: (reason?: unknown) => void;
}

interface ThreadRuntimeOptions {
  sessionId: string;
  queue: InMemoryQueue;
  turnRuntime: TurnRuntime;
}

function nowIso(): string {
  return new Date().toISOString();
}

export class ThreadRuntime {
  private readonly queue: QueuedOp[] = [];
  private readonly watchers = new Set<ThreadWatcher>();
  private processing = false;

  constructor(private readonly options: ThreadRuntimeOptions) {}

  submit(op: TurnOp): Promise<TurnRuntimeDispatchResult> {
    return new Promise<TurnRuntimeDispatchResult>((resolve, reject) => {
      this.queue.push({ op, resolve, reject });
      this.emit("op_queued", op, this.queue.length);
      this.schedule();
    });
  }

  subscribe(watcher: ThreadWatcher): () => void {
    this.watchers.add(watcher);
    return () => {
      this.watchers.delete(watcher);
    };
  }

  private schedule(): void {
    if (this.processing) {
      return;
    }
    if (this.queue.length === 0) {
      return;
    }
    this.processing = true;
    this.options.queue.enqueue(async () => {
      try {
        while (this.queue.length > 0) {
          const next = this.queue.shift();
          if (!next) {
            continue;
          }
          this.emit("op_started", next.op, this.queue.length);
          try {
            const result = await this.options.turnRuntime.dispatch(next.op);
            this.emit("op_completed", next.op, this.queue.length, result.reason);
            next.resolve(result);
          } catch (error) {
            const detail = error instanceof Error ? error.message : "thread_runtime_dispatch_failed";
            this.emit("op_failed", next.op, this.queue.length, detail);
            next.reject(error);
          }
        }
      } finally {
        this.processing = false;
        if (this.queue.length > 0) {
          this.schedule();
        }
      }
    });
  }

  private emit(type: ThreadWatcherEventType, op: TurnOp, queuedDepth: number, detail?: string): void {
    const event: ThreadWatcherEvent = {
      runId: op.payload.runId,
      sessionId: this.options.sessionId,
      type,
      opType: op.type,
      queuedDepth,
      timestamp: nowIso(),
      detail
    };
    for (const watcher of this.watchers) {
      watcher(event);
    }
  }
}

interface ThreadRuntimeManagerOptions {
  queue: InMemoryQueue;
  createTurnRuntime: (sessionId: string) => TurnRuntime;
}

export class ThreadRuntimeManager {
  private readonly runtimes = new Map<string, ThreadRuntime>();

  constructor(private readonly options: ThreadRuntimeManagerOptions) {}

  getOrCreate(sessionId: string): ThreadRuntime {
    let runtime = this.runtimes.get(sessionId);
    if (!runtime) {
      runtime = new ThreadRuntime({
        sessionId,
        queue: this.options.queue,
        turnRuntime: this.options.createTurnRuntime(sessionId)
      });
      this.runtimes.set(sessionId, runtime);
    }
    return runtime;
  }

  submit(sessionId: string, op: TurnOp): Promise<TurnRuntimeDispatchResult> {
    return this.getOrCreate(sessionId).submit(op);
  }

  subscribe(sessionId: string, watcher: ThreadWatcher): () => void {
    return this.getOrCreate(sessionId).subscribe(watcher);
  }
}
