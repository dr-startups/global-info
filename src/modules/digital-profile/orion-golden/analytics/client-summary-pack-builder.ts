/**
 * Stage 4 — build ClientSummaryPack from CanonicalClaims + RepresentativeEvidence.
 * Not wired to production renderer/composer yet.
 */

import type { CanonicalClaim, CanonicalThemeId, MaterialityLevel } from "../contracts/canonical-claim";
import type { CanonicalClaimsBundle } from "../contracts/canonical-claim";
import type { RiskLevel } from "../contracts/common";
import { clientSafeDomain } from "../../services/composite-serp-merge";
import {
  CLIENT_SUMMARY_PACK_SCHEMA_VERSION,
  ClientSummaryPackSchema,
  type ClientSummaryPack,
  type ClientMaterialTheme,
  type RepresentativeArticle,
  type ClientIsolatedItem,
  type InternationalDatabaseEntry,
} from "../contracts/client-summary-pack";
import type { RepresentativeEvidenceSelection } from "../contracts/representative-evidence";
import { themeLabelRu } from "./canonical-themes";
import {
  isQuotableEvidence,
  stripPromotionalTail,
} from "./client-quote-hygiene";
import type { VerifiedFact } from "../gpt/fact-extraction";

const LEVEL_RANK: Record<MaterialityLevel, number> = {
  CRITICAL: 5,
  HIGH: 4,
  MEDIUM: 3,
  LOW: 2,
  CONTEXT_ONLY: 1,
};

const DATABASE_DOMAIN =
  /world.?check|dowjones|lexis|rupep|opensanctions|peps\.dossier|ofac/iu;

/** Tokens that must never appear in client-facing pack fields. */
export const INTERNAL_CLIENT_TOKEN_RE =
  /\b(?:findingId|reportRunId|datasetId|sourceDatasetId|inventoryReportRunId|schemaVersion|contentVersion|promptVersion|subjectMatch|promotionPriority|evidenceRef|storageRef|observationKey|compositeDigest|ORION_GPT|llm-suggested|SUBJECT_MATCH|LIKELY_SUBJECT|OTHER_SUBJECT|INSUFFICIENT_IDENTIFIERS|APPENDIX|KEEP_PRIMARY|KEEP_SUPPORTING)\b|inventory:[a-z0-9_-]+|claim-[a-f0-9]{8,}|finding-[a-z0-9_]+-|sha256:[a-f0-9]+|\/storage\/|prisma\.|rawMetadata/iu;

export type ClientSummaryPackBuildInput = {
  caseId: string;
  datasetId: string;
  subjectId: string;
  sourceHashes: string[];
  claimsBundle: CanonicalClaimsBundle;
  representative: RepresentativeEvidenceSelection;
  /** Verified facts per theme (05.2c2); absent when extraction is off. */
  factsByTheme?: Record<string, VerifiedFact[]>;
  /**
   * Authoritative overall verdict (executive summary scale).
   *
   * Without it the summary text recomputed its own verdict from theme
   * materiality, on a different scale that has «критический» while the badge
   * scale tops out at HIGH. One slide therefore carried two answers:
   * «Итоговая оценка: Высокий риск» directly above «Итоговая оценка:
   * критический риск» (step 07.9).
   */
  overallVerdict?: string;
  /**
   * Themes fact extraction ran for. A processed theme survives only if at least
   * one fact was **explicitly** assigned to it by the model: a fact that merely
   * inherited the requested theme means the model declined to place it, and
   * treating that silence as endorsement is what published «Репутационные
   * скандалы … установлено: родился 10 октября 1984 года» (step 06.3).
   */
  factsProcessedThemes?: readonly string[];
  scope?: {
    regions?: string[];
    sourceClasses?: string[];
    surfaces?: string[];
    collectedLabel?: string;
    newestLabel?: string | null;
    coverageLimitations?: string[];
  };
  changesSinceBaseline?: {
    summary?: string;
    addedCount?: number | null;
    removedCount?: number | null;
  };
};

