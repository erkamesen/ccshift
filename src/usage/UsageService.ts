import * as vscode from 'vscode';
import { promises as fs, watch as fsWatch, type FSWatcher } from 'fs';
import * as path from 'path';
import type { AccountProfile } from '../types/account';
import type { UsageRecord } from '../types/usage';
import type { Logger } from '../utils/logger';
import { readJsonFile } from '../utils/filesystem';
import { isValidProfileId } from '../utils/paths';
import type { CLIIntegration } from '../integration/CLIIntegration';
import type { AccountManager } from '../accounts/AccountManager';
import type { AuthenticationService } from '../accounts/AuthenticationService';
import type { UsageCache } from './UsageCache';
import { snapshotFromStatusLine } from './usageParsing';
import { newerSnapshot } from './usageModel';

// Usage from `claude -p /usage` (manual, after switch, timer) and from the
// status line collector inbox.

export interface UsageServiceConfig {
  autoRefreshMinutes(): number;
}

export class UsageService implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<string | undefined>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private queue: Promise<void> = Promise.resolve();
  private readonly pending = new Set<string>();
  private readonly running = new Set<string>();
  private inboxWatcher?: FSWatcher;
  private inboxTimer?: NodeJS.Timeout;
  private autoTimer?: NodeJS.Timeout;
  private inboxDebounce?: NodeJS.Timeout;

  constructor(
    private readonly cache: UsageCache,
    private readonly cli: CLIIntegration,
    private readonly accounts: AccountManager,
    private readonly auth: AuthenticationService,
    private readonly inboxDir: string,
    private readonly config: UsageServiceConfig,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    await this.cache.load();
    const cacheWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(path.dirname(this.cache.file)), path.basename(this.cache.file)),
    );
    const reload = (): void => {
      this.cache
        .load()
        .then(() => this.emitter.fire(undefined))
        .catch(() => undefined);
    };
    this.disposables.push(cacheWatcher, cacheWatcher.onDidChange(reload), cacheWatcher.onDidCreate(reload));
    this.disposables.push(
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) {
          this.autoRefreshTick();
        }
      }),
    );
    this.startInbox();
    this.autoTimer = setInterval(() => this.autoRefreshTick(), 60_000);
    void this.ingestInbox();
    setTimeout(() => this.autoRefreshTick(), 5_000);
  }

  record(id: string): UsageRecord | undefined {
    return this.cache.get(id);
  }

  isRefreshing(id: string): boolean {
    return this.pending.has(id) || this.running.has(id);
  }

  /** One query at a time. */
  refresh(profileId: string, options: { force?: boolean } = {}): Promise<void> {
    if (this.pending.has(profileId)) {
      return this.queue;
    }
    this.pending.add(profileId);
    this.emitter.fire(profileId);
    const run = async (): Promise<void> => {
      this.pending.delete(profileId);
      this.running.add(profileId);
      try {
        await this.refreshNow(profileId, options.force === true);
      } catch (error) {
        this.logger.error(`Usage refresh failed for ${profileId}`, error);
      } finally {
        this.running.delete(profileId);
        this.emitter.fire(profileId);
      }
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  async refreshAll(options: { force?: boolean } = {}): Promise<void> {
    await Promise.all(this.accounts.list().map((p) => this.refresh(p.id, options)));
  }

  private minIntervalMs(): number {
    const minutes = this.config.autoRefreshMinutes();
    return minutes > 0 ? Math.max(60_000, minutes * 60_000 * 0.8) : 60_000;
  }

  private async refreshNow(profileId: string, force: boolean): Promise<void> {
    const profile = this.accounts.get(profileId);
    if (!profile) {
      return;
    }
    await this.cache.load();
    const before = this.cache.get(profileId);
    if (!force && before?.lastAttemptAt !== undefined && Date.now() - before.lastAttemptAt < this.minIntervalMs()) {
      return; // Another window refreshed it recently.
    }
    await this.cache.update(profileId, (r) => ({ ...r, lastAttemptAt: Date.now() }));

    const result = await this.cli.queryUsage(this.accounts.configDirFor(profile));
    const at = Date.now();
    switch (result.kind) {
      case 'ok':
        await this.cache.update(profileId, (r) => ({
          ...r,
          snapshot: newerSnapshot(r.snapshot, result.snapshot),
          lastError: undefined,
        }));
        if (profile.authState !== 'authenticated') {
          await this.auth.check(profile);
        }
        this.logger.info(`Usage updated for "${profile.displayName}"`);
        break;
      case 'no-limits':
      case 'no-report': {
        // A signed-out profile returns no report at all, so check the sign-in
        // before blaming the Claude Code version.
        const check = await this.auth.check(profile);
        let kind: 'auth' | 'unsupported' | 'cli-unsupported' | 'cli';
        let message: string;
        if (check.state === 'unauthenticated') {
          kind = 'auth';
          message = 'Not signed in.';
        } else if (check.state === 'error') {
          kind = 'cli';
          message = check.error ?? 'Sign-in check failed.';
        } else if (check.status && check.status.authMethod !== 'claude.ai') {
          kind = 'unsupported';
          message = 'Plan usage limits apply to Claude subscriptions (Pro, Max, Team, Enterprise) only.';
        } else if (result.kind === 'no-report') {
          kind = 'cli-unsupported';
          message = 'The installed Claude Code did not return a structured usage report. Update Claude Code.';
        } else {
          kind = 'unsupported';
          message = 'Claude Code reported no plan usage for this account.';
        }
        await this.cache.update(profileId, (r) => ({ ...r, lastError: { kind, message, at } }));
        break;
      }
      case 'error':
        await this.cache.update(profileId, (r) => ({
          ...r,
          lastError: { kind: 'cli', message: result.message, at },
        }));
        break;
    }
  }

  private autoRefreshTick(): void {
    const minutes = this.config.autoRefreshMinutes();
    if (minutes <= 0 || !vscode.window.state.focused) {
      return;
    }
    const intervalMs = minutes * 60_000;
    const now = Date.now();
    for (const profile of this.accounts.list()) {
      if (profile.authState === 'unauthenticated') {
        continue;
      }
      const r = this.cache.get(profile.id);
      const last = Math.max(r?.snapshot?.observedAt ?? 0, r?.lastAttemptAt ?? 0);
      if (now - last >= intervalMs) {
        void this.refresh(profile.id);
      }
    }
  }

  // ----- status-line collector inbox -----

  private startInbox(): void {
    fs.mkdir(this.inboxDir, { recursive: true, mode: 0o700 })
      .then(() => {
        try {
          this.inboxWatcher = fsWatch(this.inboxDir, { persistent: false }, () => this.scheduleInbox());
          this.inboxWatcher.on('error', () => undefined);
        } catch (error) {
          this.logger.debug(`Inbox watcher unavailable, polling instead: ${String(error)}`);
        }
      })
      .catch(() => undefined);
    // Fallback in case file events are missed.
    this.inboxTimer = setInterval(() => void this.ingestInbox(), 60_000);
  }

  private scheduleInbox(): void {
    if (this.inboxDebounce) {
      clearTimeout(this.inboxDebounce);
    }
    this.inboxDebounce = setTimeout(() => void this.ingestInbox(), 500);
  }

  async ingestInbox(): Promise<void> {
    let names: string[];
    try {
      names = await fs.readdir(this.inboxDir);
    } catch {
      return;
    }
    for (const name of names) {
      const match = /^([a-z0-9-]+)\.json$/.exec(name);
      if (!match || !isValidProfileId(match[1])) {
        continue;
      }
      const id = match[1];
      const file = path.join(this.inboxDir, name);
      const profile: AccountProfile | undefined = this.accounts.get(id);
      try {
        const stat = await fs.stat(file);
        const parsed = await readJsonFile(file, 1024 * 1024);
        // Consume the file: it may contain session details we do not need to keep.
        await fs.rm(file, { force: true });
        if (!profile || parsed.kind !== 'ok') {
          continue;
        }
        const snapshot = snapshotFromStatusLine(parsed.value, Math.min(stat.mtimeMs, Date.now()));
        if (!snapshot) {
          continue; // No rate limits in this payload (e.g. before the first API response).
        }
        await this.cache.update(id, (r) => ({ ...r, snapshot: newerSnapshot(r.snapshot, snapshot) }));
        this.emitter.fire(id);
      } catch (error) {
        this.logger.debug(`Skipped status-line data for ${id}: ${String(error)}`);
      }
    }
  }

  async forget(profileId: string): Promise<void> {
    await this.cache.remove(profileId);
    this.emitter.fire(profileId);
  }

  dispose(): void {
    this.inboxWatcher?.close();
    if (this.inboxTimer) {
      clearInterval(this.inboxTimer);
    }
    if (this.autoTimer) {
      clearInterval(this.autoTimer);
    }
    if (this.inboxDebounce) {
      clearTimeout(this.inboxDebounce);
    }
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }
}
