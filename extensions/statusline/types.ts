export type IconMode = "nerd" | "unicode" | "ascii";

export interface UsageWindow {
  usedPercent: number;
  resetsAt?: number;
}

export interface Quota {
  fiveHour?: UsageWindow;
  weekly?: UsageWindow;
}

export interface QuotaState {
  status: "loading" | "ready" | "unavailable" | "error";
  quota?: Quota;
  updatedAt?: number;
  reason?: string;
  /** Loader hint: delay before the next automatic poll. Not kept in the poller's state. */
  pollMs?: number;
}

export interface FooterState {
  cwd: string;
  home: string;
  branch: string | null;
  model?: { id: string; provider: string; reasoning: boolean };
  effort: string;
  /** Pi's editor border color for the current thinking level (theme.getThinkingBorderColor). */
  effortColor?: (text: string) => string;
  /** Share of the model's context window in use; null when unknown (e.g. after compaction). */
  context?: { percent: number | null };
  quota: QuotaState;
  statuses: readonly string[];
  icons: IconMode;
  color: boolean;
  now: number;
}
