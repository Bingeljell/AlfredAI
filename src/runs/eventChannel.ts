import type { RunEvent } from "../types.js";

export interface RunEventChannelOptions {
  maxBufferedEvents?: number;
  lowWatermark?: number;
}

interface PendingEvent {
  event: RunEvent;
  resolve: () => void;
  reject: (error: unknown) => void;
}

export class RunEventChannel {
  private readonly maxBufferedEvents: number;
  private readonly lowWatermark: number;
  private readonly queue: PendingEvent[] = [];
  private readonly capacityWaiters: Array<() => void> = [];
  private readonly idleWaiters: Array<() => void> = [];
  private flushing = false;

  constructor(
    private readonly sink: (event: RunEvent) => Promise<void>,
    options: RunEventChannelOptions = {}
  ) {
    this.maxBufferedEvents = Math.max(20, options.maxBufferedEvents ?? 400);
    const configuredLowWatermark = options.lowWatermark ?? Math.floor(this.maxBufferedEvents * 0.65);
    this.lowWatermark = Math.min(this.maxBufferedEvents - 1, Math.max(1, configuredLowWatermark));
  }

  async push(event: RunEvent): Promise<void> {
    await this.waitForCapacity();
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ event, resolve, reject });
      this.scheduleFlush();
    });
  }

  async flush(): Promise<void> {
    if (!this.flushing && this.queue.length === 0) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
      this.scheduleFlush();
    });
  }

  private async waitForCapacity(): Promise<void> {
    while (this.queue.length >= this.maxBufferedEvents) {
      await new Promise<void>((resolve) => {
        this.capacityWaiters.push(resolve);
      });
    }
  }

  private scheduleFlush(): void {
    if (this.flushing) {
      return;
    }
    this.flushing = true;
    void this.flushLoop();
  }

  private async flushLoop(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const pending = this.queue.shift();
        if (!pending) {
          continue;
        }
        try {
          await this.sink(pending.event);
          pending.resolve();
        } catch (error) {
          pending.reject(error);
        } finally {
          this.notifyCapacityWaiters();
        }
      }
    } finally {
      this.flushing = false;
      this.resolveIdleWaiters();
      if (this.queue.length > 0) {
        this.scheduleFlush();
      }
    }
  }

  private notifyCapacityWaiters(): void {
    if (this.queue.length > this.lowWatermark || this.capacityWaiters.length === 0) {
      return;
    }
    const waiters = this.capacityWaiters.splice(0, this.capacityWaiters.length);
    for (const waiter of waiters) {
      waiter();
    }
  }

  private resolveIdleWaiters(): void {
    if (this.flushing || this.queue.length > 0 || this.idleWaiters.length === 0) {
      return;
    }
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const waiter of waiters) {
      waiter();
    }
  }
}
