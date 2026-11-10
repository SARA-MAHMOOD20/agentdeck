import type OpenAI from 'openai';
import { AGENT_PRIORITY, type AgentId, type ModelUsage } from '@agentdeck/shared';
import { httpStatus, isTransient, withRetry } from '../common/retry.js';
import { nextPacificMidnight, pacificDate } from '../common/time.js';
import { QuotaExhaustedError, UnknownModelError } from './errors.js';

export type ChatParams = OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
export type ChatCompletion = OpenAI.Chat.ChatCompletion;

export interface ChatClient {
  create(params: ChatParams): Promise<ChatCompletion>;
}

/** One model the queue can send to, with its own limits. */
export interface ModelTarget {
  model: string;
  rpm: number;
  rpd: number;
  client: ChatClient;
}

export interface UsageStore {
  countsFor(date: string): Promise<Record<string, number>>;
  incrementRequests(model: string, date: string): Promise<number>;
  addTokens(model: string, date: string, tokensIn: number, tokensOut: number): Promise<void>;
}

export interface QueueClock {
  now(): number;
  sleep(ms: number): Promise<void>;
  random(): number;
}

export interface QueueHooks {
  /** Called once per model per Pacific day when its daily quota runs out. */
  onExhausted?(model: string, resetsAt: number): void;
  onRetry?(model: string, err: unknown, attempt: number, delayMs: number): void;
  onStoreError?(err: unknown): void;
}

export interface QueueOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface QueueRequest {
  agentId: AgentId;
  model: string;
  params: Omit<ChatParams, 'model'>;
}

export interface QueueResult {
  completion: ChatCompletion;
  /** Requests actually sent (1 + retries). */
  attempts: number;
}

interface ModelState {
  date: string;
  count: number;
  exhausted: boolean;
  notified: boolean;
  sends: number[];
}

interface Waiter {
  priority: number;
  seq: number;
  model: string;
  resolve: () => void;
  reject: (err: unknown) => void;
}

const WINDOW_MS = 60_000;
const DEFAULTS: QueueOptions = { maxRetries: 4, baseDelayMs: 1_000, maxDelayMs: 30_000 };

export const realClock: QueueClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  random: () => Math.random(),
};

/** A 429 that says the per-day quota (not per-minute) is gone. */
export function isDailyQuotaError(err: unknown): boolean {
  if (httpStatus(err) !== 429) return false;
  const text = JSON.stringify(err instanceof Error ? { m: err.message, e: err } : err);
  return /PerDay|per day|requests_per_day/i.test(text);
}

/** Retry-After header or Gemini's RetryInfo.retryDelay, in ms. */
export function retryDelayHint(err: unknown): number | undefined {
  const e = err as { headers?: { get?: (k: string) => string | null } | Record<string, string> } | null;
  const header =
    typeof e?.headers?.get === 'function'
      ? (e.headers as { get: (k: string) => string | null }).get('retry-after')
      : (e?.headers as Record<string, string> | undefined)?.['retry-after'];
  if (header && !Number.isNaN(Number(header))) return Number(header) * 1000;
  const text = err instanceof Error ? err.message + JSON.stringify(err) : JSON.stringify(err);
  const m = /retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s/i.exec(text) ?? /retry in (\d+(?:\.\d+)?)\s*s/i.exec(text);
  return m ? Math.ceil(Number(m[1]) * 1000) : undefined;
}

/**
 * Global LLM gate: per-model RPM (sliding 60 s window) and RPD (persisted, Pacific day),
 * priority ordering across agents, and retries with backoff + jitter.
 */
export class LlmQueue {
  private readonly targets = new Map<string, ModelTarget>();
  private readonly state = new Map<string, ModelState>();
  private waiters: Waiter[] = [];
  private seq = 0;
  private wakeScheduled = false;
  private readonly opts: QueueOptions;

  constructor(
    targets: ModelTarget[],
    private readonly store: UsageStore,
    private readonly clock: QueueClock = realClock,
    private readonly hooks: QueueHooks = {},
    opts: Partial<QueueOptions> = {},
  ) {
    for (const t of targets) this.targets.set(t.model, t);
    this.opts = { ...DEFAULTS, ...opts };
  }

  /** Load today's persisted counts so a restart doesn't reset them. */
  async init(): Promise<void> {
    const date = pacificDate(this.clock.now());
    const counts = await this.store.countsFor(date);
    for (const model of this.targets.keys()) {
      const count = counts[model] ?? 0;
      const s = this.roll(model);
      s.count = Math.max(s.count, count);
    }
  }

