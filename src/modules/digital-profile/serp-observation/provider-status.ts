import type { SerpProviderStatus } from "./types";

const CAPTCHA_RE =
  /\b(captcha|recaptcha|hcaptcha|unusual\s+traffic|are\s+you\s+a\s+robot|sorry\/index|blocked.*bot)\b/i;

/**
 * Classify provider fetch outcome. CAPTCHA is a distinct typed status and must
 * never be reported as NO_RESULTS. Callers must not infinite-retry CAPTCHA.
 */
export function classifyProviderFetchOutcome(input: {
  configured: boolean;
  httpStatus?: number | null;
  errorMessage?: string | null;
  rawBodyText?: string | null;
  organicCount?: number | null;
}): SerpProviderStatus {
  if (!input.configured) return "PROVIDER_NOT_CONFIGURED";

  const blob = `${input.errorMessage ?? ""}\n${input.rawBodyText ?? ""}`;
  if (CAPTCHA_RE.test(blob)) return "PROVIDER_BLOCKED_CAPTCHA";

  if (input.httpStatus === 429) return "PROVIDER_RATE_LIMITED";
  if (input.httpStatus != null && input.httpStatus >= 400) {
    if (CAPTCHA_RE.test(String(input.httpStatus))) return "PROVIDER_BLOCKED_CAPTCHA";
    return "PROVIDER_FAILED";
  }

  if (input.errorMessage?.trim()) {
    return "PROVIDER_FAILED";
  }

  if ((input.organicCount ?? 0) === 0) return "NO_RESULTS";
  return "OK";
}

export function isCaptchaBlocked(status: SerpProviderStatus): boolean {
  return status === "PROVIDER_BLOCKED_CAPTCHA";
}

/** CAPTCHA / hard failures are not empty-result pages. */
export function isEmptyResultsStatus(status: SerpProviderStatus): boolean {
  return status === "NO_RESULTS";
}
