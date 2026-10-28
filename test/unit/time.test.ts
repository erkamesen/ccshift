import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAgo, formatDuration, formatReset, formatWeekdayTime, TIME } from '../../src/utils/time';

const { MINUTE, HOUR, DAY } = TIME;

test('formatDuration', () => {
  assert.equal(formatDuration(30_000), 'less than a minute');
  assert.equal(formatDuration(12 * MINUTE + 59_000), '12m');
  assert.equal(formatDuration(HOUR), '1h');
  assert.equal(formatDuration(HOUR + 24 * MINUTE), '1h 24m');
  assert.equal(formatDuration(2 * DAY + 3 * HOUR + 10 * MINUTE), '2d 3h');
  assert.equal(formatDuration(DAY), '1d');
  assert.equal(formatDuration(Number.NaN), 'less than a minute');
});

test('formatAgo', () => {
  const now = 1_800_000_000_000;
  assert.equal(formatAgo(now - 10_000, now), 'just now');
  assert.equal(formatAgo(now - MINUTE, now), '1 minute ago');
  assert.equal(formatAgo(now - 5 * MINUTE, now), '5 minutes ago');
  assert.equal(formatAgo(now - 3 * HOUR, now), '3 hours ago');
  assert.equal(formatAgo(now - 2 * DAY, now), '2 days ago');
});

test('formatReset: countdown under a day, weekday and time beyond', () => {
  // 2026-10-26 is a Monday.
  const now = Date.parse('2026-10-24T12:00:00Z');
  assert.equal(formatReset(now + HOUR + 24 * MINUTE, now, 'UTC'), 'Resets in 1h 24m');
  assert.equal(formatReset(Date.parse('2026-10-26T10:00:00Z'), now, 'UTC'), 'Resets on Monday, 10:00');
  assert.equal(formatReset(undefined, now, 'UTC'), 'Reset time unknown');
  assert.match(formatReset(now - MINUTE, now, 'UTC'), /^Reset Saturday, 11:59$/);
});

test('reset times follow the given time zone', () => {
  const t = Date.parse('2026-10-31T17:00:00Z');
  assert.equal(formatWeekdayTime(t, 'UTC'), 'Saturday, 17:00');
  assert.equal(formatWeekdayTime(t, 'Europe/Istanbul'), 'Saturday, 20:00');
  assert.equal(formatWeekdayTime(Date.parse('2026-10-31T00:30:00Z'), 'UTC'), 'Saturday, 00:30');
});
