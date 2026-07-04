import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createCase } from "../src/modules/digital-profile/services/case-service";
import { runFullAudit } from "../src/modules/digital-profile/services/agent-run-service";
import { importLexisNexisHybridReport } from "../src/modules/digital-profile/compliance-providers/service";
import { runExactOrionPipeline } from "../src/modules/digital-profile/orion-section-pipeline/run-exact-orion-pipeline";
import type { OrionGpt55SectionAnalysis } from "../src/modules/digital-profile/orion-section-pipeline/types";

const OUT = join(process.cwd(), "storage", "digital-profile", "qa-r9-3-lexis-gpt55-e2e");

const R93_GPT55_STAGES = new Set([
  "executive_narrative_summary",
  "ru_audit_summary",
  "ru_search_links_overview",
  "uae_audit_summary",
  "compliance_risk_matrix",
  "lexisnexis_profile_overview",
  "compliance_database_summary_for_risk_matrix",
]);

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function runInspect(pptx: string, reportJson: string, outPath: string): number {
  const result = spawnSync("python", ["scripts/inspect-0541-pptx.py", pptx, reportJson], {
    cwd: process.cwd(),
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${result.stdout || ""}${result.stderr || ""}`;
  const match = out.match(/\{[\s\S]*\}/);
  if (match) {
    writeFileSync(outPath, `${match[0]}\n`, "utf-8");
  } else {
    writeFileSync(outPath, JSON.stringify({ r9ModeDetected: false, raw: out }, null, 2), "utf-8");
  }
  process.stdout.write(result.stdout || "");
  process.stderr.write(result.stderr || "");
  return result.status ?? 1;
}

function resolveLexisFixturePath(): string | null {
  const candidates = [
    process.env.LEXISNEXIS_FIXTURE_PATH,
    process.env.LEXIS_FIXTURE_PATH,
    process.env.LEXIS_DOCX_FIXTURE_PATH,
    join(
      process.cwd(),
      "storage",
      "digital-profile",
      "qa-r7-4a-real-lexisnexis-docx",
      "fixtures",
      "LexisNexis_Дерипаска.docx"
    ),
    join(process.cwd(), "storage", "digital-profile", "fixtures", "lexisnexis-sample.docx"),
    join(process.cwd(), "storage", "digital-profile", "fixtures", "lexis-sample.docx"),
  ].filter((x): x is string => Boolean(x && x.trim()));
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function ensureCaseId(): Promise<string> {
  if (process.env.CASE_ID && process.env.CASE_ID.trim()) {
    return process.env.CASE_ID.trim();
  }
  const created = await createCase({
    fullName: `R9.3 QA Subject ${new Date().toISOString().slice(0, 19)}`,
    aliases: ["Konstantin Tomilin"],
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
    targetRegions: ["RU", "UAE", "INTERNATIONAL"],
    notes: "R9.3 non-destructive Lexis+GPT55 QA case",
  });
  return created.id;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function buildClientReadableInspection(outRoot: string, clientJson: Record<string, unknown>) {
  const analyses = (clientJson.sectionAnalyses as OrionGpt55SectionAnalysis[] | undefined) ?? [];
  const byStage = new Map(analyses.map((a) => [a.microStageKey, a]));
  const executive = byStage.get("executive_narrative_summary");
  const ruSummary = byStage.get("ru_audit_summary");
  const ruLinks = byStage.get("ru_search_links_overview");
  const uaeSummary = byStage.get("uae_audit_summary");
  const lexisOverview = byStage.get("lexisnexis_profile_overview");
  const offerStages = analyses.filter((a) => a.macroSectionKey === "offer");

  const rawThemeRe = /\b(sanctions_watchlist|pep_political_exposure|adverse_media|legal_regulatory)\b/;
  const clientStr = JSON.stringify(clientJson);
  const checks: Array<{ name: string; pass: boolean; detail: string }> = [];

  const execPlain = executive?.clientNarrative?.plainConclusion ?? "";
  checks.push({
    name: "executive-plain-conclusion",
    pass: execPlain.length > 20,
    detail: execPlain.slice(0, 120),
  });
  checks.push({
    name: "executive-what-found",
    pass: (executive?.clientNarrative?.whatWasFound?.length ?? 0) > 0,
    detail: String(executive?.clientNarrative?.whatWasFound?.length ?? 0),
  });
  checks.push({
    name: "executive-review-explained",
    pass:
      (executive?.evidenceSummary?.requiresReview ?? 0) === 0 ||
      /ручн|провер/i.test(
        `${executive?.clientNarrative?.plainConclusion ?? ""} ${(executive?.clientNarrative?.whatRequiresReview ?? []).join(" ")}`
      ),
    detail: "review wording",
  });
  checks.push({
    name: "executive-risk-hint",
    pass: /LOW|MEDIUM|HIGH|низк|средн|высок/i.test(execPlain),
    detail: execPlain.slice(0, 80),
  });
  checks.push({
    name: "ru-plain-russian",
    pass: Boolean(ruSummary?.clientNarrative?.plainConclusion),
    detail: ruSummary?.clientNarrative?.plainConclusion?.slice(0, 80) ?? "",
  });
  checks.push({
    name: "ru-themes-human-readable",
    pass: !(ruLinks?.evidenceSummary?.keyThemes ?? []).some((t) => rawThemeRe.test(t)),
    detail: (ruLinks?.evidenceSummary?.keyThemes ?? []).slice(0, 3).join(", "),
  });
  checks.push({
    name: "ru-domains-present-when-evidence",
    pass:
      (ruLinks?.evidenceSummary?.total ?? 0) === 0 ||
      (ruLinks?.evidenceSummary?.keyDomains?.length ?? 0) > 0,
    detail: String(ruLinks?.evidenceSummary?.keyDomains?.length ?? 0),
  });
  checks.push({
    name: "uae-sensitive-framing",
    pass:
      !uaeSummary ||
      /watchlist|sanction|ofac|eu|ручн|провер|контекст/i.test(
        `${uaeSummary.clientNarrative.plainConclusion} ${uaeSummary.clientNarrative.whyItMatters}`
      ),
    detail: uaeSummary?.clientNarrative?.plainConclusion?.slice(0, 80) ?? "n/a",
  });
  checks.push({
    name: "uae-no-false-zero-negative",
    pass:
      !uaeSummary ||
      !(
        (uaeSummary.evidenceSummary.requiresReview ?? 0) > 0 &&
        /0 подтверж|ничего не найден|нет сигнал/i.test(uaeSummary.clientNarrative.plainConclusion)
      ),
    detail: "contradiction check",
  });
  checks.push({
    name: "lexis-upload-wording",
    pass:
      !lexisOverview ||
      (lexisOverview.evidenceSummary.total === 0 &&
        !/не запрошен/i.test(lexisOverview.clientNarrative.plainConclusion)) ||
      /LexisNexis|импорт|обработ/i.test(lexisOverview.clientNarrative.plainConclusion),
    detail: lexisOverview?.clientNarrative?.plainConclusion?.slice(0, 100) ?? "",
  });
  checks.push({
    name: "offer-adaptation",
    pass:
      offerStages.length === 0 ||
      offerStages.some((s) => /Digital Profile|Compliance|Wikipedia|рекоменда/i.test(s.clientNarrative.plainConclusion)),
    detail: offerStages[0]?.clientNarrative?.plainConclusion?.slice(0, 80) ?? "",
  });
  checks.push({
    name: "no-raw-theme-keys-client",
    pass: !rawThemeRe.test(clientStr),
    detail: rawThemeRe.test(clientStr) ? "raw theme key detected" : "clean",
  });
  checks.push({
    name: "no-zero-negative-vs-review-contradiction",
    pass: !analyses.some(
      (a) =>
        a.evidenceSummary.confirmed === 0 &&
        a.evidenceSummary.requiresReview > 0 &&
        /0 подтверж|ничего не найден/i.test(a.clientNarrative.plainConclusion) &&
        !/ручн|провер/i.test(a.clientNarrative.plainConclusion)
    ),
    detail: "global contradiction scan",
  });

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) {
    check(`client-readable: ${c.name}`, c.pass, c.detail);
  }

  const inspection = {
    status: failed.length === 0 ? "PASS" : "BLOCKED",
    checks,
    failedCount: failed.length,
    stageSamples: {
      executive: executive?.clientNarrative,
      ruSummary: ruSummary?.clientNarrative,
      lexisOverview: lexisOverview?.clientNarrative,
      offer: offerStages[0]?.clientNarrative,
    },
  };
  writeFileSync(join(outRoot, "client-readable-narrative-inspection.json"), `${JSON.stringify(inspection, null, 2)}\n`, "utf-8");
  return inspection;
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const caseId = await ensureCaseId();
  writeFileSync(join(OUT, "qa-case-id.txt"), `${caseId}\n`, "utf-8");

  const fixturePath = resolveLexisFixturePath();
  let lexisImportResult: Record<string, unknown> | null = null;
  let lexisVisualE2eStatus: "PASS" | "SKIPPED" | "FAIL" = "SKIPPED";
  let lexisSkipReason = "Lexis DOCX fixture not available";

  try {
    const fullAudit = await runFullAudit(caseId, { actorId: "qa-r9-3" }, { runtimeMode: "real_first_with_fallback" });
    writeFileSync(
      join(OUT, "full-audit-runtime.json"),
      JSON.stringify(
        { outcome: fullAudit.outcome, runtimeStrategy: fullAudit.runtimeStrategy, runSummary: fullAudit.runSummary },
        null,
        2
      ),
      "utf-8"
    );
    check("full audit executed", true, fullAudit.outcome);
  } catch (error) {
    check("full audit executed", false, error instanceof Error ? error.message : String(error));
  }

  if (fixturePath) {
    try {
      const file = readFileSync(fixturePath);
      const imported = await importLexisNexisHybridReport(
        caseId,
        {
          fileName: "lexis-r93-fixture.docx",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          buffer: file,
        },
        { actorId: "qa-r9-3" }
      );
      lexisImportResult = {
        parserStatus: imported.parserStatus,
        conversionStatus: imported.conversionStatus,
        parsedSignalsCreated: imported.parsedSignalsCreated,
        reviewRequiredCount: imported.reviewRequiredCount,
        latestImportStatus: imported.document.status,
        pageCount: imported.document.pageCount,
        renderedPages: imported.document.renderedPages?.length ?? 0,
        fixturePath,
      };
      writeFileSync(join(OUT, "lexis-import.json"), JSON.stringify(imported, null, 2), "utf-8");
      check(
        "lexis fixture import",
        imported.parserStatus === "parsed" || imported.parserStatus === "partial",
        `parser=${imported.parserStatus} conversion=${imported.conversionStatus} pages=${imported.document.pageCount}`
      );
      if (imported.conversionStatus === "ready" && (imported.document.renderedPages?.length ?? 0) > 0) {
        lexisVisualE2eStatus = "PASS";
      } else {
        lexisVisualE2eStatus = "FAIL";
        check("lexis visual conversion", false, `conversion=${imported.conversionStatus} pages=${imported.document.pageCount}`);
      }
    } catch (error) {
      lexisVisualE2eStatus = "FAIL";
      check("lexis fixture import", false, error instanceof Error ? error.message : String(error));
    }
  } else {
    console.log("[WARN] Lexis fixture not found; Lexis visual E2E marked SKIPPED.");
  }

  const r93GptEnabled = process.env.R9_3_GPT55_VALIDATE === "true";
  const pipeline = await runExactOrionPipeline(caseId, {
    outputRoot: OUT,
    locale: "ru",
    useRealCaseData: true,
    r93Gpt55Validate: r93GptEnabled,
  });
  check("pipeline composed", pipeline.compositionInspection.errors.length === 0);

  const realContext = existsSync(join(OUT, "real-case-context-inspection.json"))
    ? readJson<Record<string, unknown>>(join(OUT, "real-case-context-inspection.json"))
    : {};
  const lexisContext = (realContext.lexis as Record<string, unknown> | undefined) ?? {};
  const composition = pipeline.compositionInspection;
  const lexisVisualCount = composition.lexisNexisVisualPageCount;

  writeFileSync(
    join(OUT, "lexisnexis-e2e-inspection.json"),
    `${JSON.stringify(
      {
        fixturePath: fixturePath ?? null,
        fixtureAvailable: Boolean(fixturePath),
        importResult: lexisImportResult,
        contextLexis: lexisContext,
        latestImportStatus: lexisContext.latestReady
          ? String((lexisContext.latestReady as Record<string, unknown>).status ?? "")
          : lexisContext.latestAny
            ? String((lexisContext.latestAny as Record<string, unknown>).status ?? "")
            : null,
        parserStatus: lexisImportResult?.parserStatus ?? null,
        conversionStatus: lexisImportResult?.conversionStatus ?? null,
        visualPageCount: lexisVisualCount,
        lexisVisualE2eStatus,
        lexisSkipReason: lexisVisualE2eStatus === "SKIPPED" ? lexisSkipReason : undefined,
        section4VisualSlidesPresent: lexisVisualCount > 0,
      },
      null,
      2
    )}\n`,
    "utf-8"
  );

  if (lexisVisualE2eStatus === "PASS") {
    check("lexis latestImportStatus ready", String(lexisImportResult?.latestImportStatus ?? "") === "ready");
    check("lexis parserStatus parsed", lexisImportResult?.parserStatus === "parsed");
    check("lexis conversionStatus ready", lexisImportResult?.conversionStatus === "ready");
    check("lexisNexisVisualPageCount > 0", lexisVisualCount > 0, String(lexisVisualCount));
    check(
      "section4 lexis visual slides",
      pipeline.slideManifests
        .flatMap((m) => m.slides)
        .some((s) => s.slideType === "lexisnexis_visual_page"),
      String(lexisVisualCount)
    );
  } else if (lexisVisualE2eStatus === "SKIPPED") {
    check("lexis visual E2E skipped (fixture missing)", true, lexisSkipReason);
    check(
      "lexis fallback slide present when no visuals",
      lexisVisualCount === 0
        ? pipeline.slideManifests.flatMap((m) => m.slides).some((s) => s.slideType === "lexisnexis_unavailable_fallback")
        : true
    );
  }

  const gptInspection = existsSync(join(OUT, "gpt55-narrative-inspection.json"))
    ? readJson<{
        enabled: boolean;
        summary: { selected: number; ready: number; fallback: number };
        rows: Array<{ microStageKey: string; selectedForGpt55: boolean; generatedBy: string; status: string }>;
      }>(join(OUT, "gpt55-narrative-inspection.json"))
    : { enabled: false, summary: { selected: 0, ready: 0, fallback: 0 }, rows: [] };

  const hasOpenAiKey = Boolean(process.env.OPENAI_API_KEY?.trim());
  if (r93GptEnabled && hasOpenAiKey) {
    const gptReady = gptInspection.rows.filter((r) => r.selectedForGpt55 && r.generatedBy === "gpt-5.5");
    check("gpt55 selected stages executed", gptReady.length >= 1, `ready=${gptReady.length}`);
    for (const stage of R93_GPT55_STAGES) {
      const row = gptInspection.rows.find((r) => r.microStageKey === stage);
      if (row?.selectedForGpt55) {
        check(`gpt55 stage ${stage}`, row.generatedBy === "gpt-5.5" || row.status === "fallback", row.generatedBy);
      }
    }
  } else {
    check("gpt55 path skipped (env)", true, r93GptEnabled ? "OPENAI_API_KEY missing" : "R9_3_GPT55_VALIDATE not true");
    check(
      "deterministic fallback available",
      pipeline.analyses.every((a) => a.generatedBy === "deterministic" || a.status === "fallback" || a.generatedBy === "gpt-5.5")
    );
  }

  const required = [
    "run-manifest.json",
    "blueprint.json",
    "real-case-context-inspection.json",
    "lexisnexis-e2e-inspection.json",
    "gpt55-narrative-inspection.json",
    "micro-stage-mapping-inspection.json",
    "composed/final-deck-manifest.json",
    "composed/final-report-json-internal.json",
    "composed/final-report-json-client.json",
    "composed/final-report-v17-ru-internal-draft.pptx",
    "composed/final-report-v17-ru-internal-draft.pdf",
    "composed/final-report-v17-ru-client.pptx",
    "composed/final-report-v17-ru-client.pdf",
    "composed/composition-inspection.json",
    "composed/consistency-inspection.json",
    "composed/client-policy-inspection.json",
    "composed/r7-r9-comparison-inspection.json",
  ];
  for (const rel of required) {
    check(`${rel} exists`, existsSync(join(OUT, rel)));
  }

  for (const key of [
    "executive_narrative_summary",
    "ru_search_links_overview",
    "uae_google_search_links_overview",
    "lexisnexis_profile_overview",
    "lexisnexis_visual_pages",
    "compliance_database_summary_for_risk_matrix",
  ]) {
    const dir = join(OUT, "micro-stages", key);
    check(`${key}/evidence-pack.json`, existsSync(join(dir, "evidence-pack.json")));
    check(`${key}/final-analysis.json`, existsSync(join(dir, "final-analysis.json")));
    check(`${key}/slide-manifest.json`, existsSync(join(dir, "slide-manifest.json")));
  }

  const clientJson = readJson<Record<string, unknown>>(join(OUT, "composed", "final-report-json-client.json"));
  const narrativeInspection = buildClientReadableInspection(OUT, clientJson);

  const clientPolicy = readJson<{ status: string; violations: unknown[] }>(
    join(OUT, "composed", "client-policy-inspection.json")
  );
  check("client policy violations = 0", (clientPolicy.violations?.length ?? 0) === 0);

  const inspectInternal = runInspect(
    join(OUT, "composed", "final-report-v17-ru-internal-draft.pptx"),
    join(OUT, "composed", "final-report-json-internal.json"),
    join(OUT, "composed", "r9-inspect-internal.json")
  );
  check("R9 inspect internal", inspectInternal === 0, `rc=${inspectInternal}`);

  const inspectClient = runInspect(
    join(OUT, "composed", "final-report-v17-ru-client.pptx"),
    join(OUT, "composed", "final-report-json-client.json"),
    join(OUT, "composed", "r9-inspect-client.json")
  );
  check("R9 inspect client", inspectClient === 0, `rc=${inspectClient}`);

  const pagePngCount = (dir: string) =>
    existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith("page-") && f.endsWith(".png")).length : 0;

  let verdict: "PASS" | "PASS_WITH_SKIPPED_LEXIS_VISUAL" | "BLOCKED" = "PASS";
  if (failures > 0 || narrativeInspection.status === "BLOCKED" || clientPolicy.status === "BLOCKED") {
    verdict = "BLOCKED";
  } else if (lexisVisualE2eStatus === "SKIPPED") {
    verdict = "PASS_WITH_SKIPPED_LEXIS_VISUAL";
  }

  writeFileSync(
    join(OUT, "qa-summary.json"),
    JSON.stringify(
      {
        status: verdict,
        caseId,
        runId: pipeline.run.runId,
        output: OUT,
        failures,
        lexisVisualE2eStatus,
        lexisVisualPageCount: lexisVisualCount,
        pageCounts: {
          internal: composition.finalInternalPageCount,
          client: composition.finalClientPageCount,
          lexisVisual: lexisVisualCount,
          internalPng: pagePngCount(join(OUT, "composed", "pages-pdf")),
          clientPng: pagePngCount(join(OUT, "composed", "client-pages-pdf")),
        },
        gpt55: {
          enabled: r93GptEnabled,
          openAiKeyConfigured: hasOpenAiKey,
          summary: gptInspection.summary,
        },
        clientReadable: narrativeInspection.status,
        clientPolicy: clientPolicy.status,
      },
      null,
      2
    ),
    "utf-8"
  );

  console.log(`\nVerdict: ${verdict}`);
  console.log(`${failures ? `FAILED (${failures} checks)` : "PASSED (0 failures)"}`);
  process.exit(verdict === "BLOCKED" ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
