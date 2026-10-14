import type { UsageWindow } from "./types.ts";

const FIVE_HOURS = 5 * 60 * 60;
const WEEK = 7 * 24 * 60 * 60;

/** A sanitized, user-presentable quota failure. Raw provider/network errors never reach the UI. */
export class QuotaError extends Error {
  readonly retryAfterMs?: number;
  readonly pollMs?: number;
  /**
   * @param retryAfterMs provider-requested cooldown; manual refreshes are refused until it passes.
   * @param pollMs suggested delay before the next automatic poll; manual refresh stays allowed.
   */
  constructor(message: string, options: { retryAfterMs?: number; pollMs?: number } = {}) {
    super(message);
    this.retryAfterMs = options.retryAfterMs;
    this.pollMs = options.pollMs;
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function usedPercent(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, value))
    : undefined;
}

/**
 * Plans can swap windows or omit a weekly allowance. Classify by duration only, so a daily
 * or differently sized allowance is never relabelled as five-hour or weekly.
 */
export function windowName(seconds: number): "fiveHour" | "weekly" | undefined {
  return seconds === FIVE_HOURS ? "fiveHour" : seconds === WEEK ? "weekly" : undefined;
}

export function usageWindow(used: unknown, resetsAt: number): UsageWindow | undefined {
  const percent = usedPercent(used);
  if (percent === undefined) return undefined;
  return { usedPercent: percent, ...(Number.isFinite(resetsAt) && resetsAt > 0 ? { resetsAt } : {}) };
}
