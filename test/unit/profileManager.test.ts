import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ProfileError, ProfileManager } from '../../src/accounts/ProfileManager';
import { DEFAULT_PROFILE_ID } from '../../src/types/account';
import { silentLogger, tempDir } from './helpers';

async function setup(): Promise<{ pm: ProfileManager; home: string; claudeDir: string; root: string }> {
  const root = await tempDir();
  const home = path.join(root, 'manager');
  const claudeDir = path.join(root, 'dot-claude');
  await fs.mkdir(claudeDir);
  await fs.writeFile(path.join(claudeDir, 'sentinel'), 'keep me');
  const pm = new ProfileManager({ home, defaultConfigDir: claudeDir, logger: silentLogger });
  await pm.load();
  return { pm, home, claudeDir, root };
}

test('first load creates metadata with only the default profile', async () => {
  const { pm, home, claudeDir } = await setup();
  assert.equal(pm.profiles.length, 1);
  const d = pm.profiles[0];
  assert.equal(d.id, DEFAULT_PROFILE_ID);
  assert.equal(d.kind, 'default');
  assert.equal(d.configDir, claudeDir);
  assert.equal(d.ownedDir, false);
  const mode = (await fs.stat(path.join(home, 'metadata.json'))).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal((await fs.stat(home)).mode & 0o777, 0o700);
});

test('creating a profile makes a private folder inside profiles/ and persists it', async () => {
  const { pm, home } = await setup();
  const p = await pm.createManagedProfile('Work');
  assert.match(p.id, /^acct-[0-9a-f]{8}$/);
  assert.equal(p.configDir, path.join(home, 'profiles', p.id));
  assert.equal((await fs.stat(p.configDir)).mode & 0o777, 0o700);
  const again = new ProfileManager({ home, defaultConfigDir: pm.profiles[0].configDir, logger: silentLogger });
  await again.load();
  assert.equal(again.find(p.id)?.displayName, 'Work');
  assert.notEqual(p.id, 'Work', 'profile id is not derived from the name');
});

test('names are validated and unique (case-insensitive)', async () => {
  const { pm } = await setup();
  await pm.createManagedProfile('Work');
  await assert.rejects(pm.createManagedProfile('work'), ProfileError);
  await assert.rejects(pm.createManagedProfile('   '), ProfileError);
  await assert.rejects(pm.createManagedProfile('x'.repeat(41)), ProfileError);
  await assert.rejects(pm.createManagedProfile('bad\nname'), ProfileError);
});

test('rename, default and recent list', async () => {
  const { pm } = await setup();
  const a = await pm.createManagedProfile('A');
  const b = await pm.createManagedProfile('B');
  await pm.rename(a.id, 'Alpha');
  assert.equal(pm.find(a.id)?.displayName, 'Alpha');
  await assert.rejects(pm.rename(b.id, 'alpha'), ProfileError);
  await pm.setDefault(b.id);
  assert.equal(pm.metadata.defaultProfileId, b.id);
  await pm.pushRecent(a.id);
  await pm.pushRecent(b.id);
  await pm.pushRecent(a.id);
  assert.deepEqual(pm.metadata.recentProfileIds, [a.id, b.id]);
  await pm.unregister(b.id);
  assert.equal(pm.metadata.defaultProfileId, DEFAULT_PROFILE_ID);
  assert.deepEqual(pm.metadata.recentProfileIds, [a.id]);
});

test('the default profile cannot be removed or deleted', async () => {
  const { pm, claudeDir } = await setup();
  await assert.rejects(pm.unregister(DEFAULT_PROFILE_ID), ProfileError);
  await assert.rejects(pm.deleteOwnedDirectory(pm.profiles[0]), ProfileError);
  assert.equal(await fs.readFile(path.join(claudeDir, 'sentinel'), 'utf8'), 'keep me');
});

test('deleting an owned profile removes only its folder', async () => {
  const { pm, claudeDir } = await setup();
  const p = await pm.createManagedProfile('Temp');
  await fs.writeFile(path.join(p.configDir, 'file'), 'x');
  await pm.deleteOwnedDirectory(p);
  await assert.rejects(fs.stat(p.configDir));
  assert.equal(await fs.readFile(path.join(claudeDir, 'sentinel'), 'utf8'), 'keep me');
});

test('registered external folders are never deletable', async () => {
  const { pm, root } = await setup();
  const ext = path.join(root, 'claude-work');
  await fs.mkdir(ext);
  const p = await pm.registerExistingDirectory(ext, 'External');
  assert.equal(p.ownedDir, false);
  await assert.rejects(pm.deleteOwnedDirectory(p), ProfileError);
  assert.ok((await fs.stat(ext)).isDirectory());
  await assert.rejects(pm.registerExistingDirectory(ext, 'Again'), /already registered/);
});

