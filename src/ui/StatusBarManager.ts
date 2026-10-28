import * as vscode from 'vscode';
import type { AccountView } from './viewModel';
import { statusBarText } from './viewModel';
import { tildify } from '../utils/paths';

export class StatusBarManager implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem('ccshift.status', vscode.StatusBarAlignment.Right, 100);
    this.item.name = 'Claude Account';
    this.item.command = 'ccshift.switchAccount';
  }

  update(active: AccountView | undefined, unregisteredDir: string | undefined, enabled: boolean): void {
    if (!enabled) {
      this.item.hide();
      return;
    }
    if (!active) {
      this.item.text = '$(account) Claude: unregistered folder';
      this.item.tooltip = new vscode.MarkdownString(
        `Claude Code is configured to use \`${tildify(unregisteredDir ?? 'unknown')}\`, which is not a registered account.\n\nClick to choose an account.`,
      );
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.item.show();
      return;
    }
    this.item.text = `$(account) Claude: ${statusBarText(active)}`;
    this.item.backgroundColor =
      active.authState === 'unauthenticated' || active.fiveHour.severity === 'critical' || active.sevenDay.severity === 'critical'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : active.fiveHour.severity === 'warning' || active.sevenDay.severity === 'warning'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;

    const md = new vscode.MarkdownString(undefined, true);
    md.supportThemeIcons = true;
    md.appendMarkdown(`**${escapeMd(active.name)}**`);
    if (active.plan) {
      md.appendMarkdown(` · ${escapeMd(active.plan)}`);
    }
    md.appendMarkdown('\n\n');
    if (active.authState === 'unauthenticated') {
      md.appendMarkdown('$(warning) Not signed in\n\n');
    }
    md.appendMarkdown(`5-hour: **${active.fiveHour.percentLabel}** · ${escapeMd(active.fiveHour.resetLabel)}\n\n`);
    md.appendMarkdown(`Weekly: **${active.sevenDay.percentLabel}** · ${escapeMd(active.sevenDay.resetLabel)}\n\n`);
    md.appendMarkdown(
      `${escapeMd(active.usageStateLabel)}${active.updatedLabel ? ` · ${escapeMd(active.updatedLabel)}` : ''}\n\n`,
    );
    if (active.errorMessage) {
      md.appendMarkdown(`$(info) ${escapeMd(active.errorMessage)}\n\n`);
    }
    md.appendMarkdown('Click to switch accounts');
    this.item.tooltip = md;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');
}
