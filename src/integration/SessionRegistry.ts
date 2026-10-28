import { promises as fs } from 'fs';
import * as path from 'path';

// Running sessions are registered as <configDir>/sessions/<pid>.json.
// Undocumented format, so parse loosely and only use it for warnings.
// The *.key files next to them are never read.

export interface LiveSession {
  pid: number;
  sessionId?: string;
  cwd?: string;
  status?: string;
  entrypoint?: string;
  name?: string;
}

export interface SessionScan {
  readable: boolean;
  sessions: LiveSession[];
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function parseSessionEntry(value: unknown): LiveSession | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined;
  }
  const v = value as Record<string, unknown>;
  const pid = typeof v.pid === 'number' ? v.pid : Number.NaN;
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  const str = (x: unknown): string | undefined => (typeof x === 'string' && x.length < 4096 ? x : undefined);
  return {
    pid,
    sessionId: str(v.sessionId),
    cwd: str(v.cwd),
    status: str(v.status),
    entrypoint: str(v.entrypoint),
    name: str(v.name),
  };
}

export async function readLiveSessions(
  configDir: string,
  isAlive: (pid: number) => boolean = isProcessAlive,
): Promise<SessionScan> {
  const dir = path.join(configDir, 'sessions');
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    return { readable: (error as NodeJS.ErrnoException).code === 'ENOENT', sessions: [] };
  }
  const sessions: LiveSession[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) {
      continue;
    }
    try {
      const file = path.join(dir, name);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > 64 * 1024) {
        continue;
      }
      const entry = parseSessionEntry(JSON.parse(await fs.readFile(file, 'utf8')));
      if (entry && isAlive(entry.pid)) {
        sessions.push(entry);
      }
    } catch {
      // Unreadable or half-written entry: ignore it.
    }
  }
  return { readable: true, sessions };
}

export function summarizeSessions(scan: SessionScan): { total: number; busy: number } {
  return {
    total: scan.sessions.length,
    busy: scan.sessions.filter((s) => s.status === 'busy').length,
  };
}
