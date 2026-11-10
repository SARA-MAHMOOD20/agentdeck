import { Global, Inject, Injectable, Logger, Module, type OnApplicationBootstrap } from '@nestjs/common';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { AgentsRepo, RulesRepo, RunsRepo, StepsRepo, UsageRepo } from './repos.js';
import { SUPABASE } from './tokens.js';

export { SUPABASE };


/** Keeps the `app_owner` row (used by RLS) in sync with DASHBOARD_ALLOWED_EMAIL. */
@Injectable()
export class OwnerSync implements OnApplicationBootstrap {
  private readonly log = new Logger(OwnerSync.name);
  constructor(
    @Inject(SUPABASE) private readonly db: SupabaseClient,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async onApplicationBootstrap() {
    const email = this.env.DASHBOARD_ALLOWED_EMAIL.toLowerCase();
    const del = await this.db.from('app_owner').delete().neq('email', email);
    const ins = await this.db.from('app_owner').upsert({ email });
    if (del.error || ins.error) this.log.error(`Could not sync app_owner: ${(del.error ?? ins.error)?.message}`);
  }
}

@Global()
@Module({
  providers: [
    {
      provide: SUPABASE,
      inject: [ENV],
      useFactory: (env: Env) =>
        createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
          auth: { persistSession: false, autoRefreshToken: false },
        }),
    },
    OwnerSync,
    AgentsRepo,
    RunsRepo,
    StepsRepo,
    RulesRepo,
    UsageRepo,
  ],
  exports: [SUPABASE, AgentsRepo, RunsRepo, StepsRepo, RulesRepo, UsageRepo],
})
export class DatabaseModule {}
