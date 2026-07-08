/**
 * R10.8a — Admin UI polish QA (static + validation + safety).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isHighImpactManualReviewItem,
  validateAdminReviewDecisionInput,
} from "../evidence/admin-review-decision-validation";

export type AdminUiPolishVerdict =
  | "ADMIN_UI_POLISH_READY"
  | "BLOCKED_FILTERS"
  | "BLOCKED_DETAIL_PANEL"
  | "BLOCKED_DECISION_VALIDATION"
  | "BLOCKED_ENUM_LEAK"
  | "BLOCKED_BULK_APPROVAL_RISK"
  | "BLOCKED_RENDERER_INVOKED";

function check(id: string, passed: boolean, detail: string) {
  return { id, passed, detail };
}

export function inspectAdminUiPolishQa(input?: { workspaceRoot?: string }): {
  version: "r10-8a-admin-ui-polish-qa-v1";
  passed: boolean;
  verdict: AdminUiPolishVerdict;
  issues: string[];
  checks: Array<{ id: string; passed: boolean; detail: string }>;
} {
  const root = input?.workspaceRoot ?? process.cwd();
  const issues: string[] = [];
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];

  const viewPath = join(root, "src/modules/digital-profile/client/ManualReviewAdminView.tsx");
  const helpersPath = join(root, "src/modules/digital-profile/client/manual-review-ui-helpers.ts");
  const regenPath = join(
    root,
    "src/app/api/digital-profile/cases/[id]/orion-golden/client-content/regenerate/route.ts"
  );

  const view = existsSync(viewPath) ? readFileSync(viewPath, "utf-8") : "";
  const helpers = existsSync(helpersPath) ? readFileSync(helpersPath, "utf-8") : "";

  checks.push(check("view-exists", Boolean(view), viewPath));
  checks.push(check("helpers-exist", Boolean(helpers), helpersPath));

  const filtersOk =
    /data-testid="filters-panel"/.test(view) &&
    /QUICK_FILTER_LABELS/.test(view) &&
    /filterReliability/.test(view) &&
    /Только на проверке|pending_only/.test(view);
  checks.push(check("filters-render", filtersOk, "filters-panel + quick filters + reliability"));
  if (!filtersOk) issues.push("filters");

  const groupsOk =
    /data-testid="group-view"/.test(view) &&
    /viewMode === "groups"/.test(view) &&
    /GROUP_ORDER/.test(view);
  checks.push(check("group-view-render", groupsOk, "group-view present"));
  if (!groupsOk) issues.push("filters");

  const detailOk =
    /data-testid="detail-panel"/.test(view) &&
    /data-testid="binding-explanation"/.test(view) &&
    /data-testid="positive-signals"/.test(view) &&
    /data-testid="negative-signals"/.test(view) &&
    /data-testid="missing-context"/.test(view) &&
    /data-testid="risk-interpretation"/.test(view) &&
    /CopyButton/.test(view);
  checks.push(check("detail-panel-fields", detailOk, "identity/risk/missing context + copy"));
  if (!detailOk) issues.push("detail");

  const ruOk =
    /ADMIN_STATUS_LABELS/.test(helpers) &&
    /Требует проверки/.test(helpers) &&
    /Одобрено с оговоркой/.test(helpers) &&
    /Другой субъект/.test(helpers) &&
    /Пересобрать клиентский анализ/.test(view) &&
    /Очередь ручной проверки/.test(view) &&
    /labelStatus\(/.test(view);
  checks.push(check("russian-labels", ruOk, "RU labels mapped for statuses/actions"));
  if (!ruOk) issues.push("enum-leak");

  // Enum leak: status select should show labelStatus, not raw enum as only visible text in options
  const enumLeak =
    /<option key=\{s\} value=\{s\}>\s*\{s\}\s*<\/option>/.test(view) ||
    (!/labelStatus\(s\)/.test(view) && /STATUSES\.map/.test(view));
  checks.push(check("no-raw-enum-in-status-options", !enumLeak, "status options use Russian labels"));
  if (enumLeak) issues.push("enum-leak");

  const caveatFail = validateAdminReviewDecisionInput({
    status: "APPROVED_WITH_CAVEAT",
    caveatText: "",
  });
  checks.push(
    check("caveat-validation", caveatFail.ok === false, caveatFail.errors.join("; "))
  );
  if (caveatFail.ok) issues.push("decision-validation");

  const wrongFail = validateAdminReviewDecisionInput({
    status: "WRONG_SUBJECT",
    reviewerNote: "",
  });
  checks.push(check("wrong-subject-validation", wrongFail.ok === false, wrongFail.errors.join("; ")));
  if (wrongFail.ok) issues.push("decision-validation");

  const excludedFail = validateAdminReviewDecisionInput({
    status: "EXCLUDED",
    reviewerNote: "",
  });
  // UI requires note for EXCLUDED; shared validator may not — check UI source
  const uiExcludedNote = /status === "EXCLUDED".*reviewerNote|EXCLUDED.*обязательна/s.test(view);
  checks.push(
    check(
      "excluded-note-ui",
      uiExcludedNote || excludedFail.ok === false,
      "EXCLUDED requires reviewerNote in UI"
    )
  );

  const highImpactFail = validateAdminReviewDecisionInput({
    status: "APPROVED",
    isHighImpact: true,
    highImpactAcknowledged: false,
  });
  checks.push(
    check("high-impact-ack", highImpactFail.ok === false, highImpactFail.errors.join("; "))
  );
  if (highImpactFail.ok) issues.push("decision-validation");

  const bulkRisk =
    /bulkApprove|массово.*одобр|APPROVED.*selectedIds|status:\s*"APPROVED"/.test(view) &&
    /for \(const item of (items|selected)/.test(view) &&
    /status:\s*"APPROVED"/.test(view);
  // Allow APPENDIX_ONLY / WRONG_SUBJECT bulk only
  const hasUnsafeBulkApprove = /status:\s*"APPROVED"/.test(view) && /selectedIds/.test(view) &&
    /submitOrionAdminReviewDecision[\s\S]{0,200}status:\s*"APPROVED"/.test(view);
  checks.push(
    check(
      "no-bulk-high-impact-approval",
      !hasUnsafeBulkApprove && /Массовое одобрение high-impact/.test(view),
      `unsafeBulkApprove=${hasUnsafeBulkApprove}`
    )
  );
  if (hasUnsafeBulkApprove) issues.push("bulk-approval");

  const safeBulkOk =
    /bulkAppendixSafe/.test(view) &&
    /isSafeLowImpactForBulkAppendix/.test(view) &&
    /bulkWrongSubjectSafe/.test(view);
  checks.push(check("safe-bulk-helpers", safeBulkOk, "appendix/wrong-subject only"));

  if (existsSync(regenPath)) {
    const regenSrc = readFileSync(regenPath, "utf-8");
    const invokesRenderer = /renderOrionGolden|rendered-client\.(pdf|pptx)|renderReport\(/i.test(regenSrc);
    checks.push(check("regenerate-no-renderer", !invokesRenderer, `renderer=${invokesRenderer}`));
    if (invokesRenderer) issues.push("renderer");
  }

  const regenUx =
    /Пересобрать клиентский анализ/.test(view) &&
    /rendererInvoked/.test(view) &&
    /data-testid="regenerate-panel"/.test(view);
  checks.push(check("regenerate-ux", regenUx, "timestamp/paths/renderer flag"));

  const pendingWarn = /не являются подтверждёнными негативными/.test(view);
  checks.push(check("pending-not-confirmed-copy", pendingWarn, "pending warning present"));

  const noFake = !/qaSampleOnly:\s*true/.test(view) && !/fake.?approv/i.test(view);
  checks.push(check("no-fake-approvals-in-ui", noFake, "no fake approval generation in UI"));

  checks.push(
    check(
      "high-impact-detector",
      isHighImpactManualReviewItem({ riskSignal: "COMPLIANCE_RELEVANT", title: "Lexis" }) === true,
      "detector ok"
    )
  );

  let verdict: AdminUiPolishVerdict = "ADMIN_UI_POLISH_READY";
  if (issues.includes("filters")) verdict = "BLOCKED_FILTERS";
  else if (issues.includes("detail")) verdict = "BLOCKED_DETAIL_PANEL";
  else if (issues.includes("decision-validation")) verdict = "BLOCKED_DECISION_VALIDATION";
  else if (issues.includes("enum-leak")) verdict = "BLOCKED_ENUM_LEAK";
  else if (issues.includes("bulk-approval")) verdict = "BLOCKED_BULK_APPROVAL_RISK";
  else if (issues.includes("renderer")) verdict = "BLOCKED_RENDERER_INVOKED";

  return {
    version: "r10-8a-admin-ui-polish-qa-v1",
    passed: verdict === "ADMIN_UI_POLISH_READY",
    verdict,
    issues,
    checks,
  };
}

export function writeAdminUiPolishQaReport(workspaceRoot = process.cwd()): string {
  const outDir = join(workspaceRoot, "storage/digital-profile/qa-r10-8-admin-ui");
  mkdirSync(outDir, { recursive: true });
  const report = {
    ...inspectAdminUiPolishQa({ workspaceRoot }),
    generatedAt: new Date().toISOString(),
  };
  const outPath = join(outDir, "r10-8a-admin-ui-polish-qa.json");
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  return outPath;
}
