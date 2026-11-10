import { Global, Module } from '@nestjs/common';
import { AgentRunner } from './agent-runner.js';

@Global()
@Module({ providers: [AgentRunner], exports: [AgentRunner] })
export class AgentsCoreModule {}