test('registering the default folder or a missing folder is refused', async () => {
  const { pm, claudeDir, root } = await setup();
  await assert.rejects(pm.registerExistingDirectory(claudeDir, 'Dup'), /default/);
  await assert.rejects(pm.registerExistingDirectory(path.join(root, 'nope'), 'Missing'), /does not exist/);
  await assert.rejects(pm.registerExistingDirectory('relative/path', 'Rel'), /absolute/);
});

test('tampered metadata cannot redirect an owned profile outside profiles/', async () => {
  const { pm, home, claudeDir } = await setup();
  const meta = JSON.parse(await fs.readFile(pm.metadataPath, 'utf8'));
  meta.profiles.push(
    { id: 'acct-deadbeef', displayName: 'Evil', color: 'red', kind: 'managed', configDir: claudeDir, ownedDir: true, createdAt: 1, authState: 'unknown' },
    { id: '../escape', displayName: 'Traversal', color: 'red', kind: 'managed', configDir: '/tmp', ownedDir: true, createdAt: 1, authState: 'unknown' },
    { id: 'acct-00000001', displayName: 'Same as default', color: 'red', kind: 'managed', configDir: claudeDir, ownedDir: false, createdAt: 1, authState: 'unknown' },
  );
  await fs.writeFile(pm.metadataPath, JSON.stringify(meta));
  await pm.load();
  const evil = pm.find('acct-deadbeef');
  assert.ok(evil);
  assert.equal(evil.configDir, path.join(home, 'profiles', 'acct-deadbeef'), 'owned dir derived from id, not from the file');
  assert.equal(pm.find('../escape'), undefined);
  assert.equal(pm.find('acct-00000001'), undefined, 'a second registration of the default folder is dropped');
  await pm.deleteOwnedDirectory(evil); // folder does not exist: a no-op, and certainly not the default folder
  assert.equal(await fs.readFile(path.join(claudeDir, 'sentinel'), 'utf8'), 'keep me');
});

test('a symlinked profile folder is not followed when deleting', async () => {
  const { pm, root } = await setup();
  const p = await pm.createManagedProfile('Linked');
  const victim = path.join(root, 'victim');
  await fs.mkdir(victim);
  await fs.writeFile(path.join(victim, 'data'), 'precious');
  await fs.rm(p.configDir, { recursive: true });
  await fs.symlink(victim, p.configDir);
  await assert.rejects(pm.deleteOwnedDirectory(p), /not a plain directory/);
  assert.equal(await fs.readFile(path.join(victim, 'data'), 'utf8'), 'precious');
});

test('corrupted metadata is backed up and owned profiles are recovered', async () => {
  const { pm, home } = await setup();
  const p = await pm.createManagedProfile('Keep');
  await fs.writeFile(pm.metadataPath, '{ this is not json');
  const fresh = new ProfileManager({ home, defaultConfigDir: pm.profiles[0].configDir, logger: silentLogger });
  await fresh.load();
  assert.ok(fresh.find(p.id), 'profile recovered from its folder');
  assert.ok(fresh.find(DEFAULT_PROFILE_ID));
  const backups = (await fs.readdir(home)).filter((n) => n.startsWith('metadata.json.corrupt-'));
  assert.equal(backups.length, 1);
});

test('identity is stored separately from the profile id and sanitized', async () => {
  const { pm } = await setup();
  const p = await pm.createManagedProfile('Work');
  await pm.recordAuth(p.id, 'authenticated', { email: 'a@example.com', orgId: 'org', subscriptionType: 'max' });
  assert.equal(pm.find(p.id)?.identity?.email, 'a@example.com');
  assert.equal(pm.find(p.id)?.authState, 'authenticated');
  const raw = await fs.readFile(pm.metadataPath, 'utf8');
  assert.doesNotMatch(raw, /token|secret|refresh/i);
});

test('sameLocation treats a symlinked path as the same folder', async () => {
  const { sameLocation } = await import('../../src/utils/filesystem');
  const { root } = await setup();
  const real = path.join(root, 'real');
  await fs.mkdir(real);
  await fs.symlink(real, path.join(root, 'link'));
  assert.equal(await sameLocation(path.join(root, 'link'), real), true);
  assert.equal(await sameLocation(path.join(root, 'link') + '/', real), true);
  assert.equal(await sameLocation(path.join(root, 'nope'), real), false);
});
