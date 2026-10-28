import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { Services } from '../services';
import { DEFAULT_PROFILE_ID, type AccountProfile } from '../types/account';
import { ProfileError, validateDisplayName } from '../accounts/ProfileManager';
import { describePlan } from '../accounts/identity';
import { describeError } from '../utils/logger';
import { tildify } from '../utils/paths';
import { formatPercent, windowView } from '../usage/usageModel';
import { showDiagnostics } from './diagnose';

/** Command ids, also used by package.json. */
export const COMMANDS = {
  addAccount: 'ccshift.addAccount',
  switchAccount: 'ccshift.switchAccount',
  quickToggle: 'ccshift.quickToggle',
  openDashboard: 'ccshift.openDashboard',
  refreshUsage: 'ccshift.refreshUsage',
  renameAccount: 'ccshift.renameAccount',
  removeAccount: 'ccshift.removeAccount',
  setWorkspaceAccount: 'ccshift.setWorkspaceAccount',
  setDefaultAccount: 'ccshift.setDefaultAccount',
  reauthenticate: 'ccshift.reauthenticate',
  diagnose: 'ccshift.diagnose',
  installUsageCollector: 'ccshift.installUsageCollector',
  removeUsageCollector: 'ccshift.removeUsageCollector',
  showLogs: 'ccshift.showLogs',
  cleanUp: 'ccshift.cleanUp',
} as const;

interface AccountPickItem extends vscode.QuickPickItem {
  profileId?: string;
  action?: 'add' | 'dashboard' | 'none';
}

function usageSummary(s: Services, profile: AccountProfile): string {
  const record = s.usage.record(profile.id);
  const now = Date.now();
  const five = windowView(record?.snapshot?.fiveHour, now);
  const seven = windowView(record?.snapshot?.sevenDay, now);
  if (!record?.snapshot) {
    return profile.authState === 'unauthenticated' ? 'not signed in' : 'usage unknown';
  }
  return `5h ${formatPercent(five.percent)} · 7d ${formatPercent(seven.percent)}`;
}

function accountItems(s: Services, filter: (p: AccountProfile) => boolean = () => true): AccountPickItem[] {
  const activeId = s.accounts.activeProfile()?.id;
  const defaultId = s.accounts.defaultProfile().id;
  const workspaceId = s.accounts.workspaceAccount()?.id;
  return s.accounts
    .list()
    .filter(filter)
    .map((p) => {
      const tags: string[] = [];
      if (p.id === defaultId) {
        tags.push('default');
      }
      if (p.id === workspaceId) {
        tags.push('this workspace');
      }
      const plan = describePlan(p.identity);
      return {
        label: `${p.id === activeId ? '$(pass-filled)' : '$(circle-large-outline)'} ${p.displayName}`,
        description: [plan, usageSummary(s, p)].filter(Boolean).join(' · '),
        detail: [p.identity?.email ?? (p.authState === 'unauthenticated' ? 'Not signed in' : tildify(p.configDir)), ...tags].join(' · '),
        profileId: p.id,
      };
    });
}

async function pickAccount(
  s: Services,
  placeHolder: string,
  filter?: (p: AccountProfile) => boolean,
): Promise<AccountProfile | undefined> {
  const items = accountItems(s, filter);
  if (items.length === 0) {
    vscode.window.showInformationMessage('No matching accounts.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true, matchOnDetail: true });
  return pick?.profileId ? s.accounts.get(pick.profileId) : undefined;
}

async function resolveTarget(
  s: Services,
  arg: unknown,
  placeHolder: string,
  filter?: (p: AccountProfile) => boolean,
): Promise<AccountProfile | undefined> {
  if (typeof arg === 'string') {
    const p = s.accounts.get(arg);
    if (p && (!filter || filter(p))) {
      return p;
    }
  }
  return pickAccount(s, placeHolder, filter);
}

async function askName(s: Services, initial?: string, exceptId?: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: 'Account name',
    prompt: 'A label for this account, such as Personal or Work. Only used in VS Code.',
    value: initial,
    validateInput: (value) => {
      const problem = validateDisplayName(value);
      if (problem) {
        return problem;
      }
      const lower = value.trim().toLowerCase();
      return s.accounts.list().some((p) => p.id !== exceptId && p.displayName.toLowerCase() === lower)
        ? 'An account with this name already exists.'
        : undefined;
    },
  });
}

