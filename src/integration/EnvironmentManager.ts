import * as vscode from 'vscode';
import {
  effectiveConfigDir,
  hasIgnoredConfigDirEntry,
  otherEntries,
  withConfigDir,
  type EnvEntry,
} from './envVars';

// claudeCode.environmentVariables is machine-scoped, so it only lives in user
// settings and applies to every window of the VS Code profile.

const SECTION = 'claudeCode';
const KEY = 'environmentVariables';

export interface EnvironmentReading {
  globalValue: unknown;
  configDir: string | undefined;
  issues: string[];
}

export class EnvironmentManager {
  read(): EnvironmentReading {
    const config = vscode.workspace.getConfiguration(SECTION);
    const inspected = config.inspect<unknown>(KEY);
    const effective = config.get<unknown>(KEY);
    const issues: string[] = [];
    if (inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined) {
      issues.push(
        'claudeCode.environmentVariables is also set in workspace settings. It is a machine-scoped setting, so VS Code ignores the workspace value.',
      );
    }
    if (hasIgnoredConfigDirEntry(effective)) {
      issues.push('claudeCode.environmentVariables contains a CLAUDE_CONFIG_DIR that is not an absolute path; Claude Code ignores it.');
    }
    const fromGlobal = effectiveConfigDir(inspected?.globalValue);
    const fromEffective = effectiveConfigDir(effective);
    if (fromGlobal !== fromEffective) {
      issues.push(
        'The effective CLAUDE_CONFIG_DIR differs from the one in user settings (for example a remote or policy value). Switching may not take effect.',
      );
    }
    return { globalValue: inspected?.globalValue, configDir: fromEffective, issues };
  }

  extraEntries(): EnvEntry[] {
    return otherEntries(vscode.workspace.getConfiguration(SECTION).get<unknown>(KEY));
  }

  async writeConfigDir(dir: string | undefined): Promise<void> {
    const config = vscode.workspace.getConfiguration(SECTION);
    const current = config.inspect<unknown>(KEY)?.globalValue;
    const next = withConfigDir(current, dir);
    const empty = Array.isArray(next) ? next.length === 0 : Object.keys(next as object).length === 0;
    await config.update(KEY, empty && current === undefined ? undefined : next, vscode.ConfigurationTarget.Global);
  }

  onDidChange(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.${KEY}`) || e.affectsConfiguration(`${SECTION}.claudeProcessWrapper`)) {
        listener();
      }
    });
  }
}
