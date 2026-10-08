# Pi Terminal Statusline

An icon-led, two-row footer for [Pi](https://pi.dev). Working location on the left; model, reasoning effort and capacity on the right. Colors come from your terminal's ANSI palette—Catppuccin, Solarized, light or dark—without shipping a competing theme.

**Release status:** implementation complete; npm publication pending publisher authentication and final package-name confirmation. `pi-terminal-statusline` is the provisional name. The npm install command below will work only after publication.

<img width="3238" height="189" alt="imagen" src="https://github.com/user-attachments/assets/786c847d-9e7b-46a2-b5aa-142068340be8" />

## Install

Requires **Pi 1.0.0 or later** (`@earendil-works` packages) and Node.js 22.19+. This release does not target the older `@mariozechner` Pi API.

Once published:

```sh
pi install npm:pi-terminal-statusline
```

Install directly from this repository (no npm publication needed):

```sh
pi install git:github.com/ElliotLuque/pi-terminal-statusline
```

Or from a local clone:

```sh
git clone https://github.com/ElliotLuque/pi-terminal-statusline.git
cd pi-terminal-statusline
pi install .
```

Or try it without changing your settings:

```sh
pi --extension ./extensions/statusline/index.ts
```

Run `/reload` in an existing session after installation. This extension replaces Pi's footer, not its editor or header. Only one footer replacement can own the footer at a time; disable other custom-footer extensions. Existing `setStatus()` text is retained when space permits.

The nixdots Home Manager Pi module fetches this repository through a locked, non-flake input and installs the extension directly from the Nix store. **Do not also install the npm/local package in that setup**, or it will be loaded twice. See [the Nix integration](https://github.com/ElliotLuque/nixdots/blob/main/docs/pi-statusline.md).

## Read the footer

| Field | Meaning |
| --- | --- |
| Directory / branch | Pi's working directory and current Git branch, including worktrees; omitted branch outside Git |
| Model icon / name | Provider logo (OpenAI, Claude, Gemini, Grok, DeepSeek, Qwen, Kimi, Meta, GLM…) and selected model |
| Effort | Pi's current reasoning level, colored like Pi's input border; `n/a` without reasoning support |
| `ctx` | Conversation tokens as a percentage of the model's context window (number only, no bar) |
| Usage meters | Time left until reset, bar, percentage used: five-hour window first, weekly second. `5h`/`week` appear only when the reset time is unknown |

Only the subscription windows have bars. **Every bar means percentage used**, not percentage remaining. Green below 75%, yellow from 75%, red from 90%. Values are also textual, so color is never the only signal.

Unknown context (for example after compaction) and missing quota windows show `--`, never `0%`. `...` means quota is loading. `!` means a failed request; `24%!` means the last known 24% is stale. An elapsed reset says `reset pending` until fresh data arrives—it does not guess that usage fell to zero. `/statusline` explains the latest quota state.

On narrower terminals, bars shrink, then times compact (`2h10m`), then bars disappear; times and percentages always remain. Long directories, branches, models and statuses are truncated by terminal columns, including wide Unicode text. Extremely narrow terminals necessarily truncate fields but never wrap into a third row.

## Quota support

| Selected provider | Authentication | Quota |
| --- | --- | --- |
| `openai` | Sign in with ChatGPT (`/login`) | Read through the Codex CLI (`codex app-server`); requires `codex login` with the same ChatGPT account |
| `openai-codex` | Legacy Codex subscription OAuth | Same |
| `anthropic` | Claude subscription OAuth (`/login`) | `five_hour` and account-wide `seven_day` |
| Any provider | API keys, local models, custom proxy endpoints | Unavailable; model and context still work |

Pi's newer “Sign in with ChatGPT” token is scoped to inference: ChatGPT's usage endpoint rejects it and responses carry no rate-limit headers. The extension therefore asks the Codex CLI over its app-server protocol; Codex owns and refreshes its own login, and this extension never reads Codex credentials. If Codex is missing the quota shows `--`; if its login expired it shows `!` and `/statusline` says to run `codex login`. Usage shown is for the account logged into Codex.

Usage is **account-level**, including use outside this conversation. It is not calculated from conversation token counts. Some plans omit one window. OpenAI windows are identified by duration, so a daily or differently sized allowance is never falsely labeled weekly or five-hour.

Quota endpoints are provider-specific subscription APIs and can change or reject tokens with insufficient scopes. The extension makes a best-effort read; availability is not guaranteed for every plan. No live account validation has been performed for this release. `/statusline refresh` retries after login or a transient error; rate-limit `Retry-After` is respected.

Only the selected provider is fetched, once on startup/provider change and every 60 seconds. Requests are deduplicated, time out after 10 seconds (including auth resolution), and run outside rendering and streaming hooks. `--offline` / `PI_OFFLINE=1` disables quota polling. Idle reset labels redraw every 30 seconds without additional requests.

## Commands and icons

```text
/statusline                     Show state and quota diagnostics
/statusline on                  Enable this footer
/statusline off                 Restore Pi's default footer
/statusline refresh             Refresh selected-provider quota
/statusline icons nerd          Provider logos + Nerd Font icons (default)
/statusline icons unicode       Portable Unicode icons
/statusline icons ascii         ASCII labels and bars
```

Preferences are saved separately in `<agent-dir>/terminal-statusline.json`; Pi's `settings.json` is not rewritten. The agent directory honors `PI_CODING_AGENT_DIR`. Invalid/missing preference files use defaults.

Nerd mode requires Nerd Fonts 3.x, and provider logos come from the [Herdr Agent Icons](https://github.com/hhdebb/herdr-radar) font (`U+E1A0–U+E1BA`), which must be installed and mapped by your terminal (e.g. Kitty `symbol_map`). Unknown providers fall back to a Nerd robot icon. The extension cannot reliably detect your font; choose Unicode/ASCII if glyphs render as boxes. The terminal owns the font, foreground, background and all colors. `NO_COLOR` disables color, as does `TERM=dumb`. Changing Pi's own theme does not override the terminal palette in this footer.

## Security and privacy

- Uses Pi's model registry to resolve/refresh existing login credentials; no independent login or token-refresh flow.
- Sends access tokens only to `https://chatgpt.com/backend-api/wham/usage` or `https://api.anthropic.com/api/oauth/usage`; redirects are rejected.
- Custom model/auth base URLs disable quota reads to avoid forwarding proxy credentials to another host.
- Does not read `auth.json` directly, scrape browser sessions, persist quota snapshots, log raw responses, or transmit data to this package's author.
- Authentication/network failures are sanitized. Terminal control sequences are removed from paths, models, branches and status text.
- No runtime dependencies beyond Pi's host-provided packages.

## Develop and publish

```sh
# From the root of this repository:
npm ci --ignore-scripts
npm run check
npm test
npm run preview
npm run release                 # Tests and validates the actual npm pack file list; no publish
```

Development tests pin Pi 1.0.4, whose dependency tree passes npm audit. Pi packages remain host-provided peers and are not bundled with the extension. Keep your host Pi installation up to date independently.

### Mandatory marketplace release checklist

1. Confirm the final npm package name and publisher. Update `package.json`, this README and install examples if renamed.
2. Commit/merge the source so repository/homepage URLs resolve publicly. Do not publish a package whose source exists only in a local worktree.
3. Log in interactively with `npm login` (2FA may be required). Never put publisher tokens in the repository or paste them into an agent conversation.
4. Run `npm run release -- --publish`. It checks authentication, type-checks, runs tests, validates the tarball allowlist, publishes publicly, then verifies version/metadata in the npm registry.
5. Test `pi install npm:pi-terminal-statusline@0.1.0` in an isolated agent directory, open Pi, and check `/statusline` with real subscription logins.
6. Verify discovery in the [Pi package gallery](https://pi.dev/packages). The `pi-package` keyword makes it eligible; indexing is asynchronous and a published npm package alone is not proof of a visible marketplace listing.
7. Replace the pending-release note with the verified version/listing. Do not claim publication before these checks pass.

Gallery images/videos are optional and deliberately omitted rather than linking to a missing or misleading preview.

## License

MIT.
