/**
 * R10.4 / R10.7a — Build EvidenceJudgment records from inventory items (deterministic heuristics).
 */

import type { RawInventoryItem } from "../types";
import type { EvidenceDecisionRecord } from "../types";
import { detectControversialTopics } from "./controversial-fact-policy";
import {
  finalizeEvidenceJudgment,
  type ContentNature,
  type EvidenceJudgment,
  type JudgmentRelevanceClass,
  type RiskSignal,
  type SourceReliability,
  type SubjectBinding,
} from "./evidence-judgment";
import type { SubjectIdentityProfile } from "../identity/subject-identity-profile";
import { buildSubjectIdentityProfile } from "../identity/subject-identity-profile-builder";
import { scoreSubjectBinding } from "../identity/subject-binding-scorer";

const MARKETPLACE = ["aliexpress", "ozon", "wildberries", "market.yandex", "ebay", "amazon."];
const PRODUCT = ["лампа", "led lamp", "lilygo", "esp32", "arduino", "купить", "цена", "модуль"];
const LOGIN = ["gosuslugi", "госуслugi", "esia.gosuslugi", "login", "войти", "личный кабинет"];

/** Official / government registry hosts. */
const PUBLIC_REGISTRY_DOMAINS = [
  "egrul.nalog.ru",
  "nalog.ru",
  "fedresurs.ru",
  "kad.arbitr.ru",
  "sudact.ru",
  "gosuslugi.ru",
  "minjust.ru",
];

/**
 * RU business-registry aggregators — PUBLIC_REGISTRY / BUSINESS_REGISTRY_AGGREGATOR
 * only when page looks like a registry/business profile (not opinion/adverse media).
 */
const BUSINESS_REGISTRY_AGGREGATOR_DOMAINS = [
  "rusprofile.ru",
  "list-org.com",
  "checko.ru",
  "zachestnyibiznes.ru",
  "sbis.ru",
  "kontur.ru",
  "focus.kontur.ru",
  "klerk.ru",
  "audit-it.ru",
  "spark-interfax.ru",
  "sravni.ru",
  "otc.ru",
];

const REGISTRY_PROFILE_HINTS =
  /\b(инн|огрн|огрнип|егрюл|егрип|ип\b|ооо\b|ао\b|зао\b|реестр|контрагент|юрлиц|профиль|карточка|участник|учредител|директор|гендиректор)\b/i;

const ADVERSE_DOMINANT =
  /санкц|sanction|watchlist|арест|fraud|corrupt|компромат|скандал|приговор|обвинен|расследован|offshore|офшор|pep\b|adverse/i;

function hay(item: RawInventoryItem): string {
  return [item.title, item.snippet, item.sourceUrl, item.provider, item.evidenceType]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function domainOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return url.split("/")[0];
  }
}

function domainMatches(dom: string, hosts: string[]): boolean {
  return hosts.some((h) => dom === h || dom.endsWith(`.${h}`));
}

function looksLikeRegistryOrBusinessProfile(text: string): boolean {
  return REGISTRY_PROFILE_HINTS.test(text) || /инн\s*\d{10,12}/i.test(text);
}

function mapRelevance(relevanceClass: EvidenceDecisionRecord["relevanceClass"]): JudgmentRelevanceClass {
  switch (relevanceClass) {
    case "strong_relevant":
      return "STRONG_RELEVANT";
    case "relevant":
      return "RELEVANT";
    case "potentially_relevant":
      return "POTENTIALLY_RELEVANT";
    case "weak_match":
      return "LOW_RELEVANCE";
    case "excluded_noise":
      return "NOISE";
    default:
      return "POTENTIALLY_RELEVANT";
  }
}