function claimsById(bundle: CanonicalClaimsBundle): Map<string, CanonicalClaim> {
  return new Map(bundle.claims.map((c) => [c.claimId, c]));
}

function stripInternalLeak(text: string): string {
  return String(text ?? "")
    .replace(/\[finding-[^\]]+\]/giu, "")
    .replace(/inventory:[a-z0-9_-]+/giu, "")
    .replace(/claim-[a-f0-9]{8,}/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function collectClientStrings(pack: Omit<ClientSummaryPack, "gates" | "trace" | "schemaVersion" | "caseId" | "datasetId" | "sourceHashes" | "evidenceRefs" | "subjectId"> & {
  overallAssessment: ClientSummaryPack["overallAssessment"];
  materialThemes: ClientMaterialTheme[];
  isolatedSignificantItems: ClientIsolatedItem[];
  internationalDatabases: InternationalDatabaseEntry[];
  nextSteps: string[];
  scope: ClientSummaryPack["scope"];
  changesSinceBaseline: ClientSummaryPack["changesSinceBaseline"];
}): string[] {
  const out: string[] = [];
  const push = (v: string | string[] | null | undefined) => {
    if (Array.isArray(v)) for (const x of v) out.push(String(x));
    else if (v) out.push(String(v));
  };
  push(pack.overallAssessment.conclusion);
  push(pack.overallAssessment.reasons);
  push(pack.overallAssessment.limitations);
  push(pack.scope.coverageLimitations);
  push(pack.scope.period.collectedLabel);
  push(pack.scope.period.newestLabel);
  push(pack.changesSinceBaseline.summary);
  push(pack.nextSteps);
  for (const t of pack.materialThemes) {
    push(t.clientTitle);
    push(t.conclusion);
    push(t.concreteClaims);
    push(t.whyItMatters);
    push(t.qualification);
    push(t.recommendedChecks);
    for (const a of t.representativeArticles) {
      push(a.title);
      push(a.domain);
      push(a.conciseCompleteDescription);
      push(a.sourceAllegationOrStatus);
      push(a.clientQualification);
    }
  }
  for (const i of pack.isolatedSignificantItems) {
    push(i.title);
    push(i.domain);
    push(i.description);
    push(i.qualification);
  }
  for (const d of pack.internationalDatabases) {
    push(d.databaseName);
    push(d.statusSummary);
    push(d.qualification);
  }
  return out;
}

function countInternalTokens(texts: string[]): number {
  let n = 0;
  for (const t of texts) {
    if (INTERNAL_CLIENT_TOKEN_RE.test(t)) n += 1;
  }
  return n;
}

function riskFromMateriality(levels: MaterialityLevel[]): RiskLevel {
  const max = levels.reduce((a, b) => (LEVEL_RANK[b] > LEVEL_RANK[a] ? b : a), "CONTEXT_ONLY" as MaterialityLevel);
  if (max === "CRITICAL") return "critical";
  if (max === "HIGH") return "high";
  if (max === "MEDIUM") return "medium";
  if (max === "LOW") return "low";
  return "none";
}

function whyItMatters(themeId: CanonicalThemeId): string {
  switch (themeId) {
    case "criminal_judicial":
      return "Для банка или партнёра судебные и криминальные сюжеты обычно становятся поводом для расширенной проверки статусов дел и первоисточников.";
    case "corruption_integrity":
      return "Коррупционные и этические сюжеты повышают требования к проверке связей, конфликтов интересов и первичных документов.";
    case "sanctions_pep_rca_compliance":
      return "Санкционные и мониторинговые совпадения отрабатываются в первую очередь при KYC и онбординге.";
    case "political_public_exposure":
      return "Политическая публичная экспозиция усиливает вопросы о влиянии, приемлемости контрагента и согласованной позиции для комплаенс-запросов.";
    case "offshore_financial_transparency":
      return "Офшорные и непрозрачные структуры владения типично требуют раскрытия бенефициаров и источников контроля.";
    case "business_ownership_associates":
      return "Деловые связи и круг связанных лиц могут расширять периметр due diligence.";
    case "regulatory":
      return "Регуляторное внимание повышает необходимость сверки ограничений и официальных статусов.";
    case "reputational_scandal":
      return "Устойчивые скандальные сюжеты влияют на репутационную оценку даже при отсутствии судебного приговора.";
    case "family_personal_risk_relevant":
      return "Семейные и личные связи учитываются, если они меняют профиль риска или переносят негатив на субъекта.";
    case "identity_mismatch":
      return "Ошибочная идентификация требует отделения материалов других лиц от профиля субъекта.";
    default:
      return "Тема учитывается при оценке комплаенс- и репутационных рисков сделки.";
  }
}

/**
 * Скобочная отсылка к источнику; опускается, если домен неизвестен или его
 * нельзя называть клиенту (демо-данные).
 */
function sourceSuffix(domain: string | undefined): string {
  const d = clientSafeDomain(domain);
  return d ? ` (${d})` : "";
}

/**
 * Collapses recommendations that differ only by the theme they name.
 *
 * `new Set` removed exact duplicates only, so eight themes produced eight
 * copies of "Сверить первоисточники и статус материалов по теме «X»" — a whole
 * slide of one sentence repeated. Same-shaped lines become one line listing
 * every theme, which is what an analyst would write.
 */
export function collapseRecommendations(items: string[]): string[] {
  const groups = new Map<string, { sample: string; subjects: string[] }>();
  const order: string[] = [];

  for (const raw of items) {
    const text = String(raw ?? "").trim();
    if (!text) continue;
    // Shape = the sentence with its quoted subject blanked out.
    const shape = text.replace(/«[^»]*»/gu, "«»");
    const subject = /«([^»]*)»/u.exec(text)?.[1]?.trim();
    const existing = groups.get(shape);
    if (!existing) {
      groups.set(shape, { sample: text, subjects: subject ? [subject] : [] });
      order.push(shape);
      continue;
    }
    if (subject && !existing.subjects.includes(subject)) existing.subjects.push(subject);
  }

  return order.map((shape) => {
    const { sample, subjects } = groups.get(shape)!;
    if (subjects.length <= 1) return sample;
    const list = subjects.map((s) => `«${s}»`).join(", ");
    return sample.replace(/«[^»]*»/u, list);
  });
}

function articleFromSelection(
  claim: CanonicalClaim,
  title: string,
  domain: string,
  excerpt: string
): RepresentativeArticle {
  const cleanTitle = stripInternalLeak(title || claim.originalTitle || "Материал без заголовка");
  // Never borrow sourceDomains[0]: it belongs to some other material of the
  // same claim, and a misattributed source discredits the evidence (step 05.3).
  const cleanDomain = (domain || claim.originalDomain || "").trim();
  // Рекламная обвязка площадки и голые адреса — не содержание материала
  // (шаг 13, C4). Если после чистки цитировать нечего, описание строится по
  // заголовку, а не публикует обрывок призыва подписаться.
  const cleanExcerpt = isQuotableEvidence(excerpt) ? stripPromotionalTail(excerpt) : "";
  const cleanClaimExcerpt = isQuotableEvidence(claim.displayExcerpt)
    ? stripPromotionalTail(claim.displayExcerpt)
    : "";
  const description = stripInternalLeak(
    cleanExcerpt ||
      cleanClaimExcerpt ||
      (cleanTitle
        ? cleanDomain
          ? `«${cleanTitle}» — источник ${clientSafeDomain(cleanDomain)}.`
          : `«${cleanTitle}».`
        : "Описание материала сохранено в доказательной трассе.")
  );
  const allegation = stripInternalLeak(
    claim.claimKind === "DATABASE_STATUS"
      ? "Статус в комплаенс-/мониторинговой базе требует сверки карточки."
      : claim.claimKind === "OFFICIAL_RECORD"
        ? "Официальная или реестровая запись; сверить актуальность статуса."
        : "В материале сообщается о связанных с субъектом обстоятельствах; утверждения источника не равны установленному факту."
  );
  return {
    title: cleanTitle,
    domain: cleanDomain,
    sourceDate: claim.dates[0] ?? null,
    conciseCompleteDescription: description,
    sourceAllegationOrStatus: allegation,
    evidenceRefs: [...claim.evidenceRefs],
    confidence: claim.confidence,
    materialityLevel: claim.materialityLevel,
    clientQualification: stripInternalLeak(claim.clientQualification),
    claimKind: claim.claimKind,
  };
}

/**
 * Sentence for one verified fact: the statement, its verbatim quote and the
 * attribution resolved from our own records. Replaces the old
 * "Найдены публикации, в том числе «заголовок»" template, which named sources
 * without ever saying what they reported.
 */
function factSentence(fact: VerifiedFact): string {
  const source = [fact.sourceDomain, fact.publishedAt].filter(Boolean).join(", ");
  const attribution = source ? ` (${source})` : "";
  return stripInternalLeak(`${fact.statement} Цитата: «${fact.quote}»${attribution}.`);
}

function buildThemeBlock(
  themeId: CanonicalThemeId,
  selection: RepresentativeEvidenceSelection,
  byClaim: Map<string, CanonicalClaim>,
  facts: VerifiedFact[] = [],
  /** True when fact extraction ran for this theme and returned nothing for it. */
  processedWithoutFacts = false
): ClientMaterialTheme | null {
  // A theme the keyword filter invented: its materials were shown to the model
  // and it filed no statement under this theme. Publishing it produced slides
  // like «Репутационные скандалы … установлено: родился 10 октября 1984 года» —
  // a theme title carrying a fact that only inherited it.
  if (processedWithoutFacts) return null;
  const selected = selection.selectedByTheme[themeId] ?? [];
  if (selected.length === 0) return null;

  const articles: RepresentativeArticle[] = [];
  const evidenceRefs = new Set<string>();
  const domains = new Set<string>();
  const concreteClaims: string[] = [];
  let ceiling: MaterialityLevel = "CONTEXT_ONLY";
  let qualification = "";

  for (const sel of selected) {
    const claim = byClaim.get(sel.claimId);
    if (!claim) continue;
    if (claim.subjectMatch === "OTHER_SUBJECT") continue;
    if (LEVEL_RANK[claim.materialityLevel] > LEVEL_RANK[ceiling]) {
      ceiling = claim.materialityLevel;
    }
    const article = articleFromSelection(
      claim,
      sel.originalTitle,
      sel.sourceDomain,
      sel.displayExcerpt
    );
    // Invariant: title and description must be present. An unknown domain is
    // tolerated — the attribution is then omitted rather than invented.
    if (!article.title || !article.conciseCompleteDescription) continue;
    articles.push(article);
    for (const r of article.evidenceRefs) evidenceRefs.add(r);
    // Theme-level domains legitimately aggregate every source behind the theme.
    // Only the per-article attribution must stay tied to its own material.
    if (article.domain) domains.add(article.domain);
    for (const d of claim.sourceDomains) if (d) domains.add(d);
    concreteClaims.push(
      stripInternalLeak(
        `В выборке: «${article.title}»${sourceSuffix(article.domain)}. ${article.sourceAllegationOrStatus}`
      )
    );
    if (!qualification) qualification = article.clientQualification;
  }

  if (articles.length === 0 || evidenceRefs.size === 0 || concreteClaims.length === 0) {
    return null;
  }

  const clientTitle = themeLabelRu(themeId);
  // Verified facts say what the materials report; the title-based sentences
  // only say which materials exist. Prefer the former when we have them.
  if (facts.length > 0) {
    concreteClaims.length = 0;
    concreteClaims.push(...facts.map(factSentence));
  }
  const lead = articles[0]!;
  /*
   * Тема здесь не называется.
   *
   * Она уже стоит заголовком блока (`clientTitle` → `heading`), и её же
   * приписывает `formatSemanticBullet`, если тело с неё не начинается. Вместе
   * с прежним «По теме «X»…» название темы выходило в тексте два, а на одном
   * блоке и три раза подряд: «Репутационные скандалы… По теме «Репутационные
   * скандалы…» найдены… Репутационные скандалы… «заголовок»».
   */
  const conclusion = stripInternalLeak(
    facts.length > 0
      ? `Установлено: ${facts[0]!.statement}`
      : `Найдены конкретные материалы, в том числе «${lead.title}»${sourceSuffix(lead.domain)}.`
  );

  return {
    themeId,
    clientTitle,
    conclusion,
    concreteClaims,
    representativeArticles: articles,
    whyItMatters: whyItMatters(themeId),
    qualification:
      qualification ||
      "Сведения требуют проверки по первичным документам; наличие публикации не подтверждает изложенные обвинения.",
    recommendedChecks: [
      stripInternalLeak(
        `Сверить первоисточники и статус материалов по теме «${clientTitle}».`
      ),
      "Подготовить согласованную позицию для KYC и партнёрских запросов.",
    ],
    materialityLevel: ceiling,
    evidenceRefs: [...evidenceRefs],
    sourceDomains: [...domains],
  };
}

function buildInternationalDatabases(
  claims: CanonicalClaim[]
): InternationalDatabaseEntry[] {
  const dbClaims = claims.filter(
    (c) =>
      c.subjectMatch !== "OTHER_SUBJECT" &&
      (c.claimKind === "DATABASE_STATUS" ||
        c.sourceDomains.some((d) => DATABASE_DOMAIN.test(d)) ||
        c.themeIds.includes("sanctions_pep_rca_compliance"))
  );
  const byDomain = new Map<string, CanonicalClaim[]>();
  for (const c of dbClaims) {
    const domain =
      c.sourceDomains.find((d) => DATABASE_DOMAIN.test(d)) ?? c.sourceDomains[0] ?? "compliance-db";
    // Keep media sanctions out of "international databases" block unless DB-like.
    if (!DATABASE_DOMAIN.test(domain) && c.claimKind !== "DATABASE_STATUS") continue;
    const list = byDomain.get(domain) ?? [];
    list.push(c);
    byDomain.set(domain, list);
  }
  const out: InternationalDatabaseEntry[] = [];
  for (const [domain, list] of [...byDomain.entries()].sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    const top = list.sort(
      (a, b) => LEVEL_RANK[b.materialityLevel] - LEVEL_RANK[a.materialityLevel]
    )[0]!;
    const name = /rupep/i.test(domain)
      ? "RuPEP"
      : /lexis/i.test(domain)
        ? "LexisNexis"
        : /dowjones|dow.?jones/i.test(domain)
          ? "Dow Jones"
          : /world.?check/i.test(domain)
            ? "World-Check"
            : /ofac/i.test(domain)
              ? "OFAC / sanctions list"
              : domain;
    out.push({
      databaseName: name,
      statusSummary: stripInternalLeak(
        top.originalTitle
          ? `По открытым/импортированным данным есть сигнал, связанный с записью «${top.originalTitle}».`
          : "Зафиксирован предварительный сигнал международной или комплаенс-базы."
      ),
      qualification: stripInternalLeak(
        top.clientQualification ||
          "Сигнал базы требует сверки идентификаторов и полной карточки; без подтверждения не считается установленным фактом."
      ),
      evidenceRefs: [...new Set(list.flatMap((c) => c.evidenceRefs))],
      sourceDomains: [domain],
    });
  }
  return out;
}

/** Verdict wording for the summary sentence, on the executive summary scale. */
function verdictSentenceLabel(verdict: string): string | null {
  const map: Record<string, string> = {
    HIGH: "высокий",
    ELEVATED: "повышенный",
    MIXED: "смешанный",
    LOW: "низкий",
  };
  return map[String(verdict).toUpperCase()] ?? null;
}

function buildOverallAssessment(
  subjectId: string,
  themes: ClientMaterialTheme[],
  allEvidence: string[],
  overallVerdict?: string
): ClientSummaryPack["overallAssessment"] {
  const levels = themes.map((t) => t.materialityLevel);
  const riskLevel = riskFromMateriality(levels);
  // One verdict per report: prefer the authoritative one when supplied.
  const authoritative = overallVerdict ? verdictSentenceLabel(overallVerdict) : null;
  const topTitles = themes
    .slice(0, 4)
    .map((t) => t.clientTitle)
    .join("; ");
  const conclusion = stripInternalLeak(
    riskLevel === "none"
      ? `По собранным открытым источникам существенных рисковых тем по субъекту не выделено; вывод ограничен доступностью данных.`
      : `Итоговая оценка: ${
          authoritative ??
          (riskLevel === "critical"
            ? "критический"
            : riskLevel === "high"
              ? "высокий"
              : riskLevel === "medium"
                ? "средний"
                : "низкий")
        } риск. Основные основания: ${topTitles || "подтверждённые темы риска в открытых источниках"}.`
  );
  const reasons = themes.slice(0, 6).map((t) =>
    stripInternalLeak(
      `${t.clientTitle}: ${t.representativeArticles[0]?.title ?? t.concreteClaims[0]}`
    )
  );
  if (reasons.length === 0) {
    reasons.push("Существенные темы риска в текущей выборке не сформированы.");
  }
  return {
    riskLevel,
    conclusion,
    reasons,
    limitations: [
      "Вывод основан на открытых и импортированных источниках; первичные документы могут изменить оценку.",
      "Медийные утверждения не приравниваются к установленным фактам.",
    ],
    evidenceRefs: allEvidence.length > 0 ? allEvidence : ["trace:no-material-themes"],
  };
}

export function buildClientSummaryPack(input: ClientSummaryPackBuildInput): ClientSummaryPack {
  const byClaim = claimsById(input.claimsBundle);
  // Themes dropped for want of an own verified fact — excluded on purpose,
  // so the coverage gate must not read them as unexplained disappearances.
  const prunedThemeIds = new Set<string>();
  const materialThemes: ClientMaterialTheme[] = [];

  // CRITICAL/HIGH themes from representative selection must appear.
  const requiredHigh = new Set<CanonicalThemeId>();
  for (const themeId of input.representative.materialThemeIds) {
    const sels = input.representative.selectedByTheme[themeId] ?? [];
    const ceiling = sels.reduce(
      (acc, s) => (LEVEL_RANK[s.materialityLevel] > LEVEL_RANK[acc] ? s.materialityLevel : acc),
      "CONTEXT_ONLY" as MaterialityLevel
    );
    if (ceiling === "CRITICAL" || ceiling === "HIGH" || ceiling === "MEDIUM") {
      if (themeId !== "identity_mismatch") requiredHigh.add(themeId);
    }
  }

  for (const themeId of [...input.representative.materialThemeIds].sort()) {
    if (themeId === "identity_mismatch") continue;
    const allThemeFacts = input.factsByTheme?.[themeId] ?? [];
    // A fact that merely inherited this theme was not filed here by the model,
    // so it must not appear in the theme's text either. Otherwise the lead
    // sentence picks it up and the deck reads «Репутационные скандалы …
    // установлено: родился 10 октября 1984 года» (step 06.3).
    const themeFacts = allThemeFacts.filter((f) => f.themeId === themeId);
    const hasOwnFact = themeFacts.length > 0;
    const processedWithoutFacts =
      (input.factsProcessedThemes?.includes(themeId) ?? false) && !hasOwnFact;
    if (processedWithoutFacts) prunedThemeIds.add(themeId);
    const block = buildThemeBlock(
      themeId,
      input.representative,
      byClaim,
      themeFacts,
      processedWithoutFacts
    );
    if (block) materialThemes.push(block);
  }

  // Count missing CRITICAL/HIGH themes (gate).
  let missing = 0;
  for (const themeId of requiredHigh) {
    // Pruned by 06.3: the theme had no verified fact of its own. That is an
    // accounted-for exclusion, not a missing theme; counting it here turned a
    // cosmetic defect into CLIENT_SUMMARY_PACK_VALID=false and killed the whole
    // report.
    if (prunedThemeIds.has(themeId)) continue;
    const ceiling = (input.representative.selectedByTheme[themeId] ?? []).reduce(
      (acc, s) => (LEVEL_RANK[s.materialityLevel] > LEVEL_RANK[acc] ? s.materialityLevel : acc),
      "CONTEXT_ONLY" as MaterialityLevel
    );
    if (
      (ceiling === "CRITICAL" || ceiling === "HIGH") &&
      !materialThemes.some((t) => t.themeId === themeId)
    ) {
      missing += 1;
    }
  }

  const isolatedSignificantItems: ClientIsolatedItem[] = [];
  for (const iso of input.representative.isolatedSignificantItems) {
    const claim = byClaim.get(iso.claimId);
    if (!claim || claim.subjectMatch === "OTHER_SUBJECT") continue;
    // AMBIGUOUS never presented as established fact.
    const qualification =
      claim.subjectMatch === "AMBIGUOUS" ||
      claim.subjectMatch === "INSUFFICIENT_IDENTIFIERS"
        ? "Принадлежность субъекту не подтверждена; материал не включается в итог как факт об этом лице."
        : stripInternalLeak(claim.clientQualification);
    const domain = iso.sourceDomains[0] || claim.sourceDomains[0] || "неизвестный источник";
    isolatedSignificantItems.push({
      title: stripInternalLeak(iso.originalTitle || claim.originalTitle || "Единичный материал"),
      domain,
      description: stripInternalLeak(iso.displayExcerpt),
      qualification,
      materialityLevel: iso.materialityLevel,
      evidenceRefs: [...iso.evidenceRefs],
    });
  }

  const internationalDatabases = buildInternationalDatabases(
    input.claimsBundle.claims.filter((c) => c.subjectMatch !== "OTHER_SUBJECT")
  );

  const allEvidence = [
    ...new Set(materialThemes.flatMap((t) => t.evidenceRefs)),
  ];
  const overallAssessment = buildOverallAssessment(
    input.subjectId,
    materialThemes,
    allEvidence,
    input.overallVerdict
  );

  const nextSteps = collapseRecommendations(
    materialThemes.flatMap((t) => t.recommendedChecks).concat([
      "Сверить актуальность санкционных и мониторинговых записей по официальным источникам.",
      "Подготовить единый пакет документов для KYC и партнёрских запросов.",
    ])
  ).slice(0, 8);

  const scope = {
    regions: input.scope?.regions ?? ["RU", "UAE"],
    sourceClasses: input.scope?.sourceClasses ?? [
      "поисковая выдача",
      "открытые СМИ",
      "комплаенс-базы",
    ],
    surfaces: input.scope?.surfaces ?? [
      "organic",
      "suggestions",
      "images",
      "ai_answers",
      "compliance",
    ],
    period: {
      collectedLabel: input.scope?.collectedLabel ?? "по дате сбора в кейсе",
      newestLabel: input.scope?.newestLabel ?? null,
    },
    coverageLimitations: (input.scope?.coverageLimitations ?? []).map(stripInternalLeak),
  };

  const changesSinceBaseline = {
    summary: stripInternalLeak(
      input.changesSinceBaseline?.summary ??
        "Сравнение с baseline отражено в отдельном отчёте об изменениях, если он доступен."
    ),
    addedCount: input.changesSinceBaseline?.addedCount ?? null,
    removedCount: input.changesSinceBaseline?.removedCount ?? null,
  };

  const findingIds = [
    ...new Set(input.claimsBundle.claims.flatMap((c) => c.provenance.findingIds)),
  ];
  const dispositionRefs = [
    ...new Set(input.claimsBundle.claims.map((c) => c.dispositionRef)),
  ];

  const draftClient = {
    scope,
    overallAssessment,
    materialThemes,
    isolatedSignificantItems,
    internationalDatabases,
    changesSinceBaseline,
    nextSteps,
  };
  const internalTokenHits = countInternalTokens(collectClientStrings(draftClient));

  let assertionsWithoutEvidence = 0;
  for (const t of materialThemes) {
    if (t.evidenceRefs.length === 0) assertionsWithoutEvidence += 1;
    if (t.concreteClaims.length === 0) assertionsWithoutEvidence += 1;
    for (const a of t.representativeArticles) {
      if (a.evidenceRefs.length === 0) assertionsWithoutEvidence += 1;
      if (a.claimKind === "SOURCE_ALLEGATION" && !a.clientQualification.trim()) {
        assertionsWithoutEvidence += 1;
      }
    }
  }

  const valid =
    missing === 0 &&
    assertionsWithoutEvidence === 0 &&
    internalTokenHits === 0 &&
    materialThemes.every(
      (t) =>
        // An unknown domain is not an integrity failure — the attribution is
        // simply omitted. Borrowing another material's domain would be one,
        // and is now structurally impossible (step 05.3).
        t.representativeArticles.every((a) => a.title && a.conciseCompleteDescription) &&
        t.evidenceRefs.length > 0
    );

  const pack: ClientSummaryPack = {
    schemaVersion: CLIENT_SUMMARY_PACK_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    sourceHashes: input.sourceHashes,
    evidenceRefs: allEvidence,
    subjectId: input.subjectId,
    scope,
    overallAssessment,
    materialThemes,
    isolatedSignificantItems,
    internationalDatabases,
    changesSinceBaseline,
    nextSteps,
    trace: {
      claimIds: input.claimsBundle.claims.map((c) => c.claimId),
      findingIds,
      dispositionRefs,
      representativeSelectionRef: "representative-evidence-selection.json",
      canonicalClaimsRef: "canonical-claims.json",
      p1p2Account: input.representative.p1p2Account.map((p) => ({
        findingId: p.findingId,
        status: p.status,
        reasonCode: p.reasonCode,
      })),
    },
    gates: {
      CLIENT_SUMMARY_PACK_VALID: valid,
      MATERIAL_THEMES_MISSING: missing,
      CLIENT_ASSERTIONS_WITHOUT_EVIDENCE: assertionsWithoutEvidence,
      INTERNAL_TOKENS_IN_CLIENT_FIELDS: internalTokenHits,
    },
  };

  return ClientSummaryPackSchema.parse(pack);
}

export function assertClientSummaryPackGatesPass(pack: ClientSummaryPack): void {
  const g = pack.gates;
  if (!g.CLIENT_SUMMARY_PACK_VALID) {
    throw new Error("CLIENT_SUMMARY_PACK_VALID=false");
  }
  if (g.MATERIAL_THEMES_MISSING !== 0) {
    throw new Error(`MATERIAL_THEMES_MISSING=${g.MATERIAL_THEMES_MISSING}`);
  }
  if (g.CLIENT_ASSERTIONS_WITHOUT_EVIDENCE !== 0) {
    throw new Error(
      `CLIENT_ASSERTIONS_WITHOUT_EVIDENCE=${g.CLIENT_ASSERTIONS_WITHOUT_EVIDENCE}`
    );
  }
  if (g.INTERNAL_TOKENS_IN_CLIENT_FIELDS !== 0) {
    throw new Error(`INTERNAL_TOKENS_IN_CLIENT_FIELDS=${g.INTERNAL_TOKENS_IN_CLIENT_FIELDS}`);
  }
}
