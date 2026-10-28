import type { UsageCacheFile, UsageRecord } from '../types/usage';
import type { Logger } from '../utils/logger';
import { atomicWriteFile, readJsonFile } from '../utils/filesystem';
import { isValidProfileId } from '../utils/paths';
import { mergeRecords } from './usageModel';

// usage-cache.json. Shared by windows: each write re-reads and merges per profile.

function sanitizeWindow(raw: unknown): { usedPercent: number; resetsAt?: number } | undefined {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const w = raw as Record<string, unknown>;
  if (typeof w.usedPercent !== 'number' || !Number.isFinite(w.usedPercent) || w.usedPercent < 0) {
    return undefined;
  }
  const resetsAt =
    typeof w.resetsAt === 'number' && Number.isFinite(w.resetsAt) ? w.resetsAt : undefined;
  return { usedPercent: w.usedPercent, resetsAt };
}

export function sanitizeRecord(raw: unknown): UsageRecord | undefined {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const out: UsageRecord = {};
  const s = r.snapshot as Record<string, unknown> | undefined;
  if (
    s &&
    typeof s === 'object' &&
    typeof s.observedAt === 'number' &&
    (s.source === 'cli-usage' || s.source === 'status-line')
  ) {
    const fiveHour = sanitizeWindow(s.fiveHour);
    const sevenDay = sanitizeWindow(s.sevenDay);
    if (fiveHour || sevenDay) {
      out.snapshot = { fiveHour, sevenDay, observedAt: s.observedAt, source: s.source };
    }
  }
  if (typeof r.lastAttemptAt === 'number') {
    out.lastAttemptAt = r.lastAttemptAt;
  }
  const e = r.lastError as Record<string, unknown> | undefined;
  if (e && typeof e === 'object' && typeof e.kind === 'string' && typeof e.at === 'number') {
    const kinds = ['auth', 'unsupported', 'cli-unsupported', 'cli', 'parse'];
    if (kinds.includes(e.kind)) {
      out.lastError = {
        kind: e.kind as NonNullable<UsageRecord['lastError']>['kind'],
        at: e.at,
        message: typeof e.message === 'string' ? e.message.slice(0, 500) : '',
      };
    }
  }
  return out;
}

export function sanitizeCacheFile(raw: unknown): UsageCacheFile {
  const records: Record<string, UsageRecord> = {};
  if (raw !== null && typeof raw === 'object') {
    const rec = (raw as Record<string, unknown>).records;
    if (rec !== null && typeof rec === 'object') {
      for (const [id, value] of Object.entries(rec as Record<string, unknown>)) {
        if (isValidProfileId(id)) {
          const r = sanitizeRecord(value);
          if (r) {
            records[id] = r;
          }
        }
      }
    }
  }
  return { version: 1, records };
}

export class UsageCache {
  private data: UsageCacheFile = { version: 1, records: {} };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    readonly file: string,
    private readonly logger: Logger,
  ) {}

  async load(): Promise<void> {
    this.data = await this.readDisk();
  }

  private async readDisk(): Promise<UsageCacheFile> {
    const result = await readJsonFile(this.file, 4 * 1024 * 1024);
    if (result.kind === 'ok') {
      return sanitizeCacheFile(result.value);
    }
    if (result.kind === 'invalid') {
      this.logger.warn(`usage-cache.json is unreadable (${result.error}); starting with an empty cache`);
    }
    return { version: 1, records: {} };
  }

  get(id: string): UsageRecord | undefined {
    return this.data.records[id];
  }

  update(id: string, mutate: (current: UsageRecord) => UsageRecord): Promise<void> {
    const run = async (): Promise<void> => {
      const disk = await this.readDisk();
      const merged: Record<string, UsageRecord> = {};
      const ids = new Set([...Object.keys(disk.records), ...Object.keys(this.data.records)]);
      for (const key of ids) {
        merged[key] = mergeRecords(this.data.records[key], disk.records[key]);
      }
      merged[id] = mutate(merged[id] ?? {});
      this.data = { version: 1, records: merged };
      await atomicWriteFile(this.file, JSON.stringify(this.data, null, 2) + '\n', 0o600);
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }

  remove(id: string): Promise<void> {
    const run = async (): Promise<void> => {
      const disk = await this.readDisk();
      delete disk.records[id];
      delete this.data.records[id];
      this.data = disk;
      await atomicWriteFile(this.file, JSON.stringify(this.data, null, 2) + '\n', 0o600);
    };
    this.writeChain = this.writeChain.then(run, run);
    return this.writeChain;
  }
}
