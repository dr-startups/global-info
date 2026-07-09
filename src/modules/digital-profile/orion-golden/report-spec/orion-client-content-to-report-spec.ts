/**
 * R10.9 — Adapter: post-review OrionClientContent → OrionGoldenReportSpec.
 * Client_audit mode: no commercial/product/about blocks; no raw inventory as narrative source.
 */

import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import type { OrionClientContent } from "../content/orion-client-content-builder";
import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";
import type { ExecutiveSynthesisOutput } from "../gpt/orion-executive-synthesis-from-sections";
import type { SectionDerivedRiskMatrix } from "../sections/orion-risk-matrix-from-sections";
import type { OrionGoldenExecutiveSynthesis } from "../types";
import { sanitizeOrionGoldenClientText } from "../client/client-text-sanitizer";
import type { OrionGoldenReportSpec, SectionBlock } from "./orion-report-spec";

const EMPTY_COMMERCIAL: SectionBlock = {
  sectionTitle: "",
  metrics: { omitted: "client_audit" },
  narrative: "",
  tables: [],
  evidenceCards: [],
  visualAssets: [],
  slideSpecs: [],
  sourceRefs: [],
  qaMetadata: { sectionKey: "omitted_client_audit" },
};

function mapGlobalRiskLevel(
  level: string
): OrionGoldenExecutiveSynthesis["globalRiskLevel"] {
  const map: Record<string, OrionGoldenExecutiveSynthesis["globalRiskLevel"]> = {
    Низкий: "low",
    Средний: "medium",
    Высокий: "high",
    Критический: "critical",
    "Требует проверки": "review_required",
    low: "low",
    medium: "medium",
    high: "high",
    critical: "critical",
    review_required: "review_required",
  };
  return map[level] ?? "review_required";
}

function emptyBlock(title: string, sectionKey: string, narrative?: string): SectionBlock {
  return {
    sectionTitle: title,
    metrics: { status: "collapsed" },
    narrative: narrative ?? "",
    tables: [],
    evidenceCards: [],
    visualAssets: [],
    slideSpecs: narrative
      ? [
          {
            slideKey: `${sectionKey}-1`,
            template: "orion_golden_audit_dashboard",
            title,
            bullets: [sanitizeOrionGoldenClientText(narrative).slice(0, 280)],
          },
        ]
      : [],
    sourceRefs: [],
    qaMetadata: { sectionKey },
  };
}

function sectionBlockFromClientSections(
  client: OrionClientContent,
  sectionIdPrefixes: string[],
  fallbackTitle: string,
  sectionKey: string
): SectionBlock {
  const matched = (client.sections ?? []).filter((s) =>
    sectionIdPrefixes.some((p) => s.sectionId.includes(p) || s.sectionId.startsWith(p))
  );
  const usable = matched.filter(
    (s) =>
      s.status !== "DATA_POOR" &&
      s.status !== "COLLAPSED" &&
      (s.narrative?.trim() || s.keyFindings?.length)
  );

  if (usable.length === 0) {
    return emptyBlock(fallbackTitle, sectionKey);
  }

  const evidenceCards = usable
    .flatMap((s) =>
      (s.keyFindings ?? []).map((f) => ({
        title: sanitizeOrionGoldenClientText(f.title),
        summary: sanitizeOrionGoldenClientText(
          f.caveat ? `${f.summary} (оговорка: ${f.caveat})` : f.summary
        ),
        domain: undefined as string | undefined,
      }))
    )
    .filter((c) => c.title && !/wrong.?subject|другой субъект/i.test(`${c.title} ${c.summary}`))
    .slice(0, 12);

  const sourceRefs = [
    ...new Set(usable.flatMap((s) => s.evidenceRefs ?? []).filter(Boolean)),
  ].slice(0, 40);

  // R10.9a — one slide per usable section with short narrative + finding bullets (no mega dump)
  const slideSpecs = usable.slice(0, 6).map((s, idx) => {
    const shortNarr = sanitizeOrionGoldenClientText(s.narrative || "").slice(0, 420);
    const findingBullets = (s.keyFindings ?? [])
      .slice(0, 5)
      .map((f) =>
        sanitizeOrionGoldenClientText(
          f.caveat ? `${f.title} — ${f.caveat}` : f.title
        )
      )
      .filter(Boolean);
    return {
      slideKey: `${sectionKey}-${idx + 1}`,
      template: "orion_golden_audit_dashboard",
      title: sanitizeOrionGoldenClientText(s.title || fallbackTitle),
      bullets: findingBullets.length
        ? findingBullets
        : shortNarr
          ? [shortNarr]
          : ["Подтверждённых ключевых выводов в разделе недостаточно."],
    };
  });

  return {
    sectionTitle: fallbackTitle,
    metrics: {
      sections: usable.length,
      findings: evidenceCards.length,
      collapsed: matched.length - usable.length,
    },
    // Keep block narrative short — deck uses per-slide bullets
    narrative: sanitizeOrionGoldenClientText(usable[0]?.narrative || "").slice(0, 500),
    tables: [],
    evidenceCards,
    visualAssets: [],
    slideSpecs,
    sourceRefs,
    qaMetadata: { sectionKey },
  };
}

