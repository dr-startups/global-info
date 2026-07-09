/**
 * R10.11 — Classic ORION audit ReportSpec: 1:1 registry section mapping + commercial pack.
 */

import { classifyAutocompleteQuery } from "../../evidence-quality/autocomplete-class";
import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import type { OrionClientContent } from "../content/orion-client-content-builder";
import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";
import type { ExecutiveSynthesisOutput } from "../gpt/orion-executive-synthesis-from-sections";
import type { SectionDerivedRiskMatrix } from "../sections/orion-risk-matrix-from-sections";
import { getClientAuditSections } from "../sections/orion-section-registry";
import { sanitizeOrionGoldenClientText } from "../client/client-text-sanitizer";
import { humanizeClientRiskMatrixRow } from "../client/risk-matrix-normalizer";
import type { OrionGoldenReportSpec, SectionBlock } from "../report-spec/orion-report-spec";
import {
  buildAppendixBlock,
  buildManualReviewBlock,
  type ClientContentToReportSpecInput,
} from "../report-spec/orion-client-content-to-report-spec";
import { buildOrionClassicCommercialPack } from "./orion-classic-commercial-pack";
import {
  bulletsPerSlideForSection,
  templateForRegistrySection,
} from "./orion-classic-section-template-map";
import {
  asClientBullet,
  chunkItems,
  sanitizeClassicBullets,
  truncateAtWordBoundary,
} from "./orion-classic-text-utils";

export type OrionClassicAuditReportSpec = OrionGoldenReportSpec & {
  reportMode: "classic_orion_audit";
  registrySections: Array<{ sectionId: string; order: number; block: SectionBlock }>;
};

type ClientSection = NonNullable<OrionClientContent["sections"]>[number];

