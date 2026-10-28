import * as vscode from 'vscode';
import * as path from 'path';
import { OutputLogger } from './utils/logger';
import { defaultClaudeConfigDir, managerHome, tildify } from './utils/paths';
import { ProfileManager } from './accounts/ProfileManager';
import { AccountManager } from './accounts/AccountManager';
import { AuthenticationService } from './accounts/AuthenticationService';
import { AccountSwitcher } from './accounts/AccountSwitcher';
import { EnvironmentManager } from './integration/EnvironmentManager';
import { ClaudeCodeIntegration } from './integration/ClaudeCodeIntegration';
import { CLIIntegration } from './integration/CLIIntegration';
import { readLiveSessions } from './integration/SessionRegistry';
import { UsageCache } from './usage/UsageCache';
import { UsageService } from './usage/UsageService';
import { StatusLineCollector } from './usage/StatusLineCollector';
import { recommend, recommendationKey } from './usage/recommendation';
import { formatPercent } from './usage/usageModel';
import { formatAgo } from './utils/time';
import { StatusBarManager } from './ui/StatusBarManager';
import { DashboardProvider, type DashboardState } from './ui/DashboardProvider';
import { buildAccountView, type AccountView } from './ui/viewModel';
import { COMMANDS, registerCommands } from './commands/registerCommands';
import type { Services } from './services';

const SHOWN_RECOMMENDATIONS_KEY = 'ccshift.shownRecommendations';

function cfg<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('ccshift').get<T>(key, fallback);
}

function thresholds(): { warning: number; critical: number } {
  const warning = Math.min(100, Math.max(1, cfg('recommendations.warningThreshold', 80)));
  const critical = Math.min(100, Math.max(warning, cfg('recommendations.criticalThreshold', 95)));
  return { warning, critical };
}

/** Returned for the integration tests. */
export interface CcshiftApi {
  services: Services;
}

