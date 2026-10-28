import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recommend, recommendationKey } from '../../src/usage/recommendation';
import type { AccountProfile } from '../../src/types/account';
import type { UsageRecord } from '../../src/types/usage';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const policy = { warningThreshold: 80, criticalThreshold: 95, maxDataAgeMs: 30 * MIN };

function profile(id: string, authState: AccountProfile['authState'] = 'authenticated'): AccountProfile {
  return { id, displayName: id, color: 'blue', kind: 'managed', configDir: `/p/${id}`, ownedDir: true, createdAt: 0, authState };
}

function rec(five: number | undefined, seven: number | undefined, ageMin = 1, fiveReset = NOW + 60 * MIN): UsageRecord {
  return {
    snapshot: {
      fiveHour: five === undefined ? undefined : { usedPercent: five, resetsAt: fiveReset },
      sevenDay: seven === undefined ? undefined : { usedPercent: seven, resetsAt: NOW + 3 * 24 * 60 * MIN },
      observedAt: NOW - ageMin * MIN,
      source: 'cli-usage',
    },
  };
}

test('no recommendation below the warning threshold', () => {
  const records: Record<string, UsageRecord> = { a: rec(50, 40), b: rec(10, 10) };
  assert.equal(recommend(profile('a'), [profile('a'), profile('b')], (id) => records[id], policy, NOW), undefined);
});

test('critical: picks the account with the most headroom', () => {
  const records: Record<string, UsageRecord> = { a: rec(96, 50), b: rec(40, 60), c: rec(18, 30) };
  const r = recommend(profile('a'), [profile('a'), profile('b'), profile('c')], (id) => records[id], policy, NOW);
  assert.equal(r?.level, 'critical');
  assert.equal(r?.window, 'fiveHour');
  assert.equal(r?.candidate?.profile.id, 'c');
  assert.equal(r?.candidate?.fiveHourPercent, 18);
});

test('weekly limit can trigger too', () => {
  const records: Record<string, UsageRecord> = { a: rec(10, 85), b: rec(10, 10) };
  const r = recommend(profile('a'), [profile('a'), profile('b')], (id) => records[id], policy, NOW);
  assert.equal(r?.level, 'warning');
  assert.equal(r?.window, 'sevenDay');
});

test('stale, unknown, unauthenticated or near-limit candidates are never recommended', () => {
  const records: Record<string, UsageRecord> = {
    a: rec(97, 50),
    stale: rec(5, 5, 60),
    unknown: rec(undefined, 5),
    signedOut: rec(1, 1),
    busy: rec(85, 10),
    resetSince: rec(5, 5, 1, NOW - MIN),
  };
  const accounts = [profile('a'), profile('stale'), profile('unknown'), profile('signedOut', 'unauthenticated'), profile('busy'), profile('resetSince')];
  const r = recommend(profile('a'), accounts, (id) => records[id], policy, NOW);
  assert.equal(r?.level, 'critical');
  assert.equal(r?.candidate, undefined);
});

test('stale data for the active account produces no alert', () => {
  const records: Record<string, UsageRecord> = { a: rec(99, 99, 120), b: rec(1, 1) };
  assert.equal(recommend(profile('a'), [profile('a'), profile('b')], (id) => records[id], policy, NOW), undefined);
});

test('alert key changes with the window period so it repeats once per period', () => {
  const r1 = recommend(profile('a'), [profile('a')], () => rec(96, 1, 1, NOW + 60 * MIN), policy, NOW)!;
  const r2 = recommend(profile('a'), [profile('a')], () => rec(96, 1, 1, NOW + 120 * MIN), policy, NOW)!;
  assert.notEqual(recommendationKey('a', r1), recommendationKey('a', r2));
});