function mapGlobalRiskLevel(
  level: string
): OrionGoldenReportSpec["executiveSummary"]["globalRiskLevel"] {
  const map: Record<string, OrionGoldenReportSpec["executiveSummary"]["globalRiskLevel"]> = {
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

function buildExecutiveFromClient(
  client: OrionClientContent,
  executive?: ExecutiveSynthesisOutput | null,
  riskMatrix?: SectionDerivedRiskMatrix | null
): OrionGoldenReportSpec["executiveSummary"] {
  const matrixSource = client.riskMatrixSummary ?? riskMatrix;
  const riskMatrixRows = (matrixSource?.rows ?? [])
    .filter((r) => !r.requiresManualReview || Boolean(r.caveat))
    .map((r) => ({
      theme: sanitizeOrionGoldenClientText(r.theme),
      level: sanitizeOrionGoldenClientText(r.level),
      summary: sanitizeOrionGoldenClientText(
        r.requiresManualReview || r.caveat
          ? `${r.summary}${r.caveat ? ` — ${r.caveat}` : " — требует ручной проверки"}`
          : r.summary
      ),
    }));

  const execText =
    executive?.executiveSummary ||
    client.executiveSummaryDraft ||
    "Резюме формируется на основе секционного анализа.";

  return {
    executiveSummary: truncateAtWordBoundary(execText, 1200),
    globalRiskLevel: mapGlobalRiskLevel(
      executive?.globalRiskLevel ?? matrixSource?.globalRiskLevel ?? "Требует проверки"
    ),
    riskMatrix: riskMatrixRows,
    mainRisks: sanitizeClassicBullets(executive?.mainRisks?.map(asClientBullet) ?? [], 200),
    possibleConsequences: sanitizeClassicBullets(
      executive?.possibleConsequences?.map(asClientBullet) ?? [],
      200
    ),
    finalRecommendations: sanitizeClassicBullets(
      (executive?.finalRecommendations ?? client.recommendations ?? []).map(asClientBullet),
      200
    ),
    nextSteps: sanitizeClassicBullets(executive?.nextSteps?.map(asClientBullet) ?? [], 200),
    generatedBy: "gpt-5.5",
  };
}

function adverseThemeRows(inventory?: FullEvidenceInventory): Array<{ theme: string; count: number }> {
  if (!inventory) return [];
  const counts = new Map<string, number>();
  for (const item of inventory.items) {
    if (item.evidenceType !== "search_result") continue;
    const cls = String(item.classification ?? "").toLowerCase();
    const theme = String(item.rawMetadata?.themeLabel ?? item.rawMetadata?.riskTheme ?? "").trim();
    if (!/adverse|negative|undesirable|нежелат|негатив|риск/i.test(`${cls} ${theme}`)) continue;
    const key = theme || cls || "Нежелательная тема";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([theme, count]) => ({ theme, count }));
}

function serpPositionTable(
  inventory: FullEvidenceInventory | undefined,
  region: "RU" | "UAE"
): Array<{ headers: string[]; rows: string[][] }> {
  if (!inventory) return [];
  const byQuery = new Map<string, Array<{ rank: number; domain: string; title: string }>>();
  for (const item of inventory.items) {
    if (item.evidenceType !== "search_result") continue;
    if (region === "RU" && item.region !== "RU" && item.region !== "GLOBAL") continue;
    if (region === "UAE" && item.region !== "UAE" && item.region !== "INTL") continue;
    const query = item.query?.trim() || "основной запрос";
    const domain =
      String(item.sourceUrl ?? "")
        .replace(/^https?:\/\//, "")
        .split("/")[0] ?? "";
    const list = byQuery.get(query) ?? [];
    list.push({
      rank: list.length + 1,
      domain: domain.slice(0, 40),
      title: truncateAtWordBoundary(item.title, 60),
    });
    byQuery.set(query, list);
  }
  const tables: Array<{ headers: string[]; rows: string[][] }> = [];
  for (const [query, rows] of [...byQuery.entries()].slice(0, 5)) {
    tables.push({
      headers: ["Поз.", "Домен", "Заголовок", "Запрос"],
      rows: rows.slice(0, 20).map((r) => [String(r.rank), r.domain, r.title, query]),
    });
  }
  return tables;
}

function suggestionBullets(
  inventory: FullEvidenceInventory | undefined,
  subjectName: string,
  surfaceType: "suggestion" | "related_query",
  provider?: "yandex" | "google"
): string[] {
  if (!inventory) return [];
  const typeMatchers =
    surfaceType === "related_query"
      ? ["related_query", "related query"]
      : ["suggestion", "search_suggestion"];
  return inventory.items
    .filter((item) => {
      const et = item.evidenceType.toLowerCase();
      if (!typeMatchers.some((t) => et.includes(t.replace("_", "")) || et === t)) return false;
      if (provider && !String(item.provider).toLowerCase().includes(provider)) return false;
      return true;
    })
    .slice(0, 40)
    .map((item) => {
      const query = item.query || item.title;
      const cls = classifyAutocompleteQuery(query, subjectName);
      const riskTag = cls === "RISK_QUERY" ? " ⚠ рискованный запрос" : "";
      return `${query}${riskTag}`;
    });
}

function blockFromClientSection(
  section: ClientSection,
  subjectName: string,
  inventory?: FullEvidenceInventory
): SectionBlock | null {
  if (section.status === "NOT_APPLICABLE" || section.status === "DATA_POOR" || section.status === "COLLAPSED") {
    return null;
  }
  if (!section.narrative?.trim() && (section.keyFindings?.length ?? 0) === 0) {
    return null;
  }

  const template = templateForRegistrySection(section.sectionId);
  const perSlide = bulletsPerSlideForSection(section.sectionId);
  const title = sanitizeOrionGoldenClientText(section.title);

  let bullets: string[] = [];
  if (section.sectionId.includes("suggestions") || section.sectionId.includes("related_queries")) {
    const provider = section.sectionId.includes("yandex")
      ? "yandex"
      : section.sectionId.includes("google")
        ? "google"
        : undefined;
    const surfaceType = section.sectionId.includes("related") ? "related_query" : "suggestion";
    const fromInventory = suggestionBullets(inventory, subjectName, surfaceType, provider);
    bullets =
      fromInventory.length > 0
        ? fromInventory
        : section.keyFindings.map((f) =>
            truncateAtWordBoundary(`${f.title}: ${f.summary}`, 180)
          );
  } else if (section.sectionId.includes("undesirable_theme")) {
    const themes = adverseThemeRows(inventory);
    bullets =
      themes.length > 0
        ? themes.map((t) => `${t.theme} — ${t.count} публикац.`)
        : section.keyFindings.map((f) => truncateAtWordBoundary(`${f.title}: ${f.summary}`, 180));
  } else {
    bullets = section.keyFindings.map((f) =>
      truncateAtWordBoundary(
        f.caveat ? `${f.title} — ${f.summary} (${f.caveat})` : `${f.title} — ${f.summary}`,
        200
      )
    );
    if (bullets.length === 0 && section.narrative) {
      bullets = [truncateAtWordBoundary(section.narrative, 400)];
    }
  }

  bullets = sanitizeClassicBullets(bullets, 220);
  const slideSpecs: SectionBlock["slideSpecs"] = [];
  const chunks = chunkItems(bullets, perSlide);
  if (chunks.length === 0) {
    slideSpecs.push({
      slideKey: `${section.sectionId}-1`,
      template,
      title,
      bullets: [truncateAtWordBoundary(section.narrative, 400)],
    });
  } else {
    for (const [idx, chunk] of chunks.entries()) {
      slideSpecs.push({
        slideKey: `${section.sectionId}-${idx + 1}`,
        template,
        title: chunks.length > 1 ? `${title} (${idx + 1}/${chunks.length})` : title,
        bullets: chunk,
      });
    }
  }

  const tables = section.sectionId.includes("serp_position")
    ? serpPositionTable(inventory, section.sectionId.startsWith("32_") ? "UAE" : "RU")
    : [];

  return {
    sectionTitle: title,
    metrics: {
      findings: section.keyFindings.length,
      status: section.status,
      tables: tables.length,
    },
    narrative: truncateAtWordBoundary(section.narrative, 600),
    tables,
    evidenceCards: section.keyFindings.slice(0, 20).map((f) => ({
      title: sanitizeOrionGoldenClientText(f.title),
      summary: truncateAtWordBoundary(f.summary, 220),
    })),
    visualAssets: [],
    slideSpecs,
    sourceRefs: section.evidenceRefs.slice(0, 40),
    qaMetadata: { sectionKey: section.sectionId },
  };
}

function riskMatrixBlockFromExecutive(
  executive: OrionGoldenReportSpec["executiveSummary"]
): SectionBlock {
  const matrix = (executive.riskMatrix ?? []).map((r) =>
    humanizeClientRiskMatrixRow({ theme: r.theme, level: r.level, summary: r.summary })
  );
  const slideSpecs: SectionBlock["slideSpecs"] = [];
  for (const [idx, chunk] of chunkItems(matrix, 5).entries()) {
    slideSpecs.push({
      slideKey: `risk-matrix-${idx + 1}`,
      template: "orion_golden_risk_matrix",
      title: matrix.length > 5 ? `Матрица compliance-рисков (${idx + 1})` : "Матрица compliance-рисков",
      bullets: chunk.map((r) =>
        truncateAtWordBoundary(`${r.theme} — ${r.level}: ${r.summary}`, 200)
      ),
    });
  }
  if (slideSpecs.length === 0) {
    slideSpecs.push({
      slideKey: "risk-matrix-empty",
      template: "orion_golden_risk_matrix",
      title: "Матрица compliance-рисков",
      bullets: ["Существенных подтверждённых тем риска не выявлено на текущем этапе."],
    });
  }
  return {
    sectionTitle: "Матрица compliance-рисков",
    metrics: { themes: matrix.length },
    narrative: "",
    tables: [],
    evidenceCards: matrix.map((r) => ({ title: r.theme, summary: r.summary })),
    visualAssets: [],
    slideSpecs,
    sourceRefs: [],
    qaMetadata: { sectionKey: "02_compliance_risk_matrix" },
  };
}

function emptyLegacy(sectionKey: string): SectionBlock {
  return {
    sectionTitle: sectionKey,
    metrics: { status: "empty" },
    narrative: "",
    tables: [],
    evidenceCards: [],
    visualAssets: [],
    slideSpecs: [],
    sourceRefs: [],
    qaMetadata: { sectionKey },
  };
}

export type ClassicReportSpecInput = ClientContentToReportSpecInput & {
  inventory?: FullEvidenceInventory;
};

export function buildOrionClassicReportSpecFromClientContent(
  input: ClassicReportSpecInput
): OrionClassicAuditReportSpec {
  const { clientContent: client } = input;
  const subjectName = client.subject.displayName;
  const executive = buildExecutiveFromClient(
    client,
    input.executiveSynthesis,
    input.riskMatrix ?? client.riskMatrixSummary
  );
  const commercial = buildOrionClassicCommercialPack();

  const sectionById = new Map((client.sections ?? []).map((s) => [s.sectionId, s]));
  const registrySections: OrionClassicAuditReportSpec["registrySections"] = [];

  for (const reg of getClientAuditSections()) {
    if (reg.sectionId === "01_executive_summary") {
      registrySections.push({
        sectionId: reg.sectionId,
        order: reg.order,
        block: {
          sectionTitle: "Резюме",
          metrics: { mode: "executive" },
          narrative: executive.executiveSummary,
          tables: [],
          evidenceCards: [],
          visualAssets: [],
          slideSpecs: [
            {
              slideKey: "executive-1",
              template: "orion_golden_executive_card",
              title: "Резюме",
              bullets: [
                ...executive.mainRisks.slice(0, 4),
                ...executive.possibleConsequences.slice(0, 3),
              ],
            },
            ...(executive.finalRecommendations.length
              ? [
                  {
                    slideKey: "executive-recs",
                    template: "orion_golden_executive_card",
                    title: "Резюме — рекомендуемые действия",
                    bullets: executive.finalRecommendations.slice(0, 6),
                  },
                ]
              : []),
          ],
          sourceRefs: [],
          qaMetadata: { sectionKey: "01_executive_summary" },
        },
      });
      continue;
    }
    if (reg.sectionId === "02_compliance_risk_matrix") {
      registrySections.push({
        sectionId: reg.sectionId,
        order: reg.order,
        block: riskMatrixBlockFromExecutive(executive),
      });
      continue;
    }
    if (reg.sectionId === "50_manual_review_required") {
      registrySections.push({
        sectionId: reg.sectionId,
        order: reg.order,
        block: buildManualReviewBlock(client),
      });
      continue;
    }
    if (reg.sectionId === "54_evidence_appendix") continue;

    const sec = sectionById.get(reg.sectionId);
    if (!sec && /suggestions|related_queries/.test(reg.sectionId) && input.inventory) {
      const provider = reg.sectionId.includes("yandex")
        ? "yandex"
        : reg.sectionId.includes("google")
          ? "google"
          : undefined;
      const surfaceType = reg.sectionId.includes("related") ? "related_query" : "suggestion";
      const bullets = suggestionBullets(input.inventory, subjectName, surfaceType, provider);
      if (bullets.length > 0) {
        registrySections.push({
          sectionId: reg.sectionId,
          order: reg.order,
          block: blockFromClientSection(
            {
              sectionId: reg.sectionId,
              order: reg.order,
              title: reg.titleRu,
              status: "READY",
              narrative: `Аудит ${surfaceType === "related_query" ? "похожих запросов" : "поисковых подсказок"} по сохранённым данным.`,
              keyFindings: bullets.slice(0, 20).map((b, idx) => ({
                title: `Запрос ${idx + 1}`,
                summary: b,
                evidenceRefs: [],
              })),
              evidenceRefs: [],
            },
            subjectName,
            input.inventory
          )!,
        });
      }
      continue;
    }
    if (!sec) continue;
    const block = blockFromClientSection(sec, subjectName, input.inventory);
    if (block) {
      registrySections.push({ sectionId: reg.sectionId, order: reg.order, block });
    }
  }

  const appendixBlock = buildAppendixBlock(client);
  registrySections.push({
    sectionId: "52_limitations",
    order: 52,
    block: appendixBlock,
  });

  const tocTitles = [
    "Резюме",
    "Матрица рисков",
    ...registrySections.map((s) => s.block.sectionTitle).slice(0, 24),
    "Наше предложение",
    "О нас",
  ];

  const now = new Date().toISOString().slice(0, 10);
  const pick = (id: string) => registrySections.find((s) => s.sectionId === id)?.block;

  return {
    version: "orion-golden-report-spec-v1",
    reportMode: "classic_orion_audit",
    registrySections,
    subject: {
      displayName: sanitizeOrionGoldenClientText(subjectName),
      locale: "ru",
      auditDate: now,
      reportTitle: "ORION Digital Profile — аудит цифрового профиля",
    },
    globalToc: tocTitles.map((title) => ({ title: sanitizeOrionGoldenClientText(title) })),
    executiveSummary: executive,
    riskMatrix: executive.riskMatrix,
    ruDigitalProfile: pick("03_digital_profile_overview") ?? emptyLegacy("ru_digital_profile"),
    ruAuditSummary: pick("10_ru_audit_summary") ?? emptyLegacy("ru_audit_summary"),
    ruSearchResults: pick("11_ru_search_links") ?? emptyLegacy("ru_search_results"),
    ruWikipedia: pick("16_ru_wikipedia") ?? emptyLegacy("ru_wikipedia"),
    uaeDigitalProfile: pick("30_uae_audit_summary") ?? emptyLegacy("uae_digital_profile"),
    uaeAuditSummary: pick("30_uae_audit_summary") ?? emptyLegacy("uae_audit_summary"),
    uaeSearchResults: pick("31_uae_google_search_links") ?? emptyLegacy("uae_search_results"),
    uaeWikipedia: pick("35_uae_wikipedia") ?? emptyLegacy("uae_wikipedia"),
    complianceDatabases: pick("40_compliance_database_summary") ?? emptyLegacy("compliance_databases"),
    lexisNexis: pick("44_lexisnexis_profile") ?? emptyLegacy("lexisnexis"),
    dowJones: pick("42_dow_jones_profile") ?? emptyLegacy("dow_jones"),
    worldCheck: pick("43_world_check_profile") ?? emptyLegacy("world_check"),
    offer: commercial.offer,
    productOverview: commercial.productOverview,
    solutionDigitalProfile: commercial.solutionDigitalProfile,
    solutionComplianceDatabases: commercial.solutionComplianceDatabases,
    solutionWikipedia: commercial.solutionWikipedia,
    about: commercial.about,
    appendix: appendixBlock,
    assets: input.assets ?? [],
    qaMetadata: {
      generatedBy: "gpt-5.5",
      architectureVersion: "r10-11-classic-orion-audit-v1",
      inventoryCounts: input.inventoryCounts ?? input.inventory?.counts ?? {
        searchResults: 0,
        searchSurfaces: 0,
        databaseProfiles: 0,
        riskFindings: 0,
        wikiChecks: 0,
        screenshots: 0,
      },
      warnings: [
        ...(input.warnings ?? []),
        "classic_orion_audit_mode",
        "commercial_pack_included",
        client.mode === "post_review"
          ? "source:orion-client-content.post-review"
          : "source:orion-client-content.pre-review",
      ],
    },
  };
}
