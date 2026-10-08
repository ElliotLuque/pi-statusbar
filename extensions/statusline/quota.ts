import { spawn } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Quota, QuotaState, UsageWindow } from "./types.ts";

const FIVE_HOURS = 5 * 60 * 60;
const WEEK = 7 * 24 * 60 * 60;
const POLL_MS = 60_000;
const TIMEOUT_MS = 10_000;

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function percent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : undefined;
}

function window(value: unknown, provider: "openai" | "anthropic"): UsageWindow | undefined {
  const data = record(value);
  if (!data) return undefined;
  const usedPercent = percent(provider === "openai" ? data.used_percent : data.utilization);
  if (usedPercent === undefined) return undefined;
  const reset = provider === "openai"
    ? typeof data.reset_at === "number" ? data.reset_at * 1000 : NaN
    : typeof data.resets_at === "string" ? Date.parse(data.resets_at) : NaN;
  return { usedPercent, ...(Number.isFinite(reset) && reset > 0 ? { resetsAt: reset } : {}) };
}

export function parseOpenAIQuota(value: unknown): Quota {
  const rateLimit = record(record(value)?.rate_limit);
  const quota: Quota = {};
  for (const name of ["primary_window", "secondary_window"]) {
    const data = record(rateLimit?.[name]);
    // Plans can swap windows or omit a weekly allowance. Never relabel a daily limit as 5h.
    if (data?.limit_window_seconds === FIVE_HOURS) quota.fiveHour = window(data, "openai");
    if (data?.limit_window_seconds === WEEK) quota.weekly = window(data, "openai");
  }
  return quota;
}

/** Codex app-server `account/rateLimits/read` result: windows in minutes, resets in epoch seconds. */
export function parseCodexAppServerQuota(value: unknown): Quota {
  const snapshot = record(record(value)?.rateLimits);
  const quota: Quota = {};
  for (const name of ["primary", "secondary"]) {
    const data = record(snapshot?.[name]);
    const usedPercent = percent(data?.usedPercent);
    if (!data || usedPercent === undefined) continue;
    const resetsAt = typeof data.resetsAt === "number" && data.resetsAt > 0 ? data.resetsAt * 1000 : undefined;
    const window = { usedPercent, ...(resetsAt ? { resetsAt } : {}) };
    if (data.windowDurationMins === FIVE_HOURS / 60) quota.fiveHour = window;
    if (data.windowDurationMins === WEEK / 60) quota.weekly = window;
  }
  return quota;
}

type Spawner = typeof spawn;

/**
 * Pi's "Sign in with ChatGPT" token is scoped to the inference API: ChatGPT's usage endpoint
 * rejects it and responses carry no rate-limit headers. Ask the Codex CLI instead, over its
 * documented app-server protocol. Codex owns and refreshes its own login; we never read it.
 */
export function fetchCodexAppServerQuota(signal: AbortSignal, spawner: Spawner = spawn): Promise<QuotaState> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawner("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      child.kill();
      fn();
    };
    const onAbort = () => finish(() => reject(new Error("Cancelled")));
    signal.addEventListener("abort", onAbort, { once: true });
    const send = (message: object) => child.stdin?.write(JSON.stringify(message) + "\n");
    child.on("error", (error: NodeJS.ErrnoException) => finish(() => error.code === "ENOENT"
      ? resolve({ status: "unavailable", reason: "ChatGPT sign-in quota needs the Codex CLI (install it and run codex login)" })
      : reject(new QuotaError("Could not start codex app-server"))));
    child.on("exit", () => finish(() => reject(new QuotaError("codex app-server exited before reporting usage"))));
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 1_000_000) return finish(() => reject(new QuotaError("codex app-server response too large")));
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message: Record<string, unknown> | undefined;
        try { message = record(JSON.parse(line)); } catch { continue; }
        if (message?.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (message?.id === 2) {
          const error = record(message.error);
          if (error) {
            const text = typeof error.message === "string" ? error.message : "";
            // Do not surface the raw message: it can echo backend bodies.
            return finish(() => reject(new QuotaError(/401|unauthori[sz]ed|sign(ing)? in|refresh/i.test(text)
              ? "Codex login expired or missing; run codex login"
              : "Codex could not read usage")));
          }
          const quota = parseCodexAppServerQuota(message.result);
          return finish(() => resolve(quota.fiveHour || quota.weekly
            ? { status: "ready", quota, updatedAt: Date.now() }
            : { status: "unavailable", reason: "Codex reported no five-hour or weekly windows" }));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "pi-terminal-statusline", version: "0.1.0" } } });
  });
}

export function parseAnthropicQuota(value: unknown): Quota {
  const data = record(value);
  return { fiveHour: window(data?.five_hour, "anthropic"), weekly: window(data?.seven_day, "anthropic") };
}

