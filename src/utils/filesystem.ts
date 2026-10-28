import { promises as fs } from 'fs';
import * as path from 'path';
import { randomBytes } from 'crypto';

/** Create a directory (and parents) readable only by the current user. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

/** Write to a temp file next to the target, then rename. Keeps the old mode unless one is given. */
export async function atomicWriteFile(file: string, data: string, mode?: number): Promise<void> {
  const dir = path.dirname(file);
  await ensurePrivateDir(dir);
  let finalMode = mode;
  if (finalMode === undefined) {
    try {
      finalMode = (await fs.stat(file)).mode & 0o777;
    } catch {
      finalMode = 0o600;
    }
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const handle = await fs.open(tmp, 'wx', finalMode);
  try {
    await handle.writeFile(data, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.chmod(tmp, finalMode);
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true });
    throw error;
  }
}

export type JsonReadResult =
  | { kind: 'missing' }
  | { kind: 'ok'; value: unknown }
  | { kind: 'invalid'; error: string };

export async function readJsonFile(file: string, maxBytes = 1024 * 1024): Promise<JsonReadResult> {
  let stat;
  try {
    stat = await fs.stat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'missing' };
    }
    return { kind: 'invalid', error: (error as Error).message };
  }
  if (!stat.isFile()) {
    return { kind: 'invalid', error: 'not a regular file' };
  }
  if (stat.size > maxBytes) {
    return { kind: 'invalid', error: `file is larger than ${maxBytes} bytes` };
  }
  try {
    const text = await fs.readFile(file, 'utf8');
    return { kind: 'ok', value: JSON.parse(text) };
  } catch (error) {
    return { kind: 'invalid', error: (error as Error).message };
  }
}

export function normalizeDir(p: string): string {
  const resolved = path.resolve(p);
  const root = path.parse(resolved).root;
  return resolved.length > root.length ? resolved.replace(/[\\/]+$/, '') : resolved;
}

export function samePath(a: string, b: string): boolean {
  return normalizeDir(a) === normalizeDir(b);
}

/** Same path textually, or the same location after resolving symbolic links. */
export async function sameLocation(a: string, b: string): Promise<boolean> {
  if (samePath(a, b)) {
    return true;
  }
  try {
    const [ra, rb] = await Promise.all([fs.realpath(a), fs.realpath(b)]);
    return samePath(ra, rb);
  } catch {
    return false;
  }
}

export function isStrictlyInside(parent: string, child: string): boolean {
  const rel = path.relative(normalizeDir(parent), normalizeDir(child));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Quote a string for POSIX sh using single quotes. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