async function addAccount(s: Services): Promise<void> {
  const method = await vscode.window.showQuickPick(
    [
      {
        label: '$(add) Sign in to another Claude account',
        detail: 'Creates a separate Claude Code configuration folder and runs "claude auth login" for it.',
        value: 'new' as const,
      },
      {
        label: '$(folder-opened) Register an existing configuration folder',
        detail: 'For a folder you already use with CLAUDE_CONFIG_DIR, such as ~/.claude-work.',
        value: 'existing' as const,
      },
    ],
    { placeHolder: 'Add a Claude account' },
  );
  if (!method) {
    return;
  }
  const name = await askName(s);
  if (!name) {
    return;
  }
  try {
    if (method.value === 'existing') {
      const folder = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Register Folder',
        title: 'Choose a Claude Code configuration folder',
      });
      if (!folder?.[0]) {
        return;
      }
      const profile = await s.accounts.profiles.registerExistingDirectory(folder[0].fsPath, name);
      s.accounts.fire();
      const check = await s.auth.check(profile);
      if (check.state === 'authenticated') {
        vscode.window.showInformationMessage(`Registered "${profile.displayName}".`);
        void s.usage.refresh(profile.id, { force: true });
      } else {
        const choice = await vscode.window.showWarningMessage(`Registered "${profile.displayName}". It is not signed in.`, 'Sign In');
        if (choice === 'Sign In') {
          await s.auth.signIn(profile);
        }
      }
      return;
    }

    const defaultProfile = s.accounts.get(DEFAULT_PROFILE_ID)!;
    const seed = await vscode.window.showQuickPick(
      [
        { label: 'Start with empty settings', value: false },
        {
          label: `Copy settings.json and CLAUDE.md from "${defaultProfile.displayName}"`,
          detail: 'Copies only these two files. Sign-ins, history and other data are never copied.',
          value: true,
        },
      ],
      { placeHolder: 'Settings for the new account' },
    );
    if (!seed) {
      return;
    }
    const profile = await s.accounts.profiles.createManagedProfile(name);
    if (seed.value) {
      for (const file of ['settings.json', 'CLAUDE.md']) {
        try {
          await fs.copyFile(path.join(defaultProfile.configDir, file), path.join(profile.configDir, file), fs.constants.COPYFILE_EXCL);
        } catch {
          // Missing in the default folder: nothing to copy.
        }
      }
    }
    s.accounts.fire();
    const ok = await s.auth.signIn(profile);
    if (ok) {
      void s.usage.refresh(profile.id, { force: true });
      const choice = await vscode.window.showInformationMessage(`Switch to "${profile.displayName}" now?`, 'Switch', 'Not Now');
      if (choice === 'Switch') {
        await s.switcher.switchTo(profile.id);
      }
    }
  } catch (error) {
    vscode.window.showErrorMessage(error instanceof ProfileError ? error.message : `Could not add the account: ${describeError(error)}`);
  }
}

async function switchAccount(s: Services, arg: unknown): Promise<void> {
  if (typeof arg === 'string' && s.accounts.get(arg)) {
    await s.switcher.switchTo(arg);
    return;
  }
  const items: AccountPickItem[] = accountItems(s);
  const active = s.accounts.active();
  if (active.kind === 'unregistered') {
    items.unshift({
      label: '$(warning) Unregistered folder in use',
      description: tildify(active.configDir),
      action: 'none',
    });
  }
  items.push(
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    { label: '$(add) Add account…', action: 'add' },
    { label: '$(dashboard) Open dashboard', action: 'dashboard' },
  );
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: 'Switch the Claude account used by Claude Code',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) {
    return;
  }
  if (pick.action === 'add') {
    await addAccount(s);
  } else if (pick.action === 'dashboard') {
    await vscode.commands.executeCommand(COMMANDS.openDashboard);
  } else if (pick.profileId) {
    await s.switcher.switchTo(pick.profileId);
  }
}

