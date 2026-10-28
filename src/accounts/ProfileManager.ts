import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';
import {
  ACCOUNT_COLORS,
  DEFAULT_PROFILE_ID,
  type AccountColor,
  type AccountMetadata,
  type AccountProfile,
  type AuthState,
  type ClaudeIdentity,
} from '../types/account';
import type { Logger } from '../utils/logger';
import {
  atomicWriteFile,
  ensurePrivateDir,
  isStrictlyInside,
  normalizeDir,
  readJsonFile,
  samePath,
} from '../utils/filesystem';
import { isValidProfileId } from '../utils/paths';

// metadata.json + profiles/<id>. No secrets in here; credentials stay with
// Claude Code. Several windows share the file, so every change re-reads it first.

export class ProfileError extends Error {}

export const MAX_DISPLAY_NAME = 40;

export function validateDisplayName(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) {
    return 'Enter a name.';
  }
  if (trimmed.length > MAX_DISPLAY_NAME) {
    return `Use at most ${MAX_DISPLAY_NAME} characters.`;
  }
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) {
    return 'The name contains control characters.';
  }
  return undefined;
}

function isColor(x: unknown): x is AccountColor {
  return typeof x === 'string' && (ACCOUNT_COLORS as readonly string[]).includes(x);
}

function sanitizeIdentity(raw: unknown): ClaudeIdentity | undefined {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: ClaudeIdentity = {};
  for (const key of ['email', 'orgId', 'orgName', 'subscriptionType', 'authMethod', 'apiProvider'] as const) {
    const v = r[key];
    if (typeof v === 'string' && v.length <= 512) {
      out[key] = v;
    }
  }
  return Object.keys(out).length ? out : undefined;
}

const AUTH_STATES: AuthState[] = ['unknown', 'authenticated', 'unauthenticated', 'error'];

export interface ProfileManagerOptions {
  home: string;
  defaultConfigDir: string;
  logger: Logger;
  now?: () => number;
}

export class ProfileManager {
  readonly home: string;
  readonly profilesRoot: string;
  readonly metadataPath: string;
  private readonly defaultConfigDir: string;
  private readonly logger: Logger;
  private readonly now: () => number;
  private current?: AccountMetadata;

  constructor(options: ProfileManagerOptions) {
    this.home = normalizeDir(options.home);
    this.profilesRoot = path.join(this.home, 'profiles');
    this.metadataPath = path.join(this.home, 'metadata.json');
    this.defaultConfigDir = normalizeDir(options.defaultConfigDir);
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
  }

  get metadata(): AccountMetadata {
    if (!this.current) {
      throw new ProfileError('Profiles have not been loaded yet.');
    }
    return this.current;
  }

  get profiles(): AccountProfile[] {
    return this.metadata.profiles;
  }

  find(id: string): AccountProfile | undefined {
    return this.current?.profiles.find((p) => p.id === id);
  }

  findByConfigDir(dir: string): AccountProfile | undefined {
    return this.current?.profiles.find((p) => samePath(p.configDir, dir));
  }

  ownedDirFor(id: string): string {
    if (!isValidProfileId(id) || id === DEFAULT_PROFILE_ID) {
      throw new ProfileError(`Invalid profile id: ${id}`);
    }
    const dir = path.join(this.profilesRoot, id);
    if (!isStrictlyInside(this.profilesRoot, dir)) {
      throw new ProfileError(`Profile path escapes the profiles folder: ${id}`);
    }
    return dir;
  }

  async load(): Promise<AccountMetadata> {
    await ensurePrivateDir(this.home);
    await ensurePrivateDir(this.profilesRoot);
    const result = await readJsonFile(this.metadataPath);
    let metadata: AccountMetadata;
    if (result.kind === 'ok') {
      metadata = this.sanitize(result.value);
    } else if (result.kind === 'missing') {
      metadata = this.sanitize(undefined);
      await this.write(metadata);
    } else {
      const backup = `${this.metadataPath}.corrupt-${this.now()}`;
      this.logger.warn(`metadata.json could not be read (${result.error}); keeping a copy and rebuilding the account list`);
      try {
        await fs.rename(this.metadataPath, backup);
      } catch {
        // If it cannot be moved, it is overwritten below; the profiles themselves are untouched.
      }
      metadata = this.sanitize(undefined);
      metadata.profiles.push(...(await this.recoverOwnedProfiles(metadata.profiles)));
      await this.write(metadata);
    }
    this.current = metadata;
    return metadata;
  }

  async update(mutate: (m: AccountMetadata) => void): Promise<AccountMetadata> {
    await this.load();
    const next = structuredClone(this.metadata);
    mutate(next);
    const clean = this.sanitize(next);
    await this.write(clean);
    this.current = clean;
    return clean;
  }

  private async write(metadata: AccountMetadata): Promise<void> {
    await atomicWriteFile(this.metadataPath, JSON.stringify(metadata, null, 2) + '\n', 0o600);
  }