function assessSourceReliability(item: RawInventoryItem, text: string): SourceReliability {
  const provider = item.provider.toUpperCase();
  const dom = (domainOf(item.sourceUrl) ?? "").toLowerCase();

  if (MARKETPLACE.some((m) => text.includes(m) || dom.includes(m.replace(".", "")))) {
    return "MARKETPLACE";
  }
  if (/\.example|mock:|demo/i.test(text) || dom.endsWith(".example")) return "UNKNOWN";
  if (/LEXIS|DOW_JONES|WORLD_CHECK|WORLDCHECK/.test(provider)) return "AUTHORITATIVE";

  if (
    domainMatches(dom, PUBLIC_REGISTRY_DOMAINS) ||
    /nalog\.|gosuslugi|egrul|fedresurs|minjust|kad\.arbitr|sudact/.test(dom)
  ) {
    return "PUBLIC_REGISTRY";
  }

  // R10.7a — trusted RU aggregators only when registry/business-profile-like and not adverse-dominated
  if (domainMatches(dom, BUSINESS_REGISTRY_AGGREGATOR_DOMAINS)) {
    if (ADVERSE_DOMINANT.test(text) && !looksLikeRegistryOrBusinessProfile(text)) {
      return "UNKNOWN";
    }
    if (looksLikeRegistryOrBusinessProfile(text) || /профиль|справочник|контрагент|ип |ооо /i.test(text)) {
      return "BUSINESS_REGISTRY_AGGREGATOR";
    }
    return "BUSINESS_REGISTRY_AGGREGATOR";
  }

  if (/tass\.|interfax|kommersant|vedomosti|rbc\.|forbes|reuters|bbc|bloomberg/.test(dom)) {
    return "REPUTABLE_MEDIA";
  }
  if (/facebook|vk\.com|instagram|twitter|x\.com|linkedin|telegram|t\.me/.test(dom)) return "SOCIAL_MEDIA";
  if (/forum|blog|livejournal|pikabu|habr/.test(dom)) return "BLOG_FORUM";
  return "UNKNOWN";
}

function assessContentNature(item: RawInventoryItem, text: string): ContentNature {
  if (includesAny(text, MARKETPLACE) || includesAny(text, PRODUCT)) return "ADVERTISEMENT";
  if (includesAny(text, LOGIN)) return "TECHNICAL_PAGE";
  if (/\[demo\]/i.test(text)) return "FACT";
  if (/компромат|rumor|слух|anonymous/i.test(text)) return "RUMOR";
  if (/обвин|alleg|claim|утвержда|подозрева/i.test(text)) return "ALLEGATION";
  if (/мнен|opinion|editorial|column/i.test(text)) return "OPINION";
  if (
    item.evidenceType === "wikipedia" ||
    /profile|справочник|directory|карточка|контрагент|егрюл|егрип/i.test(text)
  ) {
    return "PROFILE_PAGE";
  }
  if (item.evidenceType === "compliance_hit" || item.evidenceType === "risk_finding") return "FACT";
  return "FACT";
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((t) => text.includes(t));
}

function isRegistryLikeSource(sourceReliability: SourceReliability): boolean {
  return sourceReliability === "PUBLIC_REGISTRY" || sourceReliability === "BUSINESS_REGISTRY_AGGREGATOR";
}

/**
 * Filter controversial topics that are false positives on neutral registry/profile pages.
 * e.g. "проверк" in registry card text, or procurement on IP cards.
 */
function filterControversialForNeutralRegistry(
  topics: ReturnType<typeof detectControversialTopics>,
  text: string,
  sourceReliability: SourceReliability,
  contentNature: ContentNature
): ReturnType<typeof detectControversialTopics> {
  if (!isRegistryLikeSource(sourceReliability)) return topics;
  if (contentNature !== "FACT" && contentNature !== "PROFILE_PAGE") return topics;
  if (ADVERSE_DOMINANT.test(text)) return topics;

  const softTopicIds = new Set(["procurement", "investigation_mention", "donations"]);
  return topics.filter((t) => {
    if (!softTopicIds.has(t.topicId)) return true;
    if (/санкц|sanction|арест|приговор|офшор|offshore|pep\b/i.test(text)) return true;
    return false;
  });
}

