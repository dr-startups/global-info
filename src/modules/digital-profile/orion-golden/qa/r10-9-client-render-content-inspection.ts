/**
 * R10.9 — Content inspection for ReportSpec/deck built from client content.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OrionGoldenDeckManifest } from "../composer/orion-deck-composer";
import type { OrionGoldenReportSpec } from "../report-spec/orion-report-spec";
import { ORION_GOLDEN_FORBIDDEN_RAW_TOKENS } from "../client/client-text-sanitizer";

export type ClientRenderContentInspectionVerdict =
  | "CONTENT_SOURCE_OK"
  | "BLOCKED_CLIENT_TEXT_LEAK"
  | "BLOCKED_WRONG_SUBJECT_RENDERED"
  | "BLOCKED_PENDING_AS_CONFIRMED"
  | "BLOCKED_COMMERCIAL_SLIDES"
  | "BLOCKED_MISSING_REQUIRED_SECTIONS";

function check(id: string, passed: boolean, detail: string) {
  return { id, passed, detail };
}

function collectText(reportSpec: OrionGoldenReportSpec, deck: OrionGoldenDeckManifest): string {
  const parts: string[] = [
    reportSpec.executiveSummary.executiveSummary,
    ...reportSpec.executiveSummary.mainRisks,
    ...reportSpec.executiveSummary.finalRecommendations,
    reportSpec.ruAuditSummary.narrative,
    reportSpec.ruSearchResults.narrative,
    reportSpec.appendix.narrative,
    reportSpec.offer.narrative,
  ];
  for (const s of deck.finalSlides) {
    parts.push(s.title, s.narrative ?? "", ...(s.bullets ?? []));
  }
  return parts.join("\n");
}

export function inspectClientRenderContent(input: {
  reportSpec: OrionGoldenReportSpec;
  deckManifest: OrionGoldenDeckManifest;
  clientContentPath?: string;
}): {
  version: "r10-9-client-render-content-inspection-v1";
  passed: boolean;
  verdict: ClientRenderContentInspectionVerdict;
  issues: string[];
  checks: Array<{ id: string; passed: boolean; detail: string }>;
} {
  const { reportSpec, deckManifest } = input;
  const issues: string[] = [];
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const text = collectText(reportSpec, deckManifest);
  const lower = text.toLowerCase();
  const sectionKeys = new Set(deckManifest.finalSlides.map((s) => s.sectionKey));

  const hasExec = sectionKeys.has("executive_summary") && Boolean(reportSpec.executiveSummary.executiveSummary);
  checks.push(check("executive-summary", hasExec, "executive summary present"));
  if (!hasExec) issues.push("missing-required");

  const hasRisk = sectionKeys.has("compliance_risk_matrix");
  checks.push(check("compact-risk-matrix", hasRisk, `rows=${reportSpec.riskMatrix?.length ?? 0}`));
  if (!hasRisk) issues.push("missing-required");

  const hasManual =
    sectionKeys.has("manual_review_required") ||
    /ручной проверк|не являются подтверждёнными/i.test(text);
  checks.push(check("manual-review-caveated", hasManual, `present=${hasManual}`));
  if (!hasManual) issues.push("missing-required");

  const hasLimitations = /ограничен/i.test(text) || sectionKeys.has("appendix");
  checks.push(check("limitations-or-appendix", hasLimitations, `present=${hasLimitations}`));

  const hasRecs =
    sectionKeys.has("recommendations") ||
    (reportSpec.executiveSummary.finalRecommendations?.length ?? 0) > 0;
  checks.push(check("recommendations", hasRecs, `present=${hasRecs}`));

  const fromClient =
    reportSpec.qaMetadata.architectureVersion.includes("r10-9-client-content") ||
    reportSpec.qaMetadata.warnings.some((w) => w.includes("client_audit_render"));
  checks.push(check("render-from-client-content", fromClient, reportSpec.qaMetadata.architectureVersion));
  if (!fromClient) issues.push("old-content");

  const commercial = ["product_overview", "about", "solution_digital_profile", "solution_compliance_databases", "solution_wikipedia"].filter(
    (k) => sectionKeys.has(k)
  );
  checks.push(check("no-commercial-slides", commercial.length === 0, commercial.join(",") || "none"));
  if (commercial.length) issues.push("commercial");

  const wrongSubject = /wrong_subject|другой субъект.*(подтвержд|риск)/i.test(text);
  checks.push(check("no-wrong-subject-as-finding", !wrongSubject, `leak=${wrongSubject}`));
  if (wrongSubject) issues.push("wrong-subject");

  const pendingAsConfirmed =
    /подтверждённ(ый|ого|ые)\s+(негативн|риск)/i.test(text) &&
    /требует проверки|на ручной проверке/i.test(text) &&
    /подтверждённ.*ручн/i.test(text);
  // Softer: look for explicit bad pattern "подтверждённый риск" near pending without caveat
  const badPending = /pending.*(confirmed|подтвержд)/i.test(lower) || /review_required/.test(lower);
  checks.push(check("pending-not-confirmed", !badPending, `badPending=${badPending}`));
  if (badPending) issues.push("pending-confirmed");

  const leaks: string[] = [];
  for (const token of ORION_GOLDEN_FORBIDDEN_RAW_TOKENS) {
    if (lower.includes(token.toLowerCase())) leaks.push(token);
  }
  for (const token of ["storage/", "localhost", "/app/", "snake_case", "requires_review"]) {
    if (lower.includes(token.toLowerCase())) leaks.push(token);
  }
  checks.push(check("no-client-text-leaks", leaks.length === 0, leaks.slice(0, 8).join(",") || "none"));
  if (leaks.length) issues.push("text-leak");

  if (input.clientContentPath && existsSync(input.clientContentPath)) {
    const raw = readFileSync(input.clientContentPath, "utf-8");
    checks.push(
      check(
        "post-review-artifact-exists",
        /post-review|r10-6-orion-client-content/.test(raw),
        input.clientContentPath
      )
    );
  }

  let verdict: ClientRenderContentInspectionVerdict = "CONTENT_SOURCE_OK";
  if (issues.includes("text-leak")) verdict = "BLOCKED_CLIENT_TEXT_LEAK";
  else if (issues.includes("wrong-subject")) verdict = "BLOCKED_WRONG_SUBJECT_RENDERED";
  else if (issues.includes("pending-confirmed")) verdict = "BLOCKED_PENDING_AS_CONFIRMED";
  else if (issues.includes("commercial")) verdict = "BLOCKED_COMMERCIAL_SLIDES";
  else if (issues.includes("missing-required") || issues.includes("old-content")) {
    verdict = "BLOCKED_MISSING_REQUIRED_SECTIONS";
  }

  return {
    version: "r10-9-client-render-content-inspection-v1",
    passed: verdict === "CONTENT_SOURCE_OK",
    verdict,
    issues,
    checks,
  };
}

export function writeClientRenderContentInspection(outputRoot: string, inspection: ReturnType<typeof inspectClientRenderContent>): string {
  const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
  mkdirSync(outputRoot, { recursive: true });
  const out = join(outputRoot, "r10-9-client-render-content-inspection.json");
  writeFileSync(out, `${JSON.stringify({ ...inspection, generatedAt: new Date().toISOString() }, null, 2)}\n`, "utf-8");
  return out;
}
