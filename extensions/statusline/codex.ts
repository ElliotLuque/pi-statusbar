import { spawn } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import type { Quota, QuotaState } from "./types.ts";
import { QuotaError, record, usedPercent, windowName } from "./usage.ts";

/** Codex is a local process, not an HTTP call: poll it less often than the HTTP providers. */
export const CODEX_POLL_MS = 5 * 60_000;

export type Spawner = typeof spawn;
export type ExecutableFinder = (name: string) => string | undefined;

const version = (() => {
  try {
    return String(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
  } catch {
    return "unknown";
  }
})();

/**
 * Locate an executable on PATH the way the platform shell would, including Windows PATHEXT
 * (npm installs `codex.cmd` there). Returns undefined instead of spawning a missing program.
 */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const directories = (env.PATH ?? env.Path ?? "").split(windows ? ";" : ":").filter(Boolean);
  const extensions = windows ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension.toLowerCase());
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!windows) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return undefined;
}

/** Batch shims (`codex.cmd`) cannot be spawned directly on Windows; run them through cmd.exe. */
function launch(executable: string, spawner: Spawner) {
  const options = { stdio: ["pipe", "pipe", "ignore"] as ("pipe" | "ignore")[], windowsHide: true };
  if (/\.(cmd|bat)$/i.test(executable)) {
    return spawner(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `""${executable}" app-server"`], {
      ...options, windowsVerbatimArguments: true,
    });
  }
  return spawner(executable, ["app-server"], options);
}

const missing: QuotaState = {
  status: "unavailable",
  reason: "ChatGPT sign-in quota needs the Codex CLI (install it and run codex login)",
  pollMs: CODEX_POLL_MS,
};

/** Codex app-server `account/rateLimits/read` result: windows in minutes, resets in epoch seconds. */
export function parseCodexAppServerQuota(value: unknown): Quota {
  const snapshot = record(record(value)?.rateLimits);
  const quota: Quota = {};
  for (const name of ["primary", "secondary"]) {
    const data = record(snapshot?.[name]);
    const used = usedPercent(data?.usedPercent);
    const slot = typeof data?.windowDurationMins === "number" ? windowName(data.windowDurationMins * 60) : undefined;
    if (!data || used === undefined || !slot) continue;
    const resetsAt = typeof data.resetsAt === "number" && data.resetsAt > 0 ? data.resetsAt * 1000 : undefined;
    quota[slot] = { usedPercent: used, ...(resetsAt ? { resetsAt } : {}) };
  }
  return quota;
}

/**
 * Pi's "Sign in with ChatGPT" token is scoped to the inference API: ChatGPT's usage endpoint
 * rejects it and responses carry no rate-limit headers. Ask the Codex CLI instead, over its
 * documented app-server protocol. Codex owns and refreshes its own login; we never read it.
 */
export function fetchCodexAppServerQuota(
  signal: AbortSignal,
  spawner: Spawner = spawn,
  find: ExecutableFinder = findExecutable,
): Promise<QuotaState> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const executable = find("codex");
    if (!executable) return resolve(missing);
    const child = launch(executable, spawner);
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
      ? resolve(missing)
      : reject(new QuotaError("Could not start codex app-server", { pollMs: CODEX_POLL_MS }))));
    child.on("exit", () => finish(() => reject(new QuotaError("codex app-server exited before reporting usage", { pollMs: CODEX_POLL_MS }))));
    child.stdin?.on("error", () => {});
    child.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 1_000_000) return finish(() => reject(new QuotaError("codex app-server response too large", { pollMs: CODEX_POLL_MS })));
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
              : "Codex could not read usage", { pollMs: CODEX_POLL_MS })));
          }
          const quota = parseCodexAppServerQuota(message.result);
          return finish(() => resolve(quota.fiveHour || quota.weekly
            ? { status: "ready", quota, updatedAt: Date.now(), pollMs: CODEX_POLL_MS }
            : { status: "unavailable", reason: "Codex reported no five-hour or weekly windows", pollMs: CODEX_POLL_MS }));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "pi-terminal-statusline", version } } });
  });
}
