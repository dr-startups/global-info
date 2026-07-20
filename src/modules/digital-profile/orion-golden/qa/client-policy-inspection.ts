/**
 * R10 — Client text policy inspection for ORION Golden ReportSpec + deck.
 */

import { scanReportSpecClientText } from "./client-policy-scan";
import type { OrionGoldenDeckManifest } from "../composer/orion-deck-composer";
import {
  ORION_GOLDEN_FORBIDDEN_RAW_TOKENS,
  scanOrionGoldenClientTextForForbiddenTokens,
} from "../client/client-text-sanitizer";
import type { OrionGoldenReportSpec } from "../report-spec/orion-report-spec";

const EXTRA_FORBIDDEN = [
  "storage/",
  "openai",
  "mock",
  "fallback",
  "deterministic",
  "debug",
  "storagekey",
  "adverse_media",
  "executive_summary-rf-",
  "micro-stage",
  "micro_stage",
  "localhost",
  "/app/",
  "evidence_",
] as const;

function collectClientFacingParts(input: {
  reportSpec: OrionGoldenReportSpec;
  deckManifest: OrionGoldenDeckManifest;
}): string[] {
  const parts: string[] = [];
  parts.push(input.reportSpec.subject.displayName, input.reportSpec.subject.reportTitle);
  parts.push(input.reportSpec.executiveSummary.executiveSummary);
  parts.push(
    ...input.reportSpec.executiveSummary.mainRisks,
    ...input.reportSpec.executiveSummary.finalRecommendations,
    ...input.reportSpec.executiveSummary.nextSteps
  );
  for (const block of [
    input.reportSpec.ruAuditSummary,
    input.reportSpec.ruSearchResults,
    input.reportSpec.uaeAuditSummary,
    input.reportSpec.complianceDatabases,
    input.reportSpec.lexisNexis,
  ]) {
    parts.push(block.narrative, block.sectionTitle);
    for (const card of block.evidenceCards) parts.push(card.title, card.summary);
  }
  for (const slide of input.deckManifest.finalSlides) {
    parts.push(slide.title, slide.narrative ?? "", ...(slide.bullets ?? []));
  }
  return parts.filter(Boolean);
}

export function inspectOrionGoldenClientPolicy(input: {
  reportSpec: OrionGoldenReportSpec;
  deckManifest: OrionGoldenDeckManifest;
}): { passed: boolean; issues: string[] } {
  const parts = collectClientFacingParts(input);
  const text = parts.join("\n");
  const issues = new Set<string>(scanReportSpecClientText(text));

  const lower = text.toLowerCase();
  for (const term of [...EXTRA_FORBIDDEN, ...ORION_GOLDEN_FORBIDDEN_RAW_TOKENS]) {
    if (lower.includes(term.toLowerCase())) issues.add(`forbidden:${term}`);
  }

  for (const issue of scanOrionGoldenClientTextForForbiddenTokens(text)) {
    issues.add(issue);
  }

  if (/\bcmr[a-z0-9]{10,}\b/i.test(text)) {
    issues.add("forbidden:raw-case-id");
  }

  return { passed: issues.size === 0, issues: [...issues] };
}
