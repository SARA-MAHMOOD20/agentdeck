import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type OpenAI from 'openai';
import { ENV } from '../../config/config.module.js';
import type { Env } from '../../config/env.schema.js';
import { formatLocal } from '../../common/time.js';
import { AgentsRepo, RulesRepo, RunsRepo, StepsRepo } from '../../database/repos.js';
import { QuotaExhaustedError } from '../../llm/errors.js';
import { LlmService, type ChatMessage } from '../../llm/llm.service.js';
import { toOpenAiTool, type Tool, type ToolContext } from './tool.js';
import { AGENT_ERROR, type AgentErrorEvent, type AgentResult, type RunAgentOptions } from './types.js';

const MAX_TOOL_RESULT_CHARS = 20_000;

export class MaxIterationsError extends Error {
  constructor(n: number) {
    super(`Agent did not finish within ${n} iterations`);
  }
}

/**
 * Generic tool-calling loop with full tracing to agent_runs / agent_steps.
 * Never throws: failures are recorded on the run and returned as status "failed".
 */
@Injectable()
export class AgentRunner {
  private readonly log = new Logger(AgentRunner.name);

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly agents: AgentsRepo,
    private readonly runs: RunsRepo,
    private readonly steps: StepsRepo,
    private readonly rules: RulesRepo,
    private readonly llm: LlmService,
    private readonly events: EventEmitter2,
  ) {}

  async runAgent(opts: RunAgentOptions): Promise<AgentResult> {
    const totals = { tokensIn: 0, tokensOut: 0, llmRequests: 0 };
    let runId: string | null = null;

    try {
      const agent = await this.agents.get(opts.agentId);
      if (!agent) throw new Error(`Unknown agent "${opts.agentId}"`);
      const model = opts.model ?? this.llm.modelFor(agent.model_tier);
      const base = {
        agent_id: opts.agentId,
        parent_run_id: opts.parentRunId ?? null,
        trigger: opts.trigger,
        model,
        input: opts.input ?? null,
      };

      if (agent.status === 'paused') {
        const run = await this.runs.create({
          ...base,
          status: 'skipped',
          error: 'Agent is paused',
          ended_at: new Date().toISOString(),
        });
        return { runId: run.id, status: 'skipped', output: null, error: 'Agent is paused', ...totals };
      }

      const run = await this.runs.create({ ...base, status: 'running' });
      runId = run.id;

      const rules = await this.rules.enabledFor(opts.agentId);
      const system = [
        agent.system_prompt?.trim() || opts.systemPrompt,
        rules.length ? `\nUser rules (always follow):\n${rules.map((r) => `- ${r.rule_text}`).join('\n')}` : '',
        `\nCurrent time: ${formatLocal(Date.now(), this.env.TIMEZONE)}`,
      ].join('\n');

      const messages: ChatMessage[] = [
        { role: 'system', content: system },
        ...(opts.history ?? []),
        { role: 'user', content: typeof opts.input === 'string' ? opts.input : JSON.stringify(opts.input) },
      ];
      const tools = new Map(opts.tools.map((t) => [t.name, t]));
      const toolDefs = opts.tools.map(toOpenAiTool);
      const ctx: ToolContext = {
        runId,
        agentId: opts.agentId,
        runSubAgent: (sub) => this.runAgent({ ...sub, trigger: 'agent', parentRunId: runId }),
      };

      let stepIndex = 0;
      const maxIterations = opts.maxIterations ?? 8;

      for (let i = 0; i < maxIterations; i++) {
        const started = Date.now();
        const { completion, attempts } = await this.llm.chat(opts.agentId, model, {
          messages,
          ...(toolDefs.length ? { tools: toolDefs } : {}),
        });
        const choice = completion.choices[0];
        if (!choice) throw new Error('LLM returned no choices');
        const tin = completion.usage?.prompt_tokens ?? 0;
        const tout = completion.usage?.completion_tokens ?? 0;
        totals.tokensIn += tin;
        totals.tokensOut += tout;
        totals.llmRequests += attempts;

        const message = assistantMessage(choice.message);
        await this.steps.add({
          run_id: runId,
          step_index: stepIndex++,
          type: 'llm_call',
          payload: {
            model,
            attempts,
            finishReason: choice.finish_reason,
            content: choice.message.content,
            toolCalls: (choice.message.tool_calls ?? []).map(describeToolCall),
          },
          duration_ms: Date.now() - started,
          tokens_in: tin,
          tokens_out: tout,
        });
        messages.push(message);

        const calls = (choice.message.tool_calls ?? []).filter((c) => c.type === 'function');
        if (!calls.length) {
          const output = choice.message.content ?? '';
          await this.runs.finish(runId, {
            status: 'succeeded',
            output: { text: output },
            tokens_in: totals.tokensIn,
            tokens_out: totals.tokensOut,
            llm_requests: totals.llmRequests,
          });
          return { runId, status: 'succeeded', output, ...totals };
        }

        for (const call of calls) {
          const { name, arguments: rawArgs } = call.function;
          await this.steps.add({
            run_id: runId,
            step_index: stepIndex++,
            type: 'tool_call',
            payload: { toolCallId: call.id, name, args: safeJson(rawArgs) },
          });
          const t0 = Date.now();
          const outcome = await this.executeTool(tools.get(name), name, rawArgs, ctx);
          await this.steps.add({
            run_id: runId,
            step_index: stepIndex++,
            type: 'tool_result',
            payload: { toolCallId: call.id, name, ...outcome },
            duration_ms: Date.now() - t0,
          });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify(outcome.ok ? outcome.result : { error: outcome.error }).slice(
              0,
              MAX_TOOL_RESULT_CHARS,
            ),
          });
        }
      }
      throw new MaxIterationsError(maxIterations);
    } catch (err) {
      return this.fail(opts, runId, err, totals);
    }
  }

  /**
   * Unknown tools and invalid input go back to the LLM as an error so it can correct itself.
   * Exceptions thrown by the tool itself propagate and fail the run.
   */
  private async executeTool(
    tool: Tool | undefined,
    name: string,
    rawArgs: string,
    ctx: ToolContext,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    if (!tool) return { ok: false, error: `Unknown tool "${name}"` };
    let args: unknown;
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      return { ok: false, error: 'Arguments were not valid JSON' };
    }
    const parsed = tool.input.safeParse(args);
    if (!parsed.success) {
      return {
        ok: false,
        error: `Invalid input: ${parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ')}`,
      };
    }
    return { ok: true, result: await tool.execute(parsed.data, ctx) };
  }

  private async fail(
    opts: RunAgentOptions,
    runId: string | null,
    err: unknown,
    totals: { tokensIn: number; tokensOut: number; llmRequests: number },
  ): Promise<AgentResult> {
    const message = err instanceof Error ? err.message : String(err);
    // Quota exhaustion is expected: the run is skipped and the queue posts one notice per day.
    const status = err instanceof QuotaExhaustedError ? 'skipped' : 'failed';
    if (runId) {
      await this.runs
        .finish(runId, {
          status,
          error: message,
          tokens_in: totals.tokensIn,
          tokens_out: totals.tokensOut,
          llm_requests: totals.llmRequests,
        })
        .catch((e) => this.log.error(`Could not record failure for run ${runId}: ${(e as Error).message}`));
    }
    if (status === 'failed') {
      this.log.error(`Agent ${opts.agentId} run ${runId ?? '(none)'} failed: ${message}`);
      this.events.emit(AGENT_ERROR, { agentId: opts.agentId, runId, message } satisfies AgentErrorEvent);
    }
    return { runId, status, output: null, error: message, ...totals };
  }
}

/**
 * The assistant message to send back on the next turn. Keeps provider extras such as
 * Gemini's `extra_content.google.thought_signature` (required for multi-turn tool calls)
 * and drops null fields the provider might reject.
 */
function assistantMessage(msg: OpenAI.Chat.ChatCompletionMessage): ChatMessage {
  const { refusal, annotations, audio, function_call, ...rest } = msg as OpenAI.Chat.ChatCompletionMessage & {
    annotations?: unknown;
  };
  void refusal;
  void annotations;
  void audio;
  void function_call;
  return rest as ChatMessage;
}

function describeToolCall(c: OpenAI.Chat.ChatCompletionMessageToolCall) {
  return c.type === 'function' ? { id: c.id, name: c.function.name, args: safeJson(c.function.arguments) } : { id: c.id, type: c.type };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
