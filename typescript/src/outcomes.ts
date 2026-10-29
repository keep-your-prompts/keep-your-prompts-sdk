// Optional outcome reporting: POST {api}/v1/apps/{app}/outcomes, buffered and fail-silent.
import { describeError, type FetchLike } from './io.js';

export type OutcomeKind = 'success' | 'failure' | 'feedback_positive' | 'feedback_negative';
export const OUTCOME_KINDS: readonly OutcomeKind[] = ['success', 'failure', 'feedback_positive', 'feedback_negative'];

export interface OutcomeReport {
  /** Prompt name as deployed (e.g. `triage`). */
  prompt: string;
  outcome: OutcomeKind;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Body that was used. Defaults to the sha256 of the prompt currently held. */
  sha256?: string;
}

/** One event as the API receives it (`RecordOutcome`). */
export interface OutcomeEvent {
  env: string;
  prompt: string;
  sha256: string;
  outcome: OutcomeKind;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface OutcomeSettings {
  apiKey: string;
  apiUrl: string;
  app: string;
  fetch: FetchLike;
  userAgent: string;
  maxBuffer: number;
  flushInterval: number;
  timeoutMs: number;
  log: (level: 'debug' | 'warn', msg: string) => void;
}

const BATCH = 500; // the API accepts at most 500 events per request

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;

export class OutcomeBuffer {
  private events: OutcomeEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight: Promise<void> | undefined;
  dropped = 0;

  constructor(private readonly s: OutcomeSettings) {}

  get size(): number {
    return this.events.length;
  }

  add(e: OutcomeEvent): void {
    for (const k of ['latencyMs', 'inputTokens', 'outputTokens'] as const) {
      const v = count(e[k]);
      if (v === undefined) delete e[k];
      else e[k] = v;
    }
    this.events.push(e);
    // Bounded: the oldest events go first.
    if (this.events.length > this.s.maxBuffer) {
      const over = this.events.length - this.s.maxBuffer;
      this.events.splice(0, over);
      this.dropped += over;
    }
    if (this.events.length >= BATCH) void this.flush();
    else this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.s.flushInterval <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.s.flushInterval);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Send everything buffered. Never throws; failed batches are put back (within the bound). */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    while (this.inflight) await this.inflight;
    if (!this.events.length) return;
    this.inflight = this.send();
    try {
      await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }

  private async send(): Promise<void> {
    const url = `${this.s.apiUrl.replace(/\/+$/, '')}/v1/apps/${encodeURIComponent(this.s.app)}/outcomes`;
    while (this.events.length) {
      const batch = this.events.splice(0, BATCH);
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.s.timeoutMs);
      try {
        const res = await this.s.fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.s.apiKey}`,
            'Content-Type': 'application/json',
            ...(typeof (globalThis as { document?: unknown }).document === 'undefined'
              ? { 'User-Agent': this.s.userAgent }
              : {}),
          },
          body: JSON.stringify(batch),
          signal: ctl.signal,
        });
        await res.body?.cancel().catch(() => undefined);
        if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
        if (res.status >= 400) {
          // A client error will not get better by retrying: drop the batch.
          this.dropped += batch.length;
          this.s.log('warn', `outcome report rejected: HTTP ${res.status} (${batch.length} events dropped)`);
        }
      } catch (e) {
        // Put the batch back for the next flush (bounded) and stop for now.
        this.events.unshift(...batch);
        if (this.events.length > this.s.maxBuffer) {
          const over = this.events.length - this.s.maxBuffer;
          this.events.splice(0, over);
          this.dropped += over;
        }
        this.s.log('debug', `outcome report failed, will retry: ${describeError(e)}`);
        this.schedule();
        return;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
