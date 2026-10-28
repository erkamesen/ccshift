import { promises as fs } from 'fs';
import * as path from 'path';
import type { AccountProfile } from '../types/account';
import { atomicWriteFile, ensurePrivateDir, readJsonFile, shellQuote } from '../utils/filesystem';
import { isValidProfileId } from '../utils/paths';

// Opt-in status line collector. Only runs in terminal CLI sessions (the VS Code
// panel does not run status lines). Keeps and chains any existing status line.

export const COLLECTOR_SCRIPT_NAME = 'statusline-collector.sh';

/** Copies stdin to the inbox, then runs the original status line if there was one. */
export const COLLECTOR_SCRIPT = `#!/bin/sh
# ccshift status-line collector.
# Installed and removed with the "ccshift: ... Usage Collector" commands.
# Usage: statusline-collector.sh <profile-id> <label>
umask 077
id="$1"
case "$id" in
  ''|*[!a-z0-9-]*) exit 0 ;;
esac
root="\${CCSHIFT_HOME:-$HOME/.ccshift}"
inbox="$root/usage/inbox"
input=$(cat)
mkdir -p "$inbox" 2>/dev/null
tmp="$inbox/.$id.$$.tmp"
if printf '%s' "$input" > "$tmp" 2>/dev/null; then
  mv -f "$tmp" "$inbox/$id.json" 2>/dev/null || rm -f "$tmp"
else
  rm -f "$tmp"
fi
original="$root/statusline/$id.command"
if [ -f "$original" ]; then
  if [ -x /bin/bash ]; then sh_bin=/bin/bash; else sh_bin=/bin/sh; fi
  printf '%s' "$input" | "$sh_bin" -c "$(cat "$original")"
else
  printf '%s\\n' "$2"
fi
`;

export type CollectorStatus =
  | { kind: 'not-installed' }
  | { kind: 'installed'; chained: boolean }
  | { kind: 'detached' }
  | { kind: 'settings-unreadable'; error: string };

interface SavedOriginal {
  statusLine?: unknown;
  hadStatusLine: boolean;
}

export class StatusLineCollector {
  readonly scriptPath: string;
  readonly statusLineDir: string;
  readonly inboxDir: string;

  constructor(readonly home: string) {
    this.scriptPath = path.join(home, 'bin', COLLECTOR_SCRIPT_NAME);
    this.statusLineDir = path.join(home, 'statusline');
    this.inboxDir = path.join(home, 'usage', 'inbox');
  }

  private settingsPath(profile: AccountProfile): string {
    return path.join(profile.configDir, 'settings.json');
  }

  private originalPath(id: string): string {
    if (!isValidProfileId(id)) {
      throw new Error('invalid profile id');
    }
    return path.join(this.statusLineDir, `${id}.original.json`);
  }

  private commandPath(id: string): string {
    if (!isValidProfileId(id)) {
      throw new Error('invalid profile id');
    }
    return path.join(this.statusLineDir, `${id}.command`);
  }

  commandFor(profile: AccountProfile): string {
    const label = `Claude account: ${profile.displayName}`.replace(/[^\p{L}\p{N} ._:()-]/gu, '');
    return `${shellQuote(this.scriptPath)} ${shellQuote(profile.id)} ${shellQuote(label)}`;
  }

  private isOurCommand(command: unknown): boolean {
    return typeof command === 'string' && command.includes(this.scriptPath);
  }

  async status(profile: AccountProfile): Promise<CollectorStatus> {
    const settings = await readJsonFile(this.settingsPath(profile));
    if (settings.kind === 'invalid') {
      return { kind: 'settings-unreadable', error: settings.error };
    }
    const statusLine =
      settings.kind === 'ok' && settings.value && typeof settings.value === 'object'
        ? (settings.value as Record<string, unknown>).statusLine
        : undefined;
    const command =
      statusLine && typeof statusLine === 'object' ? (statusLine as Record<string, unknown>).command : undefined;
    const hasSaved = (await readJsonFile(this.originalPath(profile.id))).kind === 'ok';
    if (this.isOurCommand(command)) {
      const chained = await fs.stat(this.commandPath(profile.id)).then(
        () => true,
        () => false,
      );
      return { kind: 'installed', chained };
    }
    return hasSaved ? { kind: 'detached' } : { kind: 'not-installed' };
  }

