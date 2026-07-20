/** Thrown when OpenAI returns HTTP 429 after QA-configured retries. Safe to surface to CLI. */
export class OpenAiRateLimitError extends Error {
  readonly code = "BLOCKED_OPENAI_RATE_LIMIT" as const;

  constructor(detail = "OpenAI rate limit (HTTP 429) after retries") {
    super(detail);
    this.name = "OpenAiRateLimitError";
  }
}

/** True for HTTP 429 status numbers or Error messages that name a 429. */
export function isOpenAiHttp429(error: unknown): boolean {
  if (typeof error === "number") return error === 429;
  return error instanceof Error && /openai-http-429|openai-429/i.test(error.message);
}
