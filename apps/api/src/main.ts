import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { EnvValidationError, loadEnv } from './config/env.schema.js';

async function bootstrap() {
  // Fail fast with a readable list of every bad env var before Nest starts.
  let env;
  try {
    env = loadEnv(process.env);
  } catch (e) {
    if (e instanceof EnvValidationError) {
      console.error(`\n${e.message}\n`);
      process.exit(1);
    }
    throw e;
  }

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.enableCors({ origin: env.DASHBOARD_URL, credentials: true });
  app.enableShutdownHooks();
  await app.listen(env.PORT);
  app.get(Logger).log(`API listening on :${env.PORT}`);
}

void bootstrap();