  private defaultProfile(existing?: Partial<AccountProfile>): AccountProfile {
    return {
      id: DEFAULT_PROFILE_ID,
      displayName: existing?.displayName && !validateDisplayName(existing.displayName) ? existing.displayName.trim() : 'Default',
      color: isColor(existing?.color) ? existing.color : 'blue',
      kind: 'default',
      configDir: this.defaultConfigDir,
      ownedDir: false,
      createdAt: typeof existing?.createdAt === 'number' ? existing.createdAt : this.now(),
      identity: sanitizeIdentity(existing?.identity),
      authState: existing?.authState && AUTH_STATES.includes(existing.authState) ? existing.authState : 'unknown',
      authCheckedAt: typeof existing?.authCheckedAt === 'number' ? existing.authCheckedAt : undefined,
    };
  }

  /** Drop anything invalid instead of trying to repair it. */
  sanitize(raw: unknown): AccountMetadata {
    const r = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const list = Array.isArray(r.profiles) ? r.profiles : [];
    const profiles: AccountProfile[] = [];
    const seenIds = new Set<string>();
    const rawDefault = list.find(
      (p): p is Record<string, unknown> => p !== null && typeof p === 'object' && (p as { id?: unknown }).id === DEFAULT_PROFILE_ID,
    );
    profiles.push(this.defaultProfile(rawDefault as Partial<AccountProfile> | undefined));
    seenIds.add(DEFAULT_PROFILE_ID);

    for (const item of list) {
      if (item === null || typeof item !== 'object') {
        continue;
      }
      const p = item as Record<string, unknown>;
      const id = p.id;
      if (!isValidProfileId(id) || seenIds.has(id)) {
        continue;
      }
      const name = typeof p.displayName === 'string' ? p.displayName.trim() : '';
      if (validateDisplayName(name)) {
        continue;
      }
      const ownedDir = p.ownedDir === true;
      let configDir: string;
      if (ownedDir) {
        // Owned directories are always derived from the id, never taken from the file.
        configDir = this.ownedDirFor(id);
      } else {
        if (typeof p.configDir !== 'string' || !path.isAbsolute(p.configDir)) {
          continue;
        }
        configDir = normalizeDir(p.configDir);
      }
      if (samePath(configDir, this.defaultConfigDir) || profiles.some((x) => samePath(x.configDir, configDir))) {
        continue;
      }
      seenIds.add(id);
      profiles.push({
        id,
        displayName: name,
        color: isColor(p.color) ? p.color : 'blue',
        kind: 'managed',
        configDir,
        ownedDir,
        createdAt: typeof p.createdAt === 'number' ? p.createdAt : this.now(),
        identity: sanitizeIdentity(p.identity),
        authState: AUTH_STATES.includes(p.authState as AuthState) ? (p.authState as AuthState) : 'unknown',
        authCheckedAt: typeof p.authCheckedAt === 'number' ? p.authCheckedAt : undefined,
      });
    }

    const defaultProfileId =
      typeof r.defaultProfileId === 'string' && seenIds.has(r.defaultProfileId) ? r.defaultProfileId : DEFAULT_PROFILE_ID;
    const recent = Array.isArray(r.recentProfileIds)
      ? r.recentProfileIds.filter((x): x is string => typeof x === 'string' && seenIds.has(x))
      : [];
    return { version: 1, profiles, defaultProfileId, recentProfileIds: [...new Set(recent)].slice(0, 10) };
  }

  private async recoverOwnedProfiles(existing: AccountProfile[]): Promise<AccountProfile[]> {
    const recovered: AccountProfile[] = [];
    let names: string[] = [];
    try {
      names = await fs.readdir(this.profilesRoot);
    } catch {
      return recovered;
    }
    for (const name of names) {
      if (!isValidProfileId(name) || name === DEFAULT_PROFILE_ID || existing.some((p) => p.id === name)) {
        continue;
      }
      const dir = path.join(this.profilesRoot, name);
      const stat = await fs.lstat(dir).catch(() => undefined);
      if (!stat?.isDirectory()) {
        continue;
      }
      recovered.push({
        id: name,
        displayName: `Recovered ${name}`.slice(0, MAX_DISPLAY_NAME),
        color: 'blue',
        kind: 'managed',
        configDir: dir,
        ownedDir: true,
        createdAt: this.now(),
        authState: 'unknown',
      });
    }
    return recovered;
  }

  private nextColor(): AccountColor {
    const used = new Set(this.current?.profiles.map((p) => p.color));
    return ACCOUNT_COLORS.find((c) => !used.has(c)) ?? ACCOUNT_COLORS[(this.current?.profiles.length ?? 0) % ACCOUNT_COLORS.length];
  }

  private assertNameAvailable(name: string, exceptId?: string): void {
    const problem = validateDisplayName(name);
    if (problem) {
      throw new ProfileError(problem);
    }
    const lower = name.trim().toLowerCase();
    if (this.current?.profiles.some((p) => p.id !== exceptId && p.displayName.toLowerCase() === lower)) {
      throw new ProfileError(`An account named "${name.trim()}" already exists.`);
    }
  }

