# agentdeck — Build Plan

Status: **approved 2026-11-10** · Phase 1 built

This plan covers the whole project, with full detail for Phase 1. Later phases get a detailed plan at their start.

---

## 1. Decisions & deviations from the spec

| # | Topic | Decision | Why |
|---|---|---|---|
| D1 | Supabase keys | `SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` replace `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` | Legacy keys are retired in early 2027 |
| D2 | JWT verification | Verify dashboard tokens locally against the project's JWKS (`/auth/v1/.well-known/jwks.json`) with `jose`, then check `email === DASHBOARD_ALLOWED_EMAIL` | No network call to Supabase per API request; works with the new asymmetric signing keys |
| D3 | Backend DB access | `@supabase/supabase-js` with the secret key; atomic operations (quota counters) as Postgres functions called via RPC | Everything over HTTPS; no DB password in the running app |
| D4 | Migrations | SQL files in `supabase/migrations`, applied with the Supabase CLI run via `pnpm dlx` (no global install) using `SUPABASE_DB_URL` | Lets Claude apply migrations directly each phase (see question Q1) |
| D5 | Models | `LLM_MODEL_FAST=gemini-3.1-flash-lite`, `LLM_MODEL_SMART=gemini-3.5-flash-lite`, 13 RPM / 450 RPD each, tracked per model | Free-tier Flash models only allow 20 RPD; two Flash-Lite models give two separate 500/day quotas |
| D6 | Quota pause | When a model's daily quota runs out, the **queue** stops serving non-chat requests until reset. `agents.status` is not changed | Resumes on its own at midnight Pacific; your manual pause/resume choices are not overwritten |
| D7 | Gemini 3 tool calling | Pass back the assistant message exactly as received, including `extra_content.google.thought_signature` | Gemini 3 models reject follow-up tool turns without the signature |
| D8 | Tool input errors | If tool input fails zod validation, the error goes back to the LLM as the tool result, so it can correct itself. Other thrown errors fail the run, as the spec says | Saves a whole failed run (and quota) on a typo in arguments |
| D9 | Extra tables | `app_owner`, `connections`, `error_reports` (see §4) | Owner-only RLS, live connection status and QR code, error dedup that survives restarts |
| D10 | WhatsApp QR | Streamed through Supabase Realtime on the `connections` table instead of SSE | SSE can't send an auth header from the browser; Realtime already handles auth |
| D11 | Discord | `necord` (NestJS wrapper around discord.js v14) | Slash commands, buttons and guards as Nest decorators, with less boilerplate |
| D12 | Tests | **Vitest + SWC** (changed from Jest). Tests for the core pieces (`LlmQueue`, `runAgent`, tool schemas, crypto) are written in Phase 1, not Phase 8 | NestJS 12 is ESM-only and Jest's ESM support is poor; SWC keeps decorator metadata |
| D14 | Framework | NestJS 12, ESM throughout (`.js` import suffixes), API compiled with `tsc` | NestJS 12 ships ESM only; tsx/esbuild drop decorator metadata that Nest DI needs |
| D15 | Two Gmail accounts | `oauth_tokens` keyed by `(provider, account)`; `flagged_items.account` records which inbox | Owner wants both the uni and personal inbox watched |
| D13 | Timezone | `TIMEZONE=Asia/Karachi` (IANA name) | Date libraries need IANA names; "GMT+5" is ambiguous |

---

## 2. Folder structure

