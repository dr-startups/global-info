/** R9.12 — Client-facing text safety contract for ORION storyboard outputs. */

import { FORBIDDEN_CLIENT_LABELS } from "./schema";

export const CLIENT_HOSTILE_PATTERNS: RegExp[] = [
  /\bcmr[a-z0-9]{10,}\b/gi,
  /executive_summary-rf-/gi,
  /ru_audit_summary-rf-/gi,
  /ru_search_results-rf-/gi,
  /-sr-cmr[a-z0-9]+/gi,
  /executive_summary-sr-/gi,
  /ru_audit_summary-sr-/gi,
  /ru_search_results-sr-/gi,
  /\bstorage\/digital-profile\b/gi,
  /\blocalhost\b/gi,
  /\bORION_STATIC\b/gi,
  /\bfixture\b/gi,
  /\bmicro-stage\b/gi,
  /\bstage key\b/gi,
  /\bmanifest\b/gi,
  /\bfallback\b/gi,
  /\bmock\b/gi,
  /\bdebug\b/gi,
  /\bPRESENT\b/g,
  /\bUNKNOWN\b/g,
  /\bNOT_COLLECTED\b/g,
  /\badverse_media\b/gi,
  /\bpep\b/gi,
  /\bexample\.com\b/gi,
  /\bexample\.ru\b/gi,
];

const EVIDENCE_ID_PATTERN =
  /\b(?:executive_summary|ru_audit_summary|ru_search_results|lexis_summary|recommended_actions)-(?:rf|sr)-[a-z0-9-]+\b/gi;

const MANUAL_REVIEW_VARIANTS = [
  "требует ручной проверки",
  "требует ручной верификации",
  "необходима ручная проверка",
  "нужна дополнительная верификация",
  "следует подтвердить вручную",
];

export function stripEvidenceIdsFromClientText(text: string): string {
  let out = text;
  out = out.replace(EVIDENCE_ID_PATTERN, "");
  out = out.replace(/\bcmr[a-z0-9]{10,}\b/gi, "");
  out = out.replace(/\b[a-z_]+-(?:rf|sr)-cmr[a-z0-9]+\b/gi, "");
  return out.replace(/\s{2,}/g, " ").trim();
}

export function humanizeEvidenceRefsForClient(text: string): string {
  let out = stripEvidenceIdsFromClientText(text);
  out = out.replace(/\bevidenceRef\b/gi, "источник");
  out = out.replace(/\bassetRef\b/gi, "материал");
  return out.replace(/\s{2,}/g, " ").trim();
}

export function sanitizeClientNarrativeText(text: string): string {
  if (!text) return "";
  let out = humanizeEvidenceRefsForClient(text);
  for (const term of FORBIDDEN_CLIENT_LABELS) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(re, "");
  }
  for (const re of CLIENT_HOSTILE_PATTERNS) {
    out = out.replace(re, "");
  }
  out = out.replace(/\bPEP\b/g, "политически значимое лицо");
  out = out.replace(/\brow\b/gi, "запись");
  return out.replace(/\s{2,}/g, " ").trim();
}

export function assertNoClientHostileTokens(text: string, context = "client-text"): string[] {
  const issues: string[] = [];
  const lower = text.toLowerCase();
  for (const term of FORBIDDEN_CLIENT_LABELS) {
    if (lower.includes(term.toLowerCase())) issues.push(`${context}:forbidden:${term}`);
  }
  for (const re of CLIENT_HOSTILE_PATTERNS) {
    re.lastIndex = 0;
    const m = text.match(re);
    if (m?.length) issues.push(`${context}:pattern:${m[0]}`);
  }
  if (/\+ \d+ more items/i.test(text)) issues.push(`${context}:forbidden:+more-items`);
  return issues;
}

export function diversifyManualReviewPhrase(text: string, seed = 0): string {
  const idx = Math.abs(seed) % MANUAL_REVIEW_VARIANTS.length;
  if (!/требует ручной проверки/i.test(text)) return text;
  return text.replace(/требует ручной проверки/gi, MANUAL_REVIEW_VARIANTS[idx]!);
}

export function sanitizeStringArray(items: string[], seed = 0): string[] {
  return items
    .map((item, i) => diversifyManualReviewPhrase(sanitizeClientNarrativeText(item), seed + i))
    .filter(Boolean);
}

export function collectClientVisibleTextFromStoryboard(storyboard: {
  subject?: { displayName?: string };
  slides: Array<{
    title?: string;
    subtitle?: string;
    clientTakeaway?: string;
    findings?: Array<{ headline?: string; summary?: string }>;
    evidenceRefs?: Array<{ label?: string; summary?: string; statusLabel?: string }>;
    recommendedActions?: Array<{ label?: string; rationale?: string }>;
    metrics?: Array<{ label?: string; value?: string | number }>;
  }>;
}): string {
  const parts: string[] = [storyboard.subject?.displayName ?? ""];
  for (const slide of storyboard.slides) {
    parts.push(slide.title ?? "", slide.subtitle ?? "", slide.clientTakeaway ?? "");
    for (const f of slide.findings ?? []) parts.push(f.headline ?? "", f.summary ?? "");
    for (const e of slide.evidenceRefs ?? []) parts.push(e.label ?? "", e.summary ?? "", e.statusLabel ?? "");
    for (const a of slide.recommendedActions ?? []) parts.push(a.label ?? "", a.rationale ?? "");
    for (const m of slide.metrics ?? []) parts.push(String(m.label ?? ""), String(m.value ?? ""));
  }
  return parts.join("\n");
}
