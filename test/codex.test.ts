import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CODEX_POLL_MS, fetchCodexAppServerQuota, findExecutable, parseCodexAppServerQuota } from "../extensions/statusline/codex.ts";
import { fetchQuota } from "../extensions/statusline/quota.ts";
import { QuotaError } from "../extensions/statusline/usage.ts";

const installed = () => "/usr/bin/codex";

const result = { rateLimits: {
  primary: { usedPercent: 24, windowDurationMins: 300, resetsAt: 1_800_000_000 },
  secondary: { usedPercent: 51, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
} };

/** Fake `codex app-server`: answers initialize, then the rate-limit read. */
function fakeCodex(reply: (method: string) => object | undefined, calls: unknown[][] = []) {
  return ((command: string, args: string[], options: object) => {
    calls.push([command, ...args, options]);
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
  const calls: unknown[][] = [];
  const ctx = { model: { id: "gpt-6.1-sol", provider: "openai", baseUrl: "https://api.openai.com/v1" }, modelRegistry: {
    isUsingOAuth: () => true,
    getApiKeyAndHeaders: async () => assert.fail("Pi credentials must not be used for Codex quota"),
  } } as unknown as ExtensionContext;
  const neverFetch = (async () => assert.fail("no HTTP request")) as typeof fetch;
  const state = await fetchQuota(ctx, new AbortController().signal, {
    fetch: neverFetch, findExecutable: installed,
    spawn: fakeCodex(method => method === "initialize" ? { result: {} } : method === "account/rateLimits/read" ? { result } : undefined, calls),
  });
  assert.deepEqual(calls.map(call => call.slice(0, 2)), [["/usr/bin/codex", "app-server"]]);
  assert.equal(state.status, "ready");
  assert.equal(state.pollMs, CODEX_POLL_MS); // A process spawn, so polled less often than HTTP.
  assert.equal(state.quota?.weekly?.usedPercent, 51);
});

test("expired Codex login gives an actionable, sanitized error", async () => {
  await assert.rejects(
    fetchCodexAppServerQuota(new AbortController().signal, fakeCodex(method => method === "initialize"
      ? { result: {} } : { error: { code: -32603, message: "GET wham/usage failed: 401 Unauthorized; body=secret-body" } }), installed),
    // No retry-after: the user can run `codex login` and refresh immediately.
    (error: unknown) => error instanceof QuotaError && /codex login/.test(error.message) && !error.message.includes("secret-body")
      && error.retryAfterMs === undefined,
  );
});

test("missing Codex CLI is unavailable without spawning anything", async () => {
  const state = await fetchCodexAppServerQuota(new AbortController().signal, (() => assert.fail("must not spawn")) as never, () => undefined);
  assert.equal(state.status, "unavailable");
  assert.match(state.reason!, /codex login/);
});

test("a Codex CLI that vanishes after lookup (ENOENT) is unavailable, not an error", async () => {
  const missing = (() => {
    const child = new EventEmitter() as EventEmitter & { kill(): void; stdin: PassThrough; stdout: PassThrough };
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
    setImmediate(() => child.emit("error", Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })));
    return child;
  }) as never;
  const state = await fetchCodexAppServerQuota(new AbortController().signal, missing, installed);
  assert.equal(state.status, "unavailable");
  assert.match(state.reason!, /codex login/);
});

test("abort kills the app-server", async () => {
  let child: { killed: boolean } | undefined;
  const spawner = fakeCodex(() => undefined);
  const controller = new AbortController();
  const pending = fetchCodexAppServerQuota(controller.signal, ((...args: never[]) => (child = (spawner as Function)(...args))) as never, installed);
  controller.abort();
  await assert.rejects(pending, /Cancelled/);
  assert.equal(child?.killed, true);
});

test("Windows npm shims (codex.cmd) run through cmd.exe; real executables are spawned directly", async () => {
  const reply = (method: string) => method === "initialize" ? { result: {} } : { result };
  const shim: unknown[][] = [];
  await fetchCodexAppServerQuota(new AbortController().signal, fakeCodex(reply, shim), () => "C:\\Program Files\\nodejs\\codex.cmd");
  assert.match(String(shim[0][0]), /cmd(\.exe)?$/i);
  assert.deepEqual(shim[0].slice(1, 5), ["/d", "/s", "/c", '""C:\\Program Files\\nodejs\\codex.cmd" app-server"']);
  assert.equal((shim[0][5] as { windowsVerbatimArguments?: boolean }).windowsVerbatimArguments, true);
  const binary: unknown[][] = [];
  await fetchCodexAppServerQuota(new AbortController().signal, fakeCodex(reply, binary), () => "C:\\tools\\codex.exe");
  assert.deepEqual(binary[0].slice(0, 2), ["C:\\tools\\codex.exe", "app-server"]);
});

test("findExecutable searches PATH, honours PATHEXT on Windows, and skips non-executables on POSIX", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-statusline-path-"));
  try {
    const empty = join(directory, "empty");
    const bin = join(directory, "bin");
    await mkdir(empty);
    await mkdir(bin);
    assert.equal(findExecutable("codex", { PATH: [empty, bin].join(":") }, "linux"), undefined);
    await writeFile(join(bin, "codex"), "");
    if (process.platform !== "win32") {
      await chmod(join(bin, "codex"), 0o644);
      assert.equal(findExecutable("codex", { PATH: bin }, "linux"), undefined);
      await chmod(join(bin, "codex"), 0o755);
      assert.equal(findExecutable("codex", { PATH: [empty, bin].join(":") }, "linux"), join(bin, "codex"));
    }
    await writeFile(join(bin, "codex.cmd"), "");
    const found = findExecutable("codex", { Path: `${empty};${bin}`, PATHEXT: ".EXE;.CMD" }, "win32");
    if (process.platform === "win32") assert.match(found!, /codex\.cmd$/);
    else assert.equal(found, undefined); // win32 path joins are not resolvable on POSIX hosts.
    assert.equal(findExecutable("codex", {}, "linux"), undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
