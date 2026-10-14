# Changelog

## 0.1.2 - 14 oct 2026

- Published from GitHub Actions with npm provenance.

## 0.1.1 - 14 oct 2026

- Renamed from `pi-terminal-statusline` to `@elliotluque/pi-statusbar`. Install with `pi install npm:@elliotluque/pi-statusbar`.
- `/statusbar` is the command now; `/statusline` keeps working. Your saved settings carry over.
- Preview image in the Pi package gallery.

## 0.1.0 - 14 oct 2026

- Two-row footer: working directory and Git branch on the left; provider logo, model and reasoning effort on the right.
- Context usage shown as a percentage of the model's context window.
- Five-hour and weekly subscription usage meters for ChatGPT/Codex and Claude plans, led by the time left until reset.
- Usage meters are hidden for API-key, local and other providers without subscription usage.
- Signing in later is picked up automatically, or immediately with `/statusline refresh`.
- Clear loading, unknown, error and stale states; usage is never shown as 0% when unknown.
- Uses your terminal's colors; Nerd Font, Unicode and ASCII icon modes.
- Adapts to narrow terminals without wrapping.
- `/statusline` commands, with preferences remembered between sessions.
- Works on Linux, macOS and Windows.