async function removeAccount(s: Services, arg: unknown): Promise<void> {
  const profile = await resolveTarget(s, arg, 'Remove which account?', (p) => p.kind !== 'default');
  if (!profile) {
    return;
  }
  const buttons = profile.ownedDir ? ['Remove', 'Remove and Delete Folder'] : ['Remove'];
  const choice = await vscode.window.showWarningMessage(
    `Remove "${profile.displayName}"?`,
    {
      modal: true,
      detail: profile.ownedDir
        ? `"Remove" only unregisters it and keeps ${tildify(profile.configDir)}. "Remove and Delete Folder" signs it out with "claude auth logout" and deletes that folder, including its conversation history. Other accounts are not affected.`
        : `This unregisters it. The folder ${tildify(profile.configDir)} was not created by ccshift and is kept.`,
    },
    ...buttons,
  );
  if (!choice) {
    return;
  }
  try {
    if (s.accounts.activeProfile()?.id === profile.id) {
      const preferred = s.accounts.defaultProfile();
      const fallback = preferred.id === profile.id ? s.accounts.get(DEFAULT_PROFILE_ID)! : preferred;
      const result = await s.switcher.switchTo(fallback.id, { allowUnauthenticated: true });
      if (result.outcome !== 'switched') {
        vscode.window.showWarningMessage(`"${profile.displayName}" is still active, so it was not removed.`);
        return;
      }
    }
    if ((await s.collector.status(profile)).kind !== 'not-installed') {
      await s.collector.remove(profile);
    }
    if (choice === 'Remove and Delete Folder') {
      const busy = await s.switcher.confirmAgainstRunningSessions(
        profile.configDir,
        profile.displayName,
        'Deleting the folder while sessions use it would break them. Continue only if they are finished.',
      );
      if (!busy) {
        return;
      }
      // Removes the sign-in from the Keychain entry that belongs to this folder.
      const loggedOut = await s.cli.logout(profile.configDir);
      if (!loggedOut) {
        s.logger.warn(`"claude auth logout" did not succeed for "${profile.displayName}"; its Keychain entry may remain`);
      }
      await s.accounts.profiles.deleteOwnedDirectory(profile);
    }
    await s.accounts.profiles.unregister(profile.id);
    await s.usage.forget(profile.id);
    if (s.accounts.workspaceAccount()?.id === profile.id) {
      await s.accounts.setWorkspaceAccount(undefined);
    }
    s.accounts.fire();
    vscode.window.showInformationMessage(`Removed "${profile.displayName}".`);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not remove "${profile.displayName}": ${describeError(error)}`);
  }
}

async function setWorkspaceAccount(s: Services, arg: unknown): Promise<void> {
  if (!vscode.workspace.workspaceFolders?.length && !vscode.workspace.workspaceFile) {
    vscode.window.showInformationMessage('Open a folder or workspace first.');
    return;
  }
  let profile: AccountProfile | undefined;
  if (typeof arg === 'string') {
    profile = s.accounts.get(arg);
  } else {
    const items: AccountPickItem[] = [
      { label: '$(close) No workspace account', detail: 'Use whichever account is active.', action: 'none' },
      ...accountItems(s),
    ];
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Account for this workspace' });
    if (!pick) {
      return;
    }
    if (pick.action === 'none') {
      await s.accounts.setWorkspaceAccount(undefined);
      vscode.window.showInformationMessage('This workspace no longer has its own account.');
      return;
    }
    profile = pick.profileId ? s.accounts.get(pick.profileId) : undefined;
  }
  if (!profile) {
    return;
  }
  await s.accounts.setWorkspaceAccount(profile.id);
  if (s.accounts.activeProfile()?.id !== profile.id) {
    const choice = await vscode.window.showInformationMessage(
      `"${profile.displayName}" is now this workspace's account. Terminals here use it. Switch the Claude Code panel to it too? (The panel's account applies to all windows.)`,
      'Switch',
      'Not Now',
    );
    if (choice === 'Switch') {
      await s.switcher.switchTo(profile.id);
    }
  } else {
    vscode.window.showInformationMessage(`"${profile.displayName}" is now this workspace's account.`);
  }
}