```
agentdeck/
├─ apps/
│  ├─ api/                          NestJS backend
│  │  ├─ src/
│  │  │  ├─ main.ts
│  │  │  ├─ app.module.ts
│  │  │  ├─ config/                 zod env schema, typed AppConfig provider
│  │  │  ├─ common/                 crypto (AES-256-GCM), retry/backoff, time (Pacific/local), log redaction
│  │  │  ├─ database/               Supabase client provider + one repository per table
│  │  │  ├─ auth/                   JWKS JWT guard + owner check            (used from Phase 4)
│  │  │  ├─ llm/                    LlmClient (openai SDK), LlmQueue, usage tracking, structured-output helper
│  │  │  ├─ agents/
│  │  │  │  ├─ core/                runAgent(), Tool types, tracer, rules injection, agent registry
│  │  │  │  ├─ echo/                Phase 1 test agent (echo tool)
│  │  │  │  ├─ uni-email/           Phase 3
│  │  │  │  ├─ calendar/            Phase 5
│  │  │  │  ├─ orchestrator/        Phase 6
│  │  │  │  └─ whatsapp/            Phase 7
│  │  │  ├─ integrations/
│  │  │  │  ├─ google/              OAuth, encrypted token store, Gmail + Calendar clients   (Phase 3)
│  │  │  │  └─ whatsapp/            WhatsAppAdapter interface + Baileys adapter               (Phase 7)
│  │  │  ├─ discord/                bot, owner guard, slash commands, buttons, message sync   (Phase 2)
│  │  │  ├─ errors/                 agent.error listener → #errors, dedup                      (Phase 2)
│  │  │  ├─ flagged/ pending-actions/ rules/ chat/    service layer shared by Discord + HTTP
│  │  │  ├─ maintenance/            weekly cleanup job                                         (Phase 8)
│  │  │  └─ health/                 GET /health
│  │  ├─ scripts/run-echo.ts        Phase 1: run the echo agent from the terminal
│  │  └─ test/
│  └─ web/                          React + Vite + Tailwind PWA                                (Phase 4)
├─ packages/
│  └─ shared/                       enums, row types, zod schemas, API DTOs (used by api + web)
├─ supabase/
│  └─ migrations/                   0001_init.sql, …
├─ docs/PLAN.md
├─ scripts/check-env.sh
├─ docker-compose.yml               local dev                                                  (Phase 1)
├─ docker-compose.prod.yml, Caddyfile                                                         (Phase 8)
├─ .env  .env.example  .gitignore
├─ CLAUDE.md  README.md
└─ pnpm-workspace.yaml  package.json  tsconfig.base.json
```

---

## 3. NestJS modules

| Module | Phase | Responsibility |
|---|---|---|
| `ConfigModule` | 1 | Parse `.env` with zod at startup; on failure exit with a list of every missing or invalid var |
| `DatabaseModule` | 1 | Supabase client (secret key), repositories, `app_owner` sync from env at boot |
| `CryptoModule` | 1 | AES-256-GCM `encrypt/decrypt` using `ENCRYPTION_KEY` (random IV per value, auth tag stored) |
| `LlmModule` | 1 | `LlmClient`, `LlmQueue`, `LlmUsageService` (`getUsage()` for dashboard and `/status`) |
| `AgentsCoreModule` | 1 | `AgentRunner.runAgent()`, `AgentRegistry`, tool → JSON Schema conversion, tracing |
| `EchoAgentModule` | 1 | Test agent with an `echo` tool |
| `HealthModule` | 1 | `/health`: DB now; Discord, WhatsApp and Google added in their phases |
| `EventEmitterModule` | 1 | `@nestjs/event-emitter` for `agent.error`, `llm.quota_exhausted`, etc. |
| `ScheduleModule` | 1 | `@nestjs/schedule` for crons |
| `DiscordModule` | 2 | necord client, `OwnerGuard`, commands, buttons, `DiscordMessageSync` (edit Discord when web acts) |
| `ErrorsModule` | 2 | Listens to `agent.error`, posts or edits in `#errors` with dedup |
| `AuthModule` | 3–4 | JWT guard for HTTP routes; Google OAuth controller (Phase 3) |
| `GoogleModule` | 3 | OAuth2 client, token refresh, Gmail and Calendar wrappers with retry |
| `FlaggedModule`, `RulesModule` | 3 | Service layer used by both Discord and HTTP |
| `UniEmailAgentModule` | 3 | Cron poller, pre-filter, batch classifier, Discord embeds |
| `CalendarAgentModule`, `PendingActionsModule` | 5 | Calendar tools, confirmation flow, expiry cron, daily digest |
| `OrchestratorModule`, `ChatModule` | 6 | Chat history, sub-agent tools, Discord typing indicator |
| `WhatsAppModule` | 7 | Adapter, buffering, classification, reconnect |
| `MaintenanceModule` | 8 | Weekly cleanup |

Rule: controllers and Discord handlers only call services. No business logic lives in either.

---

