/**
 * Stage 5 — deterministic ClientSummaryComposer over ClientSummaryPack.
 * Produces ORION-density Russian client prose. No renderer wiring. No LLM required.
 */

import type { ClientSummaryPack } from "../contracts/client-summary-pack";
import type { CanonicalThemeId } from "../contracts/canonical-claim";
import {
  COMPOSED_CLIENT_SUMMARY_SCHEMA_VERSION,
  ComposedClientSummarySchema,
  type ComposedClientSummary,
  type ComposedThemeSection,
} from "../contracts/composed-client-summary";
import { INTERNAL_CLIENT_TOKEN_RE } from "./client-summary-pack-builder";

/** Lead block keeps this many theme sections; the rest remain full text as continuation. */
const LEAD_THEME_COUNT = 3;

const INCOMPLETE_SENTENCE_RE =
  /(?:^|[.!?…]\s+)[^.!?…»)]*(?:\b(?:и|в|во|на|по|с|со|о|об|из|из-за|для|как|что|and|or|of|the|to|for|with)\s*|[,:;—–-])$/iu;

export type ComposeClientSummaryInput = {
  pack: ClientSummaryPack;
};

function finishSentence(text: string): string {
  let t = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (!t) return "";
  if (!/[.!?…»)]$/u.test(t)) t = `${t}.`;
  return t;
}

function splitSentences(text: string): string[] {
  return String(text ?? "")
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function countIncompleteSentences(text: string): number {
  let n = 0;
  for (const s of splitSentences(text)) {
    if (!/[.!?…»)]$/u.test(s)) n += 1;
    else if (INCOMPLETE_SENTENCE_RE.test(s)) n += 1;
  }
  // Also flag dangling whole-text tails without sentence split.
  const flat = text.trim();
  if (flat && !/[.!?…»)]$/u.test(flat)) n += 1;
  return n;
}

function countTechnicalTokens(text: string): number {
  const matches = text.match(new RegExp(INTERNAL_CLIENT_TOKEN_RE.source, "giu"));
  return matches?.length ?? 0;
}

function riskLabelRu(level: string): string {
  switch (level) {
    case "critical":
      return "критический";
    case "high":
      return "высокий";
    case "medium":
      return "средний";
    case "low":
      return "низкий";
    default:
      return "не определён как повышенный";
  }
}

function composeScope(pack: ClientSummaryPack): string {
  const regions = pack.scope.regions.length
    ? pack.scope.regions.join(", ")
    : "доступные региональные контуры";
  const sources = pack.scope.sourceClasses.length
    ? pack.scope.sourceClasses.join(", ")
    : "открытые источники";
  const period = pack.scope.period.collectedLabel || "по дате сбора в кейсе";
  const newest = pack.scope.period.newestLabel
    ? ` Наиболее свежий материал в наборе: ${pack.scope.period.newestLabel}.`
    : "";
  const limits =
    pack.scope.coverageLimitations.length > 0
      ? ` Ограничения покрытия: ${pack.scope.coverageLimitations.slice(0, 3).join("; ")}.`
      : "";
  return finishSentence(
    `Исследованы ${sources} по регионам ${regions}. Данные сформированы ${period}.${newest}${limits}`
  );
}

function composeOverall(pack: ClientSummaryPack): string {
  const risk = riskLabelRu(pack.overallAssessment.riskLevel);
  const reasons = pack.overallAssessment.reasons.slice(0, 4).map(finishSentence);
  const limitations = pack.overallAssessment.limitations.slice(0, 2).map(finishSentence);
  const parts = [
    finishSentence(
      pack.overallAssessment.conclusion.includes("Итоговая оценка")
        ? pack.overallAssessment.conclusion
        : `Итоговая оценка: ${risk} риск. ${pack.overallAssessment.conclusion}`
    ),
    reasons.length ? `Главные основания. ${reasons.join(" ")}` : "",
    limitations.length ? `Ограничения. ${limitations.join(" ")}` : "",
  ].filter(Boolean);
  return parts.join("\n");
}

/** Parenthetical source attribution, omitted when the domain is unknown. */
function sourceSuffix(domain: string | undefined): string {
  const d = (domain ?? "").trim();
  return d ? ` (${d})` : "";
}

function articleSentence(
  title: string,
  domain: string,
  description: string,
  alreadyUsedTitles: Set<string>
): string {
  const key = title.trim().toLowerCase();
  if (alreadyUsedTitles.has(key)) {
    return finishSentence(
      `Тот же материал «${title}»${sourceSuffix(domain)} также относится к этой теме`
    );
  }
  alreadyUsedTitles.add(key);
  // Prefer concrete description when it already names title/domain.
  if (description.includes(title) || description.includes(domain)) {
    return finishSentence(description);
  }
  return finishSentence(
    `В выборке присутствует материал «${title}»${sourceSuffix(domain)}. ${description}`
  );
}

