export class QuotaExhaustedError extends Error {
  override readonly name = 'QuotaExhaustedError';
  constructor(
    readonly model: string,
    readonly resetsAt: number,
  ) {
    super(`Daily LLM quota for ${model} is used up until ${new Date(resetsAt).toISOString()}`);
  }
}

export class StructuredOutputError extends Error {
  override readonly name = 'StructuredOutputError';
  constructor(
    message: string,
    readonly lastOutput: string | null,
  ) {
    super(message);
  }
}

export class UnknownModelError extends Error {
  override readonly name = 'UnknownModelError';
  constructor(model: string) {
    super(`Model "${model}" is not configured (check LLM_MODEL_FAST / LLM_MODEL_SMART)`);
  }
}
