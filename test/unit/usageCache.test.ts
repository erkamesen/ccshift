import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as path from 'path';
import { UsageCache, sanitizeCacheFile } from '../../src/usage/UsageCache';
import { silentLogger, tempDir } from './helpers';

const snapshot = (observedAt: number, pct: number) => ({
  fiveHour: { usedPercent: pct, resetsAt: observedAt + 3_600_000 },
  observedAt,
  source: 'cli-usage' as const,
});

test('two writers (two windows) keep each other\'s profiles and the newest snapshot', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'usage-cache.json');
  const w1 = new UsageCache(file, silentLogger);
  const w2 = new UsageCache(file, silentLogger);
  await w1.load();
  await w2.load();
  await w1.update('acct-1', (r) => ({ ...r, snapshot: snapshot(1000, 10) }));
  await w2.update('acct-2', (r) => ({ ...r, snapshot: snapshot(2000, 20) }));
  // w1 writes an older snapshot for acct-2 from stale memory: the newer one must survive.
  await w1.update('acct-1', (r) => ({ ...r, lastAttemptAt: 3000 }));
  const check = new UsageCache(file, silentLogger);
  await check.load();
  assert.equal(check.get('acct-1')?.snapshot?.fiveHour?.usedPercent, 10);
  assert.equal(check.get('acct-1')?.lastAttemptAt, 3000);
  assert.equal(check.get('acct-2')?.snapshot?.fiveHour?.usedPercent, 20);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('a corrupted cache is replaced, not fatal', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'usage-cache.json');
  await fs.writeFile(file, '{{{');
  const c = new UsageCache(file, silentLogger);
  await c.load();
  assert.equal(c.get('acct-1'), undefined);
  await c.update('acct-1', (r) => ({ ...r, snapshot: snapshot(1, 5) }));
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).records['acct-1'].snapshot.fiveHour.usedPercent, 5);
});

test('sanitizer drops invalid ids, sources and numbers', () => {
  const out = sanitizeCacheFile({
    records: {
      '../evil': { snapshot: snapshot(1, 5) },
      'acct-1': { snapshot: { fiveHour: { usedPercent: -1 }, observedAt: 1, source: 'cli-usage' } },
      'acct-2': { snapshot: { ...snapshot(1, 5), source: 'made-up' } },
      'acct-3': { snapshot: snapshot(1, 5), lastError: { kind: 'auth', at: 2, message: 'm' } },
    },
  });
  assert.deepEqual(Object.keys(out.records).sort(), ['acct-1', 'acct-2', 'acct-3']);
  assert.equal(out.records['acct-1'].snapshot, undefined);
  assert.equal(out.records['acct-2'].snapshot, undefined);
  assert.equal(out.records['acct-3'].lastError?.kind, 'auth');
});

test('remove deletes one profile only', async () => {
  const dir = await tempDir();
  const c = new UsageCache(path.join(dir, 'u.json'), silentLogger);
  await c.load();
  await c.update('acct-1', (r) => ({ ...r, snapshot: snapshot(1, 5) }));
  await c.update('acct-2', (r) => ({ ...r, snapshot: snapshot(1, 6) }));
  await c.remove('acct-1');
  assert.equal(c.get('acct-1'), undefined);
  assert.equal(c.get('acct-2')?.snapshot?.fiveHour?.usedPercent, 6);
});
