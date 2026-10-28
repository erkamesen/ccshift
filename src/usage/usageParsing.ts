import type { UsageSnapshot, UsageWindow } from '../types/usage';

// Two sources:
//  - status line JSON: rate_limits.{five_hour,seven_day}.{used_percentage,resets_at (unix s)}
//  - `claude -p /usage` stream-json: usage_report.rate_limits.limits[] (marked experimental)
// Missing values stay undefined.

function finiteNumber(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined;
}

function validPercent(x: unknown): number | undefined {
  const n = finiteNumber(x);
  // Over 100 is possible when a limit is exceeded; negative is never valid.
  return n !== undefined && n >= 0 && n <= 1000 ? n : undefined;
}

export function epochSecondsToMs(x: unknown): number | undefined {
  const n = finiteNumber(x);
  if (n === undefined || n <= 1_000_000_000 || n >= 100_000_000_000) {
    return undefined;
  }
  return Math.round(n * 1000);
}

export function isoToMs(x: unknown): number | undefined {
  if (typeof x !== 'string' || x.length > 64) {
    return undefined;
  }
  const ms = Date.parse(x);
  return Number.isFinite(ms) ? ms : undefined;
}

function statusLineWindow(raw: unknown): UsageWindow | undefined {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const w = raw as Record<string, unknown>;
  const usedPercent = validPercent(w.used_percentage);
  if (usedPercent === undefined) {
    return undefined;
  }
  return { usedPercent, resetsAt: epochSecondsToMs(w.resets_at) };
}

export function snapshotFromStatusLine(payload: unknown, observedAt: number): UsageSnapshot | undefined {
  if (payload === null || typeof payload !== 'object') {
    return undefined;
  }
  const rl = (payload as Record<string, unknown>).rate_limits;
  if (rl === null || typeof rl !== 'object') {
    return undefined;
  }
  const r = rl as Record<string, unknown>;
  const fiveHour = statusLineWindow(r.five_hour);
  const sevenDay = statusLineWindow(r.seven_day);
  if (!fiveHour && !sevenDay) {
    return undefined;
  }
  return { fiveHour, sevenDay, observedAt, source: 'status-line' };
}

export type UsageReportOutcome =
  | { kind: 'ok'; snapshot: UsageSnapshot }
  /** report present but no 5h/weekly rows */
  | { kind: 'no-limits' }
  /** no usage_report at all (signed out or old CLI) */
  | { kind: 'no-report' };

interface LimitRow {
  kind?: string;
  group?: string;
  percent?: number;
  resetsAt?: number;
  scoped: boolean;
}

function parseLimitRow(raw: unknown): LimitRow | undefined {
  if (raw === null || typeof raw !== 'object') {
    return undefined;
  }
  const r = raw as Record<string, unknown>;
  const scope = r.scope;
  const scoped =
    scope !== null &&
    typeof scope === 'object' &&
    Object.values(scope as Record<string, unknown>).some((v) => v !== null && v !== undefined);
  return {
    kind: typeof r.kind === 'string' ? r.kind : undefined,
    group: typeof r.group === 'string' ? r.group : undefined,
    percent: validPercent(r.percent),
    resetsAt: isoToMs(r.resets_at),
    scoped,
  };
}

function pickWindow(rows: LimitRow[], kinds: string[], group: string): UsageWindow | undefined {
  const row =
    rows.find((r) => r.kind !== undefined && kinds.includes(r.kind) && r.percent !== undefined) ??
    rows.find((r) => r.group === group && !r.scoped && r.percent !== undefined);
  return row && row.percent !== undefined ? { usedPercent: row.percent, resetsAt: row.resetsAt } : undefined;
}

export function snapshotFromUsageReport(report: unknown, observedAt: number): UsageReportOutcome {
  if (report === null || typeof report !== 'object') {
    return { kind: 'no-limits' };
  }
  const rl = (report as Record<string, unknown>).rate_limits;
  if (rl === null || typeof rl !== 'object') {
    return { kind: 'no-limits' };
  }
  const limits = (rl as Record<string, unknown>).limits;
  if (!Array.isArray(limits)) {
    return { kind: 'no-limits' };
  }
  const rows = limits.map(parseLimitRow).filter((r): r is LimitRow => r !== undefined);
  const fiveHour = pickWindow(rows, ['session', 'five_hour'], 'session');
  const sevenDay = pickWindow(rows, ['weekly_all', 'seven_day'], 'weekly');
  if (!fiveHour && !sevenDay) {
    return { kind: 'no-limits' };
  }
  return { kind: 'ok', snapshot: { fiveHour, sevenDay, observedAt, source: 'cli-usage' } };
}

export function parseUsageStream(stdout: string, observedAt: number): UsageReportOutcome {
  let sawReportKey = false;
  let lastReport: unknown = undefined;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) {
      continue;
    }
    let msg: unknown;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (msg === null || typeof msg !== 'object') {
      continue;
    }
    const m = msg as Record<string, unknown>;
    if (m.type === 'assistant' && 'usage_report' in m) {
      sawReportKey = true;
      lastReport = m.usage_report;
    }
  }
  if (!sawReportKey) {
    return { kind: 'no-report' };
  }
  return snapshotFromUsageReport(lastReport, observedAt);
}