## 4. Database schema (migration `0001_init.sql`)

All tables live in `public` with **RLS enabled**. A single policy helper:

```sql
create function is_owner() returns boolean language sql stable security definer as $$
  select coalesce((auth.jwt() ->> 'email') = (select email from app_owner limit 1), false)
$$;
-- every table:  create policy owner_read on <t> for select to authenticated using (is_owner());
```

The backend uses the secret key, which bypasses RLS. The dashboard only **reads** directly. All writes go through the API.

| Table | Columns (beyond spec) / notes |
|---|---|
| `agents` | as spec. Seeded with `uni_email`, `calendar`, `whatsapp`, `orchestrator`, `echo` |
| `agent_runs` | as spec + `model text`. Indexes: `(agent_id, started_at desc)`, `(parent_run_id)`, `(status)` |
| `agent_steps` | as spec + `tokens_in`, `tokens_out`. Index `(run_id, step_index)` |
| `llm_usage` | as spec, PK `(model, date)`. `date` is the **Pacific** calendar date |
| `flagged_items` | as spec + `account` (which inbox), unique `(source, external_id)` |
| `pending_actions` | as spec + `expires_at` (created + 24 h), `run_id` |
| `rules` | as spec |
| `oauth_tokens` | as spec + `account`, PK `(provider, account)`, ciphertext stored as text (`iv:tag:data`, base64) |
| `checkpoints` | as spec, PK `key` |
| `chat_messages` | as spec |
| `whatsapp_session` | `key text PK, value_enc text, updated_at` (Baileys stores many small keys) |
| **`app_owner`** | `email text PK`, a single row written from `DASHBOARD_ALLOWED_EMAIL` at boot |
| **`connections`** | `id text PK` (`google` / `whatsapp` / `discord`), `status`, `detail jsonb` (QR code, last error), `updated_at` |
| **`error_reports`** | `id, agent_id, fingerprint, message, run_id, discord_message_id, count, first_seen, last_seen`. Used for the 10-minute dedup |

RPC functions:
- `increment_llm_requests(p_model, p_date) returns int`: atomic upsert that returns the new count.
- `add_llm_tokens(p_model, p_date, p_tokens_in, p_tokens_out)`: adds token totals after a response.

Realtime publication: `agent_runs`, `agent_steps`, `flagged_items`, `pending_actions`, `chat_messages`, `connections`.

Enums are `text` with `check` constraints instead of Postgres enum types, because they are easier to change in later migrations.

---

## 5. Core abstractions (Phase 1)

### LlmQueue
- **One in-process dispatcher.** Requests are held in a priority heap: `orchestrator(0) > calendar(1) > uni_email(2) > whatsapp(3) > echo(4)`. Same priority is first-in, first-out.
- **RPM** uses a sliding 60-second window of send timestamps per model. When full, the dispatcher waits until the oldest timestamp expires.
- **RPD:** the count is loaded from `llm_usage` at startup and incremented atomically via RPC **before** each send, because Google counts failed requests too.
- **Reset** happens at midnight `America/Los_Angeles`. The date key is computed in that zone, so the reset is automatic.
- **Retries:** for 429, 5xx and network errors, up to 4 tries with `1s × 2^n` + 0–500 ms jitter. Gemini's `retryDelay` / `Retry-After` is used when present. A 429 that says the *daily* quota is gone marks that model exhausted immediately.
- **Exhausted model:** non-chat requests are rejected with `QuotaExhaustedError`, and their runs are recorded as `skipped` (reason "quota"). Chat gets a friendly "quota used up until HH:MM" reply. `llm.quota_exhausted` is emitted once per model per day (in Phase 2 that becomes one `#errors` post).
- `getUsage()` returns `{ model, used, limit, rpmUsed, resetsAt }[]`.

### runAgent()
Follows the spec exactly, plus:
- The system prompt is built as `agents.system_prompt` (falling back to the code default) + enabled `rules` + the current local date/time in `TIMEZONE`.
- Each LLM call and each tool call/result is written to `agent_steps` as it happens, so the dashboard can show progress live.
- `maxIterations` (default 8) exceeded → the run is marked `failed` with "max iterations reached".
- The returned `AgentResult` is `{ runId, status, output, tokensIn, tokensOut, llmRequests }`.
- Sub-agent calls pass `parentRunId` and `trigger: 'agent'`.

