import { Injectable, Module } from '@nestjs/common';
import { z } from 'zod';
import type { RunTrigger } from '@agentdeck/shared';
import { AgentRunner } from '../core/agent-runner.js';
import { defineTool } from '../core/tool.js';

/** Development-only agent that proves the tool loop works end to end. */
export const echoTool = defineTool({
  name: 'echo',
  description: 'Returns the given text unchanged.',
  input: z.object({ text: z.string().min(1).describe('The text to echo back') }),
  execute: async ({ text }) => ({ echoed: text, length: text.length }),
});

const SYSTEM_PROMPT = `You are a test agent.
Always call the "echo" tool exactly once with the user's message as "text".
Then reply with one line: "Echo: <echoed text> (<length> chars)".`;

@Injectable()
export class EchoAgent {
  constructor(private readonly runner: AgentRunner) {}

  run(text: string, trigger: RunTrigger = 'user') {
    return this.runner.runAgent({
      agentId: 'echo',
      trigger,
      input: text,
      tools: [echoTool],
      systemPrompt: SYSTEM_PROMPT,
    });
  }
}

@Module({ providers: [EchoAgent], exports: [EchoAgent] })
export class EchoAgentModule {}
