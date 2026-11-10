import type OpenAI from 'openai';
import { toJSONSchema, type z } from 'zod';
import type { AgentId } from '@agentdeck/shared';
import type { AgentResult, RunAgentOptions } from './types.js';

export interface ToolContext {
  runId: string;
  agentId: AgentId;
  /** Run another agent as a child of this run (parent_run_id is set automatically). */
  runSubAgent(opts: Omit<RunAgentOptions, 'parentRunId' | 'trigger'>): Promise<AgentResult>;
}

export interface Tool<S extends z.ZodTypeAny = z.ZodTypeAny, O = unknown> {
  name: string;
  description: string;
  input: S;
  execute(input: z.infer<S>, ctx: ToolContext): Promise<O>;
}

/** Helper that keeps input types inferred from the zod schema. */
export function defineTool<S extends z.ZodTypeAny, O>(tool: Tool<S, O>): Tool<S, O> {
  return tool;
}

/** zod → JSON Schema in the shape the OpenAI-compatible API expects. */
export function toolJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export function toOpenAiTool(tool: Tool): OpenAI.Chat.ChatCompletionTool {
  return {
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: toolJsonSchema(tool.input) },
  };
}
