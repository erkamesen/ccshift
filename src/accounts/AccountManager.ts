import * as vscode from 'vscode';
import { DEFAULT_PROFILE_ID, type AccountProfile, type ActiveSelection } from '../types/account';
import type { Logger } from '../utils/logger';
import type { EnvironmentManager } from '../integration/EnvironmentManager';
import type { ProfileManager } from './ProfileManager';

const WORKSPACE_ACCOUNT_KEY = 'ccshift.workspaceAccount';

/** The active account is read from the Claude Code setting, not stored by us. */
export class AccountManager implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly profiles: ProfileManager,
    readonly environment: EnvironmentManager,
    private readonly context: vscode.ExtensionContext,
    private readonly logger: Logger,
  ) {}

  async initialize(): Promise<void> {
    await this.profiles.load();
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(this.profiles.home), 'metadata.json'),
    );
    const reload = (): void => {
      this.profiles
        .load()
        .then(() => this.emitter.fire())
        .catch((e) => this.logger.error('Could not reload account metadata', e));
    };
    this.disposables.push(
      watcher,
      watcher.onDidChange(reload),
      watcher.onDidCreate(reload),
      this.environment.onDidChange(() => this.emitter.fire()),
    );
  }

  fire(): void {
    this.emitter.fire();
  }

  list(): AccountProfile[] {
    return this.profiles.profiles;
  }

  get(id: string): AccountProfile | undefined {
    return this.profiles.find(id);
  }

  configDirFor(profile: AccountProfile): string | undefined {
    return profile.kind === 'default' ? undefined : profile.configDir;
  }

  active(): ActiveSelection {
    const dir = this.environment.read().configDir;
    if (dir === undefined) {
      return { kind: 'profile', profile: this.profiles.find(DEFAULT_PROFILE_ID)! };
    }
    const profile = this.profiles.findByConfigDir(dir);
    if (profile && profile.kind === 'managed') {
      return { kind: 'profile', profile };
    }
    // Includes CLAUDE_CONFIG_DIR explicitly set to the default folder: Claude
    // Code treats that as a different credential entry from "not set".
    return { kind: 'unregistered', configDir: dir };
  }

  activeProfile(): AccountProfile | undefined {
    const a = this.active();
    return a.kind === 'profile' ? a.profile : undefined;
  }

  activeConfigDir(): string {
    const a = this.active();
    return a.kind === 'profile' ? a.profile.configDir : a.configDir;
  }

  defaultProfile(): AccountProfile {
    return this.profiles.find(this.profiles.metadata.defaultProfileId) ?? this.profiles.find(DEFAULT_PROFILE_ID)!;
  }

  workspaceAccount(): AccountProfile | undefined {
    const id = this.context.workspaceState.get<string>(WORKSPACE_ACCOUNT_KEY);
    return id ? this.profiles.find(id) : undefined;
  }

  /** workspaceState, so nothing is written to the repo. */
  async setWorkspaceAccount(id: string | undefined): Promise<void> {
    await this.context.workspaceState.update(WORKSPACE_ACCOUNT_KEY, id);
    this.emitter.fire();
  }

  toggleTarget(): AccountProfile | undefined {
    const activeId = this.activeProfile()?.id;
    for (const id of this.profiles.metadata.recentProfileIds) {
      if (id !== activeId) {
        const p = this.profiles.find(id);
        if (p) {
          return p;
        }
      }
    }
    return this.list().find((p) => p.id !== activeId);
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}
