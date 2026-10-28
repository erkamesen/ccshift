import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { CcshiftApi } from '../../../src/extension';
import { DEFAULT_PROFILE_ID } from '../../../src/types/account';

type Case = { name: string; fn: () => Promise<void> };
const cases: Case[] = [];
const it = (name: string, fn: () => Promise<void>): void => {
  cases.push({ name, fn });
};

const EXPECT_CLAUDE_CODE = process.env.CAM_IT_EXPECT_CLAUDE_CODE === '1';
let api: CcshiftApi;
let profileA = '';
let profileB = '';

function envSetting(): unknown {
  return vscode.workspace.getConfiguration('claudeCode').inspect('environmentVariables')?.globalValue;
}

function configDirInSetting(): string | undefined {
  const v = envSetting();
  if (!Array.isArray(v)) {
    return undefined;
  }
  return (v as { name: string; value: string }[]).find((e) => e.name === 'CLAUDE_CONFIG_DIR')?.value;
}

it('activates and exposes its services', async () => {
  const ext = vscode.extensions.all.find((e) => e.packageJSON?.name === 'ccshift');
  assert.ok(ext, 'extension under test is loaded');
  api = (await ext.activate()) as CcshiftApi;
  assert.ok(api?.services);
  const home = process.env.CCSHIFT_HOME!;
  assert.equal(api.services.home, home, 'uses the isolated data folder');
  const def = api.services.accounts.get(DEFAULT_PROFILE_ID);
  assert.equal(def?.configDir, process.env.CLAUDE_CONFIG_DIR, 'default profile = editor CLAUDE_CONFIG_DIR (isolated)');
});

it('registers every documented command', async () => {
  const all = await vscode.commands.getCommands(true);
  for (const id of [
    'addAccount',
    'switchAccount',
    'quickToggle',
    'openDashboard',
    'refreshUsage',
    'renameAccount',
    'removeAccount',
    'setWorkspaceAccount',
    'setDefaultAccount',
    'reauthenticate',
    'diagnose',
  ]) {
    assert.ok(all.includes(`ccshift.${id}`), `missing command ccshift.${id}`);
  }
});

it('finds the Claude Code extension and its bundled CLI', async () => {
  const s = api.services;
  if (!EXPECT_CLAUDE_CODE) {
    return;
  }
  assert.ok(s.claudeCode.isInstalled(), 'anthropic.claude-code installed in the test profile');
  await s.claudeCode.extension()!.activate();
  const cli = await s.cli.resolve();
  assert.ok(cli, 'CLI resolved');
  assert.equal(cli.source, 'claude-code-extension');
  // Give its configuration watchers a moment to start.
  await new Promise((r) => setTimeout(r, 3000));
});

it('creates two isolated profiles', async () => {
  const s = api.services;
  profileA = (await s.accounts.profiles.createManagedProfile('Integration A')).id;
  profileB = (await s.accounts.profiles.createManagedProfile('Integration B')).id;
  const a = s.accounts.get(profileA)!;
  assert.ok(a.configDir.startsWith(s.home));
  assert.notEqual(s.accounts.get(profileA)!.configDir, s.accounts.get(profileB)!.configDir);
});

it('switches to profile A, keeps other environment variables, and verifies the switch', async () => {
  const s = api.services;
  await vscode.workspace
    .getConfiguration('claudeCode')
    .update('environmentVariables', [{ name: 'KEEP_ME', value: 'yes' }], vscode.ConfigurationTarget.Global);
  const result = await s.switcher.switchTo(profileA, { skipConfirmations: true, allowUnauthenticated: true, notify: false });
  assert.equal(result.outcome, 'switched', result.message);
  assert.equal(result.settingApplied, true);
  assert.equal(configDirInSetting(), s.accounts.get(profileA)!.configDir);
  assert.deepEqual((envSetting() as { name: string }[]).map((e) => e.name), ['KEEP_ME', 'CLAUDE_CONFIG_DIR']);
  assert.equal(s.accounts.activeProfile()?.id, profileA);
  if (EXPECT_CLAUDE_CODE) {
    assert.equal(result.cliVerified, true, 'claude auth status saw the profile folder');
    assert.equal(result.signedIn, false, 'fresh profile is not signed in');
    assert.equal(result.acknowledgement, 'acknowledged', 'Claude Code extension followed the change');
  }
});

