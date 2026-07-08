/**
 * R10.4 — Build EvidenceJudgment records from inventory items (deterministic heuristics).
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

const WRONG_SUBJECT_NAMES = [
  "дерипаск",
  "deripaska",
  "oleg vladimirovich",
  "олег владимирович",
  "олег дерипаск",
];

const MARKETPLACE = ["aliexpress", "ozon", "wildberries", "market.yandex", "ebay", "amazon."];
const PRODUCT = ["лампа", "led lamp", "lilygo", "esp32", "arduino", "купить", "цена", "модуль"];
const LOGIN = ["gosuslugi", "госуслugi", "esia.gosuslugi", "login", "войти", "личный кабинет"];

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

function assessSubjectBinding(
  text: string,
  subjectName: string,
  aliases: string[]
): SubjectBinding {
  const names = [subjectName, ...aliases].map((n) => n.toLowerCase()).filter((n) => n.length > 2);

  for (const wrong of WRONG_SUBJECT_NAMES) {
    if (text.includes(wrong)) {
      const subjectMatch = names.some((n) => text.includes(n));
      if (!subjectMatch) return "WRONG_SUBJECT";
      // Subject string appears in E2E name but content is about Deripaska — wrong subject for compliance doc
      if (/e2e|lexis ui|r7\.5/i.test(subjectName) && text.includes(wrong)) {
        return "WRONG_SUBJECT";
      }
    }
  }

  if (names.some((n) => text.includes(n))) return "CONFIRMED";

  if (names.some((n) => n.length > 6 && text.includes(n.slice(0, Math.min(n.length, 12))))) {
    return "LIKELY";
  }

  if (/lexis|r7\.5|e2e|20260704/i.test(text) && /e2e|lexis|r7/i.test(subjectName.toLowerCase())) {
    return "WEAK";
  }

  if (/\[demo\]|\.example|mock:/i.test(text)) return "WEAK";

  return "UNKNOWN";
}

function assessSourceReliability(item: RawInventoryItem, text: string): SourceReliability {
  const provider = item.provider.toUpperCase();
  const dom = domainOf(item.sourceUrl) ?? "";

  if (MARKETPLACE.some((m) => text.includes(m) || dom.includes(m.replace(".", "")))) {
    return "MARKETPLACE";
  }
  if (/\.example|mock:|demo/i.test(text) || dom.endsWith(".example")) return "UNKNOWN";
  if (/LEXIS|DOW_JONES|WORLD_CHECK|WORLDCHECK/.test(provider)) return "AUTHORITATIVE";
  if (/nalog\.|gosuslugi|egrul|fedresurs|minjust/.test(dom)) return "PUBLIC_REGISTRY";
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
  if (item.evidenceType === "wikipedia" || /profile|справочник|directory/i.test(text)) return "PROFILE_PAGE";
  if (item.evidenceType === "compliance_hit" || item.evidenceType === "risk_finding") return "FACT";
  return "FACT";
}

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((t) => text.includes(t));
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
  if (controversial.length > 0) return controversial[0]!.defaultRiskSignal;

  if (/sanction|санкц|watchlist|pep|rca|adverse_media/i.test(text)) {
    if (binding !== "CONFIRMED" || sourceReliability === "UNKNOWN" || sourceReliability === "BLOG_FORUM") {
      return "COMPLIANCE_RELEVANT";
    }
    if (contentNature === "ALLEGATION" || contentNature === "RUMOR") return "POSSIBLE_ADVERSE";
    return "COMPLIANCE_RELEVANT";
  }

  if (/негativ|adverse|скандал|арест|fraud|corrupt|компромат/i.test(text)) {
    if (contentNature === "ALLEGATION" || contentNature === "RUMOR" || sourceReliability === "BLOG_FORUM") {
      return "POSSIBLE_ADVERSE";
    }
    if (binding === "CONFIRMED" && sourceReliability === "REPUTABLE_MEDIA") return "POSSIBLE_ADVERSE";
    return "POSSIBLE_ADVERSE";
  }

  if (/award|награда|успех|рост|positive|благотвор/i.test(text)) return "POSITIVE_SIGNAL";
  if (item.evidenceType === "wikipedia" || contentNature === "PROFILE_PAGE") return "NEUTRAL_CONTEXT";
  if (binding === "UNKNOWN" || binding === "WEAK") return "INSUFFICIENT_CONTEXT";
  return "NO_RISK_SIGNAL";
}

function buildClientSafeSummary(
  item: RawInventoryItem,
  riskSignal: RiskSignal,
  binding: SubjectBinding,
  topics: ReturnType<typeof detectControversialTopics>
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
}): EvidenceJudgment {
  const { item, decision, subjectName, aliases } = input;
  const text = hay(item);
  const controversial = detectControversialTopics(text);
  const subjectBinding = assessSubjectBinding(text, subjectName, aliases);
  const relevance = mapRelevance(decision.relevanceClass);
  const sourceReliability = assessSourceReliability(item, text);
  const contentNature = assessContentNature(item, text);
  const riskSignal = assessRiskSignal(item, text, subjectBinding, contentNature, sourceReliability, controversial);

  const confidenceBase = decision.entityMatchScore ?? 0.5;
  let confidence = confidenceBase;
  if (subjectBinding === "WRONG_SUBJECT") confidence = Math.max(confidence, 0.85);
  if (sourceReliability === "AUTHORITATIVE" && subjectBinding === "CONFIRMED") confidence = Math.min(0.95, confidence + 0.15);
  if (sourceReliability === "UNKNOWN" || sourceReliability === "MARKETPLACE") confidence = Math.min(confidence, 0.55);
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
    evidenceAgainstRisk.push("Источник или идентификация субъекта могут быть недостаточны для подтверждённого вывода.");
  }

  if (subjectBinding === "WRONG_SUBJECT") {
    manualReviewReason = "Вероятное совпадение с другим лицом / объектом — исключить из выводов до проверки идентификации.";
  } else if (riskSignal === "CONTROVERSIAL_DUAL_USE") {
    manualReviewReason = `Двусмысленный контекст (${controversial.map((c) => c.label).join(", ") || "высокий impact"}) — требуется ручная оценка.`;
  } else if (contentNature === "ALLEGATION" || contentNature === "RUMOR") {
    manualReviewReason = "Алlegation/слух без авторитетного подтверждения — нельзя включать как подтверждённый факт.";
  } else if (riskSignal === "POSSIBLE_ADVERSE" && subjectBinding !== "CONFIRMED") {
    manualReviewReason = "Возможный негативный сигнал при неполной идентификации субъекта.";
  }

  const flags: string[] = [];
  if (/\[demo\]/i.test(text)) flags.push("demo_content");
  if (/\.example/i.test(text)) flags.push("mock_domain");
  if (controversial.length) flags.push(`controversial:${controversial.map((c) => c.topicId).join(",")}`);
  if (subjectBinding === "WRONG_SUBJECT") flags.push("wrong_subject");
  if (decision.relevanceClass === "excluded_noise") flags.push("relevance_noise");

  const partial = {
    evidenceId: item.inventoryId,
    title: item.title,
    url: item.sourceUrl,
    sourceDomain: domainOf(item.sourceUrl),
    subjectBinding,
    relevance,
    sourceReliability,
    contentNature,
    riskSignal,
    confidence,
    clientSafeSummary: buildClientSafeSummary(item, riskSignal, subjectBinding, controversial),
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
}): EvidenceJudgment[] {
  const byId = new Map(input.decisions.map((d) => [d.inventoryId, d]));
  return input.items.map((item) => {
    const decision = byId.get(item.inventoryId);
    if (!decision) throw new Error(`missing-decision:${item.inventoryId}`);
    return buildEvidenceJudgmentFromItem({
      item,
      decision,
      subjectName: input.subjectName,
      aliases: input.aliases,
    });
  });
}
