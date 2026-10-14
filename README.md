# Pi Terminal Statusline

A cleaner, more useful footer for [Pi](https://pi.dev). See where you're working, which model you're using, and how much of your subscription you have left, at a glance.

<img width="3238" height="189" alt="imagen" src="https://github.com/user-attachments/assets/786c847d-9e7b-46a2-b5aa-142068340be8" />

## What you get

- **Where you are**: your working directory and current Git branch, worktrees included.
- **What you're running**: the active model with its provider logo (OpenAI, Claude, Google, Copilot) and the current reasoning effort.
- **How full the conversation is**: context usage as a percentage of the model's window.
- **How much subscription you have left**: five-hour and weekly usage bars for ChatGPT/Codex and Claude plans, with time until reset.
- **Your colors**: it uses your terminal's palette, so it fits Catppuccin, Solarized, light or dark themes with no extra setup.
- **Always two rows**: long paths and narrow terminals are handled gracefully, and the footer never wraps.

## Install

Requires Pi 1.0.0 or later.

```sh
pi install git:github.com/ElliotLuque/pi-terminal-statusline
```

Then run `/reload` in any open Pi session.

## Reading the footer

| Field | Meaning |
| --- | --- |
| Directory / branch | Where you are working and the current Git branch |
| Model | Provider logo and the selected model |
| Effort | Current reasoning level, or `n/a` if the model has none |
| `ctx` | Share of the model's context window in use |
| Usage bars | Percentage **used** in your five-hour and weekly windows, with time until reset |

Bars turn yellow at 75% used and red at 90%. `--` means a value isn't available yet, and `...` means it's loading. A trailing `!` means the last refresh failed. Run `/statusline` for details.

## Subscription usage

| Provider | Sign-in | Usage shown |
| --- | --- | --- |
| OpenAI | Sign in with ChatGPT | Yes (needs the Codex CLI signed in with `codex login`) |
| Anthropic | Claude subscription login | Yes |
| Anything else (API keys, local models, proxies) | n/a | No usage meters. Model and context still show |

Usage reflects your whole account, including activity outside the current conversation. If you sign in after starting Pi, usage appears within a few minutes, or right away with `/statusline refresh`.

## Commands

```text
/statusline                 Show current status and usage details
/statusline on | off        Turn this footer on, or go back to Pi's default
/statusline refresh         Refresh subscription usage now
/statusline icons nerd      Provider logos + Nerd Font icons (default)
/statusline icons unicode   Portable Unicode icons
/statusline icons ascii     Plain text labels
```

Your choices are remembered between sessions.

## Icons and fonts

The default style needs a [Nerd Font](https://www.nerdfonts.com/) (version 3.5 or later for the OpenAI and Claude logos). If icons show up as boxes, switch to `unicode` or `ascii` mode.

## Compatibility notes

- This replaces Pi's footer only. Disable other custom-footer extensions to avoid conflicts.
- Usage figures come from your provider's subscription services and may be unavailable on some plans.

## Privacy

Your login is only ever sent to your provider's own usage service. Nothing is sent to the author, and no usage data is stored.

## License

MIT.
