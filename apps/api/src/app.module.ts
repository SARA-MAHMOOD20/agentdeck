import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';
import { AgentsCoreModule } from './agents/core/agents-core.module.js';
import { EchoAgentModule } from './agents/echo/echo.agent.js';
import { CommonModule } from './common/common.module.js';
import { ConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.controller.js';
import { LlmModule } from './llm/llm.module.js';

const isDev = process.env.NODE_ENV !== 'production';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        // Never log message contents or secrets (CLAUDE.md: "no bodies in stdout").
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            '*.body',
            '*.content',
            '*.text',
            '*.snippet',
            '*.token',
            '*.access_token',
            '*.refresh_token',
          ],
          censor: '[redacted]',
        },
        autoLogging: { ignore: (req) => req.url === '/health' },
        ...(isDev ? { transport: { target: 'pino-pretty', options: { singleLine: true } } } : {}),
      },
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    ConfigModule,
    CommonModule,
    DatabaseModule,
    LlmModule,
    AgentsCoreModule,
    EchoAgentModule,
    HealthModule,
  ],
})
export class AppModule {}
