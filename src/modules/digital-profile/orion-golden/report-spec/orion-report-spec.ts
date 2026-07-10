/**
 * R10 — ORION Golden ReportSpec (sole renderer input).
 */

import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import type { OrionGoldenExecutiveSynthesis, OrionGoldenSectionAnalysis } from "../types";
import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";
import { ORION_GOLDEN_BLUEPRINT } from "../blueprint/orion-golden-blueprint";
import { sanitizeOrionGoldenClientText } from "../client/client-text-sanitizer";

export type OrionGoldenReportSpec = {
  version: "orion-golden-report-spec-v1";
  subject: {
    displayName: string;
    locale: "ru";
    auditDate: string;
    reportTitle: string;
  };
  globalToc: Array<{ title: string; pageHint?: number }>;
  executiveSummary: OrionGoldenExecutiveSynthesis;
  riskMatrix: OrionGoldenExecutiveSynthesis["riskMatrix"];
  ruDigitalProfile: SectionBlock;
  ruAuditSummary: SectionBlock;
  ruSearchResults: SectionBlock;
  ruWikipedia: SectionBlock;
  uaeDigitalProfile: SectionBlock;
  uaeAuditSummary: SectionBlock;
  uaeSearchResults: SectionBlock;
  uaeWikipedia: SectionBlock;
  complianceDatabases: SectionBlock;
  lexisNexis: SectionBlock;
  dowJones: SectionBlock;
  worldCheck: SectionBlock;
  offer: SectionBlock;
  productOverview: SectionBlock;
  solutionDigitalProfile: SectionBlock;
  solutionComplianceDatabases: SectionBlock;
  solutionWikipedia: SectionBlock;
  about: SectionBlock;
  appendix: SectionBlock;
  assets: ReportAssetV1[];
  qaMetadata: {
    generatedBy: "gpt-5.5";
    architectureVersion: string;
    inventoryCounts: FullEvidenceInventory["counts"];
    warnings: string[];
  };
};

export type SectionBlock = {
  sectionTitle: string;
  metrics: Record<string, number | string>;
  narrative: string;
  tables: Array<{ headers: string[]; rows: string[][] }>;
  evidenceCards: Array<{ title: string; domain?: string; summary: string }>;
  visualAssets: string[];
  slideSpecs: Array<{
    slideKey: string;
    template: string;
    title: string;
    bullets?: string[];
    /** Optional per-slide narrative (overrides block.narrative when set). */
    narrative?: string;
    /** Structured table for orion_golden_search_table (preferred over bullets). */
    table?: { headers: string[]; rows: string[][] };
  }>;
  sourceRefs: string[];
  qaMetadata: { sectionKey: string; riskLevel?: string };
};

function blockFromAnalysis(
  analysis: OrionGoldenSectionAnalysis | undefined,
  fallbackTitle: string,
  sectionKey: string
): SectionBlock {
  if (!analysis) {
    return {
      sectionTitle: fallbackTitle,
      metrics: { status: "no_data" },
      narrative: "Для данного раздела в прогоне недостаточно подтверждённых данных.",
      tables: [],
      evidenceCards: [],
      visualAssets: [],
      slideSpecs: [{ slideKey: `${sectionKey}-no-data`, template: "orion_golden_no_data_compact", title: fallbackTitle }],
      sourceRefs: [],
      qaMetadata: { sectionKey, riskLevel: "no_data" },
    };
  }
  return {
    sectionTitle: sanitizeOrionGoldenClientText(analysis.clientTitle),
    metrics: { keyEvidenceCount: analysis.keyEvidence.length },
    narrative: sanitizeOrionGoldenClientText(analysis.clientNarrative),
    tables: [],
    evidenceCards: analysis.keyEvidence.map((e) => ({
      title: sanitizeOrionGoldenClientText(e.title),
      domain: e.domain,
      summary: sanitizeOrionGoldenClientText(e.whyRelevant),
    })),
    visualAssets: [],
    slideSpecs: analysis.slidePlan.length
      ? analysis.slidePlan
      : [{ slideKey: `${sectionKey}-summary`, template: "orion_golden_audit_dashboard", title: analysis.clientTitle }],
    sourceRefs: analysis.keyEvidence.map((e) => e.title),
    qaMetadata: { sectionKey, riskLevel: analysis.riskLevel },
  };
}

function findAnalysis(analyses: OrionGoldenSectionAnalysis[], key: string): OrionGoldenSectionAnalysis | undefined {
  return analyses.find((a) => a.sectionKey === key || a.sectionKey.startsWith(key));
}

function staticBlock(title: string, sectionKey: string, bullets: string[]): SectionBlock {
  return {
    sectionTitle: title,
    metrics: {},
    narrative: bullets.join(" "),
    tables: [],
    evidenceCards: [],
    visualAssets: [],
    slideSpecs: bullets.map((b, idx) => ({
      slideKey: `${sectionKey}-${idx + 1}`,
      template: sectionKey.startsWith("solution") ? "orion_golden_solution" : sectionKey === "about" ? "orion_golden_about" : "orion_golden_offer",
      title,
      bullets: [b],
    })),
    sourceRefs: [],
    qaMetadata: { sectionKey },
  };
}

