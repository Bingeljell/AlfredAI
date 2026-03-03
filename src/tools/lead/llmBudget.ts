export class LlmBudgetManager {
  private callsUsed = 0;

  constructor(private readonly maxCalls: number) {}

  consume(): boolean {
    if (this.callsUsed >= this.maxCalls) {
      return false;
    }
    this.callsUsed += 1;
    return true;
  }

  get used(): number {
    return this.callsUsed;
  }

  get remaining(): number {
    return Math.max(0, this.maxCalls - this.callsUsed);
  }

  get limit(): number {
    return this.maxCalls;
  }
}