function assessRiskSignal(
  item: RawInventoryItem,
  text: string,
  binding: SubjectBinding,
  contentNature: ContentNature,
  sourceReliability: SourceReliability,
  controversial: ReturnType<typeof detectControversialTopics>
): RiskSignal {
  if (binding === "WRONG_SUBJECT") return "COMPLIANCE_RELEVANT";
  if (/\[demo\]|\.example|mock:/i.test(text)) return "INSUFFICIENT_CONTEXT";

  // Compliance DB potential matches always stay compliance-relevant (never auto-include)
  if (/LEXIS|DOW_JONES|WORLD_CHECK|WORLDCHECK/.test(item.provider.toUpperCase())) {
    return "COMPLIANCE_RELEVANT";
  }
  if (item.evidenceType === "compliance_hit" || item.evidenceType === "risk_finding") {
    return "COMPLIANCE_RELEVANT";
  }

  if (controversial.length > 0) return controversial[0]!.defaultRiskSignal;

  if (/sanction|санкц|watchlist|pep|rca|adverse_media/i.test(text)) {
    if (binding !== "CONFIRMED" || sourceReliability === "UNKNOWN" || sourceReliability === "BLOG_FORUM") {
      return "COMPLIANCE_RELEVANT";
    }
    if (contentNature === "ALLEGATION" || contentNature === "RUMOR") return "POSSIBLE_ADVERSE";
    return "COMPLIANCE_RELEVANT";
  }

  if (/негатив|adverse|скандал|арест|fraud|corrupt|компромат/i.test(text)) {
    if (contentNature === "ALLEGATION" || contentNature === "RUMOR" || sourceReliability === "BLOG_FORUM") {
      return "POSSIBLE_ADVERSE";
    }
    if (binding === "CONFIRMED" && sourceReliability === "REPUTABLE_MEDIA") return "POSSIBLE_ADVERSE";
    return "POSSIBLE_ADVERSE";
  }

  if (/award|награда|успех|рост|positive|благотвор/i.test(text)) return "POSITIVE_SIGNAL";

  // R10.7a — confirmed/likely neutral registry/profile facts are NOT insufficient context.
  // Distinction: insufficient context for *risk* vs sufficient context for *neutral factual use*.
  if (
    (binding === "CONFIRMED" || binding === "LIKELY") &&
    isRegistryLikeSource(sourceReliability) &&
    (contentNature === "FACT" || contentNature === "PROFILE_PAGE") &&
    !ADVERSE_DOMINANT.test(text)
  ) {
    return contentNature === "PROFILE_PAGE" ? "NEUTRAL_CONTEXT" : "NO_RISK_SIGNAL";
  }

  if (item.evidenceType === "wikipedia" || contentNature === "PROFILE_PAGE") return "NEUTRAL_CONTEXT";

  // Insufficient context only when we lack enough to classify relevance/risk or subject binding
  if (binding === "UNKNOWN" || binding === "WEAK") return "INSUFFICIENT_CONTEXT";
  return "NO_RISK_SIGNAL";
}

function buildClientSafeSummary(
  item: RawInventoryItem,
  riskSignal: RiskSignal,
  binding: SubjectBinding,
  topics: ReturnType<typeof detectControversialTopics>,
  sourceReliability: SourceReliability
): string {
  const title = item.title.slice(0, 120);
  if (binding === "WRONG_SUBJECT") {
    return `Материал, вероятно, относится к другому одноимённому лицу или объекту («${title}»). Требуется проверка идентификации.`;
  }
  if (riskSignal === "CONTROVERSIAL_DUAL_USE" && topics[0]) {
    return `Обнаружен потенциально значимый, но двусмысленный контекст (${topics[0].label}). Автоматический негативный вывод не делается.`;
  }
  if (riskSignal === "POSSIBLE_ADVERSE" || riskSignal === "COMPLIANCE_RELEVANT") {
    return `Предварительный сигнал, требующий ручной проверки: «${title}». Подтверждённый негативный статус не установлен.`;
  }
  if (
    (riskSignal === "NO_RISK_SIGNAL" || riskSignal === "NEUTRAL_CONTEXT" || riskSignal === "POSITIVE_SIGNAL") &&
    isRegistryLikeSource(sourceReliability)
  ) {
    return `Обнаружено подтверждённое реестровое / профильное упоминание: «${title}».`;
  }
  if (riskSignal === "NO_RISK_SIGNAL" || riskSignal === "NEUTRAL_CONTEXT") {
    return `Нейтральный или справочный материал: «${title}».`;
  }
  return `Материал для учёта: «${title}».`;
}

