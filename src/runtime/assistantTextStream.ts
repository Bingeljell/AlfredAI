import { redactValue } from "../utils/redact.js";

/** Batch cumulative previews so reconnect replaces text instead of duplicating it.
 * Hold the unfinished word: a credential split across provider deltas must never
 * escape redaction just because its prefix and suffix arrived separately.
 */
export class AssistantTextStream {
  private text = "";
  private published = "";
  private pending = Promise.resolve();
  private failure: unknown;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly persist: (text: string) => Promise<unknown>, intervalMs = 150) {
    this.timer = setInterval(() => this.flush(), intervalMs);
    this.timer.unref?.();
  }

  append(delta: string): void { this.text += delta; }

  private flush(final = false): void {
    const stable = final ? this.text : this.text.replace(/\S*$/, "");
    const safe = String(redactValue(stable));
    if (safe === this.published) return;
    this.published = safe;
    this.pending = this.pending.then(async () => { await this.persist(safe); }).catch((error: unknown) => { this.failure = error; });
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.flush(true);
    await this.pending;
    if (this.failure) throw this.failure;
  }
}