it('applies the account to integrated terminals', async () => {
  const s = api.services;
  const mutator = s.context.environmentVariableCollection.get('CLAUDE_CONFIG_DIR');
  assert.equal(mutator?.value, s.accounts.get(profileA)!.configDir);
});

it('switches A -> B -> A without touching either profile folder', async () => {
  const s = api.services;
  const marker = path.join(s.accounts.get(profileA)!.configDir, 'marker');
  await fs.writeFile(marker, 'a');
  const toB = await s.switcher.switchTo(profileB, { skipConfirmations: true, allowUnauthenticated: true, notify: false });
  assert.equal(toB.outcome, 'switched', toB.message);
  assert.equal(configDirInSetting(), s.accounts.get(profileB)!.configDir);
  if (EXPECT_CLAUDE_CODE) {
    assert.equal(toB.acknowledgement, 'acknowledged');
  }
  assert.equal(s.accounts.toggleTarget()?.id, profileA, 'quick toggle targets the previous account');
  const back = await s.switcher.switchTo(profileA, { skipConfirmations: true, allowUnauthenticated: true, notify: false });
  assert.equal(back.outcome, 'switched');
  assert.equal(await fs.readFile(marker, 'utf8'), 'a');
});

it('returns to the default account by removing the override', async () => {
  const s = api.services;
  const r = await s.switcher.switchTo(DEFAULT_PROFILE_ID, { skipConfirmations: true, allowUnauthenticated: true, notify: false });
  assert.equal(r.outcome, 'switched', r.message);
  assert.equal(configDirInSetting(), undefined, 'CLAUDE_CONFIG_DIR removed, not set to the default folder');
  assert.deepEqual(envSetting(), [{ name: 'KEEP_ME', value: 'yes' }]);
  assert.equal(s.accounts.activeProfile()?.id, DEFAULT_PROFILE_ID);
  if (EXPECT_CLAUDE_CODE) {
    assert.equal(r.cliVerified, true);
    assert.equal(r.acknowledgement, 'acknowledged');
  }
});

it('refuses an unauthenticated target unless allowed', async () => {
  const s = api.services;
  if (!EXPECT_CLAUDE_CODE) {
    return;
  }
  const r = await s.switcher.switchTo(profileB, { skipConfirmations: true, notify: false });
  assert.equal(r.outcome, 'cancelled');
  assert.equal(configDirInSetting(), undefined, 'nothing changed');
});

it('reports usage for a signed-out profile as sign-in required, not 0%', async () => {
  const s = api.services;
  if (!EXPECT_CLAUDE_CODE) {
    return;
  }
  await s.usage.refresh(profileB, { force: true });
  const record = s.usage.record(profileB);
  assert.equal(record?.snapshot, undefined);
  assert.equal(record?.lastError?.kind, 'auth');
});

it('produces a diagnostics report', async () => {
  const { buildDiagnostics } = await import('../../../src/commands/diagnose');
  const report = await buildDiagnostics(api.services);
  assert.match(report, /## Accounts/);
  assert.match(report, /Integration A/);
  assert.doesNotMatch(report, /accessToken|refreshToken/i);
});

it('removes a profile and deletes only its own folder', async () => {
  const s = api.services;
  const dir = s.accounts.get(profileB)!.configDir;
  await s.accounts.profiles.deleteOwnedDirectory(s.accounts.get(profileB)!);
  await s.accounts.profiles.unregister(profileB);
  await assert.rejects(fs.stat(dir));
  assert.ok((await fs.stat(process.env.CLAUDE_CONFIG_DIR!)).isDirectory(), 'default folder untouched');
});

export async function run(): Promise<void> {
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`  ✔ ${c.name}`);
    } catch (error) {
      failed++;
      console.error(`  ✘ ${c.name}\n    ${(error as Error).stack ?? error}`);
    }
  }
  console.log(`\n${cases.length - failed}/${cases.length} integration tests passed`);
  await vscode.workspace
    .getConfiguration('claudeCode')
    .update('environmentVariables', undefined, vscode.ConfigurationTarget.Global)
    .then(undefined, () => undefined);
  if (failed > 0) {
    throw new Error(`${failed} integration test(s) failed`);
  }
}
