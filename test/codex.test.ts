import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchCodexAppServerQuota, fetchQuota, parseCodexAppServerQuota, QuotaError } from "../extensions/statusline/quota.ts";

const result = { rateLimits: {
  primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1_800_000_000 },
  secondary: { usedPercent: 51, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
} };

/** Fake `codex app-server`: answers initialize, then the rate-limit read. */
function fakeCodex(reply: (method: string) => object | undefined, calls: string[][] = []) {
  return ((command: string, args: string[]) => {
    calls.push([command, ...args]);
    const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill(): void; killed: boolean };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; };
    let buffer = "";
    child.stdin.on("data", chunk => {
      buffer += chunk;
      for (const line of buffer.split("\n").slice(0, -1)) {
        const message = JSON.parse(line);
        const answer = message.id !== undefined ? reply(message.method) : undefined;
        if (answer) child.stdout.write(JSON.stringify({ id: message.id, ...answer }) + "\n");
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    });
    return child;
  }) as never;
}

test("Codex windows are classified by duration and resets converted to milliseconds", () => {
  const quota = parseCodexAppServerQuota(result);
  assert.deepEqual(quota, { fiveHour: { usedPercent: 24, resetsAt: 1_800_000_000_000 }, weekly: { usedPercent: 51, resetsAt: 1_800_600_000_000 } });
  assert.deepEqual(parseCodexAppServerQuota({ rateLimits: { primary: { usedPercent: 5, windowDurationMins: 1440 } } }), {});
  assert.deepEqual(parseCodexAppServerQuota(null), {});
});

test("openai ChatGPT sign-in reads usage through codex app-server, never with Pi's token", async () => {
  const calls: string[][] = [];
  const ctx = { model: { id: "gpt-6.1-sol", provider: "openai", baseUrl: "https://api.openai.com/v1" }, modelRegistry: {
    isUsingOAuth: () => true,
    getApiKeyAndHeaders: async () => assert.fail("Pi credentials must not be used for Codex quota"),
  } } as unknown as ExtensionContext;
  const neverFetch = (async () => assert.fail("no HTTP request")) as typeof fetch;
  const state = await fetchQuota(ctx, new AbortController().signal, neverFetch,
    fakeCodex(method => method === "initialize" ? { result: {} } : method === "account/rateLimits/read" ? { result } : undefined, calls));
  assert.deepEqual(calls, [["codex", "app-server"]]);
  assert.equal(state.status, "ready");
  assert.equal(state.quota?.weekly?.usedPercent, 51);
});

test("expired Codex login gives an actionable, sanitized error", async () => {
  await assert.rejects(
    fetchCodexAppServerQuota(new AbortController().signal, fakeCodex(method => method === "initialize"
      ? { result: {} } : { error: { code: -32603, message: "GET wham/usage failed: 401 Unauthorized; body=secret-body" } })),
    (error: unknown) => error instanceof QuotaError && /codex login/.test(error.message) && !error.message.includes("secret-body"),
  );
});

test("missing Codex CLI is unavailable, not an error", async () => {
  const missing = (() => {
    const child = new EventEmitter() as EventEmitter & { kill(): void; stdin: PassThrough; stdout: PassThrough };
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
    setImmediate(() => child.emit("error", Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })));
    return child;
  }) as never;
  const state = await fetchCodexAppServerQuota(new AbortController().signal, missing);
  assert.equal(state.status, "unavailable");
  assert.match(state.reason!, /codex login/);
});

test("abort kills the app-server", async () => {
  let child: { killed: boolean } | undefined;
  const spawner = fakeCodex(() => undefined);
  const controller = new AbortController();
  const pending = fetchCodexAppServerQuota(controller.signal, ((...args: never[]) => (child = (spawner as Function)(...args))) as never);
  controller.abort();
  await assert.rejects(pending, /Cancelled/);
  assert.equal(child?.killed, true);
});
