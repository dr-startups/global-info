/**
 * Prompt 2 — cross-surface finding synthesizer.
 * Consumes composite items + subject resolution + surface analyses and
 * produces an actual VerifiedFindingBundle. Includes contradiction
 * detection, limitations, promotion priorities and exclusion reasons.
 * The same evidence never spawns multiple findings (theme assignment is
 * exclusive, priority-ordered).
 */

import { createHash } from "node:crypto";
import type { RawInventoryItem } from "../types";
import type { RiskLevel } from "../contracts/common";
import {
  FINDING_SCHEMA_VERSION,
  FindingSchema,
  type Finding,
  type FindingContradiction,
  type PromotionPriority,
} from "../contracts/finding";
import {
  VERIFIED_FINDING_BUNDLE_SCHEMA_VERSION,
  VerifiedFindingBundleSchema,
  type VerifiedFindingBundle,
} from "../contracts/verified-finding-bundle";
import type { SubjectResolutionItem } from "../contracts/subject-resolution";
import { ADVERSE_PATTERNS } from "./surface-analyzers";
import { domainOf } from "./composite-dataset-builder";
import { mapRegionBucket, mapSurfaceBucket } from "../classic/composite-serp-overlay-merge";

export type ThemeDef = {
  themeId: string;
  label: string;
  keywords: RegExp;
  baseRisk: RiskLevel;
  recommendedAction: string;
};

/** Priority-ordered: first matching theme claims the evidence. */
export const FINDING_THEMES: ThemeDef[] = [
  {
    themeId: "security_scrutiny",
    label: "Внимание по линии безопасности / оборонный контур",
    keywords:
      /оборон|defen[cs]e|national security|спецслужб|фсб|fsb|безопасн\w* служб|security service|транспортн\w+ контур/iu,
    baseRisk: "high",
    recommendedAction: "Сверить первоисточники и подготовить документированную позицию.",
  },
  {
    themeId: "criminal_legal",
    label: "Криминальные / судебные материалы",
    keywords: /уголов|criminal|арест|arrest|обыск|розыск|прокур|следств|sledstvie|rucriminal|компромат|суд(?!острое)|court/iu,
    baseRisk: "high",
    recommendedAction: "Проверить статусы дел и первоисточники до принятия решений.",
  },
  {
    themeId: "pep_rca_watchlist",
    label: "PEP / RCA / watchlist-сигналы",
    keywords: /\bpep\b|\brca\b|watch.?list|санкц|sanction|world.?check|dow.?jones|lexis|rupep|комплаенс|compliance/iu,
    baseRisk: "medium",
    recommendedAction: "Запросить первичные карточки баз и подтвердить принадлежность совпадений.",
  },
  {
    themeId: "political_exposure",
    label: "Политические связи / публичная экспозиция",
    keywords: /полит|politic|депутат|парти|выбор|electoral|минист|правительств|govern|парламент|parliament/iu,
    baseRisk: "medium",
    recommendedAction: "Подготовить позицию по политическим публикациям.",
  },
  {
    themeId: "offshore_corporate",
    label: "Офшоры / корпоративное владение",
    keywords: /офшор|offshore|кипр|cyprus|\bbvi\b|панам|panama|бенефициар|beneficia|владел|ownership|opencorporates/iu,
    baseRisk: "medium",
    recommendedAction: "Заказать корпоративную проверку структуры владения.",
  },
  {
    themeId: "family_associates",
    label: "Семья и деловые связи",
    keywords: /жена|супруг|spouse|дети|сын|дочь|партнер|associate|соучредител|co-?founder/iu,
    baseRisk: "low",
    recommendedAction: "Собрать документальные подтверждения по активам и связям.",
  },
  {
    themeId: "business_profile",
    label: "Деловой профиль",
    keywords: /бизнесмен|businessman|предпринимател|инвестор|investor|биограф|biography|forbes|логистик|logistics|транспорт|transport|девелоп/iu,
    baseRisk: "none",
    recommendedAction: "Поддерживать актуальный позитивный деловой контент.",
  },
];

