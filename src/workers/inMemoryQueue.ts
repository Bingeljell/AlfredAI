export class InMemoryQueue {
  private activeCount = 0;
  private readonly queue: Array<() => Promise<void>> = [];

  constructor(private readonly concurrency: number) {}

  enqueue(task: () => Promise<void>): void {
    this.queue.push(task);
    this.schedule();
  }

  private schedule(): void {
    if (this.activeCount >= this.concurrency) {
      return;
    }
    const next = this.queue.shift();
    if (!next) {
      return;
    }
    this.activeCount += 1;
    void next()
      .catch(() => {
        // Intentionally swallowed; each task handles its own status updates.
      })
      .finally(() => {
        this.activeCount -= 1;
        this.schedule();
      });
  }
}
