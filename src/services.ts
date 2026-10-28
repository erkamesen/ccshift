import type * as vscode from 'vscode';
import type { AccountManager } from './accounts/AccountManager';
import type { AccountSwitcher } from './accounts/AccountSwitcher';
import type { AuthenticationService } from './accounts/AuthenticationService';
import type { CLIIntegration } from './integration/CLIIntegration';
import type { ClaudeCodeIntegration } from './integration/ClaudeCodeIntegration';
import type { StatusLineCollector } from './usage/StatusLineCollector';
import type { UsageService } from './usage/UsageService';
import type { OutputLogger } from './utils/logger';

export interface Services {
  context: vscode.ExtensionContext;
  logger: OutputLogger;
  home: string;
  accounts: AccountManager;
  auth: AuthenticationService;
  switcher: AccountSwitcher;
  cli: CLIIntegration;
  claudeCode: ClaudeCodeIntegration;
  usage: UsageService;
  collector: StatusLineCollector;
  render: () => void;
}