export async function activate(context: vscode.ExtensionContext): Promise<CcshiftApi> {
  const logger = new OutputLogger('ccshift');
  context.subscriptions.push(logger);

  const home = managerHome();
  const defaultDir = defaultClaudeConfigDir();
  const profiles = new ProfileManager({ home, defaultConfigDir: defaultDir, logger });
  const environment = new EnvironmentManager();
  const accounts = new AccountManager(profiles, environment, context, logger);
  await accounts.initialize();
  context.subscriptions.push(accounts);

  const claudeCode = new ClaudeCodeIntegration(context, logger);
  const cli = new CLIIntegration({
    configuredPath: () => cfg<string>('claudePath', ''),
    bundledCandidates: () => claudeCode.bundledCliCandidates(),
    extraEnv: () => environment.extraEntries(),
    probeCwd: path.join(home, 'probe'),
    logger,
  });
  const auth = new AuthenticationService(cli, accounts, logger);
  const collector = new StatusLineCollector(home);
  const usage = new UsageService(
    new UsageCache(path.join(home, 'usage-cache.json'), logger),
    cli,
    accounts,
    auth,
    collector.inboxDir,
    { autoRefreshMinutes: () => Math.max(0, cfg('usage.autoRefreshMinutes', 15)) },
    logger,
  );
  context.subscriptions.push(usage);

  const switcher = new AccountSwitcher(accounts, auth, cli, claudeCode, logger, (profile) => {
    void usage.refresh(profile.id, { force: true });
  });

  const statusBar = new StatusBarManager();
  context.subscriptions.push(statusBar);

  // ----- rendering -----

  const viewFor = (profileId: string, now: number): AccountView | undefined => {
    const profile = accounts.get(profileId);
    if (!profile) {
      return undefined;
    }
    const t = thresholds();
    return buildAccountView(profile, {
      activeId: accounts.activeProfile()?.id,
      defaultId: accounts.defaultProfile().id,
      workspaceId: accounts.workspaceAccount()?.id,
      record: usage.record(profile.id),
      refreshing: usage.isRefreshing(profile.id),
      now,
      warningThreshold: t.warning,
      criticalThreshold: t.critical,
      freshness: { liveMs: 2 * 60_000, staleMs: Math.max(1, cfg('usage.staleAfterMinutes', 30)) * 60_000 },
    });
  };

  const buildState = (): DashboardState => {
    const now = Date.now();
    const notices: DashboardState['notices'] = [];
    const active = accounts.active();
    if (active.kind === 'unregistered') {
      notices.push({
        level: 'warning',
        text: `Claude Code is set to use ${tildify(active.configDir)}, which is not a registered account. Switch to an account to fix this.`,
      });
    }
    if (!claudeCode.isInstalled()) {
      notices.push({
        level: 'info',
        text: 'The Claude Code extension is not installed. Switching applies to terminals and the Claude Code CLI.',
      });
    }
    if (claudeCode.processWrapper()) {
      notices.push({
        level: 'warning',
        text: 'claudeCode.claudeProcessWrapper is set. Switching is applied, but the wrapper decides how Claude starts, so it cannot be fully verified.',
      });
    }
    const ws = accounts.workspaceAccount();
    const activeProfile = accounts.activeProfile();
    if (ws && activeProfile && ws.id !== activeProfile.id) {
      notices.push({
        level: 'info',
        text: `This workspace's account is "${ws.displayName}" (used by terminals here). The Claude Code panel uses "${activeProfile.displayName}".`,
      });
    }
    const views = accounts
      .list()
      .map((p) => viewFor(p.id, now))
      .filter((v): v is AccountView => v !== undefined)
      .sort((a, b) => Number(b.isActive) - Number(a.isActive));
    return { accounts: views, notices, workspaceName: vscode.workspace.name };
  };

  const applyTerminalEnvironment = (): void => {
    const collection = context.environmentVariableCollection;
    if (!cfg('terminal.applyAccount', true)) {
      collection.clear();
      return;
    }
    const target =
      (cfg('terminal.followWorkspaceAccount', true) ? accounts.workspaceAccount() : undefined) ?? accounts.activeProfile();
    if (!target) {
      collection.clear();
      return;
    }
    const dir = accounts.configDirFor(target);
    collection.description = `Claude account: ${target.displayName}`;
    if (dir === undefined) {
      collection.delete('CLAUDE_CONFIG_DIR');
    } else {
      collection.replace('CLAUDE_CONFIG_DIR', dir);
    }
  };

  let dashboard: DashboardProvider | undefined;
  const render = (): void => {
    const now = Date.now();
    const active = accounts.active();
    statusBar.update(
      active.kind === 'profile' ? viewFor(active.profile.id, now) : undefined,
      active.kind === 'unregistered' ? active.configDir : undefined,
      cfg('statusBar.enabled', true),
    );
    void vscode.commands.executeCommand('setContext', 'ccshift.hasMultipleAccounts', accounts.list().length > 1);
    dashboard?.refresh();
    applyTerminalEnvironment();
  };

  const services: Services = {
    context,
    logger,
    home,
    accounts,
    auth,
    switcher,
    cli,
    claudeCode,
    usage,
    collector,
    render,
  };

  dashboard = new DashboardProvider(context.extensionUri, buildState, (action, id) => {
    const commandFor: Record<string, string> = {
      switch: COMMANDS.switchAccount,
      refresh: COMMANDS.refreshUsage,
      refreshAll: COMMANDS.refreshUsage,
      add: COMMANDS.addAccount,
      rename: COMMANDS.renameAccount,
      reauth: COMMANDS.reauthenticate,
      remove: COMMANDS.removeAccount,
      setDefault: COMMANDS.setDefaultAccount,
      setWorkspace: COMMANDS.setWorkspaceAccount,
      diagnose: COMMANDS.diagnose,
      collector: '',
    };
    if (action === 'collector' && id) {
      void (async () => {
        const status = await collector.status(accounts.get(id)!);
        await vscode.commands.executeCommand(
          status.kind === 'installed' ? COMMANDS.removeUsageCollector : COMMANDS.installUsageCollector,
          id,
        );
      })();
      return;
    }
    const command = commandFor[action];
    if (command) {
      void vscode.commands.executeCommand(command, action === 'refreshAll' ? undefined : id);
    }
  });
  context.subscriptions.push(
    dashboard,
    vscode.window.registerWebviewViewProvider(DashboardProvider.viewId, dashboard, {
      webviewOptions: { retainContextWhenHidden: false },
    }),
  );

  context.subscriptions.push(...registerCommands(services));

  // ----- recommendations -----

  const maybeRecommend = async (): Promise<void> => {
    if (!cfg('recommendations.enabled', true)) {
      return;
    }
    const active = accounts.activeProfile();
    if (!active) {
      return;
    }
    const t = thresholds();
    const now = Date.now();
    const rec = recommend(
      active,
      accounts.list(),
      (id) => usage.record(id),
      {
        warningThreshold: t.warning,
        criticalThreshold: t.critical,
        maxDataAgeMs: Math.max(1, cfg('recommendations.maxDataAgeMinutes', 30)) * 60_000,
      },
      now,
    );
    if (!rec) {
      return;
    }
    const key = recommendationKey(active.id, rec);
    const shown = context.globalState.get<string[]>(SHOWN_RECOMMENDATIONS_KEY, []);
    if (shown.includes(key)) {
      return;
    }
    await context.globalState.update(SHOWN_RECOMMENDATIONS_KEY, [key, ...shown].slice(0, 50));
    const windowName = rec.window === 'fiveHour' ? '5-hour' : 'weekly';
    const head = `"${active.displayName}" has used ${formatPercent(rec.activePercent)} of its ${windowName} limit.`;
    if (!rec.candidate) {
      if (rec.level === 'critical') {
        void vscode.window.showWarningMessage(`${head} No other signed-in account has recent usage data showing room to spare.`);
      }
      return;
    }
    const c = rec.candidate;
    const message =
      `${head} "${c.profile.displayName}" was at ${formatPercent(c.fiveHourPercent)} (5-hour) and ${formatPercent(c.sevenDayPercent)} (weekly) ` +
      `as of ${formatAgo(c.observedAt, now)}. That may have changed. Switch? Running sessions keep their current account.`;
    const show = rec.level === 'critical' ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
    const choice = await show(message, `Switch to ${c.profile.displayName}`, 'Dismiss', "Don't Show Again");
    if (choice === `Switch to ${c.profile.displayName}`) {
      await switcher.switchTo(c.profile.id);
    } else if (choice === "Don't Show Again") {
      await vscode.workspace.getConfiguration('ccshift').update('recommendations.enabled', false, vscode.ConfigurationTarget.Global);
    }
  };

  // ----- events -----

  context.subscriptions.push(
    accounts.onDidChange(render),
    usage.onDidChange((id) => {
      render();
      if (id === undefined || id === accounts.activeProfile()?.id) {
        void maybeRecommend();
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ccshift')) {
        cli.invalidate();
        render();
      }
    }),
    vscode.extensions.onDidChange(() => {
      cli.invalidate();
      render();
    }),
  );

  render();
  await usage.start();

  // Background start-up work: check sign-ins, then honour the workspace account.
  setTimeout(() => {
    void (async () => {
      try {
        await auth.checkAll();
        await applyWorkspaceAccountOnOpen(services);
      } catch (error) {
        logger.error('Start-up checks failed', error);
      }
    })();
  }, 1500);

  logger.info(`Activated. Data folder: ${tildify(home)}. Default configuration: ${tildify(defaultDir)}`);
  return { services };
}

async function applyWorkspaceAccountOnOpen(s: Services): Promise<void> {
  const ws = s.accounts.workspaceAccount();
  const active = s.accounts.activeProfile();
  if (!ws || active?.id === ws.id) {
    return;
  }
  const mode = cfg<'ask' | 'always' | 'never'>('workspaceAccount.applyOnOpen', 'ask');
  if (mode === 'never') {
    return;
  }
  if (mode === 'always') {
    const running = await readLiveSessions(s.accounts.activeConfigDir());
    if (running.sessions.length === 0 && ws.authState === 'authenticated') {
      await s.switcher.switchTo(ws.id, { skipConfirmations: true });
      return;
    }
  }
  const current = active?.displayName ?? 'an unregistered folder';
  const choice = await vscode.window.showInformationMessage(
    `This workspace uses the Claude account "${ws.displayName}", but Claude Code is set to "${current}". Switch? (This applies to all windows.)`,
    'Switch',
    'Not Now',
  );
  if (choice === 'Switch') {
    await s.switcher.switchTo(ws.id);
  }
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
