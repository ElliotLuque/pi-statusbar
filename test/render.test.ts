import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { providerLogo, renderFooter, resetCountdown, safeText, shortenDirectory } from "../extensions/statusline/render.ts";
import type { FooterState } from "../extensions/statusline/types.ts";

const example: FooterState = {
  cwd: "/home/elliot/projects/nixdots", home: "/home/elliot", branch: "main",
  model: { id: "gpt-5.4", provider: "openai", reasoning: true }, effort: "high",
  context: { percent: 38 },
  quota: { status: "ready", quota: { fiveHour: { usedPercent: 24, resetsAt: 7_800_000 }, weekly: { usedPercent: 51, resetsAt: 183_600_000 } } },
  statuses: [], icons: "nerd", color: false, now: 0,
};

for (const icons of ["nerd", "unicode", "ascii"] as const) {
  test(`${icons}: exactly two bounded rows at every terminal width`, () => {
    for (let width = 0; width <= 200; width++) {
      for (const line of renderFooter({ ...example, icons, color: true }, width)) {
        assert.ok(visibleWidth(line) <= width, `${width} columns: ${JSON.stringify(line)}`);
        assert.ok(!/[\r\n\t]/.test(line));
      }
      assert.equal(renderFooter(example, width).length, 2);
    }
  });
}

test("layout: directory over branch and context; model/effort over usage on the right", () => {
  const [top, bottom] = renderFooter(example, 120);
  assert.match(top, /^\uf07b ~\/projects\/nixdots +\uec81 gpt-5\.4 · \uf0e7 high$/u);
  assert.match(bottom, /^\ue0a0 main · ctx 38% +2h 10m [█░]{10} 24% · 2d 3h [█░]{10} 51%$/);
  assert.equal(visibleWidth(top), 120);
  assert.equal(visibleWidth(bottom), 120);
});

test("remaining time leads each meter and replaces the 5h/week labels", () => {
  const bottom = renderFooter(example, 120)[1];
  assert.ok(!/\b5h\b|week|↻/.test(bottom));
  // Without a reset time, the window label is the fallback.
  const noReset = renderFooter({ ...example, quota: { status: "ready", quota: { fiveHour: { usedPercent: 24 }, weekly: { usedPercent: 51 } } } }, 120)[1];
  assert.match(noReset, /5h [█░]+ 24% · week [█░]+ 51%$/);
});

test("context is on the left, numbers only: no bar and no icon", () => {
  const bottom = renderFooter(example, 120)[1];
  assert.match(bottom, /^\ue0a0 main · ctx 38% /);
  assert.ok(!bottom.includes("▣") && !bottom.includes("\uf2db"));
});

