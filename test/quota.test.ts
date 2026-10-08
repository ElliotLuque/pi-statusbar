import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchQuota, parseAnthropicQuota, parseOpenAIQuota, QuotaError } from "../extensions/statusline/quota.ts";

const fiveHour = { used_percent: 24, limit_window_seconds: 18_000, reset_at: 1_800_000_000 };
const weekly = { used_percent: 51, limit_window_seconds: 604_800, reset_at: 1_800_600_000 };
const openaiResponse = { rate_limit: { primary_window: fiveHour, secondary_window: weekly } };
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;

function context(provider = "openai", oauth = true, baseUrl?: string, auth: object = { ok: true, apiKey: token }): ExtensionContext {
  return { model: { id: "test", provider, baseUrl }, modelRegistry: { isUsingOAuth: () => oauth, getApiKeyAndHeaders: async () => auth } } as unknown as ExtensionContext;
}

function fetcher(response: unknown, inspect?: (url: string, options: RequestInit) => void): typeof fetch {
  return (async (url, options) => {
    inspect?.(String(url), options!);
    return Response.json(response);
  }) as typeof fetch;
}

test("OpenAI quota windows are classified by duration, not primary/secondary order", () => {
  const parsed = parseOpenAIQuota(openaiResponse);
  assert.equal(parsed.fiveHour?.usedPercent, 24);
  assert.equal(parsed.weekly?.usedPercent, 51);
  assert.equal(parsed.fiveHour?.resetsAt, 1_800_000_000_000);
  assert.deepEqual(parseOpenAIQuota({ rate_limit: { primary_window: weekly, secondary_window: fiveHour } }), parsed);
  assert.deepEqual(parseOpenAIQuota({ rate_limit: { primary_window: { ...fiveHour, limit_window_seconds: 86_400 } } }), {});
});

test("missing/invalid fields remain unknown while known percentages are bounded", () => {
  for (const value of [undefined, null, [], 123, "x", {}]) assert.deepEqual(parseOpenAIQuota(value), {});
  assert.equal(parseOpenAIQuota({ rate_limit: { primary_window: { ...fiveHour, used_percent: "20" } } }).fiveHour, undefined);
  assert.equal(parseOpenAIQuota({ rate_limit: { primary_window: { ...fiveHour, used_percent: NaN } } }).fiveHour, undefined);
  assert.equal(parseOpenAIQuota({ rate_limit: { primary_window: { ...fiveHour, used_percent: 130 } } }).fiveHour?.usedPercent, 100);
  assert.equal(parseOpenAIQuota({ rate_limit: { primary_window: { ...fiveHour, used_percent: -1 } } }).fiveHour?.usedPercent, 0);
  assert.equal(parseOpenAIQuota({ rate_limit: { primary_window: { ...fiveHour, reset_at: "x" } } }).fiveHour?.resetsAt, undefined);
});

test("Claude usage uses account seven_day, not a model-specific seven_day field", () => {
  const parsed = parseAnthropicQuota({ five_hour: { utilization: 0, resets_at: "2026-10-08T12:00:00Z" }, seven_day: { utilization: 65, resets_at: "bad" }, seven_day_sonnet: { utilization: 99 } });
  assert.equal(parsed.fiveHour?.usedPercent, 0);
  assert.equal(parsed.fiveHour?.resetsAt, Date.parse("2026-10-08T12:00:00Z"));
  assert.equal(parsed.weekly?.usedPercent, 65);
  assert.equal(parsed.weekly?.resetsAt, undefined);
  assert.equal(parseAnthropicQuota({ seven_day_sonnet: { utilization: 99 } }).weekly, undefined);
});

for (const provider of ["openai-codex"]) {
  test(`${provider}: authenticated request only to fixed usage endpoint, no redirects`, async () => {
    const state = await fetchQuota(context(provider), new AbortController().signal, fetcher(openaiResponse, (url, options) => {
      assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
      const headers = new Headers(options.headers);
      assert.equal(headers.get("authorization"), `Bearer ${token}`);
      assert.equal(headers.get("chatgpt-account-id"), "test-account");
      assert.equal(options.redirect, "error");
      assert.equal(options.method, undefined); // GET; never an inference request.
    }));
    assert.equal(state.status, "ready");
    assert.equal(state.quota?.fiveHour?.usedPercent, 24);
    assert.ok(!JSON.stringify(state).includes(token));
  });
}

test("account id header is preferred to decoded JWT and unrelated auth headers are not forwarded", async () => {
  const ctx = context("openai-codex", true, undefined, { ok: true, apiKey: "access", headers: { "ChatGPT-Account-Id": "workspace", "X-Secret": "private" } });
  await fetchQuota(ctx, new AbortController().signal, fetcher(openaiResponse, (_url, options) => {
    const headers = new Headers(options.headers);
    assert.equal(headers.get("chatgpt-account-id"), "workspace");
    assert.equal(headers.get("x-secret"), null);
  }));
});

test("Claude quota uses Pi-resolved OAuth bearer token and beta header", async () => {
  await fetchQuota(context("anthropic", true, "https://api.anthropic.com", { ok: true, apiKey: "claude-token" }), new AbortController().signal, fetcher({ five_hour: { utilization: 33 } }, (url, options) => {
    assert.equal(url, "https://api.anthropic.com/api/oauth/usage");
    const headers = new Headers(options.headers);
    assert.equal(headers.get("authorization"), "Bearer claude-token");
    assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20");
  }));
});

test("no requests for API keys, unsupported providers, or custom proxy credentials", async () => {
  const neverFetch = (async () => { assert.fail("credentials must not be sent"); }) as typeof fetch;
  for (const ctx of [context("ollama"), context("openai", false), context("anthropic", true, "https://proxy.example"), context("openai", true, "http://chatgpt.com"), context("openai-codex", true, undefined, { ok: true, apiKey: token, baseUrl: "https://proxy.example" })]) {
    assert.equal((await fetchQuota(ctx, new AbortController().signal, neverFetch)).status, "unavailable");
  }
});

test("missing identity and auth failures are unavailable with no secret details", async () => {
  for (const auth of [{ ok: false, error: "secret-private-error" }, { ok: true }, { ok: true, apiKey: "not-a-jwt" }]) {
    const state = await fetchQuota(context("openai-codex", true, undefined, auth), new AbortController().signal);
    assert.equal(state.status, "unavailable");
    assert.ok(!JSON.stringify(state).includes("secret-private-error"));
  }
});

test("empty successful payload is not treated as zero quota", async () => {
  const state = await fetchQuota(context("openai-codex"), new AbortController().signal, fetcher({}));
  assert.equal(state.status, "unavailable");
  assert.equal(state.quota, undefined);
});

test("HTTP failures are sanitized and rate limits retain Retry-After", async () => {
  for (const status of [401, 403, 429, 500]) {
    await assert.rejects(() => fetchQuota(context("openai-codex"), new AbortController().signal, (async () => new Response("private-response", { status, headers: { "retry-after": "120" } })) as typeof fetch), (error: unknown) => {
      assert.ok(error instanceof QuotaError);
      assert.ok(!error.message.includes("private-response"));
      assert.equal(error.retryAfterMs, 120_000);
      if (status === 401 || status === 403) assert.match(error.message, /access denied/);
      return true;
    });
  }
});

test("shutdown during auth resolution prevents a network request", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => fetchQuota(context("openai-codex"), controller.signal, fetcher({}, () => assert.fail("aborted"))), /abort/i);
});
