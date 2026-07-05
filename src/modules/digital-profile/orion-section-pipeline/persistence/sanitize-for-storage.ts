/** High-confidence secret/path markers only — avoid bare substrings like "debug" in URLs. */
const FORBIDDEN_TOKEN_CHECKS: Array<{ id: string; test: (serialized: string, lower: string) => boolean }> = [
  { id: "OPENAI_API_KEY", test: (_s, lower) => lower.includes("openai_api_key") },
  { id: "sk-", test: (serialized) => /sk-[a-z0-9_-]{12,}/i.test(serialized) },
  { id: "C:\\", test: (_s, lower) => /c:\\\\/.test(lower) },
  { id: "/mnt/", test: (_s, lower) => lower.includes("/mnt/") },
  {
    id: "storage/digital-profile",
    test: (_s, lower) => lower.includes("storage/digital-profile"),
  },
  { id: "signedUrl", test: (_s, lower) => lower.includes("signedurl") },
  { id: "rawPrompt", test: (_s, lower) => lower.includes("rawprompt") },
  { id: "rawModelResponse", test: (_s, lower) => lower.includes("rawmodelresponse") },
  { id: "stackTrace", test: (_s, lower) => lower.includes("stacktrace") },
  { id: "providerInternal", test: (_s, lower) => lower.includes("providerinternal") },
  { id: "runtimeInternal", test: (_s, lower) => lower.includes("runtimeinternal") },
];

function stripSensitiveStrings(value: string): string {
  return value
    .replace(/OPENAI_API_KEY/gi, "")
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, "")
    .replace(/C:\\[^ ]*/gi, "")
    .replace(/\/mnt\/[^ ]*/gi, "")
    .replace(/storage\/digital-profile\/[^\s"]*/gi, "")
    .replace(/signedUrl/gi, "")
    .replace(/rawPrompt/gi, "")
    .replace(/rawModelResponse/gi, "")
    .replace(/providerInternal/gi, "")
    .replace(/runtimeInternal/gi, "");
}

function sanitizeNode(node: unknown, clientVisible: boolean): unknown {
  if (node == null) return node;
  if (typeof node === "string") {
    return stripSensitiveStrings(node);
  }
  if (Array.isArray(node)) {
    return node.map((x) => sanitizeNode(x, clientVisible));
  }
  if (typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(node as Record<string, unknown>)) {
    const key = String(rawKey);
    const keyLower = key.toLowerCase();
    if (clientVisible && /(storagekey|signedurl|rawprompt|rawmodelresponse|debug|stacktrace|providerinternal|runtimeinternal)/i.test(keyLower)) {
      continue;
    }
    if (clientVisible && /(path|filepath|localpath)/i.test(keyLower)) {
      continue;
    }
    if (/(apikey|token|secret|password)/i.test(keyLower)) {
      continue;
    }
    out[key] = sanitizeNode(rawValue, clientVisible);
  }
  return out;
}

export function sanitizeForStorage(payload: unknown, input: { clientVisible: boolean }): unknown {
  return sanitizeNode(payload, input.clientVisible);
}

export function scanForbiddenTokens(payload: unknown): string[] {
  const serialized = JSON.stringify(payload ?? {});
  const lower = serialized.toLowerCase();
  return FORBIDDEN_TOKEN_CHECKS.filter(({ test }) => test(serialized, lower)).map(
    ({ id }) => id
  );
}

export function assertClientVisibleStorageSafe(payload: unknown): void {
  const tokens = scanForbiddenTokens(payload);
  if (tokens.length > 0) {
    throw new Error(`client-visible-storage-policy-violation:${tokens.join(",")}`);
  }
}
