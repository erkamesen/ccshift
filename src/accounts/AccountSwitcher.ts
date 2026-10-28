import * as vscode from 'vscode';
import type { AccountProfile } from '../types/account';
import type { Logger } from '../utils/logger';
import { describeError } from '../utils/logger';
import { samePath, sameLocation } from '../utils/filesystem';
import type { CLIIntegration } from '../integration/CLIIntegration';
import type { Acknowledgement, ClaudeCodeIntegration } from '../integration/ClaudeCodeIntegration';
import { readLiveSessions, summarizeSessions } from '../integration/SessionRegistry';
import type { AccountManager } from './AccountManager';
import type { AuthenticationService } from './AuthenticationService';
import { identityFromStatus, sameClaudeAccount } from './identity';

/**
 * Switch = change CLAUDE_CONFIG_DIR in the setting, then check:
 * setting reads back, `claude auth status` sees the right dir, and Claude Code
 * logs that it picked it up. Running sessions are left alone.
 */

export interface SwitchOptions {
  skipConfirmations?: boolean;
  allowUnauthenticated?: boolean;
  notify?: boolean;
}

export interface SwitchResult {
  outcome: 'switched' | 'already-active' | 'cancelled' | 'failed';
  profileId: string;
  settingApplied: boolean;
  cliVerified?: boolean;
  signedIn?: boolean;
  acknowledgement?: Acknowledgement | 'not-installed' | 'unchanged';
  message: string;
}

export class AccountSwitcher {
  private switching = false;

  constructor(
    private readonly accounts: AccountManager,
    private readonly auth: AuthenticationService,
    private readonly cli: CLIIntegration,
    private readonly claudeCode: ClaudeCodeIntegration,
    private readonly logger: Logger,
    private readonly afterSwitch: (profile: AccountProfile) => void,
  ) {}

  async confirmAgainstRunningSessions(configDir: string, accountName: string, consequence: string): Promise<boolean> {
    const scan = await readLiveSessions(configDir);
    const { total, busy } = summarizeSessions(scan);
    if (total === 0) {
      return true;
    }
    const working = busy > 0 ? ` ${busy} of them ${busy === 1 ? 'is' : 'are'} working right now.` : '';
    const choice = await vscode.window.showWarningMessage(
      `${total} Claude Code session${total === 1 ? ' is' : 's are'} running on "${accountName}".${working}`,
      { modal: true, detail: consequence },
      'Continue',
    );
    return choice === 'Continue';
  }

  async switchTo(profileId: string, options: SwitchOptions = {}): Promise<SwitchResult> {
    if (this.switching) {
      return this.result('cancelled', profileId, false, 'Another switch is in progress.');
    }
    this.switching = true;
    try {
      return await this.doSwitch(profileId, options);
    } catch (error) {
      this.logger.error('Account switch failed', error);
      const r = this.result('failed', profileId, false, `Switch failed: ${describeError(error)}`);
      if (options.notify !== false) {
        vscode.window.showErrorMessage(r.message);
      }
      return r;
    } finally {
      this.switching = false;
    }
  }

  private result(
    outcome: SwitchResult['outcome'],
    profileId: string,
    settingApplied: boolean,
    message: string,
    extra: Partial<SwitchResult> = {},
  ): SwitchResult {
    return { outcome, profileId, settingApplied, message, ...extra };
  }