function buildExecutiveFromClient(
  client: OrionClientContent,
  executive?: ExecutiveSynthesisOutput | null,
  riskMatrix?: SectionDerivedRiskMatrix | null
): OrionGoldenExecutiveSynthesis {
  const matrixSource = client.riskMatrixSummary ?? riskMatrix;
  const riskMatrixRows = (matrixSource?.rows ?? [])
    .filter((r) => !r.requiresManualReview || Boolean(r.caveat))
    .map((r) => ({
      theme: sanitizeOrionGoldenClientText(r.theme),
      level: sanitizeOrionGoldenClientText(r.level),
      summary: sanitizeOrionGoldenClientText(
        r.requiresManualReview || r.caveat
          ? `${r.summary}${r.caveat ? ` — ${r.caveat}` : " — требует ручной проверки, не подтверждённый вывод"}`
          : r.summary
      ),
    }));

  const execText =
    executive?.executiveSummary ||
    client.executiveSummaryDraft ||
    "Резюме формируется на основе секционного анализа. Материалы на ручной проверке не считаются подтверждёнными выводами.";

  return {
    executiveSummary: sanitizeOrionGoldenClientText(execText),
    globalRiskLevel: mapGlobalRiskLevel(
      executive?.globalRiskLevel ?? matrixSource?.globalRiskLevel ?? "Требует проверки"
    ),
    riskMatrix: riskMatrixRows,
    mainRisks: (executive?.mainRisks ?? [])
      .map((v) => sanitizeOrionGoldenClientText(typeof v === "string" ? v : String((v as { title?: string })?.title ?? "")))
      .filter((v) => Boolean(v) && !/\[object Object\]/i.test(v)),
    possibleConsequences: (executive?.possibleConsequences ?? [])
      .map((v) => sanitizeOrionGoldenClientText(typeof v === "string" ? v : ""))
      .filter((v) => Boolean(v) && !/\[object Object\]/i.test(v)),
    finalRecommendations: (
      executive?.finalRecommendations ??
      client.recommendations ??
      []
    )
      .map((v) => sanitizeOrionGoldenClientText(typeof v === "string" ? v : ""))
      .filter((v) => Boolean(v) && !/\[object Object\]/i.test(v)),
    nextSteps: (executive?.nextSteps ?? [])
      .map((v) => sanitizeOrionGoldenClientText(typeof v === "string" ? v : ""))
      .filter((v) => Boolean(v) && !/\[object Object\]/i.test(v)),
    generatedBy: executive?.generatedBy === "gpt-5.5" ? "gpt-5.5" : "gpt-5.5",
  };
}

