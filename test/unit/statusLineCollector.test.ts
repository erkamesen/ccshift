import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { StatusLineCollector } from '../../src/usage/StatusLineCollector';
import { snapshotFromStatusLine } from '../../src/usage/usageParsing';
import type { AccountProfile } from '../../src/types/account';
import { tempDir } from './helpers';

async function setup(settings?: unknown): Promise<{ c: StatusLineCollector; p: AccountProfile; home: string; settingsFile: string }> {
  const root = await tempDir();
  const home = path.join(root, 'manager');
  const configDir = path.join(root, 'profile');
  await fs.mkdir(configDir, { recursive: true });
  const settingsFile = path.join(configDir, 'settings.json');
  if (settings !== undefined) {
    await fs.writeFile(settingsFile, typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2));
  }
  const p: AccountProfile = {
    id: 'acct-1234abcd',
    displayName: "Work's",
    color: 'blue',
    kind: 'managed',
    configDir,
    ownedDir: true,
    createdAt: 0,
    authState: 'authenticated',
  };
  return { c: new StatusLineCollector(home), p, home, settingsFile };
}

const PAYLOAD = JSON.stringify({
  session_id: 's',
  rate_limits: { five_hour: { used_percentage: 33, resets_at: 1738425600 }, seven_day: { used_percentage: 44, resets_at: 1738857600 } },
});

function runStatusLine(command: string, home: string): { stdout: string; status: number | null } {
  // Claude Code runs the command through a shell with the JSON on stdin.
  const r = spawnSync('/bin/sh', ['-c', command], {
    input: PAYLOAD,
    env: { ...process.env, CCSHIFT_HOME: home },
    encoding: 'utf8',
  });
  return { stdout: r.stdout, status: r.status };
}

test('install without an existing status line, run it, then remove it cleanly', async () => {
  const { c, p, home, settingsFile } = await setup({ model: 'opus', permissions: { allow: ['Bash(ls)'] } });
  assert.deepEqual(await c.status(p), { kind: 'not-installed' });
  await c.install(p);
  assert.deepEqual(await c.status(p), { kind: 'installed', chained: false });
  const settings = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(settings.model, 'opus', 'other settings untouched');
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] });

  const out = runStatusLine(settings.statusLine.command, home);
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Claude account: Works/);
  const inbox = path.join(home, 'usage', 'inbox', `${p.id}.json`);
  const captured = JSON.parse(await fs.readFile(inbox, 'utf8'));
  assert.equal(snapshotFromStatusLine(captured, 1)?.fiveHour?.usedPercent, 33);

  assert.equal(await c.remove(p), true);
  const after = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  assert.equal(after.statusLine, undefined);
  assert.equal(after.model, 'opus');
  assert.deepEqual(await c.status(p), { kind: 'not-installed' });
});

test('an existing status line is chained (same output) and restored exactly', async () => {
  const original = { type: 'command', command: "printf 'mine:%s' \"$(cat | wc -c | tr -d ' ')\"", padding: 2 };
  const { c, p, home, settingsFile } = await setup({ statusLine: original });
  await c.install(p);
  assert.deepEqual(await c.status(p), { kind: 'installed', chained: true });
  const installed = JSON.parse(await fs.readFile(settingsFile, 'utf8')).statusLine;
  assert.equal(installed.padding, 2, 'other statusLine fields preserved');
  const out = runStatusLine(installed.command, home);
  assert.equal(out.stdout, `mine:${PAYLOAD.length}`, 'original command receives the same input');
  await c.remove(p);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, 'utf8')).statusLine, original);
});

test('removal leaves settings alone if the user replaced the collector', async () => {
  const { c, p, settingsFile } = await setup({});
  await c.install(p);
  const mine = { statusLine: { type: 'command', command: 'echo user-changed' } };
  await fs.writeFile(settingsFile, JSON.stringify(mine));
  assert.deepEqual(await c.status(p), { kind: 'detached' });
  assert.equal(await c.remove(p), false);
  assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, 'utf8')), mine);
});

test('invalid settings.json is never overwritten', async () => {
  const { c, p, settingsFile } = await setup('{ "broken": ');
  await assert.rejects(c.install(p), /could not be read as JSON/);
  assert.equal(await fs.readFile(settingsFile, 'utf8'), '{ "broken": ');
});

test('collector script ignores unsafe profile ids', async () => {
  const { c, p, home } = await setup({});
  await c.install(p);
  const r = spawnSync(c.scriptPath, ['../../etc', 'x'], {
    input: PAYLOAD,
    env: { ...process.env, CCSHIFT_HOME: home },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  const inbox = await fs.readdir(path.join(home, 'usage', 'inbox'));
  assert.deepEqual(inbox, []);
});