function composeThemeSection(
  theme: ClientSummaryPack["materialThemes"][number],
  alreadyUsedTitles: Set<string>
): ComposedThemeSection {
  const articles = theme.representativeArticles.slice(0, 2);
  const articleBits = articles.map((a) =>
    articleSentence(a.title, a.domain, a.conciseCompleteDescription, alreadyUsedTitles)
  );
  const allegation = articles[0]
    ? finishSentence(articles[0].sourceAllegationOrStatus)
    : finishSentence(theme.concreteClaims[0] ?? theme.conclusion);
  const body = [
    finishSentence(`${theme.clientTitle}. ${theme.conclusion}`),
    articleBits.join(" "),
    allegation,
    finishSentence(theme.whyItMatters),
    finishSentence(`Что проверить: ${theme.recommendedChecks.join(" ")}`),
    finishSentence(theme.qualification),
  ]
    .filter(Boolean)
    .join(" ");

  return {
    themeId: theme.themeId,
    heading: theme.clientTitle,
    body,
    materialityLevel: theme.materialityLevel,
    evidenceRefs: [...theme.evidenceRefs],
    articleTitles: articles.map((a) => a.title),
    articleDomains: articles.map((a) => a.domain),
  };
}

function composeIsolated(pack: ClientSummaryPack): string {
  if (pack.isolatedSignificantItems.length === 0) {
    return finishSentence(
      "Единичные существенные публикации вне устойчивых тем в текущем наборе отдельно не выделены"
    );
  }
  const lines = pack.isolatedSignificantItems.slice(0, 5).map((item) =>
    finishSentence(
      `«${item.title}»${sourceSuffix(item.domain)}. ${item.description} ${item.qualification}`
    )
  );
  return [`Единичные существенные публикации.`, ...lines].join(" ");
}

function composeDatabases(pack: ClientSummaryPack): string {
  if (pack.internationalDatabases.length === 0) {
    return finishSentence(
      "Отдельные подтверждённые карточки международных баз в клиентском резюме не сформированы либо требуют отдельной сверки"
    );
  }
  const lines = pack.internationalDatabases.map((d) =>
    finishSentence(
      `${d.databaseName}. ${d.statusSummary} ${d.qualification}`
    )
  );
  return [`Международные базы и официальные источники.`, ...lines].join(" ");
}

function composeChanges(pack: ClientSummaryPack): string {
  const base = finishSentence(pack.changesSinceBaseline.summary);
  const counts = [
    pack.changesSinceBaseline.addedCount != null
      ? `новых материалов: ${pack.changesSinceBaseline.addedCount}`
      : null,
    pack.changesSinceBaseline.removedCount != null
      ? `ушедших из выдачи: ${pack.changesSinceBaseline.removedCount}`
      : null,
  ].filter(Boolean);
  if (counts.length === 0) return `Изменения относительно baseline. ${base}`;
  return finishSentence(
    `Изменения относительно baseline (${counts.join(", ")}). ${base}`
  );
}

function composeNextSteps(pack: ClientSummaryPack): string {
  const steps = pack.nextSteps.slice(0, 8).map((s, i) => `${i + 1}) ${finishSentence(s)}`);
  return [`Следующие проверки.`, ...steps].join(" ");
}

function assembleFullText(
  sections: ComposedClientSummary["sections"],
  continuationThemeIds: CanonicalThemeId[]
): string {
  const themeBlocks = sections.themes.map((t) => t.body);
  const lead = themeBlocks.slice(0, LEAD_THEME_COUNT);
  const rest = themeBlocks.slice(LEAD_THEME_COUNT);
  const parts = [
    sections.overallAssessment,
    sections.scope,
    sections.auditShortHeading,
    ...lead,
  ];
  if (rest.length > 0) {
    parts.push("Продолжение резюме — остальные существенные темы.");
    parts.push(...rest);
  }
  parts.push(sections.isolatedItems);
  parts.push(sections.internationalDatabases);
  parts.push(sections.changesSinceBaseline);
  parts.push(sections.nextSteps);
  void continuationThemeIds;
  return parts.filter(Boolean).join("\n\n");
}

/**
 * Count assertions that mention a publication/domain but lack evidenceRefs on the section.
 * Composer only emits theme bodies bound to pack evidence — unsupported = missing refs.
 */
function countUnsupportedAssertions(sections: ComposedThemeSection[]): number {
  let n = 0;
  for (const s of sections) {
    if (s.evidenceRefs.length === 0) n += 1;
    if (/«[^»]{8,}»/.test(s.body) && s.articleTitles.length === 0) n += 1;
  }
  return n;
}

