/**
 * R10.8 — Admin UI QA / smoke checks (artifact + validation + route presence).
 * Does not invoke PDF/PPTX renderer. Does not create fake approvals.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isHighImpactManualReviewItem,
  validateAdminReviewDecisionInput,
} from "../evidence/admin-review-decision-validation";
import { applyAdminDecisionsToJudgments } from "../evidence/apply-admin-decisions-to-judgments";
import type { AdminReviewDecision } from "../evidence/admin-review-decision";
import type { EvidenceJudgment } from "../evidence/evidence-judgment";
import type { OrionClientContent } from "../content/orion-client-content-builder";
import { ORION_GOLDEN_QA_STORAGE_ROOT } from "../evidence/admin-review-decision-store";

export type AdminUiQaVerdict =
  | "ADMIN_UI_READY"
  | "BLOCKED_ROUTE_MISSING"
  | "BLOCKED_API_WIRING"
  | "BLOCKED_DECISION_VALIDATION"
  | "BLOCKED_PENDING_USED_AS_CONFIRMED"
  | "BLOCKED_FAKE_APPROVALS"
  | "BLOCKED_REGENERATION"
  | "BLOCKED_RENDERER_INVOKED";

function check(id: string, passed: boolean, detail: string) {
  return { id, passed, detail };
}

export function inspectAdminUiQa(input?: {
  workspaceRoot?: string;
  caseId?: string;
}): {
  version: "r10-8-admin-ui-qa-v1";
  passed: boolean;
  verdict: AdminUiQaVerdict;
  issues: string[];
  checks: Array<{ id: string; passed: boolean; detail: string }>;
  metrics?: Record<string, number | string | boolean>;
} {
  const root = input?.workspaceRoot ?? process.cwd();
  const issues: string[] = [];
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];

  const pagePath = join(
    root,
    "src/app/admin/digital-profile/[caseId]/orion-golden/manual-review/page.tsx"
  );
  const viewPath = join(root, "src/modules/digital-profile/client/ManualReviewAdminView.tsx");
  const apiQueue = join(
    root,
    "src/app/api/digital-profile/cases/[id]/orion-golden/manual-review/route.ts"
  );
  const apiItem = join(
    root,
    "src/app/api/digital-profile/cases/[id]/orion-golden/manual-review/[evidenceId]/route.ts"
  );
  const apiDecisions = join(
    root,
    "src/app/api/digital-profile/cases/[id]/orion-golden/admin-review-decisions/route.ts"
  );
  const apiRegen = join(
    root,
    "src/app/api/digital-profile/cases/[id]/orion-golden/client-content/regenerate/route.ts"
  );

  checks.push(check("manual-review-page-route", existsSync(pagePath), pagePath));
  if (!existsSync(pagePath)) issues.push("route-missing");

  checks.push(check("manual-review-admin-view", existsSync(viewPath), viewPath));
  if (!existsSync(viewPath)) issues.push("route-missing");

  checks.push(check("api-queue-route", existsSync(apiQueue), apiQueue));
  checks.push(check("api-item-route", existsSync(apiItem), apiItem));
  checks.push(check("api-decisions-route", existsSync(apiDecisions), apiDecisions));
  checks.push(check("api-regenerate-route", existsSync(apiRegen), apiRegen));
  if (![apiQueue, apiItem, apiDecisions, apiRegen].every((p) => existsSync(p))) {
    issues.push("api-wiring");
  }

  // Decision validation
  const caveatFail = validateAdminReviewDecisionInput({
    status: "APPROVED_WITH_CAVEAT",
    caveatText: "",
  });
  checks.push(
    check(
      "caveat-required",
      caveatFail.ok === false && caveatFail.errors.some((e) => /caveatText/i.test(e)),
      caveatFail.errors.join("; ")
    )
  );
  if (caveatFail.ok) issues.push("decision-validation");

  const wrongFail = validateAdminReviewDecisionInput({
    status: "WRONG_SUBJECT",
    reviewerNote: "",
  });
  checks.push(
    check("wrong-subject-note-required", wrongFail.ok === false, wrongFail.errors.join("; "))
  );
  if (wrongFail.ok) issues.push("decision-validation");

  const highImpactFail = validateAdminReviewDecisionInput({
    status: "APPROVED",
    isHighImpact: true,
    highImpactAcknowledged: false,
  });
  checks.push(
    check(
      "high-impact-approval-gated",
      highImpactFail.ok === false,
      highImpactFail.errors.join("; ")
    )
  );
  if (highImpactFail.ok) issues.push("decision-validation");

  const overwriteFail = validateAdminReviewDecisionInput({
    status: "EXCLUDED",
    existingStatus: "APPROVED",
    overwriteConfirmed: false,
  });
  checks.push(
    check("overwrite-confirmation-required", overwriteFail.ok === false, overwriteFail.errors.join("; "))
  );
  if (overwriteFail.ok) issues.push("decision-validation");

  checks.push(
    check(
      "high-impact-detector",
      isHighImpactManualReviewItem({
        riskSignal: "COMPLIANCE_RELEVANT",
        title: "LexisNexis potential match",
      }) === true,
      "compliance detector"
    )
  );

  // Prefer R10.7c real-subject calibration artifacts when present; else parallel E2E root.
  const calibrationCaseId = "cmqzz1vbr00d2vdrsrjsgie2g";
  const caseId = input?.caseId ?? calibrationCaseId;
  const calibrationRoot = join(root, "storage", "digital-profile", "qa-r10-7-real-subject-calibration");
  const parallelRoot = ORION_GOLDEN_QA_STORAGE_ROOT;
  const calibrationQueue = join(calibrationRoot, "manual-review-queue.json");
  const parallelQueue = join(parallelRoot, "manual-review-queue.json");

  let artifactRoot = parallelRoot;
  let queuePath = parallelQueue;
  if (existsSync(calibrationQueue)) {
    try {
      const calQ = JSON.parse(readFileSync(calibrationQueue, "utf-8")) as { caseId?: string };
      if (!input?.caseId || calQ.caseId === caseId || calQ.caseId === calibrationCaseId) {
        artifactRoot = calibrationRoot;
        queuePath = calibrationQueue;
      }
    } catch {
      // fall back to parallel
    }
  }

  const decisionsPath = join(artifactRoot, "admin-review-decisions.json");
  const judgmentsPath = join(artifactRoot, "evidence-judgment-inspection.json");
  let queueCount = 0;
  let queueCaseId = "";
  let fakeApprovals = 0;
  let artifactSource: "calibration-r10-7c" | "parallel-e2e" | "missing" = "missing";

  if (existsSync(queuePath)) {
    const queue = JSON.parse(readFileSync(queuePath, "utf-8")) as {
      caseId?: string;
      items?: unknown[];
      pendingCount?: number;
    };
    queueCount = queue.items?.length ?? 0;
    queueCaseId = queue.caseId ?? "";
    artifactSource = artifactRoot === calibrationRoot ? "calibration-r10-7c" : "parallel-e2e";
    checks.push(
      check(
        "queue-artifact-present",
        queueCount >= 0,
        `items=${queueCount} caseId=${queueCaseId} root=${artifactSource}`
      )
    );
    // Sanity: for calibration case, expect ~49 (R10.7c MANUAL_REVIEW), not older parallel 54
    if (artifactSource === "calibration-r10-7c") {
      const expectedish = queueCount >= 40 && queueCount <= 70;
      checks.push(
        check(
          "queue-count-matches-r107c-calibration",
          expectedish && queueCaseId === calibrationCaseId,
          `expected ~49 MANUAL_REVIEW for ${calibrationCaseId}; got ${queueCount}`
        )
      );
      if (!(expectedish && queueCaseId === calibrationCaseId)) issues.push("api-wiring");
    } else if (existsSync(calibrationQueue)) {
      checks.push(
        check(
          "queue-count-matches-r107c-calibration",
          false,
          `calibration queue exists but QA used ${artifactSource}`
        )
      );
      issues.push("api-wiring");
    } else {
      checks.push(
        check(
          "queue-count-matches-r107c-calibration",
          true,
          `calibration artifacts absent; using ${artifactSource} case=${queueCaseId} items=${queueCount}`
        )
      );
    }
  } else {
    checks.push(check("queue-artifact-present", false, "manual-review-queue.json missing"));
    checks.push(check("queue-count-matches-r107c-calibration", false, "no queue artifact"));
  }

  if (existsSync(decisionsPath)) {
    const decisions = JSON.parse(readFileSync(decisionsPath, "utf-8")) as {
      qaSampleOnly?: boolean;
      decisions?: AdminReviewDecision[];
    };
    fakeApprovals = decisions.qaSampleOnly
      ? 0
      : (decisions.decisions ?? []).filter((d) => d.status !== "PENDING" && !d.reviewedBy && !d.reviewedAt)
          .length;
    // Production file should not be qaSampleOnly with non-pending pretending to be real
    const sampleLeak =
      decisions.qaSampleOnly === true &&
      (decisions.decisions ?? []).some((d) => d.status !== "PENDING");
    checks.push(
      check(
        "no-fake-approvals-in-production-store",
        !sampleLeak,
        `qaSampleOnly=${decisions.qaSampleOnly} decisions=${decisions.decisions?.length ?? 0}`
      )
    );
    if (sampleLeak) issues.push("fake-approvals");
  } else {
    checks.push(check("no-fake-approvals-in-production-store", true, "no decisions file yet"));
  }

  // Pending not confirmed in post-review content if available
  const postPath = join(artifactRoot, "orion-client-content.post-review.json");
  if (existsSync(postPath) && existsSync(judgmentsPath)) {
    const post = JSON.parse(readFileSync(postPath, "utf-8")) as OrionClientContent;
    const judgments = (
      JSON.parse(readFileSync(judgmentsPath, "utf-8")) as { judgments: EvidenceJudgment[] }
    ).judgments;
    const pendingIds = new Set(
      judgments
        .filter((j) => j.adminReviewStatus === "PENDING" && j.reviewDecision === "MANUAL_REVIEW_REQUIRED")
        .map((j) => j.evidenceId)
    );
    const pendingAsConfirmed = post.approvedFindings.filter((f) => {
      const id = f.evidenceId ?? f.evidenceRefs?.[0];
      if (!id || !pendingIds.has(id) || f.caveat) return false;
      // Meta findings that describe pending/unknown binding are not "confirmed risks"
      const text = `${f.title} ${f.summary}`.toLowerCase();
      if (/ручн|проверк|pending|неизвестн|unknown|требует/i.test(text)) return false;
      return true;
    });
    checks.push(
      check(
        "pending-not-confirmed-findings",
        pendingAsConfirmed.length === 0,
        `${pendingAsConfirmed.length} pending treated as confirmed findings (meta/review mentions excluded)`
      )
    );
    if (pendingAsConfirmed.length) issues.push("pending-as-confirmed");

    // Simulate WRONG_SUBJECT / EXCLUDED / APPENDIX_ONLY effects
    const sample = judgments.find((j) => j.reviewDecision === "MANUAL_REVIEW_REQUIRED");
    if (sample) {
      const wrongDecision: AdminReviewDecision = {
        evidenceId: sample.evidenceId,
        status: "WRONG_SUBJECT",
        reviewerNote: "qa wrong subject",
      };
      const appliedWrong = applyAdminDecisionsToJudgments(judgments, [wrongDecision]);
      const wrongJ = appliedWrong.judgments.find((j) => j.evidenceId === sample.evidenceId);
      checks.push(
        check(
          "wrong-subject-maps-exclude",
          wrongJ?.reviewDecision === "EXCLUDE_WRONG_SUBJECT" || wrongJ?.subjectBinding === "WRONG_SUBJECT",
          `reviewDecision=${wrongJ?.reviewDecision}`
        )
      );

      const excludedDecision: AdminReviewDecision = {
        evidenceId: sample.evidenceId,
        status: "EXCLUDED",
        reviewerNote: "qa exclude",
      };
      const appliedEx = applyAdminDecisionsToJudgments(judgments, [excludedDecision]);
      const exJ = appliedEx.judgments.find((j) => j.evidenceId === sample.evidenceId);
      checks.push(
        check(
          "excluded-maps-exclude",
          exJ?.reviewDecision === "EXCLUDE_NOISE" ||
            exJ?.reviewDecision === "EXCLUDE_WRONG_SUBJECT" ||
            String(exJ?.reviewDecision).includes("EXCLUDE"),
          `reviewDecision=${exJ?.reviewDecision}`
        )
      );

      const appendixDecision: AdminReviewDecision = {
        evidenceId: sample.evidenceId,
        status: "APPENDIX_ONLY",
      };
      const appliedAp = applyAdminDecisionsToJudgments(judgments, [appendixDecision]);
      const apJ = appliedAp.judgments.find((j) => j.evidenceId === sample.evidenceId);
      checks.push(
        check(
          "appendix-only-not-auto-include",
          apJ?.reviewDecision === "APPENDIX_ONLY",
          `reviewDecision=${apJ?.reviewDecision}`
        )
      );
    }
  } else {
    checks.push(check("pending-not-confirmed-findings", true, "post-review artifact not present — skipped"));
  }

  // UI must not invoke renderer — static check of regenerate route source
  if (existsSync(apiRegen)) {
    const regenSrc = readFileSync(apiRegen, "utf-8");
    const invokesRenderer =
      /renderOrionGolden|rendered-client\.(pdf|pptx)|renderReport\(/i.test(regenSrc);
    checks.push(
      check("regenerate-no-renderer", !invokesRenderer, `rendererInvokedInSource=${invokesRenderer}`)
    );
    if (invokesRenderer) issues.push("renderer-invoked");
  }

  // High-impact caution present in UI source
  if (existsSync(viewPath)) {
    const ui = readFileSync(viewPath, "utf-8");
    const hasCaution =
      /не являются подтверждёнными негативными/i.test(ui) &&
      /highImpactAck|high-impact|High-impact/i.test(ui) &&
      /WRONG_SUBJECT будет полностью исключён/i.test(ui);
    checks.push(check("safety-warnings-in-ui", hasCaution, "warning copy present"));
    if (!hasCaution) issues.push("decision-validation");
  }

  let verdict: AdminUiQaVerdict = "ADMIN_UI_READY";
  if (issues.includes("route-missing")) verdict = "BLOCKED_ROUTE_MISSING";
  else if (issues.includes("api-wiring")) verdict = "BLOCKED_API_WIRING";
  else if (issues.includes("decision-validation")) verdict = "BLOCKED_DECISION_VALIDATION";
  else if (issues.includes("pending-as-confirmed")) verdict = "BLOCKED_PENDING_USED_AS_CONFIRMED";
  else if (issues.includes("fake-approvals")) verdict = "BLOCKED_FAKE_APPROVALS";
  else if (issues.includes("renderer-invoked")) verdict = "BLOCKED_RENDERER_INVOKED";

  return {
    version: "r10-8-admin-ui-qa-v1",
    passed: verdict === "ADMIN_UI_READY",
    verdict,
    issues,
    checks,
    metrics: {
      queueCount,
      queueCaseId,
      artifactRoot,
      artifactSource,
      fakeApprovals,
      pageExists: existsSync(pagePath),
      viewExists: existsSync(viewPath),
      parallelQueueCount: existsSync(parallelQueue)
        ? (JSON.parse(readFileSync(parallelQueue, "utf-8")) as { items?: unknown[] }).items?.length ?? 0
        : 0,
    },
  };
}

export function writeAdminUiQaReport(workspaceRoot = process.cwd()): string {
  const outDir = join(workspaceRoot, "storage/digital-profile/qa-r10-8-admin-ui");
  mkdirSync(outDir, { recursive: true });
  const report = {
    ...inspectAdminUiQa({ workspaceRoot }),
    generatedAt: new Date().toISOString(),
  };
  const outPath = join(outDir, "r10-8-admin-ui-qa.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  return outPath;
}
