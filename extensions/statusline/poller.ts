import type { QuotaState } from "./types.ts";
import { QuotaError } from "./usage.ts";

const POLL_MS = 60_000;
/** Unsupported or signed-out accounts are rechecked slowly, so a later /login is picked up. */
const UNAVAILABLE_POLL_MS = 5 * 60_000;
const TIMEOUT_MS = 10_000;
const MAX_TIMER_MS = 2_147_483_647;

export type QuotaLoader = (signal: AbortSignal) => Promise<QuotaState>;

export interface PollerOptions {
  intervalMs: number;
  unavailableMs: number;
  timeoutMs: number;
}

/** One active request; no disk cache, streaming hooks, or provider credentials in state. */
export class QuotaPoller {
  state: QuotaState = { status: "loading" };
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private stopped = true;
  private generation = 0;
  private pending?: Promise<void>;
  private nextAllowedAt = 0;
  private readonly options: PollerOptions;

  constructor(
    private readonly load: QuotaLoader,
    private readonly changed: () => void,
    options: Partial<PollerOptions> = {},
  ) {
    this.options = { intervalMs: POLL_MS, unavailableMs: UNAVAILABLE_POLL_MS, timeoutMs: TIMEOUT_MS, ...options };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    if (Date.now() < this.nextAllowedAt) return Promise.resolve();
    clearTimeout(this.timer);
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.pending = this.run(controller, generation).finally(() => {
      if (generation === this.generation) this.pending = undefined;
    });
    return this.pending;
  }

  private async run(controller: AbortController, generation: number): Promise<void> {
    let delay = this.options.intervalMs;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // Race the whole operation, including Pi's auth resolution (which has no signal parameter).
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
      timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
      timeout.unref();
    });
    try {
      const { pollMs, ...next } = await Promise.race([this.load(controller.signal), cancelled]);
      if (!this.stopped && generation === this.generation) {
        this.state = next;
        this.nextAllowedAt = 0;
        delay = pollMs ?? (next.status === "unavailable" ? this.options.unavailableMs : this.options.intervalMs);
      }
    } catch (error) {
      if (!this.stopped && generation === this.generation) {
        const known = error instanceof QuotaError ? error : undefined;
        this.state = {
          ...this.state,
          status: "error",
          reason: known?.message ?? "Quota request failed or timed out; /statusline refresh to retry",
        };
        const cooldown = known?.retryAfterMs ?? 0;
        delay = Math.max(known?.pollMs ?? this.options.intervalMs, cooldown);
        this.nextAllowedAt = cooldown > 0 ? Date.now() + cooldown : 0;
      }
    } finally {
      clearTimeout(timeout);
      if (!this.stopped && generation === this.generation) {
        this.controller = undefined;
        this.changed();
        this.timer = setTimeout(() => void this.refresh(), Math.min(delay, MAX_TIMER_MS));
        this.timer.unref();
      }
    }
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    clearTimeout(this.timer);
    this.controller?.abort();
    this.controller = undefined;
    this.pending = undefined;
  }
}
