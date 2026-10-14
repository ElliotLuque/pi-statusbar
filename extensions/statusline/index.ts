import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { QuotaPoller } from "./poller.ts";
import { defaultPreferences, isIconMode, readPreferences, savePreferences } from "./preferences.ts";
import { fetchQuota, quotaKey } from "./quota.ts";
import { renderFooter } from "./render.ts";

export default function statusbar(pi: ExtensionAPI): void {
  let preferences = { ...defaultPreferences };
  let context: ExtensionContext | undefined;
  let poller: QuotaPoller | undefined;
  let requestRender: (() => void) | undefined;
  let attached = false;
  let disposeFooter: (() => void) | undefined;
  let generation = 0;
  let providerKey = "";
  const preferencePath = join(getAgentDir(), "statusbar.json");
  // Settings saved by 0.1.0, published as pi-terminal-statusline.
  const legacyPreferencePaths = [join(getAgentDir(), "terminal-statusline.json")];

  function replacePoller(ctx: ExtensionContext): void {
    poller?.stop();
    providerKey = quotaKey(ctx.model);
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
    preferences = await readPreferences(preferencePath, legacyPreferencePaths);
    if (currentGeneration !== generation) return;
    if (preferences.enabled) attach(ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    context = ctx;
    if (!attached) return;
    if (quotaKey(ctx.model) !== providerKey) replacePoller(ctx);
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

  const statusbarCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
    description: "Status bar: on, off, refresh, icons nerd|unicode|ascii, or quota details",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("The status bar is only available in interactive Pi.", "info");
        return;
      }
      context = ctx;
      const parts = args.trim().split(/\s+/);
      const command = parts[0];
      if (!command) {
        const state = poller?.state;
        const updated = state?.updatedAt ? ` Last successful update: ${new Date(state.updatedAt).toLocaleTimeString()}.` : "";
        ctx.ui.notify(
          `Status bar ${preferences.enabled ? "on" : "off"}; ${preferences.icons} icons. Bars show percent used. Quota: ${state?.status ?? "not running"}.${updated}${state?.reason ? ` ${state.reason}.` : ""} Commands: on, off, refresh, icons nerd|unicode|ascii.`,
          "info",
        );
        return;
      }
      if (command === "refresh" && parts.length === 1) {
        if (!attached) { ctx.ui.notify("Enable the status bar with /statusbar on first.", "info"); return; }
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
        ctx.ui.notify("Use /statusbar [on|off|refresh|icons nerd|unicode|ascii].", "warning");
        return;
      }
      try {
        await savePreferences(preferencePath, preferences);
      } catch {
        ctx.ui.notify("Status bar changed for this session, but preferences could not be saved.", "warning");
      }
    },
  };
  pi.registerCommand("statusbar", statusbarCommand);
  // Kept for users of 0.1.0 (published as pi-terminal-statusline).
  pi.registerCommand("statusline", { ...statusbarCommand, description: "Alias of /statusbar" });
}
