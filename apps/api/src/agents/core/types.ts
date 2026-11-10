import type { AgentId, RunStatus, RunTrigger } from '@agentdeck/shared';
import type { ChatMessage } from '../../llm/llm.service.js';
import type { Tool } from './tool.js';

export interface RunAgentOptions {
  agentId: AgentId;
  trigger: RunTrigger;
  /** Stored on the run. A string is sent as the user message; anything else as JSON. */
  input: unknown;
  tools: Tool[];
  /** Default prompt from code. A non-empty `agents.system_prompt` in the DB overrides it. */
  systemPrompt: string;
  /** Defaults to the model for the agent's `model_tier`. */
  model?: string;
  parentRunId?: string | null;
  maxIterations?: number;
  /** Prior conversation (e.g. chat history), inserted before the user message. */
  history?: ChatMessage[];
}

export interface AgentResult {
  runId: string | null;
  status: RunStatus;
  output: string | null;
  error?: string;
  tokensIn: number;
  tokensOut: number;
  llmRequests: number;
}

export const AGENT_ERROR = 'agent.error';
export interface AgentErrorEvent {
  agentId: AgentId;
  runId: string | null;
  message: string;
}
