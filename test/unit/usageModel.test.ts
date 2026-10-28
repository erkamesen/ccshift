import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatPercent,
  isFreshEnough,
  mergeRecords,
  severityFor,
  usageState,
  windowView,
} from '../../src/usage/usageModel';
import type { UsageRecord, UsageSnapshot } from '../../src/types/usage';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

function snap(observedAt: number, five?: number, fiveReset?: number): UsageSnapshot {
  return {
    fiveHour: five === undefined ? undefined : { usedPercent: five, resetsAt: fiveReset },
    observedAt,
    source: 'cli-usage',
  };
}

test('windowView: unknown stays unknown', () => {
  assert.deepEqual(windowView(undefined, NOW), { percent: undefined, resetsAt: undefined, resetSinceObserved: false });
});

test('windowView: a window whose reset passed no longer reports its old percentage', () => {
  const v = windowView({ usedPercent: 90, resetsAt: NOW - 1 }, NOW);
  assert.equal(v.percent, undefined);
  assert.equal(v.resetSinceObserved, true);
  const w = windowView({ usedPercent: 90, resetsAt: NOW + 1 }, NOW);
  assert.equal(w.percent, 90);
});

test('usageState: freshness bands', () => {
  const policy = { liveMs: 2 * MIN, staleMs: 30 * MIN };
  assert.equal(usageState({ snapshot: snap(NOW - MIN, 10) }, 'authenticated', NOW, policy), 'live');
  assert.equal(usageState({ snapshot: snap(NOW - 10 * MIN, 10) }, 'authenticated', NOW, policy), 'cached');
  assert.equal(usageState({ snapshot: snap(NOW - 31 * MIN, 10) }, 'authenticated', NOW, policy), 'stale');
  assert.equal(usageState(undefined, 'authenticated', NOW, policy), 'noData');
});

test('usageState: auth and unsupported take precedence appropriately', () => {
  assert.equal(usageState({ snapshot: snap(NOW, 10) }, 'unauthenticated', NOW), 'authRequired');
  assert.equal(usageState({ lastError: { kind: 'auth', message: '', at: NOW } }, 'unknown', NOW), 'authRequired');
  assert.equal(usageState({ lastError: { kind: 'unsupported', message: '', at: NOW } }, 'authenticated', NOW), 'unsupported');
  assert.equal(usageState({ lastError: { kind: 'cli', message: '', at: NOW } }, 'authenticated', NOW), 'error');
  // An old error behind a newer snapshot does not hide the data.
  assert.equal(
    usageState({ snapshot: snap(NOW - MIN, 10), lastError: { kind: 'cli', message: '', at: NOW - 5 * MIN } }, 'authenticated', NOW),
    'live',
  );
});

test('mergeRecords keeps the newest snapshot and drops errors older than it', () => {
  const a: UsageRecord = { snapshot: snap(NOW - 10 * MIN, 10), lastAttemptAt: NOW - 10 * MIN };
  const b: UsageRecord = { snapshot: snap(NOW - MIN, 20), lastError: { kind: 'cli', message: 'x', at: NOW - 5 * MIN }, lastAttemptAt: NOW - MIN };
  const m = mergeRecords(a, b);
  assert.equal(m.snapshot?.fiveHour?.usedPercent, 20);
  assert.equal(m.lastError, undefined);
  assert.equal(m.lastAttemptAt, NOW - MIN);
  const n = mergeRecords(a, { lastError: { kind: 'auth', message: 'y', at: NOW } });
  assert.equal(n.snapshot?.fiveHour?.usedPercent, 10);
  assert.equal(n.lastError?.kind, 'auth');
});

test('severity and formatting', () => {
  assert.equal(severityFor(undefined, 80, 95), 'normal');
  assert.equal(severityFor(79.9, 80, 95), 'normal');
  assert.equal(severityFor(80, 80, 95), 'warning');
  assert.equal(severityFor(95, 80, 95), 'critical');
  assert.equal(formatPercent(undefined), '—');
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(75.6), '76%');
  assert.equal(isFreshEnough(snap(NOW - 5 * MIN), NOW, 10 * MIN), true);
  assert.equal(isFreshEnough(snap(NOW - 15 * MIN), NOW, 10 * MIN), false);
  assert.equal(isFreshEnough(undefined, NOW, 10 * MIN), false);
});
