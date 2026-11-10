import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import OpenAI from 'openai';
import { toJSONSchema, type z } from 'zod';
import type { AgentId, ModelTier, ModelUsage } from '@agentdeck/shared';
import { ENV } from '../config/config.module.js';
import { enabledFeatures, type Env } from '../config/env.schema.js';
import { UsageRepo } from '../database/repos.js';
import { StructuredOutputError } from './errors.js';
import {
  LlmQueue,
  realClock,
  type ChatCompletion,
  type ChatParams,
  type ModelTarget,
  type QueueResult,
} from './llm-queue.js';

export type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

export const LLM_QUOTA_EXHAUSTED = 'llm.quota_exhausted';
export interface QuotaExhaustedEvent {
  model: string;
  resetsAt: number;
}

export interface StructuredRequest<S extends z.ZodTypeAny> {
  agentId: AgentId;
  model: string;
  schema: S;
  /** Name for the JSON schema sent to the provider. */
  name: string;
  messages: ChatMessage[];
  /** Called after every LLM call (for tracing). */
  onCall?: (info: { completion: ChatCompletion; attempts: number; durationMs: number }) => Promise<void> | void;
}

@Injectable()
export class LlmService implements OnModuleInit {
  private readonly log = new Logger(LlmService.name);
  readonly queue: LlmQueue;

  constructor(
    @Inject(ENV) private readonly env: Env,
    usage: UsageRepo,
    events: EventEmitter2,
  ) {
    // Our queue owns retries, so the SDK's own retries are off.
    const gemini = new OpenAI({
      apiKey: env.LLM_API_KEY,
      baseURL: env.LLM_BASE_URL,
      maxRetries: 0,
      timeout: 60_000,
    });
    const geminiClient = { create: (p: ChatParams) => gemini.chat.completions.create(p) };
    const targets: ModelTarget[] = [];
    for (const model of new Set([env.LLM_MODEL_FAST, env.LLM_MODEL_SMART])) {
      targets.push({ model, rpm: env.LLM_RPM_LIMIT, rpd: env.LLM_RPD_LIMIT, client: geminiClient });
    }
    if (enabledFeatures(env).whatsappLocalLlm) {
      const local = new OpenAI({ apiKey: 'local', baseURL: env.WHATSAPP_LLM_BASE_URL, maxRetries: 0 });
      targets.push({
        model: env.WHATSAPP_LLM_MODEL!,
        rpm: Number.POSITIVE_INFINITY,
        rpd: Number.POSITIVE_INFINITY,
        client: { create: (p: ChatParams) => local.chat.completions.create(p) },
      });
    }

    this.queue = new LlmQueue(targets, usage, realClock, {
      onExhausted: (model, resetsAt) => {
        this.log.warn(`Daily quota exhausted for ${model}`);
        events.emit(LLM_QUOTA_EXHAUSTED, { model, resetsAt } satisfies QuotaExhaustedEvent);
      },
      onRetry: (model, err, attempt, delay) =>
        this.log.warn(`LLM retry ${attempt} for ${model} in ${delay} ms: ${(err as Error).message?.slice(0, 200)}`),
      onStoreError: (err) => this.log.error(`Failed to persist LLM usage: ${(err as Error).message}`),
    });
  }

  async onModuleInit() {
    await this.queue.init();
  }

  modelFor(tier: ModelTier): string {
    return tier === 'smart' ? this.env.LLM_MODEL_SMART : this.env.LLM_MODEL_FAST;
  }

  chat(agentId: AgentId, model: string, params: Omit<ChatParams, 'model'>): Promise<QueueResult> {
    return this.queue.chat({ agentId, model, params });
  }

  usage(): ModelUsage[] {
    return this.queue.getUsage();
  }

  /**
   * JSON output validated with zod. On a validation failure, retries once with the error
   * appended to the conversation, then throws StructuredOutputError.
   */
  async structured<S extends z.ZodTypeAny>(req: StructuredRequest<S>): Promise<z.infer<S>> {
    const jsonSchema = toJSONSchema(req.schema, { target: 'draft-7' }) as Record<string, unknown>;
    delete jsonSchema.$schema;
    const messages = [...req.messages];
    let lastText: string | null = null;

    for (let attempt = 0; attempt < 2; attempt++) {
      const started = Date.now();
      const { completion, attempts } = await this.chat(req.agentId, req.model, {
        messages,
        response_format: { type: 'json_schema', json_schema: { name: req.name, schema: jsonSchema } },
      });
      await req.onCall?.({ completion, attempts, durationMs: Date.now() - started });
      lastText = completion.choices[0]?.message.content ?? '';

      let problem: string;
      try {
        const parsed = req.schema.safeParse(JSON.parse(stripFences(lastText)));
        if (parsed.success) return parsed.data;
        problem = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      } catch (e) {
        problem = `not valid JSON (${(e as Error).message})`;
      }
      messages.push(
        { role: 'assistant', content: lastText },
        {
          role: 'user',
          content: `Your previous output failed validation: ${problem}. Return only corrected JSON matching the schema.`,
        },
      );
    }
    throw new StructuredOutputError('LLM output failed schema validation twice', lastText);
  }
}

/** Some models wrap JSON in ```json fences despite response_format. */
function stripFences(s: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(s);
  return m ? m[1]! : s;
}