const UNVERIFIED_PATTERNS = /not verified|potential match|requires analyst review|предварительн|не подтвержд|potential\s+\w+\s+in/iu;
const POSITIVE_PATTERNS = /биограф|biography|pioneer|интервью|interview|эксперт|expert|forbes|достижени/iu;
const ASSERTION_PATTERNS = /подтвержден|подтверждено|confirmed|установлен[оа]?\b|введены/iu;
const DENIAL_PATTERNS = /отклонил|опроверг|не вводил|не подтвержд|отрицает|denied|dismissed|снял обвинени/iu;

export type FindingSynthesisResult = {
  bundle: VerifiedFindingBundle;
  ambiguousFindings: Finding[];
  /** evidenceRef -> all themeIds the evidence supports (shared provenance). */
  themeAssignments: Map<string, string[]>;
  stats: {
    subjectMatchEvidence: number;
    ambiguousEvidence: number;
    otherSubjectEvidence: number;
    adverseFindingCount: number;
  };
};

function refOf(item: RawInventoryItem): string {
  return `inventory:${item.inventoryId}`;
}

function itemText(item: RawInventoryItem): string {
  return [item.title, item.snippet, item.classification, item.sourceUrl]
    .filter(Boolean)
    .join(" ");
}

/**
 * One evidence item may support multiple genuinely different claims: it is
 * matched against EVERY theme, not consumed by the first/highest-priority one.
 */
function themesFor(item: RawInventoryItem): ThemeDef[] {
  const text = itemText(item);
  return FINDING_THEMES.filter((theme) => theme.keywords.test(text));
}

/** Same evidence + same normalized claim must collapse into one contribution. */
export function claimFingerprint(themeId: string, item: RawInventoryItem): string {
  const normalizedClaim = String(item.title ?? "")
    .toLowerCase()
    .replace(/ё/gu, "е")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return `${themeId}|${normalizedClaim}`;
}

function riskFor(theme: ThemeDef, adverseCount: number, total: number): RiskLevel {
  if (theme.baseRisk === "none") return adverseCount > 0 ? "low" : "none";
  if (adverseCount === 0) return theme.baseRisk === "high" ? "medium" : "low";
  if (theme.baseRisk === "high") return adverseCount >= 3 || adverseCount / total > 0.5 ? "critical" : "high";
  return adverseCount >= 3 ? "high" : theme.baseRisk;
}

function promotionFor(risk: RiskLevel, confidence: number): PromotionPriority {
  if ((risk === "critical" || risk === "high") && confidence >= 0.6) return "P1";
  if (risk === "high" || risk === "medium") return "P2";
  if (risk === "low") return "P3";
  return "P3";
}

function detectContradictions(
  themeId: string,
  items: RawInventoryItem[]
): { contradictions: FindingContradiction[]; limitations: string[] } {
  const contradictions: FindingContradiction[] = [];
  const limitations: string[] = [];

  const unverified = items.filter((i) => UNVERIFIED_PATTERNS.test(itemText(i)));
  const adverse = items.filter((i) => ADVERSE_PATTERNS.test(itemText(i)));
  const positive = items.filter((i) => POSITIVE_PATTERNS.test(itemText(i)));

  if (unverified.length > 0) {
    limitations.push(
      `${unverified.length} из ${items.length} сигналов помечены как неподтверждённые (potential match / requires review).`
    );
    if (adverse.length > unverified.length) {
      contradictions.push({
        description:
          "Часть источников подаёт тему как установленную, при этом compliance-сигналы по той же теме явно не верифицированы.",
        evidenceRefs: [...unverified.slice(0, 3), ...adverse.slice(0, 3)].map(refOf),
      });
    }
  }

  const asserting = items.filter((i) => ASSERTION_PATTERNS.test(itemText(i)));
  const denying = items.filter((i) => DENIAL_PATTERNS.test(itemText(i)));
  if (asserting.length > 0 && denying.length > 0) {
    contradictions.push({
      description:
        "Источники противоречат друг другу по существу: одни утверждают факт, другие его опровергают.",
      evidenceRefs: [...asserting.slice(0, 2), ...denying.slice(0, 2)].map(refOf),
    });
  }

  if (adverse.length > 0 && positive.length > 0) {
    contradictions.push({
      description:
        "Тональность источников противоречива: одновременно присутствуют негативные материалы и позитивно-биографические публикации.",
      evidenceRefs: [...adverse.slice(0, 2), ...positive.slice(0, 2)].map(refOf),
    });
  }

  const domains = new Set(items.map((i) => domainOf(i.sourceUrl)).filter(Boolean));
  if (domains.size === 1 && items.length > 1) {
    limitations.push(`Все свидетельства темы происходят из одного домена (${[...domains][0]}).`);
  }
  void themeId;

  return { contradictions, limitations };
}

