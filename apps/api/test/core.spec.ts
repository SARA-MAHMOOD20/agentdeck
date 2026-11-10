import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, toOpenAiTool } from '../src/agents/core/tool.js';
import { echoTool } from '../src/agents/echo/echo.agent.js';
import { Crypto } from '../src/common/crypto.js';
import { nextMidnight, pacificDate } from '../src/common/time.js';
import { loadEnv } from '../src/config/env.schema.js';

describe('Crypto (AES-256-GCM)', () => {
  const crypto = new Crypto(randomBytes(32).toString('base64'));

  it('round-trips and uses a fresh IV each time', () => {
    const a = crypto.encrypt('refresh-token-123');
    const b = crypto.encrypt('refresh-token-123');
    expect(a).not.toBe(b);
    expect(crypto.decrypt(a)).toBe('refresh-token-123');
  });

  it('rejects tampered data and the wrong key', () => {
    const enc = crypto.encrypt('secret');
    const parts = enc.split(':');
    parts[3] = Buffer.from('tampered').toString('base64');
    expect(() => crypto.decrypt(parts.join(':'))).toThrow();
    expect(() => new Crypto(randomBytes(32).toString('base64')).decrypt(enc)).toThrow();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new Crypto(randomBytes(16).toString('base64'))).toThrow();
  });
});

describe('tool schemas', () => {
  it('converts zod input to an OpenAI function definition', () => {
    const def = toOpenAiTool(echoTool);
    expect(def).toMatchObject({
      type: 'function',
      function: {
        name: 'echo',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
    });
    expect(def.type === 'function' && def.function.parameters).not.toHaveProperty('$schema');
  });

  it('validates tool input with zod', () => {
    const tool = defineTool({
      name: 't',
      description: 'd',
      input: z.object({ start: z.iso.datetime(), minutes: z.number().int().positive() }),
      execute: async () => null,
    });
    expect(tool.input.safeParse({ start: '2026-11-12T14:00:00Z', minutes: 30 }).success).toBe(true);
    expect(tool.input.safeParse({ start: 'Thursday', minutes: -5 }).success).toBe(false);
  });
});

describe('time helpers', () => {
  it('uses the Pacific calendar date', () => {
    expect(pacificDate(Date.parse('2026-11-10T07:59:59Z'))).toBe('2026-11-09');
    expect(pacificDate(Date.parse('2026-11-10T08:00:00Z'))).toBe('2026-11-10');
  });

  it('finds the next midnight across a DST change', () => {
    // US DST ends 1 Nov 2026: midnight on 2 Nov is 08:00 UTC (PST), on 1 Nov it was 07:00 UTC (PDT).
    expect(new Date(nextMidnight(Date.parse('2026-11-01T12:00:00Z'), 'America/Los_Angeles')).toISOString()).toBe(
      '2026-11-02T08:00:00.000Z',
    );
    expect(new Date(nextMidnight(Date.parse('2026-10-31T12:00:00Z'), 'America/Los_Angeles')).toISOString()).toBe(
      '2026-11-01T07:00:00.000Z',
    );
  });
});

describe('env validation', () => {
  const valid = {
    LLM_API_KEY: 'k',
    LLM_BASE_URL: 'https://example.com/v1/',
    LLM_MODEL_FAST: 'fast',
    LLM_MODEL_SMART: 'smart',
    LLM_RPM_LIMIT: '13',
    LLM_RPD_LIMIT: '450',
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'pk',
    SUPABASE_SECRET_KEY: 'sk',
    TIMEZONE: 'Asia/Karachi',
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    DASHBOARD_ALLOWED_EMAIL: 'me@example.com',
    DASHBOARD_URL: 'http://localhost:5173',
    API_URL: 'http://localhost:3000',
    UNI_EMAIL_DOMAINS: 'isb.nu.edu.pk, nu.edu.pk',
    DISCORD_BOT_TOKEN: '',
  };

  it('parses a valid env, coercing numbers and lists', () => {
    const env = loadEnv(valid);
    expect(env.LLM_RPM_LIMIT).toBe(13);
    expect(env.UNI_EMAIL_DOMAINS).toEqual(['isb.nu.edu.pk', 'nu.edu.pk']);
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
  });

  it('lists every problem without printing values', () => {
    const bad = { ...valid, LLM_API_KEY: '', TIMEZONE: 'GMT+5', ENCRYPTION_KEY: 'short-secret' };
    let message = '';
    try {
      loadEnv(bad);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('LLM_API_KEY');
    expect(message).toContain('TIMEZONE');
    expect(message).toContain('ENCRYPTION_KEY');
    expect(message).not.toContain('short-secret');
  });
});
