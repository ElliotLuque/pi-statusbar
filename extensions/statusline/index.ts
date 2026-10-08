import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchQuota, QuotaPoller } from "./quota.ts";
import { renderFooter } from "./render.ts";
import type { IconMode } from "./types.ts";

interface Preferences { enabled: boolean; icons: IconMode }
const defaults: Preferences = { enabled: true, icons: "nerd" };
const iconModes = ["nerd", "unicode", "ascii"] as const;
function isIconMode(value: unknown): value is IconMode {
  return iconModes.includes(value as IconMode);
}

async function readPreferences(path: string): Promise<Preferences> {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return {
      enabled: typeof value?.enabled === "boolean" ? value.enabled : defaults.enabled,
      icons: isIconMode(value?.icons) ? value.icons : defaults.icons,
    };
  } catch {
    return { ...defaults };
  }
}

async function savePreferences(path: string, preferences: Preferences): Promise<void> {
  await mkdir(getAgentDir(), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(preferences, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export default function terminalStatusline(pi: ExtensionAPI): void {
  let preferences = { ...defaults };
  let context: ExtensionContext | undefined;
  let poller: QuotaPoller | undefined;
  let requestRender: (() => void) | undefined;
  let attached = false;
  let disposeFooter: (() => void) | undefined;
  let generation = 0;
  let providerKey = "";
  const preferencePath = join(getAgentDir(), "terminal-statusline.json");

  function replacePoller(ctx: ExtensionContext): void {
    poller?.stop();
    providerKey = `${ctx.model?.provider ?? ""}:${ctx.model?.baseUrl ?? ""}`;
    poller = new QuotaPoller(
      signal => process.env.PI_OFFLINE === "1"
        ? Promise.resolve({ status: "unavailable", reason: "Quota polling disabled in offline mode" })
        : fetchQuota(ctx, signal),
      () => requestRender?.(),
    );
    poller.start();
    requestRender?.();
  }

  function attach(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") return;
    context = ctx;
    ctx.ui.setFooter((tui, theme, footerData) => {
      attached = true;
      requestRender = () => tui.requestRender();
      const unsubscribe = footerData.onBranchChange(requestRender);
      // Countdown text changes while idle. The palette remains live terminal ANSI colors.
      const timer = setInterval(() => tui.requestRender(), 30_000);
      timer.unref();
      replacePoller(ctx);
      let disposed = false;
      const dispose = () => {
        if (disposed) return;
        disposed = true;
        clearInterval(timer);
        unsubscribe();
        poller?.stop();
        requestRender = undefined;
        attached = false;
        if (disposeFooter === dispose) disposeFooter = undefined;
      };
      disposeFooter = dispose;
      return {
        invalidate() {},
        render(width) {
          const current = context ?? ctx;
          const effort = pi.getThinkingLevel();
          return renderFooter({
            cwd: current.cwd,
            home: homedir(),
            branch: footerData.getGitBranch(),
            model: current.model,
            effort,
            // Same color as Pi's input field border for this thinking level.
            effortColor: theme?.getThinkingBorderColor?.(effort),
            context: current.getContextUsage(),
            quota: poller?.state ?? { status: "loading" },
            statuses: [...footerData.getExtensionStatuses().values()],
            icons: preferences.icons,
            color: process.env.NO_COLOR === undefined && process.env.TERM !== "dumb",
            now: Date.now(),
          }, width);
        },
        dispose,
      };
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    const currentGeneration = ++generation;
    poller?.stop();
    context = ctx;
    if (ctx.mode !== "tui") return;
    preferences = await readPreferences(preferencePath);
    if (currentGeneration !== generation) return;
    if (preferences.enabled) attach(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    context = ctx;
    if (!attached) return;
    const nextKey = `${ctx.model?.provider ?? ""}:${ctx.model?.baseUrl ?? ""}`;
    if (nextKey !== providerKey) replacePoller(ctx);
    requestRender?.();
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    context = ctx;
    requestRender?.();
  });
  pi.on("session_tree", (_event, ctx) => { context = ctx; requestRender?.(); });
  pi.on("session_compact", (_event, ctx) => { context = ctx; requestRender?.(); });
  pi.on("agent_end", (_event, ctx) => { context = ctx; requestRender?.(); });

  pi.on("session_shutdown", () => {
    generation++;
    poller?.stop();
    disposeFooter?.();
    context = undefined;
    requestRender = undefined;
  });

  pi.registerCommand("statusline", {
    description: "Statusline: on, off, refresh, icons nerd|unicode|ascii, or quota details",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("The terminal statusline is only available in interactive Pi.", "info");
        return;
      }
      context = ctx;
      const parts = args.trim().split(/\s+/);
      const command = parts[0];
      if (!command) {
        const state = poller?.state;
        const updated = state?.updatedAt ? ` Last successful update: ${new Date(state.updatedAt).toLocaleTimeString()}.` : "";
        ctx.ui.notify(
          `Statusline ${preferences.enabled ? "on" : "off"}; ${preferences.icons} icons. Bars show percent used. Quota: ${state?.status ?? "not running"}.${updated}${state?.reason ? ` ${state.reason}.` : ""} Commands: on, off, refresh, icons nerd|unicode|ascii.`,
          "info",
        );
        return;
      }
      if (command === "refresh" && parts.length === 1) {
        if (!attached) { ctx.ui.notify("Enable the footer with /statusline on first.", "info"); return; }
        await poller?.refresh();
        const state = poller?.state;
        ctx.ui.notify(state?.reason ?? "Quota updated.", state?.status === "error" ? "warning" : "info");
        return;
      }
      if ((command === "on" || command === "off") && parts.length === 1) {
        preferences.enabled = command === "on";
        if (preferences.enabled && !attached) attach(ctx);
        if (!preferences.enabled && attached) ctx.ui.setFooter(undefined);
      } else if (command === "icons" && parts.length === 2 && isIconMode(parts[1])) {
        preferences.icons = parts[1];
        requestRender?.();
      } else {
        ctx.ui.notify("Use /statusline [on|off|refresh|icons nerd|unicode|ascii].", "warning");
        return;
      }
      try {
        await savePreferences(preferencePath, preferences);
      } catch {
        ctx.ui.notify("Statusline changed for this session, but preferences could not be saved.", "warning");
      }
    },
  });
}
