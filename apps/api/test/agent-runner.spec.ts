import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AgentRow } from '@agentdeck/shared';
import { AgentRunner } from '../src/agents/core/agent-runner.js';
import { defineTool } from '../src/agents/core/tool.js';
import { AGENT_ERROR } from '../src/agents/core/types.js';
import { echoTool } from '../src/agents/echo/echo.agent.js';
import type { Env } from '../src/config/env.schema.js';
import { QuotaExhaustedError } from '../src/llm/errors.js';
import type { ChatCompletion } from '../src/llm/llm-queue.js';

type Msg = { role: string; content?: string | null; tool_calls?: unknown[]; [k: string]: unknown };

function completion(message: Partial<Msg> & { tool_calls?: unknown[] }): ChatCompletion {
  return {
    id: 'c',
    object: 'chat.completion',
    created: 0,
    model: 'm',
    choices: [
      {
        index: 0,
        finish_reason: message.tool_calls ? 'tool_calls' : 'stop',
        logprobs: null,
        message: { role: 'assistant', content: null, refusal: null, ...message } as never,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

const toolCall = (name: string, args: unknown, id = 'call_1') => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
  extra_content: { google: { thought_signature: 'sig-123' } },
});

function setup(opts: { status?: 'active' | 'paused'; replies?: (ChatCompletion | Error)[]; rules?: string[] } = {}) {
  const agent: AgentRow = {
    id: 'echo',
    name: 'Echo',
    status: opts.status ?? 'active',
    system_prompt: null,
    model_tier: 'fast',
    config: {},
    updated_at: '',
  };
  const runs: Record<string, unknown>[] = [];
  const finished: Record<string, Record<string, unknown>> = {};
  const steps: { run_id: string; step_index: number; type: string; payload: Record<string, unknown> }[] = [];
  const requests: { messages: Msg[]; tools?: unknown[] }[] = [];
  const replies = [...(opts.replies ?? [])];
  let runSeq = 0;

  const llm = {
    modelFor: () => 'fast-model',
    chat: vi.fn(async (_agentId: string, _model: string, params: { messages: Msg[]; tools?: unknown[] }) => {
      requests.push(structuredClone(params));
      const next = replies.shift();
      if (!next) throw new Error('no more scripted replies');
      if (next instanceof Error) throw next;
      return { completion: next, attempts: 1 };
    }),
  };
  const events = { emit: vi.fn() };

  const runner = new AgentRunner(
    { TIMEZONE: 'Asia/Karachi' } as Env,
    { get: async () => agent } as never,
    {
      create: async (row: Record<string, unknown>) => {
        const run = { id: `run-${++runSeq}`, ...row };
        runs.push(run);
        return run;
      },
      finish: async (id: string, patch: Record<string, unknown>) => {
        finished[id] = patch;
      },
    } as never,
    { add: async (s: never) => void steps.push(s) } as never,
    { enabledFor: async () => (opts.rules ?? []).map((rule_text) => ({ rule_text })) } as never,
    llm as never,
    events as never,
  );

  return { runner, runs, finished, steps, requests, llm, events };
}

const base = { agentId: 'echo' as const, trigger: 'user' as const, systemPrompt: 'You are a test agent.' };

describe('runAgent', () => {
  it('runs the tool loop, traces every step and keeps Gemini thought signatures', async () => {
    const t = setup({
      replies: [completion({ tool_calls: [toolCall('echo', { text: 'hi' })] }), completion({ content: 'Echo: hi (2 chars)' })],
      rules: ['Always be brief'],
    });

    const res = await t.runner.runAgent({ ...base, input: 'hi', tools: [echoTool] });

    expect(res).toMatchObject({ status: 'succeeded', output: 'Echo: hi (2 chars)', tokensIn: 20, tokensOut: 10, llmRequests: 2 });
    expect(t.steps.map((s) => s.type)).toEqual(['llm_call', 'tool_call', 'tool_result', 'llm_call']);
    expect(t.steps.map((s) => s.step_index)).toEqual([0, 1, 2, 3]);
    expect(t.steps[2]!.payload).toMatchObject({ name: 'echo', ok: true, result: { echoed: 'hi', length: 2 } });
    expect(t.finished['run-1']).toMatchObject({ status: 'succeeded', tokens_in: 20, llm_requests: 2 });

    // System prompt has rules and the current time.
    const system = t.requests[0]!.messages[0]!.content!;
    expect(system).toContain('You are a test agent.');
    expect(system).toContain('- Always be brief');
    expect(system).toContain('Asia/Karachi');

    // Second request includes the assistant tool call (with signature) and the tool result.
    const second = t.requests[1]!.messages;
    const assistant = second.find((m) => m.role === 'assistant')!;
    expect((assistant.tool_calls![0] as { extra_content: unknown }).extra_content).toEqual({ google: { thought_signature: 'sig-123' } });
    expect(assistant).not.toHaveProperty('refusal');
    expect(second.at(-1)).toMatchObject({ role: 'tool', tool_call_id: 'call_1' });
    expect(JSON.parse(second.at(-1)!.content!)).toEqual({ echoed: 'hi', length: 2 });
  });

  it('skips and logs when the agent is paused', async () => {
    const t = setup({ status: 'paused' });
    const res = await t.runner.runAgent({ ...base, input: 'hi', tools: [echoTool] });

    expect(res.status).toBe('skipped');
    expect(t.runs[0]).toMatchObject({ status: 'skipped', error: 'Agent is paused' });
    expect(t.llm.chat).not.toHaveBeenCalled();
  });

  it('sends invalid tool input back to the LLM instead of failing', async () => {
    const t = setup({
      replies: [completion({ tool_calls: [toolCall('echo', { text: '' })] }), completion({ content: 'done' })],
    });
    const res = await t.runner.runAgent({ ...base, input: 'hi', tools: [echoTool] });

    expect(res.status).toBe('succeeded');
    expect(t.steps[2]!.payload).toMatchObject({ ok: false });
    expect(String(t.steps[2]!.payload.error)).toContain('Invalid input');
  });

  it('reports unknown tools to the LLM', async () => {
    const t = setup({
      replies: [completion({ tool_calls: [toolCall('send_whatsapp', {})] }), completion({ content: 'done' })],
    });
    await t.runner.runAgent({ ...base, input: 'hi', tools: [echoTool] });
    expect(t.steps[2]!.payload).toMatchObject({ ok: false, error: 'Unknown tool "send_whatsapp"' });
  });

  it('marks the run failed and emits agent.error when a tool throws', async () => {
    const boom = defineTool({
      name: 'boom',
      description: 'fails',
      input: z.object({}),
      execute: async () => {
        throw new Error('tool exploded');
      },
    });
    const t = setup({ replies: [completion({ tool_calls: [toolCall('boom', {})] })] });
    const res = await t.runner.runAgent({ ...base, input: 'hi', tools: [boom] });

    expect(res).toMatchObject({ status: 'failed', error: 'tool exploded' });
    expect(t.finished['run-1']).toMatchObject({ status: 'failed', error: 'tool exploded' });
    expect(t.events.emit).toHaveBeenCalledWith(AGENT_ERROR, { agentId: 'echo', runId: 'run-1', message: 'tool exploded' });
  });

  it('fails after maxIterations', async () => {
    const loop = Array.from({ length: 3 }, (_, i) => completion({ tool_calls: [toolCall('echo', { text: 'x' }, `c${i}`)] }));
    const t = setup({ replies: loop });
    const res = await t.runner.runAgent({ ...base, input: 'hi', tools: [echoTool], maxIterations: 3 });

    expect(res.status).toBe('failed');
    expect(res.error).toContain('3 iterations');
    expect(t.llm.chat).toHaveBeenCalledTimes(3);
  });

  it('records quota exhaustion as skipped without an error event', async () => {
    const t = setup({ replies: [new QuotaExhaustedError('fast-model', Date.now())] });
    const res = await t.runner.runAgent({ ...base, input: 'hi', tools: [] });

    expect(res.status).toBe('skipped');
    expect(t.finished['run-1']).toMatchObject({ status: 'skipped' });
    expect(t.events.emit).not.toHaveBeenCalled();
  });

  it('links sub-agent runs to the parent', async () => {
    const delegate = defineTool({
      name: 'delegate',
      description: 'runs a sub-agent',
      input: z.object({}),
      execute: async (_input, ctx) => {
        const child = await ctx.runSubAgent({ agentId: 'echo', input: 'child', tools: [], systemPrompt: 'child' });
        return { childRunId: child.runId, output: child.output };
      },
    });
    const t = setup({
      replies: [
        completion({ tool_calls: [toolCall('delegate', {})] }),
        completion({ content: 'child done' }),
        completion({ content: 'parent done' }),
      ],
    });
    const res = await t.runner.runAgent({ ...base, input: 'hi', tools: [delegate] });

    expect(res.output).toBe('parent done');
    expect(t.runs[1]).toMatchObject({ id: 'run-2', parent_run_id: 'run-1', trigger: 'agent' });
  });
});