function buildManualReviewBlock(client: OrionClientContent): SectionBlock {
  const intro =
    client.manualReviewSection?.intro ||
    "Следующие материалы требуют ручной проверки и не являются подтверждёнными негативными выводами.";
  const groups = client.manualReviewGroups ?? [];
  const items = client.manualReviewSection?.items ?? [];

  const slideSpecs: SectionBlock["slideSpecs"] = [
    {
      slideKey: "manual-review-intro",
      template: "orion_golden_audit_dashboard",
      title: "Материалы на ручной проверке",
      bullets: [
        sanitizeOrionGoldenClientText(intro).slice(0, 220),
        "Статус «Требует проверки» не используется как подтверждённый риск.",
        `Всего материалов в очереди: ${items.length || groups.reduce((n, g) => n + (g.items?.length ?? 0), 0)}.`,
        groups.length
          ? `Групп по причине проверки: ${groups.length}.`
          : "Группировка по причине будет уточнена аналитиком.",
      ],
    },
  ];

  if (groups.length > 0) {
    for (const [idx, g] of groups.slice(0, 6).entries()) {
      const sample = (g.items ?? []).slice(0, 4).map((it) =>
        sanitizeOrionGoldenClientText(`${it.title}`).slice(0, 120)
      );
      slideSpecs.push({
        slideKey: `manual-review-group-${idx + 1}`,
        template: "orion_golden_audit_dashboard",
        title: sanitizeOrionGoldenClientText(g.title || g.reason),
        bullets: [
          `Материалов в группе: ${g.items?.length ?? 0}`,
          sanitizeOrionGoldenClientText(g.whyNeedsReview || "Требуется ручная проверка.").slice(0, 180),
          sanitizeOrionGoldenClientText(
            `Аналитику: ${g.analystShouldCheck || "сверить идентификаторы и контекст."}`
          ).slice(0, 180),
          ...sample,
        ],
      });
    }
  } else {
    for (let i = 0; i < Math.min(items.length, 12); i += 4) {
      const chunk = items.slice(i, i + 4);
      slideSpecs.push({
        slideKey: `manual-review-items-${Math.floor(i / 4) + 1}`,
        template: "orion_golden_audit_dashboard",
        title: "Очередь ручной проверки",
        bullets: chunk.map((it) =>
          sanitizeOrionGoldenClientText(
            `${it.title}: ${it.whyFlagged || "требует проверки"}`
          ).slice(0, 160)
        ),
      });
    }
  }

  return {
    sectionTitle: "Материалы на ручной проверке",
    metrics: {
      pending: items.length,
      groups: groups.length,
    },
    narrative: sanitizeOrionGoldenClientText(intro).slice(0, 400),
    tables: [],
    evidenceCards: items.slice(0, 12).map((i) => ({
      title: sanitizeOrionGoldenClientText(i.title),
      summary: sanitizeOrionGoldenClientText(
        `${i.whyFlagged || i.summary} (не подтверждённый вывод)`
      ),
    })),
    visualAssets: [],
    slideSpecs,
    sourceRefs: items.flatMap((i) => i.evidenceRefs ?? []).slice(0, 30),
    qaMetadata: { sectionKey: "manual_review_required", riskLevel: "review_required" },
  };
}

function buildAppendixBlock(client: OrionClientContent): SectionBlock {
  const appendix = client.appendixFindings ?? [];
  const limitations = client.limitations ?? [];
  const clusters = client.evidenceClusters ?? [];

  const slideSpecs: SectionBlock["slideSpecs"] = [
    {
      slideKey: "appendix-limitations",
      template: "orion_golden_appendix",
      title: "Ограничения анализа",
      bullets: (limitations.length
        ? limitations
        : [
            "Анализ основан на открытых источниках и предварительных сигналах.",
            "Материалы на ручной проверке не считаются подтверждённым риском.",
          ]
      )
        .slice(0, 7)
        .map((l) => sanitizeOrionGoldenClientText(l).slice(0, 180)),
    },
  ];

  if (clusters.length > 0) {
    const clientUseLabel: Record<string, string> = {
      AUTO_INCLUDE_CLIENT_REPORT: "в анализе",
      APPENDIX_ONLY: "только приложение",
      MANUAL_REVIEW_REQUIRED: "ручная проверка",
      EXCLUDE: "исключено",
    };
    slideSpecs.push({
      slideKey: "appendix-clusters",
      template: "orion_golden_appendix",
      title: "Кластеры доказательств",
      bullets: clusters.slice(0, 8).map((c) =>
        sanitizeOrionGoldenClientText(
          `${c.title}: ${c.evidenceIds.length} материал(ов), ${
            clientUseLabel[c.clientUse] ?? c.clientUse
          }${c.duplicateCount > 0 ? `, дублей: ${c.duplicateCount}` : ""}`
        ).slice(0, 160)
      ),
    });
  }

  for (let i = 0; i < Math.min(appendix.length, 12); i += 5) {
    const chunk = appendix.slice(i, i + 5);
    slideSpecs.push({
      slideKey: `appendix-evidence-${Math.floor(i / 5) + 1}`,
      template: "orion_golden_appendix",
      title: "Приложение — учтённые, но не ключевые материалы",
      bullets: chunk.map((a) =>
        sanitizeOrionGoldenClientText(
          `${a.title}${a.caveat ? ` — ${a.caveat}` : " — только приложение"}`
        ).slice(0, 160)
      ),
    });
  }

  return {
    sectionTitle: "Приложение и ограничения",
    metrics: {
      appendixItems: appendix.length,
      limitations: limitations.length,
      clusters: clusters.length,
    },
    narrative: sanitizeOrionGoldenClientText(
      "Приложение: ограничения анализа и материалы, не используемые как ключевые выводы."
    ),
    tables: [],
    evidenceCards: appendix.slice(0, 15).map((a) => ({
      title: sanitizeOrionGoldenClientText(a.title),
      summary: sanitizeOrionGoldenClientText(a.caveat || a.summary),
    })),
    visualAssets: [],
    slideSpecs,
    sourceRefs: appendix.flatMap((a) => a.evidenceRefs ?? []).slice(0, 40),
    qaMetadata: { sectionKey: "appendix" },
  };
}