export function buildOrionGoldenReportSpec(input: {
  inventory: FullEvidenceInventory;
  sectionAnalyses: OrionGoldenSectionAnalysis[];
  executive: OrionGoldenExecutiveSynthesis;
  assets: ReportAssetV1[];
}): OrionGoldenReportSpec {
  const { inventory, sectionAnalyses, executive, assets } = input;
  const now = new Date().toISOString().slice(0, 10);

  return {
    version: "orion-golden-report-spec-v1",
    subject: {
      displayName: inventory.subject.fullName,
      locale: "ru",
      auditDate: now,
      reportTitle: "ORION Digital Profile — клиентский отчёт",
    },
    globalToc: ORION_GOLDEN_BLUEPRINT.sections.map((s) => ({ title: s.title })),
    executiveSummary: executive,
    riskMatrix: executive.riskMatrix,
    ruDigitalProfile: blockFromAnalysis(undefined, "Россия: Цифровой профиль", "ru_digital_profile"),
    ruAuditSummary: blockFromAnalysis(findAnalysis(sectionAnalyses, "ru_audit"), "Россия — резюме аудита", "ru_audit_summary"),
    ruSearchResults: blockFromAnalysis(findAnalysis(sectionAnalyses, "ru_search"), "Россия — результаты поиска", "ru_search_results"),
    ruWikipedia: blockFromAnalysis(findAnalysis(sectionAnalyses, "ru_wikipedia"), "Россия — Википедия", "ru_wikipedia"),
    uaeDigitalProfile: blockFromAnalysis(undefined, "ОАЭ: Цифровой профиль", "uae_digital_profile"),
    uaeAuditSummary: blockFromAnalysis(findAnalysis(sectionAnalyses, "uae_audit"), "ОАЭ — резюме аудита", "uae_audit_summary"),
    uaeSearchResults: blockFromAnalysis(findAnalysis(sectionAnalyses, "uae_search"), "ОАЭ — результаты поиска", "uae_search_results"),
    uaeWikipedia: blockFromAnalysis(findAnalysis(sectionAnalyses, "uae_wikipedia"), "ОАЭ — Википедия", "uae_wikipedia"),
    complianceDatabases: blockFromAnalysis(findAnalysis(sectionAnalyses, "compliance"), "Compliance-базы", "compliance_databases"),
    lexisNexis: blockFromAnalysis(findAnalysis(sectionAnalyses, "lexis"), "LexisNexis", "lexisnexis"),
    dowJones: blockFromAnalysis(findAnalysis(sectionAnalyses, "dow_jones"), "Dow Jones", "dow_jones"),
    worldCheck: blockFromAnalysis(findAnalysis(sectionAnalyses, "world_check"), "World-Check", "world_check"),
    offer: blockFromAnalysis(findAnalysis(sectionAnalyses, "offer"), "Наше предложение", "offer_recommendation"),
    productOverview: staticBlock("Цифровой профиль: обзор продукта", "product_overview", [
      "Цифровой профиль ORION — комплексная проверка открытых источников и цифрового следа.",
      "Отчёт включает поисковую выдачу, медиа-сигналы, compliance-базы и рекомендации.",
    ]),
    solutionDigitalProfile: staticBlock("Решение 1: Цифровой профиль", "solution_digital_profile", [
      "Автоматизированный сбор данных из поисковых систем, Wikipedia и открытых источников.",
      "Структурированный клиентский отчёт с визуальными доказательствами и пояснениями.",
    ]),
    solutionComplianceDatabases: staticBlock("Решение 2: World-Check, LexisNexis и Dow Jones", "solution_compliance_databases", [
      "Подключение профессиональных compliance-баз для предварительной проверки.",
      "Аналитическая сводка перед визуальным приложением LexisNexis.",
    ]),
    solutionWikipedia: staticBlock("Решение 3: Википедия", "solution_wikipedia", [
      "Проверка публичного профиля и связанных статей Wikipedia по регионам аудита.",
    ]),
    about: staticBlock("О нас", "about", [
      "ORION — решение для due diligence и цифрового профилирования субъектов проверки.",
    ]),
    appendix: {
      sectionTitle: "Приложение",
      metrics: { excludedNoise: inventory.counts.searchResults },
      narrative: "В приложении учтены исключённые из ключевых выводов сигналы и шумовые совпадения.",
      tables: [],
      evidenceCards: [],
      visualAssets: [],
      slideSpecs: [
        { slideKey: "appendix-1", template: "orion_golden_appendix", title: "Приложение — учёт исключённых сигналов" },
        { slideKey: "appendix-2", template: "orion_golden_appendix", title: "Приложение — источники и покрытие" },
      ],
      sourceRefs: [],
      qaMetadata: { sectionKey: "appendix" },
    },
    assets,
    qaMetadata: {
      generatedBy: "gpt-5.5",
      architectureVersion: "r10-orion-3-agent-architecture-v1",
      inventoryCounts: inventory.counts,
      warnings: inventory.warnings,
    },
  };
}
