import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as path from 'path';
import { parseSessionEntry, readLiveSessions, summarizeSessions } from '../../src/integration/SessionRegistry';
import { tempDir } from './helpers';

test('parses session entries defensively', () => {
  assert.deepEqual(parseSessionEntry({ pid: 42, status: 'busy', sessionId: 's', entrypoint: 'claude-vscode' }), {
    pid: 42,
    sessionId: 's',
    cwd: undefined,
    status: 'busy',
    entrypoint: 'claude-vscode',
    name: undefined,
  });
  assert.equal(parseSessionEntry({ pid: '42' }), undefined);
  assert.equal(parseSessionEntry({ pid: -1 }), undefined);
  assert.equal(parseSessionEntry(null), undefined);
});

test('counts only live sessions and never reads .key files', async () => {
  const dir = await tempDir();
  const sessions = path.join(dir, 'sessions');
  await fs.mkdir(sessions);
  await fs.writeFile(path.join(sessions, '100.json'), JSON.stringify({ pid: 100, status: 'busy' }));
  await fs.writeFile(path.join(sessions, '200.json'), JSON.stringify({ pid: 200, status: 'idle' }));
  await fs.writeFile(path.join(sessions, '300.json'), JSON.stringify({ pid: 300, status: 'busy' }));
  await fs.writeFile(path.join(sessions, '400.json'), '{ half-written');
  // A .key file that would throw if parsed as a session.
  await fs.writeFile(path.join(sessions, '100.abc.key'), JSON.stringify({ pid: 999, status: 'busy' }));
  const alive = new Set([100, 200, 999]);
  const scan = await readLiveSessions(dir, (pid) => alive.has(pid));
  assert.equal(scan.readable, true);
  assert.deepEqual(scan.sessions.map((s) => s.pid).sort(), [100, 200]);
  assert.deepEqual(summarizeSessions(scan), { total: 2, busy: 1 });
});

test('a missing sessions folder means no sessions', async () => {
  const dir = await tempDir();
  const scan = await readLiveSessions(dir);
  assert.deepEqual(scan, { readable: true, sessions: [] });
});

test('the current process counts as alive', async () => {
  const dir = await tempDir();
  await fs.mkdir(path.join(dir, 'sessions'));
  await fs.writeFile(path.join(dir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, status: 'idle' }));
  const scan = await readLiveSessions(dir);
  assert.equal(scan.sessions.length, 1);
});