function buildRecommendationsBlock(client: OrionClientContent): SectionBlock {
  const recs = client.recommendations ?? [];
  if (recs.length === 0) return emptyBlock("Рекомендации", "recommendations");
  const slides: SectionBlock["slideSpecs"] = [];
  for (let i = 0; i < Math.min(recs.length, 12); i += 6) {
    slides.push({
      slideKey: `recommendations-${Math.floor(i / 6) + 1}`,
      template: "orion_golden_executive_card",
      title: "Рекомендации",
      bullets: recs.slice(i, i + 6).map((r) => sanitizeOrionGoldenClientText(r).slice(0, 180)),
    });
  }
  return {
    sectionTitle: "Рекомендации",
    metrics: { count: recs.length },
    narrative: sanitizeOrionGoldenClientText(recs[0] ?? "").slice(0, 300),
    tables: [],
    evidenceCards: [],
    visualAssets: [],
    slideSpecs: slides,
    sourceRefs: [],
    qaMetadata: { sectionKey: "recommendations" },
  };
}

export type ClientContentToReportSpecInput = {
  clientContent: OrionClientContent;
  executiveSynthesis?: ExecutiveSynthesisOutput | null;
  riskMatrix?: SectionDerivedRiskMatrix | null;
  assets?: ReportAssetV1[];
  inventoryCounts?: FullEvidenceInventory["counts"];
  warnings?: string[];
};

/**
 * Build ReportSpec for client_audit render from post-review client content.
 * Commercial/product/about blocks are empty (omitted by client_audit deck composer).
 */
