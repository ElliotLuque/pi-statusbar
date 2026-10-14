import { mkdir, writeFile } from "node:fs/promises";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { renderFooter } from "../extensions/statusline/render.ts";
import type { FooterState } from "../extensions/statusline/types.ts";

// Synthetic preview only. Never reads credentials or makes provider requests.
const now = Date.now();
const sample: FooterState = {
  cwd: "/home/elliot/projects/nixdots", home: "/home/elliot", branch: "main",
  model: { id: "gpt-5.4", provider: "openai", reasoning: true }, effort: "high",
  context: { percent: 38 },
  quota: { status: "ready", quota: {
    fiveHour: { usedPercent: 24, resetsAt: now + 130 * 60_000 },
    weekly: { usedPercent: 51, resetsAt: now + 51 * 60 * 60_000 },
  } },
  statuses: [], icons: "nerd", color: !process.env.NO_COLOR, now,
  // Stand-in for Pi's theme.getThinkingBorderColor("high") under Catppuccin Mocha (mauve).
  effortColor: text => `\x1b[38;2;203;166;247m${text}\x1b[39m`,
};

const variants: [string, FooterState, number][] = [
  ...[120, 80, 60, 40].map(width => [`${width}-columns`, sample, width] as [string, FooterState, number]),
  ["claude", { ...sample, model: { id: "claude-sonnet-4-6", provider: "anthropic", reasoning: true } }, 100],
  ["unicode-icons", { ...sample, icons: "unicode" }, 100],
  ["ascii-icons", { ...sample, icons: "ascii" }, 80],
  ["unknown", { ...sample, context: { percent: null }, quota: { status: "unavailable" } }, 80],
  ["stale", { ...sample, quota: { ...sample.quota, status: "error" } }, 120],
  ["high-usage", { ...sample, quota: { status: "ready", quota: { fiveHour: { usedPercent: 79 }, weekly: { usedPercent: 96 } } }, statuses: ["review ready"] }, 100],
];

const save = process.argv.includes("--write");
if (save) await mkdir(".impeccable/review", { recursive: true });
console.log("Synthetic footer previews — bars show percentage USED.\n");
for (const [name, state, width] of variants) {
  const lines = renderFooter(state, width);
  console.log(`${name}\n${lines.join("\n")}\n`);
  if (save) {
    await writeFile(`.impeccable/review/${name}.ansi`, lines.join("\n") + "\n");
    await writeFile(`.impeccable/review/${name}.txt`, lines.map(stripTerminalSequences).join("\n") + "\n");
  }
}