  isExhausted(model: string): boolean {
    const t = this.targets.get(model);
    if (!t) return false;
    const s = this.roll(model);
    return s.exhausted || s.count >= t.rpd;
  }

  async chat(req: QueueRequest): Promise<QueueResult> {
    const target = this.targets.get(req.model);
    if (!target) throw new UnknownModelError(req.model);
    const priority = AGENT_PRIORITY[req.agentId] ?? 99;
    let attempts = 0;

    const completion = await withRetry(
      async () => {
        await this.acquire(target, priority);
        attempts++;
        const date = this.roll(target.model).date;
        try {
          const res = await target.client.create({ ...req.params, model: target.model });
          const u = res.usage;
          if (u) {
            this.store
              .addTokens(target.model, date, u.prompt_tokens ?? 0, u.completion_tokens ?? 0)
              .catch((e) => this.hooks.onStoreError?.(e));
          }
          return res;
        } catch (err) {
          if (isDailyQuotaError(err)) {
            this.markExhausted(target.model);
            throw new QuotaExhaustedError(target.model, nextPacificMidnight(this.clock.now()));
          }
          throw err;
        }
      },
      {
        retries: this.opts.maxRetries,
        baseMs: this.opts.baseDelayMs,
        maxMs: this.opts.maxDelayMs,
        isRetryable: (e) => !(e instanceof QuotaExhaustedError) && isTransient(e),
        delayHint: retryDelayHint,
        sleep: (ms) => this.clock.sleep(ms),
        random: () => this.clock.random(),
        onRetry: (e, attempt, delay) => this.hooks.onRetry?.(target.model, e, attempt, delay),
      },
    );
    return { completion, attempts };
  }

  getUsage(): ModelUsage[] {
    const resetsAt = new Date(nextPacificMidnight(this.clock.now())).toISOString();
    const now = this.clock.now();
    return [...this.targets.values()].map((t) => {
      const s = this.roll(t.model);
      return {
        model: t.model,
        used: s.count,
        limit: t.rpd,
        rpmUsed: s.sends.filter((ts) => ts > now - WINDOW_MS).length,
        rpmLimit: t.rpm,
        exhausted: s.exhausted || s.count >= t.rpd,
        resetsAt,
      };
    });
  }

  // ---------------------------------------------------------------------------

  /** Wait for a send slot. Rejects with QuotaExhaustedError if the day's quota is gone. */
  private acquire(target: ModelTarget, priority: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.waiters.push({ priority, seq: this.seq++, model: target.model, resolve, reject });
      this.pump();
    });
  }

  /** Grant every slot that is available now, highest priority first; schedule a wake-up for the rest. */
  private pump(): void {
    const now = this.clock.now();
    this.waiters.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    const remaining: Waiter[] = [];

    for (const w of this.waiters) {
      const target = this.targets.get(w.model)!;
      const s = this.roll(w.model);
      if (s.exhausted || s.count >= target.rpd) {
        this.markExhausted(w.model);
        w.reject(new QuotaExhaustedError(w.model, nextPacificMidnight(now)));
        continue;
      }
      s.sends = s.sends.filter((ts) => ts > now - WINDOW_MS);
      if (s.sends.length < target.rpm) {
        s.sends.push(now);
        s.count++;
        this.store
          .incrementRequests(w.model, s.date)
          .then((n) => {
            if (this.state.get(w.model)?.date === s.date) s.count = Math.max(s.count, n);
          })
          .catch((e) => this.hooks.onStoreError?.(e));
        w.resolve();
      } else {
        remaining.push(w);
      }
    }
    this.waiters = remaining;

    if (remaining.length && !this.wakeScheduled) {
      const waits = remaining.map((w) => {
        const oldest = this.state.get(w.model)!.sends[0] ?? now;
        return Math.max(1, oldest + WINDOW_MS - now);
      });
      this.wakeScheduled = true;
      void this.clock.sleep(Math.min(...waits)).then(() => {
        this.wakeScheduled = false;
        this.pump();
      });
    }
  }

  /** State for the current Pacific day; rolls over at midnight. */
  private roll(model: string): ModelState {
    const date = pacificDate(this.clock.now());
    let s = this.state.get(model);
    if (!s || s.date !== date) {
      s = { date, count: 0, exhausted: false, notified: false, sends: s?.sends ?? [] };
      this.state.set(model, s);
    }
    return s;
  }

  private markExhausted(model: string): void {
    const s = this.roll(model);
    s.exhausted = true;
    if (!s.notified) {
      s.notified = true;
      this.hooks.onExhausted?.(model, nextPacificMidnight(this.clock.now()));
    }
  }
}