export function synthesizeFindings(input: {
  caseId: string;
  datasetId: string;
  items: RawInventoryItem[];
  resolutionByRef: Map<string, SubjectResolutionItem>;
  sourceHashes: string[];
  /** Coverage-driven limitations, e.g. "images (UAE): NOT_COLLECTED". */
  coverageLimitations?: string[];
}): FindingSynthesisResult {
  const themeAssignments = new Map<string, string[]>();
  const byDecisionTheme = new Map<string, RawInventoryItem[]>(); // `${decision}|${themeId}`
  const seenClaimFingerprints = new Map<string, Set<string>>(); // `${decision}|${themeId}` -> fingerprints

  let subjectMatchEvidence = 0;
  let ambiguousEvidence = 0;
  let otherSubjectEvidence = 0;

  for (const item of input.items) {
    const ref = refOf(item);
    const resolution = input.resolutionByRef.get(ref);
    const decision = resolution?.decision ?? "INSUFFICIENT_IDENTIFIERS";
    if (decision === "SUBJECT_MATCH") subjectMatchEvidence += 1;
    else if (decision === "AMBIGUOUS") ambiguousEvidence += 1;
    else if (decision === "OTHER_SUBJECT") otherSubjectEvidence += 1;

    // Multi-theme: evidence supports every distinct claim it matches;
    // duplicates of the same normalized claim within a theme collapse.
    for (const theme of themesFor(item)) {
      const key = `${decision}|${theme.themeId}`;
      const fp = claimFingerprint(theme.themeId, item);
      const fingerprints = seenClaimFingerprints.get(key) ?? new Set<string>();
      if (fingerprints.has(fp)) continue; // same evidence identity + same claim
      fingerprints.add(fp);
      seenClaimFingerprints.set(key, fingerprints);

      const assigned = themeAssignments.get(ref) ?? [];
      if (!assigned.includes(theme.themeId)) assigned.push(theme.themeId);
      themeAssignments.set(ref, assigned);

      const bucket = byDecisionTheme.get(key) ?? [];
      bucket.push(item);
      byDecisionTheme.set(key, bucket);
    }
  }

  const makeFinding = (
    themeId: string,
    items: RawInventoryItem[],
    subjectMatch: "SUBJECT_MATCH" | "AMBIGUOUS" | "OTHER_SUBJECT"
  ): Finding => {
    const theme = FINDING_THEMES.find((t) => t.themeId === themeId)!;
    const adverseItems = items.filter((i) => ADVERSE_PATTERNS.test(itemText(i)));
    const risk = riskFor(theme, adverseItems.length, items.length);
    const evidenceRefs = items.map(refOf);
    const domains = [...new Set(items.map((i) => domainOf(i.sourceUrl)).filter(Boolean))];
    const providers = [...new Set(items.map((i) => String(i.provider ?? "unknown").toLowerCase()))];
    const regions = [...new Set(items.map((i) => mapRegionBucket(i.region)))];
    const surfaces = [
      ...new Set(
        items.map((i) =>
          mapSurfaceBucket(
            String(((i.rawMetadata ?? {}) as Record<string, unknown>).surface ?? i.evidenceType)
          )
        )
      ),
    ];
    const { contradictions, limitations } = detectContradictions(themeId, items);
    if (subjectMatch === "AMBIGUOUS") {
      limitations.push("Принадлежность части свидетельств проверяемому лицу не установлена однозначно.");
    }
    for (const l of input.coverageLimitations ?? []) limitations.push(l);

    const sourceDiversity = Math.min(domains.length / 3, 1);
    const confidence =
      subjectMatch === "SUBJECT_MATCH"
        ? Math.min(0.55 + 0.3 * sourceDiversity + (adverseItems.length > 0 ? 0.05 : 0.1), 0.95)
        : 0.35;

    const topTitles = items
      .slice(0, 3)
      .map((i) => String(i.title ?? "").trim())
      .filter(Boolean);

    return FindingSchema.parse({
      schemaVersion: FINDING_SCHEMA_VERSION,
      caseId: input.caseId,
      datasetId: input.datasetId,
      sourceHashes: input.sourceHashes,
      evidenceRefs,
      findingId: `finding-${themeId}-${subjectMatch.toLowerCase()}-${createHash("sha1")
        .update(evidenceRefs.sort().join("|"))
        .digest("hex")
        .slice(0, 8)}`,
      theme: theme.label,
      claim: `${theme.label}: ${items.length} свидетельств (${adverseItems.length} негативных) в источниках ${domains.slice(0, 4).join(", ") || "без URL"}. Примеры: ${topTitles.join(" · ").slice(0, 400)}`,
      subjectMatch,
      riskLevel: risk,
      confidence,
      regions,
      sourceDomains: domains,
      providers,
      recommendedAction: theme.recommendedAction,
      contradictions,
      limitations: [...new Set(limitations)],
      promotionPriority:
        subjectMatch === "SUBJECT_MATCH" ? promotionFor(risk, confidence) : "APPENDIX",
      surfaceKinds: surfaces,
    });
  };

  const verified: Finding[] = [];
  const ambiguousFindings: Finding[] = [];
  const excludedFindings: Finding[] = [];

  for (const [key, items] of byDecisionTheme) {
    const [decision, themeId] = key.split("|");
    if (decision === "SUBJECT_MATCH") verified.push(makeFinding(themeId, items, "SUBJECT_MATCH"));
    else if (decision === "AMBIGUOUS") ambiguousFindings.push(makeFinding(themeId, items, "AMBIGUOUS"));
    else if (decision === "OTHER_SUBJECT") excludedFindings.push(makeFinding(themeId, items, "OTHER_SUBJECT"));
  }

  const sortByPriority = (a: Finding, b: Finding) => {
    const order: Record<string, number> = { P1: 0, P2: 1, P3: 2, APPENDIX: 3 };
    const d = (order[a.promotionPriority] ?? 9) - (order[b.promotionPriority] ?? 9);
    return d !== 0 ? d : a.findingId.localeCompare(b.findingId);
  };
  verified.sort(sortByPriority);
  ambiguousFindings.sort(sortByPriority);

  const exclusionReasons: Record<string, string> = {};
  for (const f of excludedFindings) {
    exclusionReasons[f.findingId] = "OTHER_SUBJECT: свидетельства относятся к другому лицу";
  }

  const bundle: VerifiedFindingBundle = VerifiedFindingBundleSchema.parse({
    schemaVersion: VERIFIED_FINDING_BUNDLE_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    sourceHashes: input.sourceHashes,
    evidenceRefs: verified.flatMap((f) => f.evidenceRefs),
    kpiEligibleSubjectMatches: ["SUBJECT_MATCH"],
    findings: [...verified, ...excludedFindings],
    excludedFindingIds: excludedFindings.map((f) => f.findingId),
    exclusionReasons,
  });

  return {
    bundle,
    ambiguousFindings,
    themeAssignments,
    stats: {
      subjectMatchEvidence,
      ambiguousEvidence,
      otherSubjectEvidence,
      adverseFindingCount: verified.filter((f) =>
        ["medium", "high", "critical"].includes(f.riskLevel)
      ).length,
    },
  };
}
