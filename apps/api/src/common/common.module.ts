import { Global, Module } from '@nestjs/common';
import { ENV } from '../config/config.module.js';
import type { Env } from '../config/env.schema.js';
import { Crypto } from './crypto.js';

@Global()
@Module({
  providers: [{ provide: Crypto, inject: [ENV], useFactory: (env: Env) => new Crypto(env.ENCRYPTION_KEY) }],
  exports: [Crypto],
})
export class CommonModule {}
