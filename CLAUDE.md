# agentdeck

Personal multi-agent assistant. NestJS backend runs LLM agents (Gemini via the OpenAI-compatible API); the owner talks to it through a private Discord server and a React dashboard. **Hard rule: everything must run for $0/month** — free tiers only (Supabase, Gemini, Oracle Always Free, Vercel).

Full plan and phase status: [docs/PLAN.md](docs/PLAN.md).

## Status

| Phase | State |
|---|---|
| 1 Foundation (monorepo, env, migrations, LlmQueue, runAgent, echo agent) | done |
| 2 Discord + Errors | next |
| 3–8 | not started |

## Layout

```
apps/api            NestJS 12 backend (ESM)
apps/web            React + Vite dashboard (Phase 4)
packages/shared     enums, row types, DTOs shared by api + web (ESM)
supabase/migrations SQL migrations, applied with `pnpm db:push`
scripts/            check-env.sh, db-push.sh
docs/PLAN.md        architecture plan + decisions
```

API modules live in `apps/api/src/<module>/`. Agent code: `src/agents/core` (runner, tool types), `src/agents/<agent>/`.

## Commands

```bash
pnpm install
pnpm env:check                          # which .env keys are filled (never prints values)
pnpm db:push                            # apply supabase/migrations (needs SUPABASE_DB_URL)
pnpm dev                                # API with watch mode on :3000
pnpm --filter @agentdeck/api echo "hi"  # run the echo agent once against real LLM + DB
pnpm test | pnpm typecheck | pnpm lint
```

pnpm comes from corepack (`~/.local/bin/pnpm`). Build `packages/shared` before the API if it changed (`pnpm --filter @agentdeck/shared build`).

## Architecture rules

- **All LLM calls go through `LlmService` → `LlmQueue`** (`src/llm/`). Never call the OpenAI SDK directly. The queue enforces per-model RPM (sliding 60 s) and RPD (persisted in `llm_usage`, Pacific-time day), priority `orchestrator > calendar > uni_email > whatsapp > echo`, and retries (429/5xx/network, backoff + 0–500 ms jitter). The SDK's own retries are disabled.
- **All agents run through `AgentRunner.runAgent()`** (`src/agents/core/agent-runner.ts`). It traces every LLM call / tool call / tool result to `agent_steps`, injects enabled `rules` + current local time into the system prompt, and never throws (failures → run `failed` + `agent.error` event; quota exhaustion → run `skipped`, no event).
- **Tools**: `defineTool({ name, description, input: zodSchema, execute })`. Each agent gets only its own tools. Invalid tool input is returned to the LLM as an error; exceptions inside `execute` fail the run.
- **Structured output**: `LlmService.structured({ schema, ... })` — zod-validated JSON, one retry with the validation error, then `StructuredOutputError`.
- **Gemini 3 thought signatures**: assistant messages are sent back verbatim (including `extra_content.google.thought_signature`). Don't rebuild assistant messages by hand.
- **Provider-neutral**: no provider or model names in code; everything from env (`LLM_*`).
- **Discord and HTTP controllers contain no business logic** — both call the same services.
- **WhatsApp is read-only**: never call any Baileys send/read-receipt function (ESLint rule enforces this).

## Database

- Supabase Postgres. Backend uses the **secret key** (`SUPABASE_SECRET_KEY`, bypasses RLS) via `@supabase/supabase-js`; repositories in `src/database/repos.ts`. Atomic counters are SQL functions called with `.rpc()`.
- RLS on every table. Dashboard users may only `select`, and only if `is_owner()` (JWT email = `app_owner.email`, synced from `DASHBOARD_ALLOWED_EMAIL` at boot). Secret tables (`oauth_tokens`, `whatsapp_session`, `checkpoints`) have no policies at all. All writes go through the API.
- Enum-like columns are `text` + `check` constraints. New migration = new file `supabase/migrations/<yyyymmddhhmmss>_<name>.sql`; never edit an applied one.
- Realtime is on for `agent_runs`, `agent_steps`, `flagged_items`, `pending_actions`, `chat_messages`, `connections`.
- OAuth tokens and WhatsApp session values are encrypted with `Crypto` (`src/common/crypto.ts`, AES-256-GCM, `v1:iv:tag:ct`). Tokens are keyed by `(provider, account)` — two Gmail accounts are expected.

## Conventions

- TypeScript strict, ESM everywhere: relative imports end in `.js`. NestJS DI needs decorator metadata, so the API is compiled with `tsc` (dev) and tested with Vitest + SWC — don't switch to tsx/esbuild.
- Inject env with `@Inject(ENV) env: Env` (`src/config`). New env vars: add to `env.schema.ts` **and** `.env.example` with a comment on where to get the value. Vars for unbuilt phases stay optional.
- **Never log email bodies, message contents, prompts or tokens.** Log IDs and counts only. Contents live in the DB.
- Tests in `apps/api/test/*.spec.ts`. Use fakes for repos/LLM (see `agent-runner.spec.ts`) and the fake clock for queue timing (see `llm-queue.spec.ts`).
- Commit after each phase; never commit `.env`.

## Environment notes

- Models: `gemini-3.1-flash-lite` (fast) and `gemini-3.5-flash-lite` (smart), 13 RPM / 450 RPD each. Free-tier Flash (non-Lite) models only allow 20 RPD; Pro models have no free quota.
- Supabase uses the new key types (`sb_publishable_…`, `sb_secret_…`); legacy anon/service_role keys retire in 2027.
- `TIMEZONE=Asia/Karachi`. Gemini quotas reset at midnight `America/Los_Angeles`.
