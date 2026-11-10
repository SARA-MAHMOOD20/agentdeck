/** Gemini's daily quotas reset at midnight Pacific time. */
export const QUOTA_TIMEZONE = 'America/Los_Angeles';

function parts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(date)) if (p.type !== 'literal') out[p.type] = Number(p.value);
  return out as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** Calendar date (YYYY-MM-DD) of `ms` in the given zone. */
export function dateInZone(ms: number, timeZone: string): string {
  const p = parts(new Date(ms), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Offset (ms) of `timeZone` from UTC at instant `ms`. */
function zoneOffset(ms: number, timeZone: string): number {
  const p = parts(new Date(ms), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC instant for a wall-clock time in `timeZone`. Handles DST shifts. */
export function zonedToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  timeZone: string,
): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let ts = guess - zoneOffset(guess, timeZone);
  ts = guess - zoneOffset(ts, timeZone);
  return ts;
}

/** The next midnight in `timeZone` after `ms`, as a UTC timestamp. */
export function nextMidnight(ms: number, timeZone: string): number {
  const p = parts(new Date(ms), timeZone);
  const tomorrow = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  return zonedToUtc(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate(),
    0,
    0,
    timeZone,
  );
}

export const pacificDate = (ms: number) => dateInZone(ms, QUOTA_TIMEZONE);
export const nextPacificMidnight = (ms: number) => nextMidnight(ms, QUOTA_TIMEZONE);

/** Human-readable local time, e.g. "Tuesday, 10 November 2026, 16:20 (Asia/Karachi)". */
export function formatLocal(ms: number, timeZone: string): string {
  const s = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));
  return `${s} (${timeZone})`;
}
