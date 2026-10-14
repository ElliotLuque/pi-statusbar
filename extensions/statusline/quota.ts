import { spawn } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type ExecutableFinder, fetchCodexAppServerQuota, findExecutable, type Spawner } from "./codex.ts";
import type { Quota, QuotaState } from "./types.ts";
import { QuotaError, record, usageWindow, windowName } from "./usage.ts";

export function parseOpenAIQuota(value: unknown): Quota {
  const rateLimit = record(record(value)?.rate_limit);
  const quota: Quota = {};
  for (const name of ["primary_window", "secondary_window"]) {
    const data = record(rateLimit?.[name]);
    const slot = typeof data?.limit_window_seconds === "number" ? windowName(data.limit_window_seconds) : undefined;
    if (!data || !slot) continue;
    const window = usageWindow(data.used_percent, typeof data.reset_at === "number" ? data.reset_at * 1000 : NaN);
    if (window) quota[slot] = window;
  }
  return quota;
}

export function parseAnthropicQuota(value: unknown): Quota {
  const data = record(value);
  const read = (value: unknown) => {
    const window = record(value);
    return window && usageWindow(window.utilization, typeof window.resets_at === "string" ? Date.parse(window.resets_at) : NaN);
  };
  return { fiveHour: read(data?.five_hour), weekly: read(data?.seven_day) };
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

/** Subscription usage endpoints reachable with a Pi-resolved OAuth token, keyed by Pi provider id. */
interface HttpUsageEndpoint {
  url: string;
  /** Origins where this provider's credentials may legitimately be used. */
  origins: readonly string[];
  /** Extra request headers, or a reason string when the request cannot be made. */
  headers(token: string, provided: Headers): Record<string, string> | string;
  parse(body: unknown): Quota;
}

const chatgpt: HttpUsageEndpoint = {
  url: "https://chatgpt.com/backend-api/wham/usage",
  origins: ["https://chatgpt.com", "https://api.openai.com"],
  headers(token, provided) {
    const id = provided.get("chatgpt-account-id") || accountId(token);
    return id ? { "ChatGPT-Account-Id": id } : "ChatGPT account identity unavailable";
  },
  parse: parseOpenAIQuota,
};

const endpoints: Record<string, HttpUsageEndpoint> = {
  "openai": chatgpt,
  "openai-codex": chatgpt,
  "anthropic": {
    url: "https://api.anthropic.com/api/oauth/usage",
    origins: ["https://api.anthropic.com"],
    headers: () => ({ "anthropic-beta": "oauth-2025-04-20", "anthropic-version": "2023-06-01" }),
    parse: parseAnthropicQuota,
  },
};

function officialOrigin(url: string | undefined, endpoint: HttpUsageEndpoint): boolean {
  if (!url) return true;
  try {
    return endpoint.origins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

function retryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? delay : undefined;
}

/** Identifies which quota account a model draws from; the poller restarts when it changes. */
export function quotaKey(model: { provider?: string; baseUrl?: string } | undefined): string {
  return `${model?.provider ?? ""}:${model?.baseUrl ?? ""}`;
}

export interface QuotaDependencies {
  fetch?: typeof fetch;
  spawn?: Spawner;
  findExecutable?: ExecutableFinder;
}

// Pi owns authentication and token refresh. Do not open auth.json, reuse refresh tokens,
// execute external credential commands ourselves, or forward credentials to custom hosts.
export async function fetchQuota(
  ctx: ExtensionContext,
  signal: AbortSignal,
  dependencies: QuotaDependencies = {},
): Promise<QuotaState> {
  const model = ctx.model;
  const endpoint = model ? endpoints[model.provider] : undefined;
  if (!model || !endpoint) {
    return { status: "unavailable", reason: "Provider does not expose subscription quotas" };
  }
  if (!officialOrigin(model.baseUrl, endpoint) || !ctx.modelRegistry.isUsingOAuth(model)) {
    return { status: "unavailable", reason: "Quota requires a direct provider subscription login" };
  }
  // Pi's `openai` ChatGPT sign-in token cannot read usage; Codex reads it with its own login.
  if (model.provider === "openai") {
    return fetchCodexAppServerQuota(signal, dependencies.spawn ?? spawn, dependencies.findExecutable ?? findExecutable);
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  signal.throwIfAborted();
  if (!auth.ok || !officialOrigin(auth.baseUrl, endpoint)) {
    return { status: "unavailable", reason: "Subscription authentication unavailable" };
  }
  const provided = new Headers();
  for (const [key, value] of Object.entries(auth.headers ?? {})) {
    if (typeof value === "string") provided.set(key, value);
  }
  const token = auth.apiKey || provided.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return { status: "unavailable", reason: "Subscription access token unavailable" };
  const extra = endpoint.headers(token, provided);
  if (typeof extra === "string") return { status: "unavailable", reason: extra };
  const headers = new Headers({ ...extra, Authorization: `Bearer ${token}`, Accept: "application/json" });
  const response = await (dependencies.fetch ?? fetch)(endpoint.url, { headers, signal, redirect: "error" });
  if (!response.ok) {
    const reason = response.status === 401 || response.status === 403
      ? "Quota access denied; try /login or check subscription permissions"
      : response.status === 429 ? "Quota service rate limited" : `Quota service returned HTTP ${response.status}`;
    // Never include the response body or a raw authentication/network error in diagnostics.
    throw new QuotaError(reason, { retryAfterMs: retryAfter(response.headers.get("retry-after"), Date.now()) });
  }
  const quota = endpoint.parse(await response.json());
  if (!quota.fiveHour && !quota.weekly) {
    return { status: "unavailable", reason: "Provider did not return five-hour or weekly quota windows" };
  }
  return { status: "ready", quota, updatedAt: Date.now() };
}
