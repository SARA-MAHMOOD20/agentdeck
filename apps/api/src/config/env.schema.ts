import { z } from 'zod';

/** Treat empty strings from .env as "not set". */
const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const required = () => z.preprocess(blankToUndefined, z.string().trim().min(1, 'is required'));
const optional = () => z.preprocess(blankToUndefined, z.string().trim().optional());
const url = () => z.preprocess(blankToUndefined, z.url('must be a URL'));
const optionalUrl = () => z.preprocess(blankToUndefined, z.url('must be a URL').optional());
const positiveInt = () => z.preprocess(blankToUndefined, z.coerce.number().int().positive());
const csv = () =>
  z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []),
    z.array(z.string()),
  );

const timezone = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    }, 'must be an IANA timezone name such as Asia/Karachi'),
);

const encryptionKey = z.preprocess(
  blankToUndefined,
  z
    .string()
    .trim()
    .refine(
      (k) => Buffer.from(k, 'base64').length === 32,
      'must be 32 bytes, base64-encoded (generate with: openssl rand -base64 32)',
    ),
);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().default(3000)),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),

  // LLM
  LLM_API_KEY: required(),
  LLM_BASE_URL: url(),
  LLM_MODEL_FAST: required(),
  LLM_MODEL_SMART: required(),
  LLM_RPM_LIMIT: positiveInt(),
  LLM_RPD_LIMIT: positiveInt(),
  WHATSAPP_LLM_BASE_URL: optionalUrl(),
  WHATSAPP_LLM_MODEL: optional(),

  // Supabase
  SUPABASE_URL: url(),
  SUPABASE_PUBLISHABLE_KEY: required(),
  SUPABASE_SECRET_KEY: required(),
  SUPABASE_DB_URL: optional(), // migrations only

  // Discord (Phase 2)
  DISCORD_BOT_TOKEN: optional(),
  DISCORD_OWNER_ID: optional(),
  DISCORD_GUILD_ID: optional(),
  DISCORD_CHANNEL_UNI_EMAIL: optional(),
  DISCORD_CHANNEL_CALENDAR: optional(),
  DISCORD_CHANNEL_WHATSAPP: optional(),
  DISCORD_CHANNEL_CHAT: optional(),
  DISCORD_CHANNEL_ERRORS: optional(),

  // Google (Phase 3)
  GOOGLE_CLIENT_ID: optional(),
  GOOGLE_CLIENT_SECRET: optional(),
  GOOGLE_REDIRECT_URI: optionalUrl(),
  UNI_EMAIL_DOMAINS: csv(),

  // App
  TIMEZONE: timezone,
  ENCRYPTION_KEY: encryptionKey,
  DASHBOARD_ALLOWED_EMAIL: z.preprocess(blankToUndefined, z.email('must be an email address')),
  DASHBOARD_URL: url(),
  API_URL: url(),
});

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {}

/** Parse and validate env. Throws one error listing every problem (never includes values). */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  const lines = result.error.issues.map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`);
  throw new EnvValidationError(
    `Invalid environment configuration (.env):\n${lines.join('\n')}\nSee .env.example for details.`,
  );
}

/** Feature flags derived from which optional vars are present. */
export function enabledFeatures(env: Env) {
  return {
    discord: Boolean(env.DISCORD_BOT_TOKEN && env.DISCORD_OWNER_ID && env.DISCORD_GUILD_ID),
    google: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI),
    whatsappLocalLlm: Boolean(env.WHATSAPP_LLM_BASE_URL && env.WHATSAPP_LLM_MODEL),
  };
}
