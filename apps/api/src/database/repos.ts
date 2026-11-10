import { Inject, Injectable } from '@nestjs/common';
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  AgentId,
  AgentRow,
  AgentRunRow,
  AgentStatus,
  RuleRow,
  RunStatus,
  RunTrigger,
  StepType,
} from '@agentdeck/shared';
import { SUPABASE } from './tokens.js';


export class DbError extends Error {
  constructor(op: string, message: string) {
    super(`DB ${op} failed: ${message}`);
  }
}

function unwrap<T>(op: string, res: { data: T | null; error: { message: string } | null }): T {
  if (res.error) throw new DbError(op, res.error.message);
  return res.data as T;
}

abstract class Repo {
  constructor(@Inject(SUPABASE) protected readonly db: SupabaseClient) {}
}

@Injectable()
export class AgentsRepo extends Repo {
  async get(id: AgentId): Promise<AgentRow | null> {
    return unwrap('agents.get', await this.db.from('agents').select('*').eq('id', id).maybeSingle());
  }

  async list(): Promise<AgentRow[]> {
    return unwrap('agents.list', await this.db.from('agents').select('*').order('id'));
  }

  async setStatus(id: AgentId, status: AgentStatus): Promise<void> {
    unwrap(
      'agents.setStatus',
      await this.db.from('agents').update({ status, updated_at: new Date().toISOString() }).eq('id', id),
    );
  }
}

export interface NewRun {
  agent_id: AgentId;
  parent_run_id?: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  model?: string | null;
  input?: unknown;
  error?: string | null;
  ended_at?: string | null;
}

@Injectable()
export class RunsRepo extends Repo {
  async create(run: NewRun): Promise<AgentRunRow> {
    return unwrap('runs.create', await this.db.from('agent_runs').insert(run).select('*').single());
  }

  async finish(
    id: string,
    patch: Partial<Pick<AgentRunRow, 'status' | 'output' | 'error' | 'tokens_in' | 'tokens_out' | 'llm_requests'>>,
  ): Promise<void> {
    unwrap(
      'runs.finish',
      await this.db.from('agent_runs').update({ ...patch, ended_at: new Date().toISOString() }).eq('id', id),
    );
  }

  async get(id: string): Promise<AgentRunRow | null> {
    return unwrap('runs.get', await this.db.from('agent_runs').select('*').eq('id', id).maybeSingle());
  }
}

export interface NewStep {
  run_id: string;
  step_index: number;
  type: StepType;
  payload: unknown;
  duration_ms?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
}

@Injectable()
export class StepsRepo extends Repo {
  async add(step: NewStep): Promise<void> {
    unwrap('steps.add', await this.db.from('agent_steps').insert(step));
  }
}

@Injectable()
export class RulesRepo extends Repo {
  async enabledFor(agentId: AgentId): Promise<RuleRow[]> {
    return unwrap(
      'rules.enabledFor',
      await this.db.from('rules').select('*').eq('agent_id', agentId).eq('enabled', true).order('created_at'),
    );
  }
}

@Injectable()
export class UsageRepo extends Repo {
  async countsFor(date: string): Promise<Record<string, number>> {
    const rows = unwrap<{ model: string; requests_count: number }[]>(
      'usage.countsFor',
      await this.db.from('llm_usage').select('model, requests_count').eq('date', date),
    );
    return Object.fromEntries(rows.map((r) => [r.model, r.requests_count]));
  }

  async incrementRequests(model: string, date: string): Promise<number> {
    return unwrap<number>(
      'usage.increment',
      await this.db.rpc('increment_llm_requests', { p_model: model, p_date: date }),
    );
  }

  async addTokens(model: string, date: string, tokensIn: number, tokensOut: number): Promise<void> {
    unwrap(
      'usage.addTokens',
      await this.db.rpc('add_llm_tokens', {
        p_model: model,
        p_date: date,
        p_tokens_in: tokensIn,
        p_tokens_out: tokensOut,
      }),
    );
  }

  /** Cheap connectivity probe for /health. */
  async ping(): Promise<void> {
    unwrap('ping', await this.db.from('agents').select('id').limit(1));
  }
}
