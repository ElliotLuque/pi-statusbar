import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { QuotaError, QuotaPoller } from "../extensions/statusline/quota.ts";
import type { QuotaState } from "../extensions/statusline/types.ts";

const ready: QuotaState = { status: "ready", quota: { fiveHour: { usedPercent: 37 } }, updatedAt: 1000 };
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test("requests are deduplicated and polling starts only explicitly", async () => {
  let calls = 0;
  let finish!: (state: QuotaState) => void;
  const poller = new QuotaPoller(async () => { calls++; return new Promise(resolve => { finish = resolve; }); }, () => {}, { intervalMs: 10_000, timeoutMs: 1000 });
  assert.equal(calls, 0);
  await poller.refresh();
  assert.equal(calls, 0);
  poller.start();
  assert.equal(calls, 1);
  const a = poller.refresh();
  const b = poller.refresh();
  assert.equal(a, b);
  finish(ready);
  await a;
  assert.deepEqual(poller.state, ready);
  assert.equal(calls, 1);
  poller.stop();
});

test("failed refresh retains the last successful data, labels it error, and hides raw errors", async () => {
  let fail = false;
  const poller = new QuotaPoller(async () => { if (fail) throw new Error("private-token-secret"); return ready; }, () => {});
  poller.start();
  await flush();
  fail = true;
  await poller.refresh();
  assert.equal(poller.state.status, "error");
  assert.deepEqual(poller.state.quota, ready.quota);
  assert.equal(poller.state.updatedAt, 1000);
  assert.ok(!JSON.stringify(poller.state).includes("private-token-secret"));
  poller.stop();
});

test("rate limited requests cannot be hammered with manual refresh", async () => {
  let calls = 0;
  const poller = new QuotaPoller(async () => { calls++; throw new QuotaError("rate limited", 1000); }, () => {}, { intervalMs: 100, timeoutMs: 100 });
  poller.start();
  await flush();
  await poller.refresh();
  await poller.refresh();
  assert.equal(calls, 1);
  poller.stop();
});

test("timeout bounds the entire load, including hung authentication", async () => {
  let signal!: AbortSignal;
  const poller = new QuotaPoller(async current => { signal = current; return new Promise(() => {}); }, () => {}, { intervalMs: 10_000, timeoutMs: 10 });
  poller.start();
  await wait(30);
  assert.equal(poller.state.status, "error");
  assert.equal(signal.aborted, true);
  poller.stop();
});

test("stop cancels requests, suppresses late updates, and is idempotent", async () => {
  let changes = 0;
  let signal!: AbortSignal;
  let finish!: (state: QuotaState) => void;
  const poller = new QuotaPoller(async current => { signal = current; return new Promise(resolve => { finish = resolve; }); }, () => changes++);
  poller.start();
  poller.stop();
  poller.stop();
  assert.equal(signal.aborted, true);
  finish(ready);
  await flush();
  assert.equal(poller.state.status, "loading");
  assert.equal(changes, 0);
});

test("unsupported providers are not polled, but an explicit refresh may retry", async () => {
  let calls = 0;
  const poller = new QuotaPoller(async () => { calls++; return { status: "unavailable" }; }, () => {}, { intervalMs: 10, timeoutMs: 100 });
  poller.start();
  await wait(30);
  assert.equal(calls, 1);
  await poller.refresh();
  assert.equal(calls, 2);
  poller.stop();
});