export function buildEvidenceJudgmentFromItem(input: {
  item: RawInventoryItem;
  decision: EvidenceDecisionRecord;
  subjectName: string;
  aliases: string[];
  identityProfile?: SubjectIdentityProfile;
}): EvidenceJudgment {
  const { item, decision, subjectName, aliases } = input;
  const text = hay(item);
  const profile =
    input.identityProfile ??
    buildSubjectIdentityProfile({
      caseId: "unknown",
      subjectName,
      aliases,
    });
  const bindingScore = scoreSubjectBinding(item, profile);
  const subjectBinding: SubjectBinding = bindingScore.binding;
  let relevance = mapRelevance(decision.relevanceClass);
  const sourceReliability = assessSourceReliability(item, text);
  const contentNature = assessContentNature(item, text);
  const rawControversial = detectControversialTopics(text);
  const controversial = filterControversialForNeutralRegistry(
    rawControversial,
    text,
    sourceReliability,
    contentNature
  );
  const riskSignal = assessRiskSignal(item, text, subjectBinding, contentNature, sourceReliability, controversial);

  // R10.7a — confirmed/likely registry/profile facts are at least RELEVANT for routing
  if (
    (subjectBinding === "CONFIRMED" || subjectBinding === "LIKELY") &&
    isRegistryLikeSource(sourceReliability) &&
    (contentNature === "FACT" || contentNature === "PROFILE_PAGE") &&
    relevance !== "NOISE" &&
    relevance !== "STRONG_RELEVANT"
  ) {
    relevance = "RELEVANT";
  }

  const confidenceBase = decision.entityMatchScore ?? 0.5;
  let confidence = confidenceBase;
  if (subjectBinding === "WRONG_SUBJECT") confidence = Math.max(confidence, 0.85);
  if (sourceReliability === "AUTHORITATIVE" && subjectBinding === "CONFIRMED") {
    confidence = Math.min(0.95, confidence + 0.15);
  }
  // R10.7b — boost confidence from binding score for confirmed/likely identity
  if (subjectBinding === "CONFIRMED") {
    confidence = Math.max(confidence, Math.min(0.92, 0.55 + bindingScore.score / 200));
  } else if (subjectBinding === "LIKELY") {
    confidence = Math.max(confidence, Math.min(0.8, 0.5 + bindingScore.score / 250));
  }
  // R10.7a — registry aggregators with confirmed binding get usable confidence for auto-include (>=0.55)
  if (
    isRegistryLikeSource(sourceReliability) &&
    (subjectBinding === "CONFIRMED" || subjectBinding === "LIKELY") &&
    (contentNature === "FACT" || contentNature === "PROFILE_PAGE")
  ) {
    confidence = Math.max(confidence, 0.58);
    confidence = Math.min(0.9, confidence + 0.08);
  }
  if (sourceReliability === "UNKNOWN" || sourceReliability === "MARKETPLACE") {
    confidence = Math.min(confidence, 0.55);
  }
  if (riskSignal === "CONTROVERSIAL_DUAL_USE") confidence = Math.min(confidence, 0.65);
  if (/\[demo\]/i.test(text)) confidence = Math.min(confidence, 0.4);

  const alternativeInterpretations: string[] = [];
  const evidenceForRisk: string[] = [];
  const evidenceAgainstRisk: string[] = [];
  let manualReviewReason: string | undefined;

  for (const t of controversial) {
    alternativeInterpretations.push(t.neutralInterpretation);
    if (t.positiveInterpretation) alternativeInterpretations.push(t.positiveInterpretation);
    evidenceForRisk.push(t.riskInterpretation);
    evidenceAgainstRisk.push(t.neutralInterpretation);
  }

  if (riskSignal === "POSSIBLE_ADVERSE" || riskSignal === "COMPLIANCE_RELEVANT") {
    evidenceForRisk.push(decision.humanReason);
    evidenceAgainstRisk.push(
      "Источник или идентификация субъекта могут быть недостаточны для подтверждённого вывода."
    );
  }

  if (subjectBinding === "WRONG_SUBJECT") {
    manualReviewReason =
      bindingScore.negativeSignals.find((s) => s.startsWith("patronymic_mismatch"))
        ? "Расхождение по отчеству / другому лицу — исключить из основных выводов."
        : "Вероятное совпадение с другим лицом / объектом — исключить из выводов до проверки идентификации.";
  } else if (riskSignal === "CONTROVERSIAL_DUAL_USE") {
    manualReviewReason = `Двусмысленный контекст (${controversial.map((c) => c.label).join(", ") || "высокий impact"}) — требуется ручная оценка.`;
  } else if (contentNature === "ALLEGATION" || contentNature === "RUMOR") {
    manualReviewReason =
      "Алlegation/слух без авторитетного подтверждения — нельзя включать как подтверждённый факт.";
  } else if (riskSignal === "POSSIBLE_ADVERSE" && subjectBinding !== "CONFIRMED") {
    manualReviewReason = "Возможный негативный сигнал при неполной идентификации субъекта.";
  } else if (riskSignal === "COMPLIANCE_RELEVANT") {
    manualReviewReason = "Compliance / watchlist / database potential match — требуется ручная проверка.";
  }

  const flags: string[] = [];
  if (/\[demo\]/i.test(text)) flags.push("demo_content");
  if (/\.example/i.test(text)) flags.push("mock_domain");
  if (controversial.length) flags.push(`controversial:${controversial.map((c) => c.topicId).join(",")}`);
  if (subjectBinding === "WRONG_SUBJECT") flags.push("wrong_subject");
  if (decision.relevanceClass === "excluded_noise") flags.push("relevance_noise");
  if (/LEXIS|DOW_JONES|WORLD_CHECK|WORLDCHECK/.test(item.provider.toUpperCase())) {
    flags.push("compliance_db_potential_match");
  }
  if (
    riskSignal === "CONTROVERSIAL_DUAL_USE" ||
    riskSignal === "POSSIBLE_ADVERSE" ||
    riskSignal === "COMPLIANCE_RELEVANT" ||
    riskSignal === "ADVERSE_CONFIRMED"
  ) {
    flags.push("high_impact_manual");
  }
  if (bindingScore.negativeSignals.some((s) => s.startsWith("patronymic_mismatch"))) {
    flags.push("patronymic_mismatch");
  }
  if (bindingScore.positiveSignals.some((s) => s.startsWith("exact_inn"))) {
    flags.push("exact_inn_match");
  }

  const partial = {
    evidenceId: item.inventoryId,
    title: item.title,
    url: item.sourceUrl,
    sourceDomain: domainOf(item.sourceUrl),
    subjectBinding,
    subjectBindingScore: bindingScore.score,
    subjectBindingExplanation: bindingScore.explanation,
    subjectBindingPositiveSignals: bindingScore.positiveSignals,
    subjectBindingNegativeSignals: bindingScore.negativeSignals,
    relevance,
    sourceReliability,
    contentNature,
    riskSignal,
    confidence,
    clientSafeSummary: buildClientSafeSummary(
      item,
      riskSignal,
      subjectBinding,
      controversial,
      sourceReliability
    ),
    whyRelevant: decision.humanReason,
    whyRiskyOrNot:
      riskSignal === "NO_RISK_SIGNAL" || riskSignal === "NEUTRAL_CONTEXT" || riskSignal === "POSITIVE_SIGNAL"
        ? "Явных подтверждённых негативных факторов не выявлено."
        : "Есть предварительный сигнал; требуется контекст и идентификация.",
    alternativeInterpretations,
    evidenceForRisk,
    evidenceAgainstRisk,
    manualReviewReason,
    recommendedAdminAction: "APPROVE_FOR_REPORT" as const,
    flags,
    adminReviewStatus: "PENDING" as const,
  };

  return finalizeEvidenceJudgment(partial);
}

export function buildAllEvidenceJudgments(input: {
  items: RawInventoryItem[];
  decisions: EvidenceDecisionRecord[];
  subjectName: string;
  aliases: string[];
  caseId?: string;
  regionHints?: string[];
  identityProfile?: SubjectIdentityProfile;
}): EvidenceJudgment[] {
  const byId = new Map(input.decisions.map((d) => [d.inventoryId, d]));
  const identityProfile =
    input.identityProfile ??
    buildSubjectIdentityProfile({
      caseId: input.caseId ?? "unknown",
      subjectName: input.subjectName,
      aliases: input.aliases,
      regionHints: input.regionHints,
      inventory: { items: input.items },
    });

  return input.items.map((item) => {
    const decision = byId.get(item.inventoryId);
    if (!decision) throw new Error(`missing-decision:${item.inventoryId}`);
    return buildEvidenceJudgmentFromItem({
      item,
      decision,
      subjectName: input.subjectName,
      aliases: input.aliases,
      identityProfile,
    });
  });
}
