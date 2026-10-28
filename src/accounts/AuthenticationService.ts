import * as vscode from 'vscode';
import type { AccountProfile, AuthState } from '../types/account';
import type { Logger } from '../utils/logger';
import { sameLocation } from '../utils/filesystem';
import type { AuthStatus, CLIIntegration } from '../integration/CLIIntegration';
import type { AccountManager } from './AccountManager';
import { identityFromStatus, sameClaudeAccount } from './identity';

export { identityFromStatus, sameClaudeAccount, describePlan } from './identity';

// Sign-in goes through `claude auth login` / `auth status`. We never touch tokens.

export interface AuthCheck {
  state: AuthState;
  status?: AuthStatus;
  error?: string;
}

export class AuthenticationService {
  constructor(
    private readonly cli: CLIIntegration,
    private readonly accounts: AccountManager,
    private readonly logger: Logger,
  ) {}

  async check(profile: AccountProfile): Promise<AuthCheck> {
    const result = await this.cli.authStatus(this.accounts.configDirFor(profile));
    if (!result.ok) {
      this.logger.warn(`Sign-in check for "${profile.displayName}" failed: ${result.error}`);
      return { state: 'error', error: result.error };
    }
    const status = result.status;
    if (status.configDirectory && !(await sameLocation(status.configDirectory, profile.configDir))) {
      const error = 'Claude Code reported a different configuration folder than expected.';
      this.logger.error(`Sign-in check for "${profile.displayName}": ${error}`);
      await this.accounts.profiles.recordAuth(profile.id, 'error');
      return { state: 'error', status, error };
    }
    const state: AuthState = status.loggedIn ? 'authenticated' : 'unauthenticated';
    await this.accounts.profiles.recordAuth(profile.id, state, status.loggedIn ? identityFromStatus(status) : undefined);
    this.logger.info(
      `Sign-in check for "${profile.displayName}": ${status.loggedIn ? `signed in (${status.authMethod ?? 'unknown method'})` : 'not signed in'}`,
    );
    this.accounts.fire();
    return { state, status };
  }

  async checkAll(): Promise<void> {
    for (const profile of this.accounts.list()) {
      await this.check(profile);
    }
  }

  async signIn(profile: AccountProfile): Promise<boolean> {
    const cli = await this.cli.resolve();
    if (!cli) {
      const choice = await vscode.window.showErrorMessage(
        'Claude Code was not found. Install the Claude Code extension or the Claude Code CLI, or set ccshift.claudePath.',
        'Diagnose',
      );
      if (choice === 'Diagnose') {
        void vscode.commands.executeCommand('ccshift.diagnose');
      }
      return false;
    }

    const configDir = this.accounts.configDirFor(profile);
    const terminalOptions: vscode.TerminalOptions = {
      name: `Claude sign-in: ${profile.displayName}`,
      iconPath: new vscode.ThemeIcon('account'),
      isTransient: true,
    };
    if (process.platform === 'win32') {
      terminalOptions.shellPath = cli.path;
      terminalOptions.shellArgs = ['auth', 'login'];
      terminalOptions.env = { CLAUDE_CONFIG_DIR: configDir ?? null };
    } else {
      // `env` receives each value as its own argument: nothing is parsed by a shell.
      // It also overrides any CLAUDE_CONFIG_DIR that terminal settings would add.
      terminalOptions.shellPath = '/usr/bin/env';
      const assignment =
        configDir !== undefined
          ? [`CLAUDE_CONFIG_DIR=${configDir}`]
          : process.env.CLAUDE_CONFIG_DIR !== undefined
            ? [`CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR}`]
            : ['-u', 'CLAUDE_CONFIG_DIR'];
      terminalOptions.shellArgs = [...assignment, cli.path, 'auth', 'login'];
    }

    const terminal = vscode.window.createTerminal(terminalOptions);
    terminal.show();
    this.logger.info(`Started "claude auth login" for "${profile.displayName}"`);

    let closed = false;
    const closeListener = vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) {
        closed = true;
      }
    });

    try {
      const signedIn = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Signing in "${profile.displayName}"`,
          cancellable: true,
        },
        async (progress, token) => {
          progress.report({ message: 'Finish signing in in your browser, then come back here.' });
          // When re-authenticating a profile that still has a working sign-in,
          // only the result after the login process exits counts.
          const waitForExit = profile.authState === 'authenticated';
          const deadline = Date.now() + 15 * 60_000;
          while (!token.isCancellationRequested && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, closed ? 0 : 2500));
            if (waitForExit && !closed) {
              continue;
            }
            const check = await this.check(profile);
            if (check.state === 'authenticated') {
              return true;
            }
            if (closed) {
              return false;
            }
          }
          return false;
        },
      );
      if (signedIn) {
        setTimeout(() => terminal.dispose(), 1500);
        await this.warnIfDuplicate(profile);
        const updated = this.accounts.get(profile.id);
        vscode.window.showInformationMessage(
          `"${profile.displayName}" is signed in${updated?.identity?.email ? ` as ${updated.identity.email}` : ''}.`,
        );
      } else {
        vscode.window.showWarningMessage(
          `"${profile.displayName}" is not signed in yet. Use "ccshift: Reauthenticate" to try again.`,
        );
      }
      return signedIn;
    } finally {
      closeListener.dispose();
    }
  }

  private async warnIfDuplicate(profile: AccountProfile): Promise<void> {
    const updated = this.accounts.get(profile.id);
    const twin = this.accounts
      .list()
      .find((p) => p.id !== profile.id && p.authState === 'authenticated' && sameClaudeAccount(p.identity, updated?.identity));
    if (!twin) {
      return;
    }
    await vscode.window.showWarningMessage(
      `"${profile.displayName}" is signed in to the same Claude account as "${twin.displayName}". They share one set of usage limits.`,
      { modal: true, detail: 'Use "ccshift: Reauthenticate" to sign this profile in to a different account, or remove one of them.' },
    );
  }
}