function accountId(token: string): string | undefined {
  try {
    const claims = record(JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")));
    const id = record(claims?.["https://api.openai.com/auth"])?.chatgpt_account_id;
    return typeof id === "string" && /^[\w-]+$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function officialOrigin(url: string | undefined, provider: string): boolean {
  if (!url) return true;
  try {
    const origin = new URL(url).origin;
    return provider === "anthropic"
      ? origin === "https://api.anthropic.com"
      : origin === "https://chatgpt.com" || origin === "https://api.openai.com";
  } catch {
    return false;
  }
}

export class QuotaError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

function retryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

// Pi owns authentication and token refresh. Do not open auth.json, reuse refresh tokens,
// execute external credential commands ourselves, or forward credentials to custom hosts.
export async function fetchQuota(
  ctx: ExtensionContext,
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
  spawner: Spawner = spawn,
): Promise<QuotaState> {
  const model = ctx.model;
  // Pi's `openai` ChatGPT sign-in talks to api.openai.com with a direct-use token.
  if (model?.provider === "openai" && officialOrigin(model.baseUrl, "openai") && ctx.modelRegistry.isUsingOAuth(model)) {
    return fetchCodexAppServerQuota(signal, spawner);
  }
  if (!model || !["openai", "openai-codex", "anthropic"].includes(model.provider)) {
    return { status: "unavailable", reason: "Provider does not expose subscription quotas" };
  }
  if (!officialOrigin(model.baseUrl, model.provider) || !ctx.modelRegistry.isUsingOAuth(model)) {
    return { status: "unavailable", reason: "Quota requires a direct provider subscription login" };
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  signal.throwIfAborted();
  if (!auth.ok || !officialOrigin(auth.baseUrl, model.provider)) {
    return { status: "unavailable", reason: "Subscription authentication unavailable" };
  }
  const providedHeaders = new Headers();
  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (typeof value === "string") providedHeaders.set(key, value);
  }
  const token = auth.apiKey || providedHeaders.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return { status: "unavailable", reason: "Subscription access token unavailable" };
  const headers = new Headers({ Authorization: `Bearer ${token}`, Accept: "application/json" });
  let url: string;
  if (model.provider === "anthropic") {
    url = "https://api.anthropic.com/api/oauth/usage";
    headers.set("anthropic-beta", "oauth-2025-04-20");
    headers.set("anthropic-version", "2023-06-01");
  } else {
    url = "https://chatgpt.com/backend-api/wham/usage";
    const id = providedHeaders.get("chatgpt-account-id") || accountId(token);
    if (!id) return { status: "unavailable", reason: "ChatGPT account identity unavailable" };
    headers.set("ChatGPT-Account-Id", id);
  }
  const response = await fetcher(url, { headers, signal, redirect: "error" });
  if (!response.ok) {
    const reason = response.status === 401 || response.status === 403
      ? "Quota access denied; try /login or check subscription permissions"
      : response.status === 429 ? "Quota service rate limited" : `Quota service returned HTTP ${response.status}`;
    // Never include the response body or a raw authentication/network error in diagnostics.
    throw new QuotaError(reason, retryAfter(response.headers.get("retry-after"), Date.now()));
  }
  const body: unknown = await response.json();
  const quota = model.provider === "anthropic" ? parseAnthropicQuota(body) : parseOpenAIQuota(body);
  if (!quota.fiveHour && !quota.weekly) {
    return { status: "unavailable", reason: "Provider did not return five-hour or weekly quota windows" };
  }
  return { status: "ready", quota, updatedAt: Date.now() };
}

export type QuotaLoader = (signal: AbortSignal) => Promise<QuotaState>;

/** One active request; no disk cache, streaming hooks, or provider credentials in state. */
export class QuotaPoller {
  state: QuotaState = { status: "loading" };
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private stopped = true;
  private generation = 0;
  private pending?: Promise<void>;
  private nextAllowedAt = 0;

  constructor(
    private readonly load: QuotaLoader,
    private readonly changed: () => void,
    private readonly options = { intervalMs: POLL_MS, timeoutMs: TIMEOUT_MS },
  ) {}

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
      const next = await Promise.race([this.load(controller.signal), cancelled]);
      if (!this.stopped && generation === this.generation) this.state = next;
    } catch (error) {
      if (!this.stopped && generation === this.generation) {
        this.state = {
          ...this.state,
          status: "error",
          reason: error instanceof QuotaError ? error.message : "Quota request failed or timed out; /statusline refresh to retry",
        };
        const cooldown = error instanceof QuotaError ? error.retryAfterMs ?? 0 : 0;
        delay = Math.max(delay, cooldown);
        this.nextAllowedAt = cooldown > 0 ? Date.now() + delay : 0;
      }
    } finally {
      clearTimeout(timeout);
      if (!this.stopped && generation === this.generation) {
        this.controller = undefined;
        this.changed();
        // Unsupported providers need no network polling; /statusline refresh can retry after login.
        if (this.state.status !== "unavailable") {
          this.timer = setTimeout(() => void this.refresh(), Math.min(delay, 2_147_483_647));
          this.timer.unref();
        }
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
