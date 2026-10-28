import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { normalizeDir } from './filesystem';

/** ~/.ccshift, or CCSHIFT_HOME if set (tests use this). */
export function managerHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CCSHIFT_HOME;
  if (override && path.isAbsolute(override)) {
    return normalizeDir(override);
  }
  const home = path.join(os.homedir(), '.ccshift');
  // Folder name used by early builds. Keep using it if it exists so registered
  // profiles (and any CLAUDE_CONFIG_DIR pointing into it) keep working.
  const legacy = path.join(os.homedir(), '.claude-account-manager');
  if (!fs.existsSync(home) && fs.existsSync(legacy)) {
    return legacy;
  }
  return home;
}

/** What Claude Code uses when the setting has no CLAUDE_CONFIG_DIR. */
export function defaultClaudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR?.trim();
  if (fromEnv && path.isAbsolute(fromEnv)) {
    return normalizeDir(fromEnv);
  }
  return path.join(os.homedir(), '.claude');
}

export const PROFILE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isValidProfileId(id: unknown): id is string {
  return typeof id === 'string' && PROFILE_ID_PATTERN.test(id);
}

export function tildify(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
}
