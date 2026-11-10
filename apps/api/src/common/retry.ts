export interface RetryOptions {
  /** Retries after the first attempt. */
  retries: number;
  baseMs: number;
  maxMs: number;
  isRetryable: (err: unknown) => boolean;
  /** Server-suggested delay (e.g. Retry-After), in ms. */
  delayHint?: (err: unknown) => number | undefined;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with 0–500 ms jitter: base × 2^attempt (capped) + jitter. */
export function backoffDelay(attempt: number, baseMs: number, maxMs: number, random = Math.random) {
  return Math.min(maxMs, baseMs * 2 ** attempt) + Math.floor(random() * 500);
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions): Promise<T> {
  const wait = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= opts.retries || !opts.isRetryable(err)) throw err;
      const hint = opts.delayHint?.(err);
      const delay = Math.max(hint ?? 0, backoffDelay(attempt, opts.baseMs, opts.maxMs, opts.random));
      opts.onRetry?.(err, attempt + 1, delay);
      await wait(delay);
    }
  }
}

/** Best-effort HTTP status from SDK errors (openai, googleapis, fetch). */
export function httpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  for (const v of [e.status, e.response?.status, e.code]) if (typeof v === 'number') return v;
  return undefined;
}

const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_SOCKET']);

/** 429, 5xx, timeouts and network errors. */
export function isTransient(err: unknown): boolean {
  const status = httpStatus(err);
  if (status === 429 || status === 408 || (status !== undefined && status >= 500)) return true;
  const e = err as { code?: unknown; name?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.code ?? e?.cause?.code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  return e?.name === 'APIConnectionError' || e?.name === 'APIConnectionTimeoutError';
}
