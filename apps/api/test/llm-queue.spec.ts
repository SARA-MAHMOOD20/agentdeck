import { describe, expect, it, vi } from 'vitest';
import { QuotaExhaustedError } from '../src/llm/errors.js';
import {
  LlmQueue,
  retryDelayHint,
  type ChatCompletion,
  type ChatParams,
  type ModelTarget,
  type QueueClock,
  type UsageStore,
} from '../src/llm/llm-queue.js';

/** Clock where a sleep finishes on the next macrotask and jumps time forward by its length. */
function fakeClock(startIso = '2026-11-10T12:00:00Z') {
  let now = Date.parse(startIso);
  const sleeps: number[] = [];
  const clock: QueueClock & { set(iso: string): void; sleeps: number[] } = {
    now: () => now,
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        sleeps.push(ms);
        setTimeout(() => {
          now += ms;
          resolve();
        }, 0);
      }),
    random: () => 0,
    set: (iso) => {
      now = Date.parse(iso);
    },
    sleeps,
  };
  return clock;
}

/** Usage store keyed by model + date, like the llm_usage table. `initial` counts apply to every date. */
function memoryStore(initial: Record<string, number> = {}): UsageStore & { counts: Map<string, number> } {
  const counts = new Map<string, number>();
  const get = (model: string, date: string) => counts.get(`${model}|${date}`) ?? initial[model] ?? 0;
  return {
    counts,
    countsFor: async (date) => Object.fromEntries(Object.keys(initial).map((m) => [m, get(m, date)])),
    incrementRequests: async (model, date) => {
      const n = get(model, date) + 1;
      counts.set(`${model}|${date}`, n);
      return n;
    },
    addTokens: async () => {},
  };
}

