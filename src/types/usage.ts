export type UsageWindowKey = 'fiveHour' | 'sevenDay';

export interface UsageWindow {
  /** 0-100, can go over 100. */
  usedPercent: number;
  /** ms since epoch */
  resetsAt?: number;
}

/** cli-usage = `claude -p /usage`, status-line = the collector. */
export type UsageSource = 'cli-usage' | 'status-line';

export interface UsageSnapshot {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  /** ms since epoch */
  observedAt: number;
  source: UsageSource;
}

export type UsageErrorKind =
  /** The profile is not signed in. */
  | 'auth'
  /** Signed in, but the account type has no subscription usage windows (API key, cloud provider). */
  | 'unsupported'
  /** The installed Claude Code did not return a structured usage report. */
  | 'cli-unsupported'
  /** Claude Code could not be found or failed to run. */
  | 'cli'
  /** The output could not be understood. */
  | 'parse';

export interface UsageError {
  kind: UsageErrorKind;
  message: string;
  at: number;
}

export interface UsageRecord {
  snapshot?: UsageSnapshot;
  lastAttemptAt?: number;
  lastError?: UsageError;
}

export interface UsageCacheFile {
  version: 1;
  records: Record<string, UsageRecord>;
}

/** Display state of an account's usage data. */
export type UsageState =
  | 'live'
  | 'cached'
  | 'stale'
  | 'noData'
  | 'authRequired'
  | 'unsupported'
  | 'error';

export interface WindowView {
  /** undefined = unknown (not 0) */
  percent?: number;
  resetsAt?: number;
  resetSinceObserved: boolean;
}
