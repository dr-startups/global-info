/** Strip secrets from strings / objects before logging. Never mutate API payloads in-place for mapping. */

export function redactSecrets(text: string): string {
  return String(text ?? "")
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]")
    .replace(/ARSENKIN_API_TOKEN\s*=\s*\S+/gi, "ARSENKIN_API_TOKEN=[REDACTED]");
}

export function redactDeep<T>(value: T): T {
  if (value == null) return value;
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/^(authorization|token|api[_-]?key|password|secret)$/i.test(k)) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out as T;
  }
  return value;
}
