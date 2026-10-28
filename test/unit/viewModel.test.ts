import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAccountView, statusBarText } from '../../src/ui/viewModel';
import { describePlan, sameClaudeAccount } from '../../src/accounts/identity';
import type { AccountProfile } from '../../src/types/account';

const NOW = Date.parse('2026-10-29T10:00:00Z');
const MIN = 60_000;

const profile: AccountProfile = {
  id: 'acct-1',
  displayName: 'Personal',
  color: 'green',
  kind: 'managed',
  configDir: '/tmp/p',
  ownedDir: true,
  createdAt: 0,
  authState: 'authenticated',
  identity: { email: 'me@example.com', subscriptionType: 'max', authMethod: 'claude.ai' },
};

const ctx = { defaultId: 'default', now: NOW, warningThreshold: 80, criticalThreshold: 95, refreshing: false };

test('a card with data', () => {
  const v = buildAccountView(profile, {
    ...ctx,
    activeId: 'acct-1',
    record: {
      snapshot: {
        fiveHour: { usedPercent: 76, resetsAt: NOW + 84 * MIN },
        sevenDay: { usedPercent: 42, resetsAt: NOW + 3 * 24 * 60 * MIN },
        observedAt: NOW - 2 * MIN,
        source: 'cli-usage',
      },
    },
  });
  assert.equal(v.isActive, true);
  assert.equal(v.plan, 'Max plan');
  assert.equal(v.fiveHour.percentLabel, '76%');
  assert.equal(v.fiveHour.resetLabel, 'Resets in 1h 24m');
  assert.match(v.sevenDay.resetLabel, /^Resets on \w+, \d\d:\d\d$/);
  assert.equal(v.updatedLabel, 'Updated 2 minutes ago');
  assert.equal(v.usageState, 'live');
  assert.equal(statusBarText(v), 'Personal · 5h 76%');
});

test('a card without data shows unknown, never 0%', () => {
  const v = buildAccountView(profile, ctx);
  assert.equal(v.fiveHour.percent, undefined);
  assert.equal(v.fiveHour.percentLabel, '—');
  assert.equal(v.usageState, 'noData');
  assert.equal(statusBarText(v), 'Personal · 5h —');
});

test('severity and stale marker', () => {
  const v = buildAccountView(profile, {
    ...ctx,
    record: { snapshot: { fiveHour: { usedPercent: 96, resetsAt: NOW + 10 * MIN }, observedAt: NOW - 45 * MIN, source: 'status-line' } },
  });
  assert.equal(v.fiveHour.severity, 'critical');
  assert.equal(v.usageState, 'stale');
  assert.equal(statusBarText(v), 'Personal · 5h 96%*');
  assert.equal(v.sourceLabel, 'from a Claude Code CLI session');
});

test('a reset since the observation hides the stale percentage', () => {
  const v = buildAccountView(profile, {
    ...ctx,
    record: { snapshot: { fiveHour: { usedPercent: 99, resetsAt: NOW - MIN }, observedAt: NOW - 10 * MIN, source: 'cli-usage' } },
  });
  assert.equal(v.fiveHour.percent, undefined);
  assert.match(v.fiveHour.resetLabel, /refresh for current usage/);
});

test('plan labels and identity comparison', () => {
  assert.equal(describePlan({ subscriptionType: 'pro' }), 'Pro plan');
  assert.equal(describePlan({ authMethod: 'api-key' }), 'API / Console');
  assert.equal(describePlan({ authMethod: 'bedrock', apiProvider: 'bedrock' }), 'Cloud provider (bedrock)');
  assert.equal(describePlan(undefined), undefined);
  assert.equal(sameClaudeAccount({ email: 'A@x.com', orgId: 'o' }, { email: 'a@x.com', orgId: 'o' }), true);
  assert.equal(sameClaudeAccount({ email: 'a@x.com', orgId: 'o1' }, { email: 'a@x.com', orgId: 'o2' }), false);
  assert.equal(sameClaudeAccount({}, {}), false);
});
