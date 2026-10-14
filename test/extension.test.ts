import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import extension from "../extensions/statusline/index.ts";

type Component = { render(width: number): string[]; dispose(): void };
type Handler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function harness(mode: "tui" | "rpc" | "json" | "print" = "tui") {
  const directory = await mkdtemp(join(tmpdir(), "pi-statusline-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  let component: Component | undefined;
  let subscriptions = 0;
  let renders = 0;
  let effort = "high";
  const notices: string[] = [];
  const pi = {
    on: (event: string, handler: Handler) => { handlers.set(event, handler); },
    registerCommand: (name: string, value: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { commands.set(name, value.handler); },
    getThinkingLevel: () => effort,
  } as unknown as ExtensionAPI;
  const ctx = {
    mode, hasUI: mode === "tui" || mode === "rpc", cwd: "/projects/repo",
    model: { id: "local-model", provider: "ollama", reasoning: true },
    modelRegistry: { isUsingOAuth: () => false },
    getContextUsage: () => ({ tokens: 10_000, contextWindow: 100_000, percent: 10 }),
    ui: {
      notify: (message: string) => notices.push(message),
      setFooter: (factory: Function | undefined) => {
        component?.dispose();
        component = factory?.({ requestRender: () => renders++ }, {}, {
          getGitBranch: () => "main",
          getExtensionStatuses: () => new Map([["other", "review ready"]]),
          onBranchChange: () => { subscriptions++; return () => subscriptions--; },
        });
      },
    },
  } as unknown as ExtensionContext;
  extension(pi);
  return {
    ctx, directory, notices,
    get component() { return component; },
    get subscriptions() { return subscriptions; },
    get renders() { return renders; },
    setEffort(value: string) { effort = value; },
    disposeComponent() { component?.dispose(); },
    event: (name: string) => handlers.get(name)?.({}, ctx),
    command: (args: string, name = "statusbar") => commands.get(name)!(args, ctx),
    async cleanup() {
      await handlers.get("session_shutdown")?.({}, ctx);
      component?.dispose();
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    },
  };
}

for (const mode of ["rpc", "json", "print"] as const) {
  test(`${mode}: no custom footer, background polling, or preferences written`, async () => {
    const h = await harness(mode);
    try {
      await h.event("session_start");
      assert.equal(h.component, undefined);
      assert.equal(h.subscriptions, 0);
      await h.command("on");
      assert.equal(h.component, undefined);
      await assert.rejects(readFile(join(h.directory, "statusbar.json")));
    } finally { await h.cleanup(); }
  });
}

test("interactive footer starts automatically; effort, provider, statuses and context update", async () => {
  const h = await harness();
  try {
    assert.equal(h.component, undefined);
    await h.event("session_start");
    await flush();
    assert.equal(h.subscriptions, 1);
    let lines = h.component!.render(140).map(stripTerminalSequences);
    assert.match(lines[0], /repo.*local-model.*high/);
    // A local model has no subscription usage, so no meters are shown.
    assert.match(lines[1], /main · ctx 10% · review ready$/);
    h.setEffort("low");
    await h.event("thinking_level_select");
    lines = h.component!.render(100).map(stripTerminalSequences);
    assert.match(lines[0], /low$/);
    h.ctx.model = { ...h.ctx.model!, id: "gpt-test", provider: "openai" };
    await h.event("model_select");
    await flush();
    assert.match(stripTerminalSequences(h.component!.render(100)[0]), /\uec81 gpt-test/);
    assert.ok(h.renders > 0);
    await h.event("session_shutdown");
    assert.equal(h.subscriptions, 0);
    h.disposeComponent();
    assert.equal(h.subscriptions, 0);
  } finally { await h.cleanup(); }
});

test("on/off and icon preferences survive reload without touching Pi settings", async () => {
  const h = await harness();
  try {
    await h.event("session_start");
    await h.command("icons unicode"); await h.command("icons nerd");
    let preferences = JSON.parse(await readFile(join(h.directory, "statusbar.json"), "utf8"));
    assert.deepEqual(preferences, { enabled: true, icons: "nerd" });
    await h.command("off");
    assert.equal(h.component, undefined);
    assert.equal(h.subscriptions, 0);
    await h.event("session_shutdown");
    await h.event("session_start");
    assert.equal(h.component, undefined);
    await h.command("on");
    assert.equal(h.subscriptions, 1);
    preferences = JSON.parse(await readFile(join(h.directory, "statusbar.json"), "utf8"));
    assert.deepEqual(preferences, { enabled: true, icons: "nerd" });
    await assert.rejects(readFile(join(h.directory, "settings.json")));
    await h.command("icons invalid");
    assert.match(h.notices.at(-1)!, /Use \/statusbar/);
  } finally { await h.cleanup(); }
});

test("/statusline still works, and settings saved by pi-terminal-statusline carry over", async () => {
  const h = await harness();
  try {
    await writeFile(join(h.directory, "terminal-statusline.json"), JSON.stringify({ enabled: false, icons: "ascii" }));
    await h.event("session_start");
    assert.equal(h.component, undefined); // The old "off" setting was honoured.
    await h.command("on", "statusline");
    const component = h.component as Component | undefined;
    assert.ok(component);
    assert.match(stripTerminalSequences(component.render(120)[0]), /^dir /); // The old ASCII icons setting was honoured.
    assert.deepEqual(JSON.parse(await readFile(join(h.directory, "statusbar.json"), "utf8")), { enabled: true, icons: "ascii" });
  } finally { await h.cleanup(); }
});
