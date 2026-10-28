import * as vscode from 'vscode';
import type { Services } from '../services';
import { readLiveSessions, summarizeSessions } from '../integration/SessionRegistry';
import { describePlan, sameClaudeAccount } from '../accounts/identity';
import { samePath } from '../utils/filesystem';
import { tildify, defaultClaudeConfigDir } from '../utils/paths';
import { formatDateTime } from '../utils/time';
import { USAGE_STATE_LABEL, usageState, formatPercent, windowView } from '../usage/usageModel';

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export async function buildDiagnostics(s: Services): Promise<string> {
  const lines: string[] = [];
  const now = Date.now();
  const env = s.accounts.environment.read();
  const cli = await s.cli.resolve();
  const cliVersion = cli ? await s.cli.version() : undefined;
  const wrapper = s.claudeCode.processWrapper();
  const defaultDir = defaultClaudeConfigDir();
  const settingsEnvDir = await s.claudeCode.settingsFileConfigDir(defaultDir);
  const issues = [...env.issues];

  if (!s.claudeCode.isInstalled()) {
    issues.push('The Claude Code extension (anthropic.claude-code) is not installed. Switching still applies to terminals and the CLI.');
  }
  if (wrapper) {
    issues.push(
      'claudeCode.claudeProcessWrapper is set. The wrapper decides how Claude starts and could override CLAUDE_CONFIG_DIR; switching is applied but cannot be fully verified.',
    );
  }
  if (settingsEnvDir) {
    issues.push(
      `${tildify(defaultDir)}/settings.json sets env.CLAUDE_CONFIG_DIR (${settingsEnvDir}). That competes with the account selected here; remove it from that file.`,
    );
  }
  if (!cli) {
    issues.push('No Claude Code CLI was found, so sign-in checks, verification and usage queries cannot run.');
  }
  if (vscode.env.remoteName) {
    issues.push(`This is a remote window (${vscode.env.remoteName}). Paths and sign-ins refer to the remote machine.`);
  }

  lines.push('# ccshift: Diagnostics', '');
  lines.push(`Generated ${formatDateTime(now)}`, '');
  lines.push('## Environment', '');
  lines.push(`- VS Code ${vscode.version} on ${process.platform}/${process.arch}`);
  lines.push(
    `- Claude Code extension: ${s.claudeCode.isInstalled() ? `${s.claudeCode.extensionVersion() ?? 'unknown version'}, ${s.claudeCode.isActive() ? 'active' : 'not active yet'}` : 'not installed'}`,
  );
  lines.push(`- Claude Code CLI: ${cli ? `${tildify(cli.path)} (${cli.source}), version ${cliVersion ?? 'unknown'}` : 'not found'}`);
  lines.push(`- claudeCode.claudeProcessWrapper: ${wrapper ? 'set' : 'not set'}`);
  lines.push(
    `- CLAUDE_CONFIG_DIR in claudeCode.environmentVariables (user settings): ${env.configDir ? `\`${tildify(env.configDir)}\`` : 'not set (default configuration)'}`,
  );
  lines.push(`- Default configuration folder: \`${tildify(defaultDir)}\``);
  lines.push(`- Account Manager data: \`${tildify(s.home)}\``);
  lines.push('');

  lines.push('## Issues', '');
  lines.push(...(issues.length ? issues.map((i) => `- ${i}`) : ['- None found.']));
  lines.push('');

  const active = s.accounts.active();
  lines.push('## Active account', '');
  if (active.kind === 'profile') {
    lines.push(`"${active.profile.displayName}" → \`${tildify(active.profile.configDir)}\``);
  } else {
    lines.push(`Unregistered folder \`${tildify(active.configDir)}\`.`);
    if (samePath(active.configDir, defaultDir)) {
      lines.push(
        '',
        'CLAUDE_CONFIG_DIR is set explicitly to the default folder. Claude Code stores credentials for an explicitly set folder separately from the unset default, so this can ask you to sign in again. Select the Default account to remove the override.',
      );
    }
  }
  lines.push('');

  lines.push('## Accounts', '');
  lines.push('| Account | Folder | Sign-in (checked now) | Plan | Running sessions | Usage | Status-line collector |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const profile of s.accounts.list()) {
    const before = profile.identity;
    const check = await s.auth.check(profile);
    const updated = s.accounts.get(profile.id) ?? profile;
    let signIn: string;
    if (check.state === 'authenticated') {
      signIn = `signed in${updated.identity?.email ? ` as ${updated.identity.email}` : ''}`;
      if (before?.email && !sameClaudeAccount(before, updated.identity)) {
        signIn += ` (was ${before.email})`;
      }
    } else if (check.state === 'unauthenticated') {
      signIn = 'not signed in';
    } else {
      signIn = `check failed: ${check.error ?? 'unknown'}`;
    }
    const sessions = summarizeSessions(await readLiveSessions(profile.configDir));
    const record = s.usage.record(profile.id);
    const state = usageState(record, updated.authState, now);
    const five = windowView(record?.snapshot?.fiveHour, now);
    const seven = windowView(record?.snapshot?.sevenDay, now);
    const usage = `${USAGE_STATE_LABEL[state]}: 5h ${formatPercent(five.percent)}, 7d ${formatPercent(seven.percent)}${record?.lastError ? ` (last error: ${record.lastError.message})` : ''}`;
    const collector = await s.collector.status(updated);
    lines.push(
      `| ${cell(updated.displayName)}${updated.kind === 'default' ? ' (default config)' : ''} | \`${cell(tildify(updated.configDir))}\` | ${cell(signIn)} | ${cell(describePlan(updated.identity) ?? '—')} | ${sessions.total} (${sessions.busy} busy) | ${cell(usage)} | ${collector.kind} |`,
    );
  }
  lines.push('');

  lines.push('## How switching works', '');
  lines.push(
    '- Each account is a separate Claude Code configuration folder. Claude Code keeps each folder\'s sign-in in its own macOS Keychain entry (or `.credentials.json`), its own settings and its own conversation history.',
    '- Switching writes `CLAUDE_CONFIG_DIR` into `claudeCode.environmentVariables` in user settings (or removes it for the default account). The Claude Code extension follows that setting: it refreshes its panels and starts new conversations with the selected folder. No window reload is needed when it confirms the change.',
    '- Each switch is verified by reading the setting back, running `claude auth status` with the same environment, and watching the Claude Code extension\'s log for its confirmation.',
    '- Usage comes from `claude -p /usage` (no model request, no tokens) and, if installed, the status-line collector for terminal sessions.',
    '',
  );
  lines.push('## Limitations', '');
  lines.push(
    '- `claudeCode.environmentVariables` is a machine-scoped setting, so the chat panel uses the same account in every window of a VS Code profile. Different accounts in two windows at once: open the second window with a different VS Code profile, or use the CLI in a terminal (terminals follow the workspace account).',
    '- Sessions already running keep the account they started with until they end. Conversation history belongs to each account and is not shared between them.',
    '- Usage figures are snapshots. They update when refreshed or when a CLI session reports them; they are not streamed live from the chat panel.',
    '- The structured `/usage` report is marked experimental in the Claude Agent SDK reference; if a future Claude Code changes it, usage shows as unavailable rather than wrong.',
  );
  return lines.join('\n');
}

export async function showDiagnostics(s: Services): Promise<void> {
  const content = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Checking Claude Code integration…' },
    () => buildDiagnostics(s),
  );
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content });
  await vscode.window.showTextDocument(doc, { preview: false });
}
