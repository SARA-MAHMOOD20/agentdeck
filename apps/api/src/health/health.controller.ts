import { Controller, Get, Inject, Module, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { UsageRepo } from '../database/repos.js';

type Check = { status: 'ok' | 'error' | 'not_configured'; latencyMs?: number; error?: string };

@Controller('health')
export class HealthController {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly usage: UsageRepo,
  ) {}

  @Get()
  async health(@Res({ passthrough: true }) res: Response) {
    const db = await this.timed(() => this.usage.ping());
    // Discord, WhatsApp and Google checks are added in their phases.
    const checks: Record<string, Check> = {
      db,
      discord: { status: 'not_configured' },
      whatsapp: { status: 'not_configured' },
      google: { status: 'not_configured' },
    };
    const ok = db.status === 'ok';
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ok' : 'degraded', checks, time: new Date().toISOString() };
  }

  private async timed(fn: () => Promise<void>): Promise<Check> {
    const t0 = Date.now();
    try {
      await fn();
      return { status: 'ok', latencyMs: Date.now() - t0 };
    } catch (e) {
      return { status: 'error', latencyMs: Date.now() - t0, error: (e as Error).message };
    }
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
