import { FORBIDDEN_CLIENT_TERMS } from "../evidence/normalized-evidence";
import type { OrionReportSpecV1 } from "../report-spec/report-spec-schema";

const RAW_ENUM_PATTERN = /\b[a-z]+_[a-z0-9_]+\b/gi;
const GENERIC_TABLE_PATTERNS = [/поле\s*\/\s*значение/i, /этап анализа/i, /showing top \d+/i];

function collectClientFacingStrings(spec: OrionReportSpecV1): string[] {
  const parts: string[] = [];
  for (const section of spec.sections) {
    parts.push(section.title, section.subtitle ?? "");
    const n = section.clientNarrative;
    parts.push(
      n.headline,
      n.summary,
      n.whyItMatters,
      n.riskInterpretation,
      ...n.whatWasFound,
      ...n.whatWasNotConfirmed,
      ...n.manualReviewQueue,
      ...n.recommendedNextSteps
    );
    for (const m of section.metrics) parts.push(m.label, String(m.value));
    for (const h of section.evidenceHighlights) parts.push(h.label, h.summary, h.status);
    for (const slide of section.slides) {
      parts.push(slide.title, slide.subtitle ?? "", slide.narrative ?? "", ...(slide.bullets ?? []));
    }
  }
  for (const asset of spec.assets) parts.push(asset.title, asset.caption ?? "");
  for (const ev of spec.evidence) {
    parts.push(
      ev.title ?? "",
      ev.snippet ?? "",
      ev.clientSafeSummary ?? "",
      ev.sourceLabel,
      ev.displayUrl ?? ""
    );
  }
  return parts.filter(Boolean);
}

export function scanReportSpecClientText(text: string): string[] {
  const issues: string[] = [];
  const lower = text.toLowerCase();
  for (const term of FORBIDDEN_CLIENT_TERMS) {
    if (lower.includes(term.toLowerCase())) {
      issues.push(`forbidden-term:${term}`);
    }
  }
  for (const pattern of GENERIC_TABLE_PATTERNS) {
    if (pattern.test(text)) {
      issues.push(`generic-pattern:${pattern.source}`);
    }
  }
  const enumHits = text.match(RAW_ENUM_PATTERN) ?? [];
  for (const hit of enumHits) {
    const h = hit.toLowerCase();
    if (
      h.includes("compliance_db") ||
      h.includes("orion_static") ||
      h.includes("micro_stage") ||
      h.includes("review_status")
    ) {
      issues.push(`raw-enum:${hit}`);
    }
  }
  return issues;
}

export function scanReportSpecObject(spec: OrionReportSpecV1): string[] {
  const issues = new Set<string>();
  for (const part of collectClientFacingStrings(spec)) {
    for (const issue of scanReportSpecClientText(part)) issues.add(issue);
  }
  return [...issues];
}

export function hasEnglishStatusLabelsInRuOutput(text: string): boolean {
  const bad = [
    /\brequires_review\b/i,
    /\bconfirmed\b/i,
    /\bnot_available\b/i,
    /\bofficial_record_found\b/i,
    /\bexcluded_noise\b/i,
    /\bPENDING\b/,
    /\bREVIEWED\b/,
  ];
  return bad.some((p) => p.test(text));
}

export function scanReportSpecForEnglishStatus(spec: OrionReportSpecV1): boolean {
  const text = collectClientFacingStrings(spec).join("\n");
  return hasEnglishStatusLabelsInRuOutput(text);
}
