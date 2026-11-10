import type {
  AgentId,
  AgentStatus,
  ModelTier,
  RunStatus,
  RunTrigger,
  StepType,
} from './enums.js';

export interface AgentRow {
  id: AgentId;
  name: string;
  status: AgentStatus;
  system_prompt: string | null;
  model_tier: ModelTier;
  config: Record<string, unknown>;
  updated_at: string;
}

export interface AgentRunRow {
  id: string;
  agent_id: AgentId;
  parent_run_id: string | null;
  trigger: RunTrigger;
  status: RunStatus;
  model: string | null;
  input: unknown;
  output: unknown;
  error: string | null;
  tokens_in: number;
  tokens_out: number;
  llm_requests: number;
  started_at: string;
  ended_at: string | null;
}

export interface AgentStepRow {
  id: string;
  run_id: string;
  step_index: number;
  type: StepType;
  payload: unknown;
  duration_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  created_at: string;
}

export interface LlmUsageRow {
  model: string;
  date: string;
  requests_count: number;
  tokens_in: number;
  tokens_out: number;
}

export interface RuleRow {
  id: string;
  agent_id: AgentId;
  rule_text: string;
  enabled: boolean;
  created_at: string;
}

/** Shape returned by the API for the dashboard quota panel and /status. */
export interface ModelUsage {
  model: string;
  used: number;
  limit: number;
  rpmUsed: number;
  rpmLimit: number;
  exhausted: boolean;
  resetsAt: string;
}
