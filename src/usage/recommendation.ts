import type { AccountProfile } from '../types/account';
import type { UsageRecord, UsageWindowKey } from '../types/usage';
import { isFreshEnough, windowView } from './usageModel';

// Suggest the account with the most room when the active one is near a limit.
// Only uses fresh data. Never switches by itself.

export interface RecommendationPolicy {
  warningThreshold: number;
  criticalThreshold: number;
  maxDataAgeMs: number;
}

export interface Recommendation {
  level: 'warning' | 'critical';
  window: UsageWindowKey;
  activePercent: number;
  windowResetsAt?: number;
  candidate?: {
    profile: AccountProfile;
    fiveHourPercent?: number;
    sevenDayPercent?: number;
    observedAt: number;
  };
}

export function recommend(
  active: AccountProfile,
  accounts: AccountProfile[],
  records: (id: string) => UsageRecord | undefined,
  policy: RecommendationPolicy,
  now: number,
): Recommendation | undefined {
  const activeRecord = records(active.id);
  if (!activeRecord?.snapshot || !isFreshEnough(activeRecord.snapshot, now, policy.maxDataAgeMs)) {
    return undefined;
  }
  let trigger: { window: UsageWindowKey; percent: number; resetsAt?: number } | undefined;
  for (const key of ['fiveHour', 'sevenDay'] as const) {
    const view = windowView(activeRecord.snapshot[key], now);
    if (view.percent !== undefined && view.percent >= policy.warningThreshold) {
      if (!trigger || view.percent > trigger.percent) {
        trigger = { window: key, percent: view.percent, resetsAt: view.resetsAt };
      }
    }
  }
  if (!trigger) {
    return undefined;
  }
  const level = trigger.percent >= policy.criticalThreshold ? 'critical' : 'warning';

  let best: Recommendation['candidate'];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const profile of accounts) {
    if (profile.id === active.id || profile.authState !== 'authenticated') {
      continue;
    }
    const snapshot = records(profile.id)?.snapshot;
    if (!snapshot || !isFreshEnough(snapshot, now, policy.maxDataAgeMs)) {
      continue;
    }
    const five = windowView(snapshot.fiveHour, now);
    const seven = windowView(snapshot.sevenDay, now);
    // A window that has reset since the observation is treated as unknown, not as empty.
    if (five.percent === undefined || seven.percent === undefined) {
      continue;
    }
    if (five.percent >= policy.warningThreshold || seven.percent >= policy.warningThreshold) {
      continue;
    }
    const score = Math.max(five.percent, seven.percent);
    if (score < bestScore) {
      bestScore = score;
      best = { profile, fiveHourPercent: five.percent, sevenDayPercent: seven.percent, observedAt: snapshot.observedAt };
    }
  }
  return { level, window: trigger.window, activePercent: trigger.percent, windowResetsAt: trigger.resetsAt, candidate: best };
}

/** One alert per account/window/level/reset period. */
export function recommendationKey(profileId: string, rec: Recommendation): string {
  return `${profileId}:${rec.window}:${rec.level}:${rec.windowResetsAt ?? 'unknown'}`;
}
