import type { AuthState } from '../types/account';
import type { UsageRecord, UsageSnapshot, UsageState, UsageWindow, UsageWindowKey, WindowView } from '../types/usage';

export interface FreshnessPolicy {
  liveMs: number;
  staleMs: number;
}

export const DEFAULT_FRESHNESS: FreshnessPolicy = {
  liveMs: 2 * 60_000,
  staleMs: 30 * 60_000,
};

/** After a window resets, its old percentage is meaningless, so report it as unknown. */
export function windowView(window: UsageWindow | undefined, now: number): WindowView {
  if (!window) {
    return { percent: undefined, resetsAt: undefined, resetSinceObserved: false };
  }
  if (window.resetsAt !== undefined && window.resetsAt <= now) {
    return { percent: undefined, resetsAt: window.resetsAt, resetSinceObserved: true };
  }
  return { percent: window.usedPercent, resetsAt: window.resetsAt, resetSinceObserved: false };
}

export function snapshotWindow(snapshot: UsageSnapshot | undefined, key: UsageWindowKey): UsageWindow | undefined {
  return snapshot?.[key];
}

export function usageState(
  record: UsageRecord | undefined,
  authState: AuthState,
  now: number,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS,
): UsageState {
  if (authState === 'unauthenticated') {
    return 'authRequired';
  }
  const snapshot = record?.snapshot;
  const error = record?.lastError;
  const errorIsNewer = error !== undefined && (snapshot === undefined || error.at > snapshot.observedAt);
  if (errorIsNewer && error.kind === 'auth') {
    return 'authRequired';
  }
  if (errorIsNewer && error.kind === 'unsupported' && snapshot === undefined) {
    return 'unsupported';
  }
  if (!snapshot) {
    return errorIsNewer ? 'error' : 'noData';
  }
  const age = now - snapshot.observedAt;
  if (age <= policy.liveMs) {
    return 'live';
  }
  if (age <= policy.staleMs) {
    return 'cached';
  }
  return 'stale';
}

export const USAGE_STATE_LABEL: Record<UsageState, string> = {
  live: 'Live',
  cached: 'Cached',
  stale: 'Stale',
  noData: 'No data',
  authRequired: 'Sign-in required',
  unsupported: 'Not available for this account type',
  error: 'Update failed',
};

export function isFreshEnough(snapshot: UsageSnapshot | undefined, now: number, maxAgeMs: number): boolean {
  return snapshot !== undefined && now - snapshot.observedAt <= maxAgeMs;
}

export function newerSnapshot(a: UsageSnapshot | undefined, b: UsageSnapshot | undefined): UsageSnapshot | undefined {
  if (!a) {
    return b;
  }
  if (!b) {
    return a;
  }
  return b.observedAt >= a.observedAt ? b : a;
}

/** Two windows may write the same record; keep the newest data. */
export function mergeRecords(a: UsageRecord | undefined, b: UsageRecord | undefined): UsageRecord {
  const snapshot = newerSnapshot(a?.snapshot, b?.snapshot);
  const errors = [a?.lastError, b?.lastError].filter((e) => e !== undefined);
  const lastError = errors.sort((x, y) => y.at - x.at)[0];
  const attempts = [a?.lastAttemptAt, b?.lastAttemptAt].filter((t): t is number => t !== undefined);
  return {
    snapshot,
    lastError: lastError && (!snapshot || lastError.at > snapshot.observedAt) ? lastError : undefined,
    lastAttemptAt: attempts.length ? Math.max(...attempts) : undefined,
  };
}

export type Severity = 'normal' | 'warning' | 'critical';

export function severityFor(percent: number | undefined, warning: number, critical: number): Severity {
  if (percent === undefined) {
    return 'normal';
  }
  if (percent >= critical) {
    return 'critical';
  }
  return percent >= warning ? 'warning' : 'normal';
}

export function formatPercent(percent: number | undefined): string {
  return percent === undefined ? '—' : `${Math.round(percent)}%`;
}