  async describeExisting(profile: AccountProfile): Promise<string | undefined> {
    const settings = await readJsonFile(this.settingsPath(profile));
    if (settings.kind !== 'ok' || !settings.value || typeof settings.value !== 'object') {
      return undefined;
    }
    const sl = (settings.value as Record<string, unknown>).statusLine;
    if (sl && typeof sl === 'object') {
      const cmd = (sl as Record<string, unknown>).command;
      return typeof cmd === 'string' ? cmd : JSON.stringify(sl);
    }
    return undefined;
  }

  async install(profile: AccountProfile): Promise<void> {
    const file = this.settingsPath(profile);
    const settings = await readJsonFile(file);
    if (settings.kind === 'invalid') {
      throw new Error(`${file} could not be read as JSON (${settings.error}); not changing it.`);
    }
    const root: Record<string, unknown> =
      settings.kind === 'ok' && settings.value && typeof settings.value === 'object' && !Array.isArray(settings.value)
        ? { ...(settings.value as Record<string, unknown>) }
        : {};
    const existing = root.statusLine;
    if (existing && typeof existing === 'object' && this.isOurCommand((existing as Record<string, unknown>).command)) {
      return;
    }

    await ensurePrivateDir(path.dirname(this.scriptPath));
    await atomicWriteFile(this.scriptPath, COLLECTOR_SCRIPT, 0o700);
    await ensurePrivateDir(this.statusLineDir);
    await ensurePrivateDir(this.inboxDir);

    const saved: SavedOriginal = { hadStatusLine: existing !== undefined, statusLine: existing };
    await atomicWriteFile(this.originalPath(profile.id), JSON.stringify(saved, null, 2), 0o600);

    let next: Record<string, unknown>;
    const existingCommand =
      existing && typeof existing === 'object' ? (existing as Record<string, unknown>).command : undefined;
    if (existing && typeof existing === 'object' && typeof existingCommand === 'string' && existingCommand.trim()) {
      await atomicWriteFile(this.commandPath(profile.id), existingCommand, 0o600);
      next = { ...(existing as Record<string, unknown>), type: 'command', command: this.commandFor(profile) };
    } else {
      await fs.rm(this.commandPath(profile.id), { force: true });
      next = { type: 'command', command: this.commandFor(profile) };
    }
    root.statusLine = next;
    await atomicWriteFile(file, JSON.stringify(root, null, 2) + '\n');
  }

  /** Returns false and leaves settings.json alone if the user changed statusLine since. */
  async remove(profile: AccountProfile): Promise<boolean> {
    const file = this.settingsPath(profile);
    const settings = await readJsonFile(file);
    const saved = await readJsonFile(this.originalPath(profile.id));
    let restored = false;
    if (settings.kind === 'ok' && settings.value && typeof settings.value === 'object' && !Array.isArray(settings.value)) {
      const root = { ...(settings.value as Record<string, unknown>) };
      const sl = root.statusLine;
      if (sl && typeof sl === 'object' && this.isOurCommand((sl as Record<string, unknown>).command)) {
        const original = saved.kind === 'ok' ? (saved.value as SavedOriginal) : { hadStatusLine: false };
        if (original.hadStatusLine && original.statusLine !== undefined) {
          root.statusLine = original.statusLine;
        } else {
          delete root.statusLine;
        }
        await atomicWriteFile(file, JSON.stringify(root, null, 2) + '\n');
        restored = true;
      }
    }
    await fs.rm(this.originalPath(profile.id), { force: true });
    await fs.rm(this.commandPath(profile.id), { force: true });
    await fs.rm(path.join(this.inboxDir, `${profile.id}.json`), { force: true });
    return restored;
  }
}
