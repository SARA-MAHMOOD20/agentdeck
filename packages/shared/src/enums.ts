/** Agent IDs. `echo` is a development-only test agent. */
export const AGENT_IDS = ['orchestrator', 'calendar', 'uni_email', 'whatsapp', 'echo'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const AGENT_STATUSES = ['active', 'paused'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export const MODEL_TIERS = ['fast', 'smart'] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const RUN_TRIGGERS = ['cron', 'webhook', 'user', 'agent', 'event'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const RUN_STATUSES = ['running', 'succeeded', 'failed', 'skipped'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const STEP_TYPES = ['llm_call', 'tool_call', 'tool_result'] as const;
export type StepType = (typeof STEP_TYPES)[number];

export const PRIORITIES = ['urgent', 'important', 'info'] as const;
export type FlagPriority = (typeof PRIORITIES)[number];

export const FLAG_SOURCES = ['gmail', 'whatsapp'] as const;
export type FlagSource = (typeof FLAG_SOURCES)[number];

export const FLAG_STATUSES = ['new', 'seen', 'dismissed'] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];

export const PENDING_STATUSES = ['pending', 'confirmed', 'cancelled', 'expired'] as const;
export type PendingStatus = (typeof PENDING_STATUSES)[number];

export const DECIDED_VIA = ['discord', 'web'] as const;
export type DecidedVia = (typeof DECIDED_VIA)[number];

export const CHAT_SOURCES = ['discord', 'web'] as const;
export type ChatSource = (typeof CHAT_SOURCES)[number];

/** LLM queue priority: lower number is served first. */
export const AGENT_PRIORITY: Record<AgentId, number> = {
  orchestrator: 0,
  calendar: 1,
  uni_email: 2,
  whatsapp: 3,
  echo: 4,
};
