import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  epochSecondsToMs,
  isoToMs,
  parseUsageStream,
  snapshotFromStatusLine,
  snapshotFromUsageReport,
} from '../../src/usage/usageParsing';

const NOW = 1_793_220_000_000;

test('status line: extracts both windows and converts seconds to ms', () => {
  const s = snapshotFromStatusLine(
    {
      session_id: 'x',
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
        seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
      },
    },
    NOW,
  );
  assert.deepEqual(s, {
    fiveHour: { usedPercent: 23.5, resetsAt: 1738425600000 },
    sevenDay: { usedPercent: 41.2, resetsAt: 1738857600000 },
    observedAt: NOW,
    source: 'status-line',
  });
});

test('status line: missing rate_limits yields no snapshot (never 0%)', () => {
  assert.equal(snapshotFromStatusLine({ model: {} }, NOW), undefined);
  assert.equal(snapshotFromStatusLine({ rate_limits: {} }, NOW), undefined);
  assert.equal(snapshotFromStatusLine(null, NOW), undefined);
  assert.equal(snapshotFromStatusLine('text', NOW), undefined);
});

test('status line: one window may be absent independently', () => {
  const s = snapshotFromStatusLine({ rate_limits: { seven_day: { used_percentage: 10, resets_at: 1738857600 } } }, NOW);
  assert.equal(s?.fiveHour, undefined);
  assert.equal(s?.sevenDay?.usedPercent, 10);
});

test('status line: invalid numbers are rejected', () => {
  const s = snapshotFromStatusLine(
    {
      rate_limits: {
        five_hour: { used_percentage: -5, resets_at: 1738425600 },
        seven_day: { used_percentage: '40', resets_at: 1738425600 },
      },
    },
    NOW,
  );
  assert.equal(s, undefined);
  const t = snapshotFromStatusLine({ rate_limits: { five_hour: { used_percentage: 5, resets_at: 'soon' } } }, NOW);
  assert.deepEqual(t?.fiveHour, { usedPercent: 5, resetsAt: undefined });
});

test('epoch conversion rejects millisecond values and junk', () => {
  assert.equal(epochSecondsToMs(1738425600), 1738425600000);
  assert.equal(epochSecondsToMs(1738425600000), undefined);
  assert.equal(epochSecondsToMs(Number.NaN), undefined);
  assert.equal(epochSecondsToMs('1738425600'), undefined);
  assert.equal(isoToMs('2026-10-29T02:00:00.129420+00:00'), Date.parse('2026-10-29T02:00:00.129+00:00'));
  assert.equal(isoToMs('not a date'), undefined);
});

// Shape observed from Claude Code 2.1.312 `claude -p /usage --output-format stream-json`.
const REPORT = {
  session: { total_cost_usd: 0 },
  rate_limits: {
    limits: [
      { kind: 'session', group: 'session', percent: 5, resets_at: '2026-10-29T02:00:00.129420+00:00', scope: null, severity: 'normal', is_active: false },
      { kind: 'weekly_all', group: 'weekly', percent: 46, resets_at: '2026-10-31T17:00:00.129442+00:00', scope: null, severity: 'normal', is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 0, resets_at: '2026-10-31T17:00:00+00:00', scope: { model: { display_name: 'Fable' }, surface: null }, severity: 'normal', is_active: false },
    ],
    extra_usage: { is_enabled: false },
  },
};

test('usage report: maps session and weekly_all rows, ignores scoped rows', () => {
  const r = snapshotFromUsageReport(REPORT, NOW);
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(r.snapshot.fiveHour?.usedPercent, 5);
    assert.equal(r.snapshot.fiveHour?.resetsAt, Date.parse('2026-10-29T02:00:00.129Z'));
    assert.equal(r.snapshot.sevenDay?.usedPercent, 46);
    assert.equal(r.snapshot.source, 'cli-usage');
  }
});

test('usage report: falls back to unscoped rows by group when kinds change', () => {
  const r = snapshotFromUsageReport(
    { rate_limits: { limits: [
      { kind: 'weekly_scoped', group: 'weekly', percent: 99, scope: { model: { display_name: 'X' } } },
      { kind: 'new_weekly_name', group: 'weekly', percent: 30, resets_at: null, scope: null },
    ] } },
    NOW,
  );
  assert.equal(r.kind, 'ok');
  if (r.kind === 'ok') {
    assert.equal(r.snapshot.fiveHour, undefined);
    assert.deepEqual(r.snapshot.sevenDay, { usedPercent: 30, resetsAt: undefined });
  }
});

test('usage report: null rate_limits or empty limits means no data', () => {
  assert.deepEqual(snapshotFromUsageReport({ rate_limits: null }, NOW), { kind: 'no-limits' });
  assert.deepEqual(snapshotFromUsageReport({ rate_limits: { limits: [] } }, NOW), { kind: 'no-limits' });
  assert.deepEqual(snapshotFromUsageReport(null, NOW), { kind: 'no-limits' });
});

test('stream parsing finds usage_report among other messages and tolerates junk lines', () => {
  const stdout = [
    'Warning: something on stdout',
    JSON.stringify({ type: 'system', subtype: 'init' }),
    '{not json',
    JSON.stringify({ type: 'assistant', message: { content: [] }, usage_report: REPORT }),
    JSON.stringify({ type: 'result', is_error: false }),
  ].join('\n');
  const r = parseUsageStream(stdout, NOW);
  assert.equal(r.kind, 'ok');
});

test('stream parsing distinguishes "no report key" from "report without limits"', () => {
  const noKey = [JSON.stringify({ type: 'assistant', message: {} }), JSON.stringify({ type: 'result' })].join('\n');
  assert.deepEqual(parseUsageStream(noKey, NOW), { kind: 'no-report' });
  const nullReport = JSON.stringify({ type: 'assistant', usage_report: null });
  assert.deepEqual(parseUsageStream(nullReport, NOW), { kind: 'no-limits' });
  assert.deepEqual(parseUsageStream('', NOW), { kind: 'no-report' });
});
