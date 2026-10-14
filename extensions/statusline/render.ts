import { sep } from "node:path";
import { sliceByColumn, stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FooterState, IconMode, UsageWindow } from "./types.ts";

// ANSI palette slots, not RGB values: the terminal owns every color (including Catppuccin).
const palette = { text: 39, muted: 37, track: 90, directory: 34, branch: 36, model: 35, effort: 36, good: 32, warning: 33, error: 31 };
type Role = keyof typeof palette;

// Provider marks from the "Herdr Agent Icons" font (Private Use Area, mapped by the terminal);
// generic symbols come from Nerd Fonts 3.x.
const logos: Record<string, string> = {
  claude: "\ue1a0", gemini: "\ue1ae", gpt: "\ue1af", deepseek: "\ue1ad", qwen: "\ue1b0", grok: "\ue1b1",
  kimi: "\ue1a6", meta: "\ue1b9", glm: "\ue1b7", copilot: "\ue1ac", cursor: "\ue1ab",
};
const icons = {
  nerd: { directory: "\uf07b", branch: "\ue0a0", model: "\u{f06a9}", effort: "\uf0e7" },
  unicode: { directory: "▱", branch: "⑂", model: "◇", effort: "ϟ" },
  ascii: { directory: "dir", branch: "git", model: "model", effort: "effort" },
} satisfies Record<IconMode, Record<string, string>>;

/** Pick a vendor mark from the provider id, then the model id (for routers and local models). */
export function providerLogo(provider: string | undefined, model: string | undefined): string | undefined {
  const p = (provider ?? "").toLowerCase();
  const m = (model ?? "").toLowerCase();
  const byProvider: [RegExp, string][] = [
    [/^(openai|openai-codex|azure-openai)/, "gpt"], [/^anthropic|claude/, "claude"], [/^(google|gemini|vertex)/, "gemini"],
    [/^xai|grok/, "grok"], [/deepseek/, "deepseek"], [/qwen|alibaba|dashscope/, "qwen"], [/moonshot|kimi/, "kimi"],
    [/^(zai|zhipu|glm)/, "glm"], [/copilot/, "copilot"], [/cursor/, "cursor"],
  ];
  const byModel: [RegExp, string][] = [
    [/^(gpt|o\d|codex)/, "gpt"], [/claude|sonnet|opus|haiku/, "claude"], [/gemini|gemma/, "gemini"], [/grok/, "grok"],
    [/deepseek/, "deepseek"], [/qwen|qwq/, "qwen"], [/kimi/, "kimi"], [/llama/, "meta"], [/glm/, "glm"],
  ];
  for (const [pattern, name] of byProvider) if (pattern.test(p)) return logos[name];
  for (const [pattern, name] of byModel) if (pattern.test(m)) return logos[name];
  return undefined;
}

export function safeText(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();
}

export function shortenDirectory(cwd: string, home: string): string {
  if (!home) return cwd;
  if (cwd === home) return "~";
  const next = cwd[home.length];
  return cwd.startsWith(home) && (next === "/" || next === sep) ? "~" + cwd.slice(home.length) : cwd;
}

/** Last path segment, accepting either separator. "~" stays "~". */
function lastSegment(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function tail(text: string, width: number, ellipsis: string): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  return ellipsis + sliceByColumn(text, visibleWidth(text) - Math.max(0, width - 1), Math.max(0, width - 1), true);
}