  async createManagedProfile(displayName: string, color?: AccountColor): Promise<AccountProfile> {
    await this.load();
    this.assertNameAvailable(displayName);
    let id = '';
    for (let i = 0; i < 5 && !id; i++) {
      const candidate = `acct-${randomBytes(4).toString('hex')}`;
      if (!this.find(candidate)) {
        id = candidate;
      }
    }
    const dir = this.ownedDirFor(id);
    // `recursive: false` makes this fail if the directory already exists.
    await fs.mkdir(dir, { recursive: false, mode: 0o700 });
    const profile: AccountProfile = {
      id,
      displayName: displayName.trim(),
      color: color ?? this.nextColor(),
      kind: 'managed',
      configDir: dir,
      ownedDir: true,
      createdAt: this.now(),
      authState: 'unauthenticated',
    };
    try {
      await this.update((m) => m.profiles.push(profile));
    } catch (error) {
      await fs.rmdir(dir).catch(() => undefined);
      throw error;
    }
    return profile;
  }

  async registerExistingDirectory(dir: string, displayName: string, color?: AccountColor): Promise<AccountProfile> {
    await this.load();
    this.assertNameAvailable(displayName);
    if (!path.isAbsolute(dir)) {
      throw new ProfileError('Choose an absolute folder path.');
    }
    const normalized = normalizeDir(dir);
    if (samePath(normalized, this.defaultConfigDir)) {
      throw new ProfileError('That folder is the default Claude Code configuration, which is already registered.');
    }
    const existing = this.findByConfigDir(normalized);
    if (existing) {
      throw new ProfileError(`That folder is already registered as "${existing.displayName}".`);
    }
    const stat = await fs.stat(normalized).catch(() => undefined);
    if (!stat?.isDirectory()) {
      throw new ProfileError('That folder does not exist.');
    }
    let id = '';
    while (!id || this.find(id)) {
      id = `acct-${randomBytes(4).toString('hex')}`;
    }
    const profile: AccountProfile = {
      id,
      displayName: displayName.trim(),
      color: color ?? this.nextColor(),
      kind: 'managed',
      configDir: normalized,
      ownedDir: false,
      createdAt: this.now(),
      authState: 'unknown',
    };
    await this.update((m) => m.profiles.push(profile));
    return profile;
  }

  async rename(id: string, displayName: string): Promise<void> {
    await this.load();
    if (!this.find(id)) {
      throw new ProfileError('That account is no longer registered.');
    }
    this.assertNameAvailable(displayName, id);
    await this.update((m) => {
      const p = m.profiles.find((x) => x.id === id);
      if (p) {
        p.displayName = displayName.trim();
      }
    });
  }

  async setColor(id: string, color: AccountColor): Promise<void> {
    await this.update((m) => {
      const p = m.profiles.find((x) => x.id === id);
      if (p) {
        p.color = color;
      }
    });
  }

  async setDefault(id: string): Promise<void> {
    await this.update((m) => {
      if (m.profiles.some((p) => p.id === id)) {
        m.defaultProfileId = id;
      }
    });
  }

  async pushRecent(id: string): Promise<void> {
    await this.update((m) => {
      m.recentProfileIds = [id, ...m.recentProfileIds.filter((x) => x !== id)].slice(0, 10);
    });
  }

  async recordAuth(id: string, state: AuthState, identity?: ClaudeIdentity): Promise<void> {
    await this.update((m) => {
      const p = m.profiles.find((x) => x.id === id);
      if (p) {
        p.authState = state;
        p.authCheckedAt = this.now();
        if (identity) {
          p.identity = identity;
        }
      }
    });
  }

  async unregister(id: string): Promise<void> {
    if (id === DEFAULT_PROFILE_ID) {
      throw new ProfileError('The default account cannot be removed.');
    }
    await this.update((m) => {
      m.profiles = m.profiles.filter((p) => p.id !== id);
      m.recentProfileIds = m.recentProfileIds.filter((x) => x !== id);
      if (m.defaultProfileId === id) {
        m.defaultProfileId = DEFAULT_PROFILE_ID;
      }
    });
  }

  /** Only for dirs we created under profiles/. No symlinks, real paths checked. */
  async deleteOwnedDirectory(profile: AccountProfile): Promise<void> {
    if (profile.kind !== 'managed' || !profile.ownedDir) {
      throw new ProfileError('Only folders created by ccshift can be deleted.');
    }
    const expected = this.ownedDirFor(profile.id);
    if (!samePath(expected, profile.configDir)) {
      throw new ProfileError('The profile folder is not where it should be; refusing to delete it.');
    }
    const stat = await fs.lstat(expected).catch(() => undefined);
    if (!stat) {
      return;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ProfileError('The profile folder is not a plain directory; refusing to delete it.');
    }
    const realRoot = await fs.realpath(this.profilesRoot);
    const realDir = await fs.realpath(expected);
    if (!isStrictlyInside(realRoot, realDir) || samePath(realDir, this.defaultConfigDir)) {
      throw new ProfileError('The profile folder resolves outside the profiles folder; refusing to delete it.');
    }
    await fs.rm(realDir, { recursive: true, force: false });
  }
}
