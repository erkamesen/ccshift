import * as vscode from 'vscode';
import { promises as fs } from 'fs';
import * as path from 'path';
import type { Logger } from '../utils/logger';
import { readJsonFile } from '../utils/filesystem';

// Read-only checks against the anthropic.claude-code extension.

export const CLAUDE_CODE_EXTENSION_ID = 'anthropic.claude-code';

export type Acknowledgement =
  | 'acknowledged'
  | 'not-observed'
  | 'unavailable';

export interface AcknowledgementWatch {
  wait(timeoutMs: number): Promise<Acknowledgement>;
}

export class ClaudeCodeIntegration {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {}

  extension(): vscode.Extension<unknown> | undefined {
    return vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID);
  }

  extensionVersion(): string | undefined {
    const ext = this.extension();
    const version = (ext?.packageJSON as { version?: unknown } | undefined)?.version;
    return typeof version === 'string' ? version : undefined;
  }

  isInstalled(): boolean {
    return this.extension() !== undefined;
  }

  isActive(): boolean {
    return this.extension()?.isActive === true;
  }

  bundledCliCandidates(): string[] {
    const ext = this.extension();
    if (!ext) {
      return [];
    }
    const names = process.platform === 'win32' ? ['claude.exe'] : ['claude'];
    return names.map((n) => path.join(ext.extensionPath, 'resources', 'native-binary', n));
  }

  processWrapper(): string | undefined {
    const value = vscode.workspace.getConfiguration('claudeCode').get<string>('claudeProcessWrapper');
    return value && value.trim() ? value.trim() : undefined;
  }

  /** env.CLAUDE_CONFIG_DIR in ~/.claude/settings.json would fight with our setting. */
  async settingsFileConfigDir(defaultConfigDir: string): Promise<string | undefined> {
    const result = await readJsonFile(path.join(defaultConfigDir, 'settings.json'));
    if (result.kind !== 'ok' || result.value === null || typeof result.value !== 'object') {
      return undefined;
    }
    const env = (result.value as Record<string, unknown>).env;
    if (env === null || typeof env !== 'object') {
      return undefined;
    }
    const v = (env as Record<string, unknown>).CLAUDE_CONFIG_DIR;
    return typeof v === 'string' ? v : undefined;
  }

  /**
   * Claude Code logs "CLAUDE_CONFIG_DIR changed ... refreshing every webview"
   * when it picks up the setting. Start this before writing the setting.
   */
  async beginAcknowledgementWatch(): Promise<AcknowledgementWatch> {
    const logDir = this.officialLogDir();
    const baseline = new Map<string, number>();
    let available = false;
    if (logDir) {
      try {
        for (const name of await fs.readdir(logDir)) {
          if (name.endsWith('.log')) {
            baseline.set(name, (await fs.stat(path.join(logDir, name))).size);
          }
        }
        // The folder exists; a log file created after this point is read from the start.
        available = true;
      } catch {
        available = false;
      }
    }
    const logger = this.logger;
    return {
      async wait(timeoutMs: number): Promise<Acknowledgement> {
        if (!available || !logDir) {
          return 'unavailable';
        }
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 300));
          try {
            for (const name of await fs.readdir(logDir)) {
              if (!name.endsWith('.log')) {
                continue;
              }
              const file = path.join(logDir, name);
              const size = (await fs.stat(file)).size;
              const from = baseline.get(name) ?? 0;
              if (size <= from) {
                continue;
              }
              const length = Math.min(size - from, 256 * 1024);
              const handle = await fs.open(file, 'r');
              try {
                const buffer = Buffer.alloc(length);
                await handle.read(buffer, 0, length, from);
                const text = buffer.toString('utf8');
                if (/CLAUDE_CONFIG_DIR changed[^\n]*refreshing every webview/.test(text)) {
                  return 'acknowledged';
                }
              } finally {
                await handle.close();
              }
            }
          } catch (error) {
            logger.debug(`Could not read the Claude Code log: ${String(error)}`);
          }
        }
        return 'not-observed';
      },
    };
  }

  private officialLogDir(): string | undefined {
    try {
      const ours = this.context.logUri.fsPath;
      const exthost = path.dirname(ours);
      return path.join(exthost, 'Anthropic.claude-code');
    } catch {
      return undefined;
    }
  }
}