export function buildOrionReportSpecFromClientContent(
  input: ClientContentToReportSpecInput
): OrionGoldenReportSpec {
  const { clientContent: client } = input;
  if (client.assemblySource === "evidence_bundles_legacy") {
    // Still allowed, but prefer section_analyses
  }

  const executive = buildExecutiveFromClient(
    client,
    input.executiveSynthesis,
    input.riskMatrix ?? client.riskMatrixSummary
  );

  const approvedNarrative = (client.approvedFindings ?? [])
    .slice(0, 20)
    .map((f) => sanitizeOrionGoldenClientText(`${f.title}: ${f.summary}`))
    .join("\n");

  const tocTitles = [
    "Резюме",
    "Матрица рисков",
    ...(client.sections ?? [])
      .filter((s) => s.status !== "DATA_POOR" && s.narrative?.trim())
      .slice(0, 20)
      .map((s) => s.title),
    "Ручная проверка",
    "Рекомендации",
    "Приложение",
  ];

  const now = new Date().toISOString().slice(0, 10);
  const manualBlock = buildManualReviewBlock(client);
  const appendixBlock = buildAppendixBlock(client);
  const recommendationsBlock = buildRecommendationsBlock(client);

  // Pack recommendations into offer slot temporarily? No — keep commercial empty.
  // Store recommendations narrative into ruDigitalProfile divider area via metrics — better:
  // Put recommendations into appendix second slide already; also expose via worldCheck unused? 
  // Use dowJones as recommendations carrier for deck mapping — cleaner to extend deck.
  // For ReportSpec compatibility, stash recommendations in `offer` with special qaMetadata
  // but deck composer for client_audit will map it as recommendations, not commercial.

  const recommendationsAsOffer: SectionBlock = {
    ...recommendationsBlock,
    qaMetadata: { sectionKey: "recommendations" },
  };

  return {
    version: "orion-golden-report-spec-v1",
    subject: {
      displayName: sanitizeOrionGoldenClientText(client.subject.displayName),
      locale: "ru",
      auditDate: now,
      reportTitle: "ORION Digital Profile — клиентский аудит",
    },
    globalToc: tocTitles.map((title) => ({ title: sanitizeOrionGoldenClientText(title) })),
    executiveSummary: executive,
    riskMatrix: executive.riskMatrix,
    ruDigitalProfile: emptyBlock("Россия: Цифровой профиль", "ru_digital_profile", approvedNarrative.slice(0, 500) || undefined),
    ruAuditSummary: sectionBlockFromClientSections(
      client,
      ["03_", "04_", "ru_audit", "identity", "registry"],
      "Россия — резюме аудита",
      "ru_audit_summary"
    ),
    ruSearchResults: sectionBlockFromClientSections(
      client,
      ["10_", "11_", "12_", "ru_search", "search", "media"],
      "Россия — результаты поиска",
      "ru_search_results"
    ),
    ruWikipedia: sectionBlockFromClientSections(
      client,
      ["20_", "wikipedia", "wiki"],
      "Россия — Википедия",
      "ru_wikipedia"
    ),
    uaeDigitalProfile: emptyBlock("ОАЭ: Цифровой профиль", "uae_digital_profile"),
    uaeAuditSummary: sectionBlockFromClientSections(
      client,
      ["30_", "uae_audit", "uae_identity"],
      "ОАЭ — резюме аудита",
      "uae_audit_summary"
    ),
    uaeSearchResults: sectionBlockFromClientSections(
      client,
      ["31_", "32_", "uae_search", "uae_media"],
      "ОАЭ — результаты поиска",
      "uae_search_results"
    ),
    uaeWikipedia: sectionBlockFromClientSections(
      client,
      ["33_", "uae_wiki", "uae_wikipedia"],
      "ОАЭ — Википедия",
      "uae_wikipedia"
    ),
    complianceDatabases: sectionBlockFromClientSections(
      client,
      ["40_", "41_", "compliance", "sanctions"],
      "Compliance-базы",
      "compliance_databases"
    ),
    lexisNexis: sectionBlockFromClientSections(
      client,
      ["42_", "lexis"],
      "LexisNexis",
      "lexisnexis"
    ),
    dowJones: sectionBlockFromClientSections(
      client,
      ["43_", "dow_jones", "dowjones"],
      "Dow Jones",
      "dow_jones"
    ),
    worldCheck: sectionBlockFromClientSections(
      client,
      ["44_", "world_check", "worldcheck"],
      "World-Check",
      "world_check"
    ),
    // Reuse offer slot for recommendations in client_audit (deck maps by qaMetadata)
    offer: recommendationsAsOffer,
    productOverview: { ...EMPTY_COMMERCIAL, qaMetadata: { sectionKey: "product_overview_omitted" } },
    solutionDigitalProfile: { ...EMPTY_COMMERCIAL, qaMetadata: { sectionKey: "solution_omitted" } },
    solutionComplianceDatabases: { ...EMPTY_COMMERCIAL, qaMetadata: { sectionKey: "solution_omitted" } },
    solutionWikipedia: { ...EMPTY_COMMERCIAL, qaMetadata: { sectionKey: "solution_omitted" } },
    about: { ...EMPTY_COMMERCIAL, qaMetadata: { sectionKey: "about_omitted" } },
    appendix: {
      ...appendixBlock,
      // Embed manual-review as first appendix slides when deck needs it —
      // also expose via metrics for QA
      metrics: {
        ...appendixBlock.metrics,
        manualReviewItems: client.manualReviewSection?.items?.length ?? 0,
        mode: client.mode,
        assemblySource: client.assemblySource,
      },
      slideSpecs: [
        ...manualBlock.slideSpecs,
        ...appendixBlock.slideSpecs,
      ],
      evidenceCards: [...manualBlock.evidenceCards, ...appendixBlock.evidenceCards].slice(0, 20),
      // Keep short — deck slides carry content; long narrative caused overlap
      narrative: sanitizeOrionGoldenClientText(manualBlock.narrative).slice(0, 300),
    },
    assets: input.assets ?? [],
    qaMetadata: {
      generatedBy: "gpt-5.5",
      architectureVersion: "r10-9a-client-content-to-report-spec-v1",
      inventoryCounts: input.inventoryCounts ?? {
        searchResults: 0,
        searchSurfaces: 0,
        databaseProfiles: 0,
        riskFindings: 0,
        wikiChecks: 0,
        screenshots: 0,
      },
      warnings: [
        ...(input.warnings ?? []),
        "client_audit_render_from_post_review_content",
        "commercial_sections_omitted",
        "r10_9a_visual_polish",
        client.mode === "post_review"
          ? "source:orion-client-content.post-review"
          : "source:orion-client-content.pre-review",
      ],
    },
  };
}