### Tools
```ts
interface Tool<I extends z.ZodTypeAny, O> {
  name: string; description: string; input: I;
  execute(input: z.infer<I>, ctx: ToolContext): Promise<O>;
}
// ctx = { runId, agentId, logger, services... }
```
Converted with `z.toJSONSchema()` (zod v4). Each agent receives only its own tool list.

### Structured outputs
`llm.structured({ schema, messages, model, priority })` sends `response_format: json_schema` and validates with zod. On a validation failure it retries once with the error appended, then throws.

### Logging
nestjs-pino, with a redaction list (`body`, `content`, `text`, `snippet`, tokens, keys). Prompts and message contents are never logged, only IDs and counts.

---

## 6. Phase breakdown

| Phase | Deliverables | How you'll test it |
|---|---|---|
| **1 Foundation** ✅ | Monorepo, NestJS app, env validation, `…_init.sql`, crypto, `LlmQueue`, `runAgent`, echo agent, `/health`, `docker-compose.yml`, `.env.example`, `CLAUDE.md`, unit tests for the core | `pnpm test` passes; `pnpm --filter api echo "hello"` → run + steps visible in Supabase Table Editor; `curl localhost:3000/health` |
| **2 Discord + Errors** | Bot, owner guard, `/status` `/pause` `/resume`, Errors module | Slash commands in your server; force an echo error → one `#errors` post, repeat → count increments |
| **3 Uni Email** | Google OAuth, token encryption + refresh, Gmail poll with checkpoint, pre-filter, batch classify, embeds + buttons | Connect Google, send yourself a test email from a uni address, see it in `#uni-email` |
| **4 Dashboard v1** | Vite PWA, magic-link auth, Overview + quota panel, Activity (realtime), Run detail | Log in on phone + laptop, watch an echo run appear live |
| **5 Calendar** | Tools, pending actions (Discord + Approvals page), email→calendar, 8 AM digest | Ask to move an event → confirm in Discord → shows confirmed on web |
| **6 Orchestrator** | `#chat` + Chat page, sub-agent tools, nested traces, typing indicator | The five example queries from the spec |
| **7 WhatsApp** | Adapter, QR on Connections page, 60 s batching, flagging, reconnect | Link the secondary number, send "urgent exam tomorrow" from another phone |
| **8 Polish + deploy** | Flagged/Agents/Connections pages, `/rule` commands, cleanup job, remaining tests, prod Docker + Caddy, Vercel config, README | Full deploy on the Oracle VM |

---

## 7. Phase 1: exact steps

1. `corepack enable` → pnpm. Workspace root: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` (strict), ESLint + Prettier.
2. `packages/shared`: enums (`AgentId`, `RunStatus`, `StepType`, …) + row types.
3. `apps/api`: NestJS 11 skeleton, `ConfigModule` with zod schema covering **all** vars (Phase 2+ vars optional until their module is enabled, so Phase 1 runs without Discord or Google keys).
4. `supabase/migrations/0001_init.sql` → apply → verify the tables exist.
5. `CryptoModule`, `DatabaseModule`, `LlmModule`, `AgentsCoreModule`, `EchoAgentModule`, `HealthModule`.
6. `scripts/run-echo.ts`: boots the Nest app context, runs the echo agent with your text, and prints the run ID + result.
7. Tests: LlmQueue (priority order, RPM wait, RPD exhaustion, Pacific reset, retry/backoff), runAgent with a mocked LLM (tool loop, step tracing, failure path, paused → skipped, max iterations), tool schema validation, crypto round-trip.
8. `.env.example` (no values), `docker-compose.yml` (api service, hot reload), `CLAUDE.md`, `git init` + first commit (if you approve, see Q2).

---

## 8. Answers to plan questions (2026-11-10)

- **Q1 migrations:** Claude applies them with `pnpm db:push` using `SUPABASE_DB_URL` (Session pooler URI).
- **Q2 git:** commit to `github.com/SARA-MAHMOOD20/agentdeck` after each phase.
- **Q3 Gmail:** watch **both** the uni inbox and the personal Gmail (Phase 3).