async function collectorCommand(s: Services, arg: unknown, install: boolean): Promise<void> {
  const profile = await resolveTarget(s, arg, install ? 'Install the usage collector for which account?' : 'Remove the usage collector from which account?');
  if (!profile) {
    return;
  }
  const settingsFile = tildify(path.join(profile.configDir, 'settings.json'));
  try {
    if (!install) {
      const restored = await s.collector.remove(profile);
      vscode.window.showInformationMessage(
        restored
          ? `Removed the usage collector from "${profile.displayName}" and restored its previous status line.`
          : `"${profile.displayName}" was not using the collector; ${settingsFile} was left unchanged.`,
      );
      return;
    }
    const status = await s.collector.status(profile);
    if (status.kind === 'installed') {
      vscode.window.showInformationMessage(`The usage collector is already installed for "${profile.displayName}".`);
      return;
    }
    if (status.kind === 'settings-unreadable') {
      vscode.window.showErrorMessage(`${settingsFile} is not valid JSON (${status.error}). Fix it first; nothing was changed.`);
      return;
    }
    const existing = await s.collector.describeExisting(profile);
    const detail = [
      `This sets "statusLine" in ${settingsFile}.`,
      existing
        ? `Your current status line (${existing}) is kept: it still runs and prints the same output. Removing the collector restores it exactly.`
        : 'There is no status line yet; Claude Code will show the account name in its place.',
      'Status lines run in terminal Claude Code sessions, not in the VS Code chat panel. The collector copies the status-line data (which includes rate limits) to ccshift.',
      profile.kind === 'default' ? 'This is your original ~/.claude configuration.' : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    const choice = await vscode.window.showWarningMessage(
      `Install the usage collector for "${profile.displayName}"?`,
      { modal: true, detail },
      'Install',
    );
    if (choice !== 'Install') {
      return;
    }
    await s.collector.install(profile);
    vscode.window.showInformationMessage(`Usage collector installed for "${profile.displayName}".`);
  } catch (error) {
    vscode.window.showErrorMessage(`Usage collector: ${describeError(error)}`);
  }
}

async function cleanUp(s: Services): Promise<void> {
  const picks = await vscode.window.showQuickPick(
    [
      {
        label: 'Return Claude Code to the default account',
        detail: 'Removes CLAUDE_CONFIG_DIR from claudeCode.environmentVariables.',
        id: 'reset',
        picked: true,
      },
      {
        label: 'Remove usage collectors from all accounts',
        detail: 'Restores each account\'s previous status line.',
        id: 'collectors',
        picked: true,
      },
      {
        label: 'Forget usage data',
        detail: `Deletes ${tildify(path.join(s.home, 'usage-cache.json'))}.`,
        id: 'cache',
      },
    ],
    { canPickMany: true, placeHolder: 'Prepare for uninstalling. Account folders and sign-ins are kept.' },
  );
  if (!picks?.length) {
    return;
  }
  const ids = new Set(picks.map((p) => p.id));
  if (ids.has('reset') && s.accounts.environment.read().configDir !== undefined) {
    await s.switcher.switchTo(DEFAULT_PROFILE_ID, { allowUnauthenticated: true });
  }
  if (ids.has('collectors')) {
    for (const p of s.accounts.list()) {
      if ((await s.collector.status(p)).kind !== 'not-installed') {
        await s.collector.remove(p);
      }
    }
  }
  if (ids.has('cache')) {
    for (const p of s.accounts.list()) {
      await s.usage.forget(p.id);
    }
  }
  vscode.window.showInformationMessage(
    `Done. Account folders under ${tildify(path.join(s.home, 'profiles'))} were kept; delete them yourself if you no longer need them.`,
  );
}

export function registerCommands(s: Services): vscode.Disposable[] {
  const reg = (id: string, fn: (...args: unknown[]) => unknown): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await fn(...args);
      } catch (error) {
        s.logger.error(`Command ${id} failed`, error);
        vscode.window.showErrorMessage(`ccshift: ${describeError(error)}`);
      }
    });

  return [
    reg(COMMANDS.addAccount, () => addAccount(s)),
    reg(COMMANDS.switchAccount, (arg) => switchAccount(s, arg)),
    reg(COMMANDS.quickToggle, async () => {
      const target = s.accounts.toggleTarget();
      if (!target) {
        vscode.window.showInformationMessage('Add a second account to use Quick Toggle.');
        return;
      }
      await s.switcher.switchTo(target.id);
    }),
    reg(COMMANDS.openDashboard, () => vscode.commands.executeCommand('ccshift.dashboard.focus')),
    reg(COMMANDS.refreshUsage, async (arg) => {
      const one = typeof arg === 'string' ? s.accounts.get(arg) : undefined;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: 'Refreshing Claude usage' },
        () => (one ? s.usage.refresh(one.id, { force: true }) : s.usage.refreshAll({ force: true })),
      );
    }),
    reg(COMMANDS.renameAccount, async (arg) => {
      const profile = await resolveTarget(s, arg, 'Rename which account?');
      if (!profile) {
        return;
      }
      const name = await askName(s, profile.displayName, profile.id);
      if (name) {
        await s.accounts.profiles.rename(profile.id, name);
        s.accounts.fire();
      }
    }),
    reg(COMMANDS.removeAccount, (arg) => removeAccount(s, arg)),
    reg(COMMANDS.setWorkspaceAccount, (arg) => setWorkspaceAccount(s, arg)),
    reg(COMMANDS.setDefaultAccount, async (arg) => {
      const profile = await resolveTarget(s, arg, 'Default account (used as the fallback, for example after removing the active account)');
      if (profile) {
        await s.accounts.profiles.setDefault(profile.id);
        s.accounts.fire();
        vscode.window.showInformationMessage(`"${profile.displayName}" is now the default account.`);
      }
    }),
    reg(COMMANDS.reauthenticate, async (arg) => {
      const profile = await resolveTarget(s, arg, 'Sign in again with which account?');
      if (profile && (await s.auth.signIn(profile))) {
        void s.usage.refresh(profile.id, { force: true });
      }
    }),
    reg(COMMANDS.diagnose, () => showDiagnostics(s)),
    reg(COMMANDS.installUsageCollector, (arg) => collectorCommand(s, arg, true)),
    reg(COMMANDS.removeUsageCollector, (arg) => collectorCommand(s, arg, false)),
    reg(COMMANDS.showLogs, () => s.logger.show()),
    reg(COMMANDS.cleanUp, () => cleanUp(s)),
  ];
}
