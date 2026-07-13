/**
 * Feature flags for ARSENKIN TOOLS integration (First36 pilot).
 * Token must never appear in logs/report — only via env.
 */

export type ArsenkinToolName =
  | "check-top"
  | "suggest"
  | "paa"
  | "ai-serp"
  | "check-h"
  | "indexation";

const DEFAULT_TOOLS: ArsenkinToolName[] = [
  "check-top",
  "suggest",
  "paa",
  "ai-serp",
  "check-h",
  "indexation",
];

function parseTools(raw: string | undefined): ArsenkinToolName[] {
  const parts = String(raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return [...DEFAULT_TOOLS];
  const allowed = new Set<ArsenkinToolName>([
    "check-top",
    "suggest",
    "paa",
    "ai-serp",
    "check-h",
    "indexation",
  ]);
  const out: ArsenkinToolName[] = [];
  for (const p of parts) {
    if (allowed.has(p as ArsenkinToolName)) out.push(p as ArsenkinToolName);
  }
  return out.length > 0 ? out : [...DEFAULT_TOOLS];
}

export function isArsenkinEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ARSENKIN_ENABLED === "1" || env.ARSENKIN_ENABLED === "true";
}

export function arsenkinTools(env: NodeJS.ProcessEnv = process.env): ArsenkinToolName[] {
  return parseTools(env.ARSENKIN_TOOLS);
}

export function isArsenkinToolEnabled(
  tool: ArsenkinToolName,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return isArsenkinEnabled(env) && arsenkinTools(env).includes(tool);
}

export function arsenkinApiToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = String(env.ARSENKIN_API_TOKEN ?? "").trim();
  return t || null;
}

export function isArsenkinConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return isArsenkinEnabled(env) && Boolean(arsenkinApiToken(env));
}

/** STANDARD=3 concurrent, CORPORATE=5 — default STANDARD for pilot. */
export function arsenkinMaxConcurrent(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ARSENKIN_MAX_CONCURRENT ?? 3);
  if (!Number.isFinite(n) || n < 1) return 3;
  return Math.min(5, Math.floor(n));
}

export function arsenkinRequestsPerMinute(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.ARSENKIN_REQUESTS_PER_MINUTE ?? 30);
  if (!Number.isFinite(n) || n < 1) return 30;
  return Math.min(30, Math.floor(n));
}
