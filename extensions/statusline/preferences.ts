import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { IconMode } from "./types.ts";

export interface Preferences { enabled: boolean; icons: IconMode }

export const defaultPreferences: Readonly<Preferences> = { enabled: true, icons: "nerd" };

const iconModes = ["nerd", "unicode", "ascii"] as const;
export function isIconMode(value: unknown): value is IconMode {
  return iconModes.includes(value as IconMode);
}

/**
 * Missing or invalid files (or fields) fall back to defaults; never throws.
 * `legacyPaths` are read, in order, only when `path` does not exist yet (renamed files).
 */
export async function readPreferences(path: string, legacyPaths: readonly string[] = []): Promise<Preferences> {
  for (const candidate of [path, ...legacyPaths]) {
    let text: string;
    try {
      text = await readFile(candidate, "utf8");
    } catch {
      continue;
    }
    return parsePreferences(text);
  }
  return { ...defaultPreferences };
}

function parsePreferences(text: string): Preferences {
  try {
    const value = JSON.parse(text);
    return {
      enabled: typeof value?.enabled === "boolean" ? value.enabled : defaultPreferences.enabled,
      icons: isIconMode(value?.icons) ? value.icons : defaultPreferences.icons,
    };
  } catch {
    return { ...defaultPreferences };
  }
}

/** Atomic write (temp file + rename), private to the user. */
export async function savePreferences(path: string, preferences: Preferences): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(preferences, null, 2) + "\n", { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