  private async doSwitch(profileId: string, options: SwitchOptions): Promise<SwitchResult> {
    const notify = options.notify !== false;
    await this.accounts.profiles.load();
    const target = this.accounts.get(profileId);
    if (!target) {
      return this.result('failed', profileId, false, 'That account is no longer registered.');
    }
    const previousSelection = this.accounts.active();
    const previousName =
      previousSelection.kind === 'profile' ? previousSelection.profile.displayName : 'the current configuration';
    const previousDir = this.accounts.activeConfigDir();
    const previousSetting = this.accounts.environment.read().configDir;
    const targetSetting = this.accounts.configDirFor(target);

    if (previousSelection.kind === 'profile' && previousSelection.profile.id === target.id) {
      if (notify) {
        vscode.window.showInformationMessage(`"${target.displayName}" is already the active Claude account.`);
      }
      await this.accounts.profiles.pushRecent(target.id);
      return this.result('already-active', target.id, true, `"${target.displayName}" is already active.`, {
        acknowledgement: 'unchanged',
      });
    }

    // 1. Is the target signed in? Checked before anything changes.
    const pre = await this.auth.check(target);
    if (pre.state === 'unauthenticated' && !options.allowUnauthenticated) {
      if (options.skipConfirmations) {
        return this.result('cancelled', target.id, false, `"${target.displayName}" is not signed in.`);
      }
      const choice = await vscode.window.showWarningMessage(
        `"${target.displayName}" is not signed in to Claude.`,
        { modal: true, detail: 'Sign in now? Claude Code opens your browser. The current account stays active until sign-in finishes.' },
        'Sign In',
        'Switch Anyway',
      );
      if (choice === 'Sign In') {
        const ok = await this.auth.signIn(target);
        if (!ok) {
          return this.result('cancelled', target.id, false, 'Sign-in did not finish.');
        }
      } else if (choice !== 'Switch Anyway') {
        return this.result('cancelled', target.id, false, 'Cancelled.');
      }
    }
    const expectedIdentity = this.accounts.get(target.id)?.identity;

    // 2. Running sessions keep running; make sure that is understood.
    if (!options.skipConfirmations) {
      const proceed = await this.confirmAgainstRunningSessions(
        previousDir,
        previousName,
        `Nothing is stopped. Sessions that are already running keep using "${previousName}" until they end. ` +
          `Claude Code refreshes its panels, and new conversations use "${target.displayName}". ` +
          `Conversations from "${previousName}" are not copied and will not appear in "${target.displayName}"'s history.`,
      );
      if (!proceed) {
        return this.result('cancelled', target.id, false, 'Cancelled.');
      }
    }

    // 3. Apply.
    const installed = this.claudeCode.isInstalled();
    const watch = installed ? await this.claudeCode.beginAcknowledgementWatch() : undefined;
    await this.accounts.environment.writeConfigDir(targetSetting);

    // 4a. The setting reads back as written.
    const after = this.accounts.environment.read();
    const settingApplied =
      targetSetting === undefined ? after.configDir === undefined : after.configDir !== undefined && samePath(after.configDir, targetSetting);
    if (!settingApplied) {
      await this.accounts.environment.writeConfigDir(previousSetting).catch(() => undefined);
      const message = `Could not switch to "${target.displayName}": the setting did not take effect. ${after.issues.join(' ')}`.trim();
      if (notify) {
        vscode.window.showErrorMessage(message);
      }
      return this.result('failed', target.id, false, message);
    }

    // 4b. The CLI, launched the way the official extension launches it, sees the right folder.
    const post = await this.cli.authStatus(after.configDir);
    let cliVerified: boolean | undefined;
    let signedIn: boolean | undefined;
    if (post.ok) {
      cliVerified =
        post.status.configDirectory === undefined ? undefined : await sameLocation(post.status.configDirectory, target.configDir);
      signedIn = post.status.loggedIn;
      if (cliVerified === false) {
        await this.accounts.environment.writeConfigDir(previousSetting);
        const message = `Switch to "${target.displayName}" was rolled back: Claude Code resolved a different configuration folder.`;
        this.logger.error(message);
        if (notify) {
          vscode.window.showErrorMessage(message);
        }
        return this.result('failed', target.id, false, message, { cliVerified });
      }
      await this.accounts.profiles.recordAuth(
        target.id,
        signedIn ? 'authenticated' : 'unauthenticated',
        signedIn ? identityFromStatus(post.status) : undefined,
      );
    } else {
      this.logger.warn(`Could not verify the switch with the CLI: ${post.error}`);
    }

    // 4c. The official extension followed the change.
    const acknowledgement: SwitchResult['acknowledgement'] = watch
      ? await watch.wait(5000)
      : 'not-installed';

    await this.accounts.profiles.pushRecent(target.id);
    this.accounts.fire();
    this.afterSwitch(this.accounts.get(target.id) ?? target);

    const updated = this.accounts.get(target.id);
    const identityChanged =
      expectedIdentity?.email && updated?.identity?.email && !sameClaudeAccount(expectedIdentity, updated.identity);
    const who = updated?.identity?.email ? ` (${updated.identity.email})` : '';
    const parts = [`Switched to "${target.displayName}"${who}.`];
    if (signedIn === false) {
      parts.push('This account is not signed in yet.');
    }
    if (cliVerified === undefined) {
      parts.push('Could not confirm with the Claude Code CLI.');
    }
    if (identityChanged) {
      parts.push(`Note: this profile is now signed in as ${updated?.identity?.email}, not ${expectedIdentity?.email}.`);
    }
    const message = parts.join(' ');
    this.logger.info(
      `Switched to "${target.displayName}": setting=ok cli=${cliVerified ?? 'unknown'} signedIn=${signedIn ?? 'unknown'} extension=${acknowledgement}`,
    );

    if (notify) {
      await this.reportOutcome(message, acknowledgement, signedIn === false ? target : undefined);
    }
    return this.result('switched', target.id, true, message, { cliVerified, signedIn, acknowledgement });
  }

  private async reportOutcome(
    message: string,
    acknowledgement: SwitchResult['acknowledgement'],
    needsSignIn: AccountProfile | undefined,
  ): Promise<void> {
    if (acknowledgement === 'not-observed' && this.claudeCode.isActive()) {
      const choice = await vscode.window.showWarningMessage(
        `${message} The Claude Code extension did not confirm that it picked up the change. Reload the window to make sure new conversations use this account.`,
        'Reload Window',
        'Later',
      );
      if (choice === 'Reload Window') {
        await this.reloadWindowSafely();
      }
      return;
    }
    if (needsSignIn) {
      const choice = await vscode.window.showWarningMessage(message, 'Sign In');
      if (choice === 'Sign In') {
        await this.auth.signIn(needsSignIn);
      }
      return;
    }
    const suffix =
      acknowledgement === 'acknowledged'
        ? ' New Claude Code conversations use this account.'
        : acknowledgement === 'not-installed'
          ? ' The Claude Code extension is not installed; terminals and the CLI use this account.'
          : ' New Claude Code conversations use this account.';
    vscode.window.showInformationMessage(message + suffix);
  }

  async reloadWindowSafely(): Promise<void> {
    const active = this.accounts.active();
    const name = active.kind === 'profile' ? active.profile.displayName : 'the current configuration';
    const proceed = await this.confirmAgainstRunningSessions(
      this.accounts.activeConfigDir(),
      name,
      'Reloading the window restarts the Claude Code panels in this window. Work in progress in this window may be interrupted; Claude Code resumes restored sessions when "claudeCode.continueAfterReload" is on.',
    );
    if (proceed) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  }
}
