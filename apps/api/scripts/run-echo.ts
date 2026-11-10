/**
 * Phase 1 smoke test: runs the echo agent once against the real LLM and database.
 * Usage: pnpm --filter @agentdeck/api echo "hello world"
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module.js';
import { EchoAgent } from '../src/agents/echo/echo.agent.js';
import { LlmService } from '../src/llm/llm.service.js';
import { EnvValidationError, loadEnv } from '../src/config/env.schema.js';

async function main() {
  try {
    loadEnv(process.env);
  } catch (e) {
    if (e instanceof EnvValidationError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

  const text = process.argv.slice(2).join(' ') || 'hello from agentdeck';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  await app.init();

  const result = await app.get(EchoAgent).run(text, 'user');
  console.log('\nRun result:');
  console.log(JSON.stringify(result, null, 2));
  console.log('\nQuota usage:');
  console.table(app.get(LlmService).usage());

  await app.close();
  process.exit(result.status === 'succeeded' ? 0 : 1);
}

void main();