test("usage bars are thick blocks; tracks differ from fill only by color, or ░ without color", () => {
  const plain = renderFooter(example, 120)[1];
  assert.match(plain, /2h 10m ██░{8} 24%/);
  assert.match(plain, /2d 3h █{5}░{5} 51%/);
  const colored = renderFooter({ ...example, color: true }, 120)[1];
  assert.match(colored, /\x1b\[32m██\x1b\[39m\x1b\[90m█{8}\x1b\[39m/);
});

test("provider marks come from Nerd Fonts; robot for providers without one", () => {
  assert.equal(providerLogo("openai", "gpt-6.1-sol"), "\uec81");
  assert.equal(providerLogo("openai-codex", "x"), "\uec81");
  assert.equal(providerLogo("anthropic", "claude-sonnet-4-6"), "\uec82");
  assert.equal(providerLogo("google", "gemini-3"), "\u{f02ad}");
  assert.equal(providerLogo("github-copilot", "gpt-5"), "\uf4b8");
  assert.equal(providerLogo("openrouter", "anthropic/claude-opus"), "\uec82");
  assert.equal(providerLogo("openrouter", "openai/gpt-oss-120b"), "\uec81");
  assert.equal(providerLogo("ollama", "gemma3:27b"), "\u{f02ad}");
  for (const [provider, model] of [["ollama", "qwen3:32b"], ["xai", "grok-4"], ["deepseek", "deepseek-r1"], ["ollama", "mystery"]]) {
    assert.equal(providerLogo(provider, model), undefined);
  }
  assert.match(renderFooter({ ...example, model: { id: "mystery", provider: "ollama", reasoning: false } }, 100)[0], /\u{f06a9} mystery · \uf0e7 n\/a$/u);
  assert.match(renderFooter({ ...example, icons: "unicode" }, 100)[0], /◇ gpt-5\.4/);
});

test("effort uses Pi's input-border color function when provided", () => {
  const top = renderFooter({ ...example, color: true, effortColor: text => `<border>${text}</border>` }, 100)[0];
  assert.match(top, /<border>\uf0e7 high<\/border>$/);
});

test("compact layout keeps times and numbers, shrinks then drops bars", () => {
  for (const width of [40, 60, 80]) assert.match(renderFooter(example, width)[1], /2h ?10m .*24% · 2d ?3h .*51%/);
  assert.match(renderFooter(example, 40)[1], /2h10m 24% · 2d3h 51%$/);
});

test("unknown values are --, never 0%; genuine zero is 0%", () => {
  const lines = renderFooter({ ...example, branch: null, model: undefined, context: { percent: null }, quota: { status: "ready", quota: {} } }, 100);
  assert.match(lines[0], /no model/);
  assert.match(lines[1], /^ctx -- +5h -- · week --$/);
  const zero = renderFooter({ ...example, context: { percent: 0 }, quota: { status: "ready", quota: { fiveHour: { usedPercent: 0 } } } }, 100);
  assert.match(zero[1], /ctx 0% +5h ░+ 0% · week --$/);
});

test("accounts without subscription usage show no meters at all", () => {
  for (const width of [40, 100]) {
    const lines = renderFooter({ ...example, quota: { status: "unavailable", reason: "API key" } }, width);
    assert.match(lines[1], /^\ue0a0 main · ctx 38%$/);
  }
});

test("loading, error and stale states", () => {
  assert.match(renderFooter({ ...example, quota: { status: "loading" } }, 100)[1], /5h \.\.\. · week \.\.\.$/);
  assert.match(renderFooter({ ...example, quota: { status: "error" } }, 100)[1], /5h ! · week !$/);
  assert.match(renderFooter({ ...example, now: 9_000_000, quota: { ...example.quota, status: "error" } }, 140)[1], /reset pending .*24%!.*51%!/);
});

test("terminal palette only; thresholds and readable labels", () => {
  const lines = renderFooter({ ...example, color: true, quota: { status: "ready", quota: { fiveHour: { usedPercent: 75 }, weekly: { usedPercent: 90 } } } }, 120);
  assert.match(lines[0], /\x1b\[34m/);
  assert.match(lines[1], /\x1b\[33m75%/);
  assert.match(lines[1], /\x1b\[31m90%/);
  assert.match(lines[1], /\x1b\[37mctx/);
  assert.ok(!lines.join().includes("38;2"));
});

test("statuses follow the branch; long and hostile text stays bounded", () => {
  const withStatus = renderFooter({ ...example, statuses: ["review ready"] }, 160);
  assert.match(withStatus[1], /^\ue0a0 main · ctx 38% · review ready +2h 10m/);
  for (const width of [1, 20, 40, 60, 80, 120]) {
    const state = { ...example, cwd: "/项目/📁/á/longdirectory".repeat(20), branch: "feature/改善".repeat(20), model: { ...example.model!, id: "long-model-🧠-界".repeat(20) }, statuses: ["\x1b]52;c;ZXZpbA==\x07\r\nstatus\x1b[2J".repeat(20)], color: true };
    for (const line of renderFooter(state, width)) {
      assert.ok(visibleWidth(line) <= width);
      assert.ok(!line.includes("]52;"));
    }
  }
});

test("helpers: sanitation, home shortening, countdowns, ASCII purity", () => {
  assert.equal(safeText("\x1b[31mhello\x1b[0m\n\u202eevil\x1b]52;c;data\x07"), "hello evil");
  assert.equal(shortenDirectory("/home/me/repo", "/home/me"), "~/repo");
  assert.equal(shortenDirectory("/home/me-too/repo", "/home/me"), "/home/me-too/repo");
  assert.equal(shortenDirectory("C:\\Users\\me\\repo", "C:\\Users\\me"), process.platform === "win32" ? "~\\repo" : "C:\\Users\\me\\repo");
  assert.equal(shortenDirectory("/srv/repo", ""), "/srv/repo");
  assert.equal(resetCountdown(7_800_000, 0), "2h 10m");
  assert.equal(resetCountdown(0, 1), "reset pending");
  assert.ok(renderFooter({ ...example, icons: "ascii" }, 120).every(line => /^[\x20-\x7e]*$/.test(line)));
  assert.equal(stripTerminalSequences(renderFooter({ ...example, color: true }, 120)[0]), renderFooter(example, 120)[0]);
});

test("collapsed directory names are sanitized: no terminal escapes reach the terminal", () => {
  const cwd = "/home/elliot/very/long/path/that/needs/collapsing/evil\x1b]52;c;ZXZpbA==\x07\x1b]0;PWNED\x07dir";
  for (const icons of ["nerd", "unicode", "ascii"] as const) {
    for (const width of [20, 40, 50, 60]) {
      for (const line of renderFooter({ ...example, cwd, icons, color: false }, width)) {
        // Only pi-tui's own SGR resets may remain; no OSC, BEL or other control bytes.
        assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(line.replace(/\x1b\[[0-9;]*m/g, "")), `${icons} ${width}: ${JSON.stringify(line)}`);
      }
    }
  }
});

test("a collapsed directory keeps its last segment; home stays ~", () => {
  const top = renderFooter({ ...example, cwd: "/home/elliot/" + "deep/".repeat(20) + "project" }, 50)[0];
  assert.match(top, /^\uf07b project /);
  assert.match(renderFooter({ ...example, cwd: "/home/elliot" }, 30)[0], /^\uf07b ~ /);
});
