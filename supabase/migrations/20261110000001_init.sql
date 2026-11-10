-- agentdeck initial schema
-- Enum-like columns use text + check constraints (easier to evolve than Postgres enums).
-- RLS: the dashboard (authenticated owner) may only READ. All writes go through the API,
-- which uses the secret key and bypasses RLS.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Owner
-- ---------------------------------------------------------------------------
create table public.app_owner (
  email text primary key
);

create or replace function public.is_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    lower(auth.jwt() ->> 'email') = (select lower(email) from public.app_owner limit 1),
    false
  )
$$;

-- ---------------------------------------------------------------------------
-- Agents
-- ---------------------------------------------------------------------------
create table public.agents (
  id text primary key,
  name text not null,
  status text not null default 'active' check (status in ('active', 'paused')),
  system_prompt text,
  model_tier text not null default 'fast' check (model_tier in ('fast', 'smart')),
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.agents (id, name, model_tier, config) values
  ('orchestrator', 'Orchestrator', 'smart', '{"historyMessages": 20}'),
  ('calendar', 'Calendar', 'smart', '{}'),
  ('uni_email', 'Uni Email', 'fast', '{"autoCalendar": true, "senderAllowlist": [], "bodyCharLimit": 2000}'),
  ('whatsapp', 'WhatsApp', 'fast', '{"muteList": []}'),
  ('echo', 'Echo (test)', 'fast', '{}');

create table public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references public.agents (id),
  parent_run_id uuid references public.agent_runs (id) on delete set null,
  trigger text not null check (trigger in ('cron', 'webhook', 'user', 'agent', 'event')),
  status text not null check (status in ('running', 'succeeded', 'failed', 'skipped')),
  model text,
  input jsonb,
  output jsonb,
  error text,
  tokens_in integer not null default 0,
  tokens_out integer not null default 0,
  llm_requests integer not null default 0,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);
create index agent_runs_agent_started_idx on public.agent_runs (agent_id, started_at desc);
create index agent_runs_started_idx on public.agent_runs (started_at desc);
create index agent_runs_parent_idx on public.agent_runs (parent_run_id);
create index agent_runs_status_idx on public.agent_runs (status);

create table public.agent_steps (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.agent_runs (id) on delete cascade,
  step_index integer not null,
  type text not null check (type in ('llm_call', 'tool_call', 'tool_result')),
  payload jsonb not null default '{}'::jsonb,
  duration_ms integer,
  tokens_in integer,
  tokens_out integer,
  created_at timestamptz not null default now(),
  unique (run_id, step_index)
);
create index agent_steps_created_idx on public.agent_steps (created_at);

create table public.rules (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references public.agents (id),
  rule_text text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index rules_agent_idx on public.rules (agent_id) where enabled;

-- ---------------------------------------------------------------------------
-- LLM usage (date = Pacific calendar date, Gemini's reset timezone)
-- ---------------------------------------------------------------------------
create table public.llm_usage (
  model text not null,
  date date not null,
  requests_count integer not null default 0,
  tokens_in bigint not null default 0,
  tokens_out bigint not null default 0,
  primary key (model, date)
);

create or replace function public.increment_llm_requests(p_model text, p_date date)
returns integer language sql security definer set search_path = public as $$
  insert into public.llm_usage as u (model, date, requests_count)
  values (p_model, p_date, 1)
  on conflict (model, date) do update set requests_count = u.requests_count + 1
  returning requests_count
$$;

create or replace function public.add_llm_tokens(
  p_model text, p_date date, p_tokens_in integer, p_tokens_out integer
) returns void language sql security definer set search_path = public as $$
  insert into public.llm_usage as u (model, date, tokens_in, tokens_out)
  values (p_model, p_date, p_tokens_in, p_tokens_out)
  on conflict (model, date) do update
    set tokens_in = u.tokens_in + excluded.tokens_in,
        tokens_out = u.tokens_out + excluded.tokens_out
$$;

-- ---------------------------------------------------------------------------
-- Flagged items / pending actions
-- ---------------------------------------------------------------------------
create table public.flagged_items (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references public.agents (id),
  source text not null check (source in ('gmail', 'whatsapp')),
  external_id text not null,
  account text,
  priority text not null check (priority in ('urgent', 'important', 'info')),
  title text not null,
  summary text,
  sender text,
  received_at timestamptz,
  extracted_dates jsonb not null default '[]'::jsonb,
  calendar_event_id text,
  discord_message_id text,
  status text not null default 'new' check (status in ('new', 'seen', 'dismissed')),
  created_at timestamptz not null default now(),
  unique (source, external_id)
);
create index flagged_items_created_idx on public.flagged_items (created_at desc);
create index flagged_items_status_idx on public.flagged_items (status, priority);

create table public.pending_actions (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null references public.agents (id),
  run_id uuid references public.agent_runs (id) on delete set null,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'confirmed', 'cancelled', 'expired')),
  decided_via text check (decided_via in ('discord', 'web')),
  discord_message_id text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '24 hours'),
  decided_at timestamptz
);
create index pending_actions_status_idx on public.pending_actions (status, expires_at);

-- ---------------------------------------------------------------------------
-- Secrets & state (encrypted values are "iv:tag:ciphertext", base64)
-- ---------------------------------------------------------------------------
create table public.oauth_tokens (
  provider text not null,
  account text not null,
  access_token_enc text,
  refresh_token_enc text,
  expiry timestamptz,
  scopes text[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (provider, account)
);

create table public.checkpoints (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table public.whatsapp_session (
  key text primary key,
  value_enc text not null,
  updated_at timestamptz not null default now()
);

create table public.chat_messages (
  id uuid primary key default gen_random_uuid(),
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  run_id uuid references public.agent_runs (id) on delete set null,
  source text not null check (source in ('discord', 'web')),
  created_at timestamptz not null default now()
);
create index chat_messages_created_idx on public.chat_messages (created_at desc);

create table public.connections (
  id text primary key check (id in ('google', 'whatsapp', 'discord')),
  status text not null default 'disconnected',
  detail jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.connections (id) values ('google'), ('whatsapp'), ('discord');

create table public.error_reports (
  id uuid primary key default gen_random_uuid(),
  agent_id text not null,
  fingerprint text not null,
  message text not null,
  run_id uuid references public.agent_runs (id) on delete set null,
  discord_message_id text,
  count integer not null default 1,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index error_reports_lookup_idx on public.error_reports (agent_id, fingerprint, last_seen desc);

-- ---------------------------------------------------------------------------
-- RLS: owner read-only on everything; secrets tables get no policy at all
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'app_owner', 'agents', 'agent_runs', 'agent_steps', 'rules', 'llm_usage',
    'flagged_items', 'pending_actions', 'oauth_tokens', 'checkpoints',
    'whatsapp_session', 'chat_messages', 'connections', 'error_reports'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;

  foreach t in array array[
    'agents', 'agent_runs', 'agent_steps', 'rules', 'llm_usage',
    'flagged_items', 'pending_actions', 'chat_messages', 'connections', 'error_reports'
  ] loop
    execute format(
      'create policy owner_read on public.%I for select to authenticated using (public.is_owner())', t
    );
  end loop;
end $$;

-- Secret-bearing tables (oauth_tokens, whatsapp_session, checkpoints, app_owner) have RLS on
-- and no policies, so only the backend's secret key can touch them.

revoke execute on function public.increment_llm_requests(text, date) from public, anon, authenticated;
revoke execute on function public.add_llm_tokens(text, date, integer, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Realtime
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table
  public.agent_runs, public.agent_steps, public.flagged_items,
  public.pending_actions, public.chat_messages, public.connections;