export function resetCountdown(resetsAt: number | undefined, now: number): string {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return "";
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes <= 0) return "reset pending";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(minutes / (24 * 60))}d ${Math.floor(minutes / 60) % 24}h`;
}

export function renderFooter(state: FooterState, width: number): string[] {
  width = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (width === 0) return ["", ""];
  const glyph = icons[state.icons];
  const ascii = state.icons === "ascii";
  const ellipsis = ascii ? "~" : "…";
  const paint = (role: Role, text: string) => state.color && text ? `\x1b[${palette[role]}m${text}\x1b[39m` : text;
  const muted = (text: string) => paint("muted", text);
  const divider = paint("track", ascii ? " | " : " · ");
  const mark = (icon: string, text: string) => icon ? `${icon} ${text}` : text;
  const clipped = (text: string, budget: number) => truncateToWidth(text, Math.max(0, budget), ellipsis);
  const utilization = (used: number | undefined): Role => used === undefined ? "muted" : used >= 90 ? "error" : used >= 75 ? "warning" : "good";
  const clamp = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;

  function row(left: string, right: string): string {
    if (!right) return clipped(left, width);
    right = clipped(right, width);
    left = clipped(left, Math.max(0, width - visibleWidth(right) - 2));
    const gap = " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
    return clipped(left + gap + right, width);
  }

  // Row one, right: provider mark, model and effort. Cap it so the directory keeps room.
  const model = state.model;
  const logo = state.icons === "nerd" ? providerLogo(model?.provider, model?.id) ?? glyph.model : glyph.model;
  const effortText = mark(glyph.effort, model?.reasoning ? safeText(state.effort) : "n/a");
  const effortPart = state.color && state.effortColor ? state.effortColor(effortText) : paint("effort", effortText);
  const modelBudget = Math.max(1, Math.floor(width * 0.6) - visibleWidth(effortPart) - visibleWidth(divider));
  const modelPart = paint("model", clipped(mark(logo, safeText(model?.id ?? "no model")), modelBudget));
  const identity = clipped(modelPart + divider + effortPart, Math.max(1, width - Math.min(10, Math.floor(width * 0.3))));

  // Row one, left: working directory, collapsing to its last segment, then truncating from the left.
  const directoryBudget = Math.max(0, width - visibleWidth(identity) - 2);
  let directory = safeText(shortenDirectory(state.cwd, state.home));
  const prefix = glyph.directory + " ";
  // Every displayed form goes through safeText: directory names can carry terminal escapes.
  if (visibleWidth(prefix + directory) > directoryBudget) directory = safeText(lastSegment(directory)) || directory;
  const location = directoryBudget > visibleWidth(prefix) + 1
    ? paint("directory", prefix + tail(directory, directoryBudget - visibleWidth(prefix), ellipsis))
    : paint("directory", clipped(directory, directoryBudget));

  // Row two. Left: branch, context, then other statuses. Right: usage meters.
  const quota = state.quota.quota;
  const stale = state.quota.status === "error" && !!quota;
  const pending = state.quota.status === "loading" ? "..." : state.quota.status === "error" && !quota ? "!" : undefined;
  const contextPercent = clamp(state.context?.percent);

  // The remaining time leads each meter and replaces the "5h"/"week" window labels.
  // Without a reset time, fall back to the label so the meter stays identifiable.
  function meter(label: string, value: UsageWindow | undefined, cells: number, compactTime: boolean): string {
    if (pending) return `${muted(label)} ${paint(state.quota.status === "error" ? "warning" : "muted", pending)}`;
    const percent = clamp(value?.usedPercent);
    const role = stale ? "warning" : utilization(percent);
    let bar = "";
    if (cells && percent !== undefined) {
      const filled = Math.round(percent / 100 * cells);
      const [fill, track] = ascii ? ["#", "-"] : state.color ? ["█", "█"] : ["█", "░"];
      bar = paint(role, fill.repeat(filled)) + paint("track", track.repeat(cells - filled)) + " ";
    }
    const used = percent === undefined ? "--" : `${Math.round(percent)}%`;
    let lead = value ? resetCountdown(value.resetsAt, state.now) : "";
    if (compactTime) lead = lead.replace(/ (?=\d)/, "").replace("reset pending", "now");
    return `${muted(lead || label)} ${bar}${paint(role, used)}${stale && value ? paint("warning", "!") : ""}`;
  }

  function capacity(cells: number, compact: boolean): string {
    return [meter("5h", quota?.fiveHour, cells, compact), meter(compact ? "wk" : "week", quota?.weekly, cells, compact)].join(divider);
  }

  const branch = state.branch ? paint("branch", mark(glyph.branch, safeText(state.branch))) : "";
  const context = `${muted("ctx")} ${contextPercent === undefined ? muted("--") : paint("text", `${Math.round(contextPercent)}%`)}`;
  const statuses = state.statuses.map(safeText).filter(Boolean).join(ascii ? " | " : " · ");
  const left = [branch, context, statuses ? muted(statuses) : ""].filter(Boolean).join(divider);
  // Accounts without subscription usage (API keys, local models) get no meters at all.
  if (state.quota.status === "unavailable" && !quota) return [row(location, identity), row(left, "")];
  const variants = [capacity(10, false), capacity(8, false), capacity(5, true), capacity(0, true)];
  const leftReserve = Math.min(visibleWidth(stripTerminalSequences(left)), 28) + 2;
  const usage = variants.find(value => visibleWidth(value) <= width - leftReserve)
    ?? variants.find(value => visibleWidth(value) <= width)
    ?? variants[variants.length - 1];
  return [row(location, identity), row(left, usage)];
}