export function composeClientSummary(
  input: ComposeClientSummaryInput
): ComposedClientSummary {
  const pack = input.pack;
  const alreadyUsedTitles = new Set<string>();

  // Sort themes: CRITICAL/HIGH first, then by title — deterministic.
  const rank = (m: string) =>
    m === "CRITICAL" ? 0 : m === "HIGH" ? 1 : m === "MEDIUM" ? 2 : 3;
  const themesSorted = [...pack.materialThemes].sort((a, b) => {
    const d = rank(a.materialityLevel) - rank(b.materialityLevel);
    if (d !== 0) return d;
    return a.themeId.localeCompare(b.themeId);
  });

  const themeSections = themesSorted.map((t) => composeThemeSection(t, alreadyUsedTitles));
  const continuationThemeIds = themeSections
    .slice(LEAD_THEME_COUNT)
    .map((t) => t.themeId);

  const sections = {
    scope: composeScope(pack),
    overallAssessment: composeOverall(pack),
    auditShortHeading: "Коротко по итогам аудита" as const,
    themes: themeSections,
    isolatedItems: composeIsolated(pack),
    internationalDatabases: composeDatabases(pack),
    changesSinceBaseline: composeChanges(pack),
    nextSteps: composeNextSteps(pack),
  };

  const fullText = assembleFullText(sections, continuationThemeIds);

  const requiredThemeIds = pack.materialThemes.map((t) => t.themeId);
  const covered = requiredThemeIds.filter((id) =>
    themeSections.some((s) => s.themeId === id && s.evidenceRefs.length > 0)
  );
  const coverage =
    requiredThemeIds.length === 0
      ? 100
      : Math.round((covered.length / requiredThemeIds.length) * 10000) / 100;

  const concreteExamples =
    themeSections.length === 0 ||
    themeSections.every((s) => s.articleTitles.length > 0 || /«[^»]{8,}»/.test(s.body));

  const techTokens = countTechnicalTokens(fullText);
  const incomplete = countIncompleteSentences(fullText);
  const unsupported = countUnsupportedAssertions(themeSections);

  // Sparse honest path: no invented themes.
  if (pack.materialThemes.length === 0) {
    const sparseText = [
      sections.overallAssessment,
      sections.scope,
      sections.auditShortHeading,
      finishSentence(
        "Существенных рисковых тем с репрезентативными материалами в текущей выборке недостаточно для развёрнутого тематического резюме"
      ),
      sections.nextSteps,
    ].join("\n\n");
    return ComposedClientSummarySchema.parse({
      schemaVersion: COMPOSED_CLIENT_SUMMARY_SCHEMA_VERSION,
      caseId: pack.caseId,
      datasetId: pack.datasetId,
      sourceHashes: pack.sourceHashes,
      evidenceRefs: pack.evidenceRefs,
      subjectId: pack.subjectId,
      fullText: sparseText,
      sections: {
        ...sections,
        themes: [],
      },
      continuationThemeIds: [],
      gates: {
        SUMMARY_MATERIAL_THEME_COVERAGE: 100,
        // Vacuous true: no material themes ⇒ no missing concrete examples.
        SUMMARY_CONCRETE_EXAMPLES_PRESENT: true,
        SUMMARY_UNSUPPORTED_ASSERTIONS: 0,
        SUMMARY_TECHNICAL_COPY_TOKENS: countTechnicalTokens(sparseText),
        SUMMARY_INCOMPLETE_SENTENCES: countIncompleteSentences(sparseText),
      },
    });
  }

  return ComposedClientSummarySchema.parse({
    schemaVersion: COMPOSED_CLIENT_SUMMARY_SCHEMA_VERSION,
    caseId: pack.caseId,
    datasetId: pack.datasetId,
    sourceHashes: pack.sourceHashes,
    evidenceRefs: pack.evidenceRefs,
    subjectId: pack.subjectId,
    fullText,
    sections,
    continuationThemeIds,
    gates: {
      SUMMARY_MATERIAL_THEME_COVERAGE: coverage,
      SUMMARY_CONCRETE_EXAMPLES_PRESENT: concreteExamples,
      SUMMARY_UNSUPPORTED_ASSERTIONS: unsupported,
      SUMMARY_TECHNICAL_COPY_TOKENS: techTokens,
      SUMMARY_INCOMPLETE_SENTENCES: incomplete,
    },
  });
}

export function assertComposedSummaryGatesPass(summary: ComposedClientSummary): void {
  const g = summary.gates;
  if (g.SUMMARY_MATERIAL_THEME_COVERAGE !== 100) {
    throw new Error(`SUMMARY_MATERIAL_THEME_COVERAGE=${g.SUMMARY_MATERIAL_THEME_COVERAGE}`);
  }
  if (!g.SUMMARY_CONCRETE_EXAMPLES_PRESENT) {
    throw new Error("SUMMARY_CONCRETE_EXAMPLES_PRESENT=false");
  }
  if (g.SUMMARY_UNSUPPORTED_ASSERTIONS !== 0) {
    throw new Error(`SUMMARY_UNSUPPORTED_ASSERTIONS=${g.SUMMARY_UNSUPPORTED_ASSERTIONS}`);
  }
  if (g.SUMMARY_TECHNICAL_COPY_TOKENS !== 0) {
    throw new Error(`SUMMARY_TECHNICAL_COPY_TOKENS=${g.SUMMARY_TECHNICAL_COPY_TOKENS}`);
  }
  if (g.SUMMARY_INCOMPLETE_SENTENCES !== 0) {
    throw new Error(`SUMMARY_INCOMPLETE_SENTENCES=${g.SUMMARY_INCOMPLETE_SENTENCES}`);
  }
}
