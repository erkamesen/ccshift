// All formatters take `now` so they can be tested.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < MINUTE) {
    return 'less than a minute';
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  const minutes = Math.floor((ms % HOUR) / MINUTE);
  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  return `${minutes}m`;
}

export function formatAgo(timestamp: number, now: number): string {
  const diff = now - timestamp;
  if (diff < MINUTE) {
    return 'just now';
  }
  if (diff < HOUR) {
    const m = Math.floor(diff / MINUTE);
    return `${m} minute${m === 1 ? '' : 's'} ago`;
  }
  if (diff < DAY) {
    const h = Math.floor(diff / HOUR);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  const d = Math.floor(diff / DAY);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

export function formatWeekdayTime(timestamp: number, timeZone?: string): string {
  const fmt = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone,
  });
  const parts = fmt.formatToParts(new Date(timestamp));
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '';
  return `${weekday}, ${hour === '24' ? '00' : hour}:${minute}`;
}

export function formatDateTime(timestamp: number, timeZone?: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(new Date(timestamp));
}

/** "Resets in 1h 24m" under a day, "Resets on Monday, 10:00" after that. */
export function formatReset(resetsAt: number | undefined, now: number, timeZone?: string): string {
  if (resetsAt === undefined) {
    return 'Reset time unknown';
  }
  const remaining = resetsAt - now;
  if (remaining <= 0) {
    return `Reset ${formatWeekdayTime(resetsAt, timeZone)}`;
  }
  if (remaining < DAY) {
    return `Resets in ${formatDuration(remaining)}`;
  }
  return `Resets on ${formatWeekdayTime(resetsAt, timeZone)}`;
}

export const TIME = { MINUTE, HOUR, DAY } as const;