const ok = (content = 'ok'): ChatCompletion =>
  ({
    id: 'x',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [{ index: 0, finish_reason: 'stop', logprobs: null, message: { role: 'assistant', content, refusal: null } }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  }) as ChatCompletion;

function target(model: string, rpm: number, rpd: number, create?: (p: ChatParams) => Promise<ChatCompletion>) {
  const calls: { model: string; tag: string; at: number }[] = [];
  return {
    calls,
    target: (clock: QueueClock): ModelTarget => ({
      model,
      rpm,
      rpd,
      client: {
        create: async (p) => {
          calls.push({ model, tag: String((p.messages[0] as { content: string }).content), at: clock.now() });
          return create ? create(p) : ok();
        },
      },
    }),
  };
}

const req = (agentId: 'orchestrator' | 'calendar' | 'uni_email' | 'whatsapp', model: string, tag: string = agentId) => ({
  agentId,
  model,
  params: { messages: [{ role: 'user' as const, content: tag }] },
});

describe('LlmQueue', () => {
  it('enforces the per-minute limit with a sliding window', async () => {
    const clock = fakeClock();
    const t = target('fast', 2, 100);
    const q = new LlmQueue([t.target(clock)], memoryStore(), clock);
    const start = clock.now();

    await Promise.all([q.chat(req('uni_email', 'fast', 'a')), q.chat(req('uni_email', 'fast', 'b')), q.chat(req('uni_email', 'fast', 'c'))]);

    expect(t.calls.map((c) => c.tag)).toEqual(['a', 'b', 'c']);
    expect(t.calls[0]!.at).toBe(start);
    expect(t.calls[1]!.at).toBe(start);
    expect(t.calls[2]!.at).toBeGreaterThanOrEqual(start + 60_000);
  });

  it('serves waiting requests in priority order: orchestrator > calendar > uni_email > whatsapp', async () => {
    const clock = fakeClock();
    const t = target('fast', 1, 100);
    const q = new LlmQueue([t.target(clock)], memoryStore(), clock);

    // First request takes the only slot; the rest queue up while it's full.
    await Promise.all([
      q.chat(req('whatsapp', 'fast', 'first')),
      q.chat(req('whatsapp', 'fast')),
      q.chat(req('uni_email', 'fast')),
      q.chat(req('calendar', 'fast')),
      q.chat(req('orchestrator', 'fast')),
    ]);

    expect(t.calls.map((c) => c.tag)).toEqual(['first', 'orchestrator', 'calendar', 'uni_email', 'whatsapp']);
  });

  it('limits each model separately', async () => {
    const clock = fakeClock();
    const fast = target('fast', 1, 100);
    const smart = target('smart', 1, 100);
    const q = new LlmQueue([fast.target(clock), smart.target(clock)], memoryStore(), clock);
    const start = clock.now();

    await Promise.all([q.chat(req('uni_email', 'fast')), q.chat(req('calendar', 'smart'))]);

    expect(fast.calls[0]!.at).toBe(start);
    expect(smart.calls[0]!.at).toBe(start);
  });

  it('rejects once the daily limit is reached and notifies only once', async () => {
    const clock = fakeClock();
    const t = target('fast', 100, 2);
    const onExhausted = vi.fn();
    const q = new LlmQueue([t.target(clock)], memoryStore(), clock, { onExhausted });

    await q.chat(req('uni_email', 'fast'));
    await q.chat(req('uni_email', 'fast'));
    await expect(q.chat(req('uni_email', 'fast'))).rejects.toBeInstanceOf(QuotaExhaustedError);
    await expect(q.chat(req('orchestrator', 'fast'))).rejects.toBeInstanceOf(QuotaExhaustedError);

    expect(t.calls).toHaveLength(2);
    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(q.getUsage()[0]).toMatchObject({ used: 2, limit: 2, exhausted: true });
  });

  it('loads persisted daily counts on init so restarts do not reset them', async () => {
    const clock = fakeClock();
    const t = target('fast', 100, 5);
    const q = new LlmQueue([t.target(clock)], memoryStore({ fast: 5 }), clock);
    await q.init();

    await expect(q.chat(req('uni_email', 'fast'))).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(t.calls).toHaveLength(0);
  });

  it('resets at midnight Pacific time', async () => {
    // 07:59 UTC on 10 Nov = 23:59 PST on 9 Nov.
    const clock = fakeClock('2026-11-10T07:59:00Z');
    const t = target('fast', 100, 1);
    const q = new LlmQueue([t.target(clock)], memoryStore(), clock);

    await q.chat(req('uni_email', 'fast'));
    await expect(q.chat(req('uni_email', 'fast'))).rejects.toBeInstanceOf(QuotaExhaustedError);

    clock.set('2026-11-10T08:00:30Z'); // 00:00:30 PST on 10 Nov
    expect(q.isExhausted('fast')).toBe(false);
    expect(q.getUsage()[0]).toMatchObject({ used: 0, resetsAt: '2026-11-11T08:00:00.000Z' });
    await expect(q.chat(req('uni_email', 'fast'))).resolves.toBeDefined();
    expect(q.getUsage()[0]).toMatchObject({ used: 1 });
  });

  it('retries 429s and 5xx with exponential backoff plus jitter', async () => {
    const clock = fakeClock();
    let n = 0;
    const t = target('fast', 100, 100, async () => {
      n++;
      if (n === 1) throw Object.assign(new Error('rate limited'), { status: 429 });
      if (n === 2) throw Object.assign(new Error('unavailable'), { status: 503 });
      return ok();
    });
    const q = new LlmQueue([t.target(clock)], memoryStore(), { ...clock, random: () => 0.5 }, {}, { baseDelayMs: 1000 });

    const res = await q.chat(req('uni_email', 'fast'));

    expect(res.attempts).toBe(3);
    expect(clock.sleeps).toEqual([1000 + 250, 2000 + 250]);
  });

  it('honours the retry delay Gemini sends', async () => {
    const clock = fakeClock();
    let n = 0;
    const t = target('fast', 100, 100, async () => {
      if (n++ === 0) throw Object.assign(new Error('429 {"retryDelay": "7s"}'), { status: 429 });
      return ok();
    });
    const q = new LlmQueue([t.target(clock)], memoryStore(), clock);

    await q.chat(req('uni_email', 'fast'));
    expect(clock.sleeps[0]).toBe(7000);
  });

  it('treats a daily-quota 429 as exhaustion without retrying', async () => {
    const clock = fakeClock();
    const err = Object.assign(new Error('429 quota exceeded: GenerateRequestsPerDayPerProjectPerModel-FreeTier'), {
      status: 429,
    });
    const t = target('fast', 100, 100, async () => {
      throw err;
    });
    const onExhausted = vi.fn();
    const q = new LlmQueue([t.target(clock)], memoryStore(), clock, { onExhausted });

    await expect(q.chat(req('uni_email', 'fast'))).rejects.toBeInstanceOf(QuotaExhaustedError);
    expect(t.calls).toHaveLength(1);
    expect(onExhausted).toHaveBeenCalledOnce();
    expect(q.isExhausted('fast')).toBe(true);
  });

  it('does not retry client errors like 400', async () => {
    const clock = fakeClock();
    const t = target('fast', 100, 100, async () => {
      throw Object.assign(new Error('bad request'), { status: 400 });
    });
    const q = new LlmQueue([t.target(clock)], memoryStore(), clock);

    await expect(q.chat(req('uni_email', 'fast'))).rejects.toThrow('bad request');
    expect(t.calls).toHaveLength(1);
  });

  it('persists each request to the usage store', async () => {
    const clock = fakeClock();
    const store = memoryStore();
    const q = new LlmQueue([target('fast', 100, 100).target(clock)], store, clock);
    await q.chat(req('uni_email', 'fast'));
    await q.chat(req('uni_email', 'fast'));
    await new Promise((r) => setImmediate(r));
    expect(store.counts.get('fast|2026-11-10')).toBe(2);
  });
});

describe('retryDelayHint', () => {
  it('reads Retry-After headers and Gemini retryDelay', () => {
    expect(retryDelayHint({ headers: { 'retry-after': '3' } })).toBe(3000);
    expect(retryDelayHint(new Error('{"@type":"RetryInfo","retryDelay":"12.5s"}'))).toBe(12500);
    expect(retryDelayHint(new Error('nothing here'))).toBeUndefined();
  });
});
