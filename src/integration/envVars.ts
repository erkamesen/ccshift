import * as path from 'path';

// Editing claudeCode.environmentVariables. The setting can be an array of
// {name, value} or an object; Claude Code uses the last absolute CLAUDE_CONFIG_DIR.

export interface EnvEntry {
  name: string;
  value: string;
}

export const CONFIG_DIR_VAR = 'CLAUDE_CONFIG_DIR';

export function isConfigDirName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' ? name.toUpperCase() === CONFIG_DIR_VAR : name === CONFIG_DIR_VAR;
}

export function normalizeEnvEntries(raw: unknown): EnvEntry[] {
  if (Array.isArray(raw)) {
    return raw
      .filter(
        (e): e is { name: string; value?: unknown } =>
          e !== null && typeof e === 'object' && typeof (e as { name?: unknown }).name === 'string',
      )
      .map((e) => ({ name: e.name, value: e.value === null || e.value === undefined ? '' : String(e.value) }));
  }
  if (raw !== null && typeof raw === 'object') {
    return Object.entries(raw as Record<string, unknown>).map(([name, value]) => ({
      name,
      value: value === null || value === undefined ? '' : String(value),
    }));
  }
  return [];
}

export function effectiveConfigDir(raw: unknown, platform: NodeJS.Platform = process.platform): string | undefined {
  let result: string | undefined;
  const isAbs = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  for (const { name, value } of normalizeEnvEntries(raw)) {
    if (isConfigDirName(name, platform) && value.trim() !== '' && isAbs(value)) {
      result = value;
    }
  }
  return result;
}

export function otherEntries(raw: unknown, platform: NodeJS.Platform = process.platform): EnvEntry[] {
  return normalizeEnvEntries(raw).filter((e) => !isConfigDirName(e.name, platform));
}

export function hasIgnoredConfigDirEntry(raw: unknown, platform: NodeJS.Platform = process.platform): boolean {
  const isAbs = platform === 'win32' ? path.win32.isAbsolute : path.posix.isAbsolute;
  return normalizeEnvEntries(raw).some((e) => isConfigDirName(e.name, platform) && !isAbs(e.value));
}

/** Set (or remove, if undefined) CLAUDE_CONFIG_DIR, keeping other entries and the shape. */
export function withConfigDir(raw: unknown, dir: string | undefined, platform: NodeJS.Platform = process.platform): unknown {
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const next: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!isConfigDirName(name, platform)) {
        next[name] = value;
      }
    }
    if (dir !== undefined) {
      next[CONFIG_DIR_VAR] = dir;
    }
    return next;
  }
  const kept = Array.isArray(raw)
    ? raw.filter(
        (e) =>
          !(e !== null && typeof e === 'object' && typeof (e as { name?: unknown }).name === 'string' &&
            isConfigDirName((e as { name: string }).name, platform)),
      )
    : [];
  return dir === undefined ? kept : [...kept, { name: CONFIG_DIR_VAR, value: dir }];
}
