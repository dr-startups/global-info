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
import {
  getAdversePatterns,
  getFindingThemes,
  resolveFindingThemesConfig,
  type ThemeDef,
} from "../../config/finding-themes";
import { domainOf } from "./composite-dataset-builder";
import { mapRegionBucket, mapSurfaceBucket } from "../classic/composite-serp-overlay-merge";

export type { ThemeDef };

/**
 * Live view of configured themes (REMEDIATION §3.1). Prefer getFindingThemes().
 * Proxy keeps `.find` / `.filter` / indexing working for existing call sites.
 */
export const FINDING_THEMES: ThemeDef[] = new Proxy([] as ThemeDef[], {
  get(_target, prop, receiver) {
    const themes = getFindingThemes();
    if (prop === "length") return themes.length;
    if (typeof prop === "string" && /^\d+$/.test(prop)) return themes[Number(prop)];
    const value = Reflect.get(themes, prop, receiver);
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(themes) : value;
  },
});

export type FindingSynthesisResult = {
  bundle: VerifiedFindingBundle;
  ambiguousFindings: Finding[];
  /** evidenceRef -> all themeIds the evidence supports (shared provenance). */
  themeAssignments: Map<string, string[]>;
  stats: {
    subjectMatchEvidence: number;
    likelySubjectEvidence: number;
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

function itemIsAdverse(item: RawInventoryItem): boolean {
  const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
  if (meta.analystNeutral === true) return false;
  if (meta.analystAdverse === true) return true;
  return getAdversePatterns().test(itemText(item));
}

/** Russian plural form: 1 публикация, 2 публикации, 5 публикаций. */
export function pluralRu(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/**
 * One evidence item may support multiple genuinely different claims: it is
 * matched against EVERY theme, not consumed by the first/highest-priority one.
 */
function themesFor(item: RawInventoryItem): ThemeDef[] {
  const text = itemText(item);
  return getFindingThemes().filter((theme) => theme.keywords.test(text));
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

  const cfg = resolveFindingThemesConfig();
  const unverified = items.filter((i) => cfg.unverifiedClaimPatterns.test(itemText(i)));
  const adverse = items.filter((i) => itemIsAdverse(i));
  const positive = items.filter((i) => cfg.positivePatterns.test(itemText(i)));

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

  const asserting = items.filter((i) => cfg.assertionPatterns.test(itemText(i)));
  const denying = items.filter((i) => cfg.denialPatterns.test(itemText(i)));
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
  let likelySubjectEvidence = 0;
  let ambiguousEvidence = 0;
  let otherSubjectEvidence = 0;

  for (const item of input.items) {
    const ref = refOf(item);
    const resolution = input.resolutionByRef.get(ref);
    const decision = resolution?.decision ?? "INSUFFICIENT_IDENTIFIERS";
    if (decision === "SUBJECT_MATCH") subjectMatchEvidence += 1;
    else if (decision === "LIKELY_SUBJECT") likelySubjectEvidence += 1;
    else if (decision === "AMBIGUOUS") ambiguousEvidence += 1;
    else if (decision === "OTHER_SUBJECT") otherSubjectEvidence += 1;

    // Multi-theme: evidence supports every distinct claim it matches;
    // duplicates of the same normalized claim within a theme collapse.
    // LIKELY/AMBIGUOUS without keyword hits still get a review theme so they
    // reach the matrix «Требует подтверждения» / appendix (§2.1).
    let themes = themesFor(item);
    if (
      themes.length === 0 &&
      (decision === "LIKELY_SUBJECT" || decision === "AMBIGUOUS")
    ) {
      const fallback = FINDING_THEMES.find((t) => t.themeId === "business_profile");
      if (fallback) themes = [fallback];
    }
    for (const theme of themes) {
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
    subjectMatch: "SUBJECT_MATCH" | "LIKELY_SUBJECT" | "AMBIGUOUS" | "OTHER_SUBJECT"
  ): Finding => {
    const theme = FINDING_THEMES.find((t) => t.themeId === themeId)!;
    const adverseItems = items.filter((i) => itemIsAdverse(i));
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
    if (subjectMatch === "LIKELY_SUBJECT") {
      limitations.push(
        "Принадлежность вероятна по фамилии и контексту, но не подтверждена однозначно — требуется проверка."
      );
    }
    for (const l of input.coverageLimitations ?? []) limitations.push(l);

    const sourceDiversity = Math.min(domains.length / 3, 1);
    const confidence =
      subjectMatch === "SUBJECT_MATCH"
        ? Math.min(0.55 + 0.3 * sourceDiversity + (adverseItems.length > 0 ? 0.05 : 0.1), 0.95)
        : subjectMatch === "LIKELY_SUBJECT"
          ? Math.min(0.45 + 0.2 * sourceDiversity, 0.7)
          : 0.35;

    const topTitles = items
      .slice(0, 3)
      .map((i) => String(i.title ?? "").trim())
      .filter(Boolean);

    // Client-grade claim: no theme echo (the theme label is prepended by
    // consumers), correct Russian plural forms, honest adverse share.
    const total = pluralRu(items.length, "публикация", "публикации", "публикаций");
    const adverseNote =
      adverseItems.length > 0
        ? `, из них с негативным содержанием — ${adverseItems.length}`
        : ", негативного содержания не зафиксировано";
    const claim =
      `${items.length} ${total}${adverseNote}. ` +
      `Источники: ${domains.slice(0, 4).join(", ") || "без URL"}.` +
      (topTitles.length ? ` Примеры заголовков: ${topTitles.join(" · ").slice(0, 380)}` : "");

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
      claim,
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
  const likelyFindings: Finding[] = [];
  const ambiguousFindings: Finding[] = [];
  const excludedFindings: Finding[] = [];

  for (const [key, items] of byDecisionTheme) {
    const [decision, themeId] = key.split("|");
    if (decision === "SUBJECT_MATCH") verified.push(makeFinding(themeId, items, "SUBJECT_MATCH"));
    else if (decision === "LIKELY_SUBJECT")
      likelyFindings.push(makeFinding(themeId, items, "LIKELY_SUBJECT"));
    else if (decision === "AMBIGUOUS") ambiguousFindings.push(makeFinding(themeId, items, "AMBIGUOUS"));
    else if (decision === "OTHER_SUBJECT") excludedFindings.push(makeFinding(themeId, items, "OTHER_SUBJECT"));
  }

  const sortByPriority = (a: Finding, b: Finding) => {
    const order: Record<string, number> = { P1: 0, P2: 1, P3: 2, APPENDIX: 3 };
    const d = (order[a.promotionPriority] ?? 9) - (order[b.promotionPriority] ?? 9);
    return d !== 0 ? d : a.findingId.localeCompare(b.findingId);
  };
  verified.sort(sortByPriority);
  likelyFindings.sort(sortByPriority);
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
    // KPI / confirmed evidence: SUBJECT_MATCH only (§2.1 invariant).
    evidenceRefs: verified.flatMap((f) => f.evidenceRefs),
    kpiEligibleSubjectMatches: ["SUBJECT_MATCH"],
    // LIKELY stays in the bundle for matrix «Требует подтверждения», not KPI.
    findings: [...verified, ...likelyFindings, ...excludedFindings],
    excludedFindingIds: excludedFindings.map((f) => f.findingId),
    exclusionReasons,
  });

  return {
    bundle,
    ambiguousFindings,
    themeAssignments,
    stats: {
      subjectMatchEvidence,
      likelySubjectEvidence,
      ambiguousEvidence,
      otherSubjectEvidence,
      adverseFindingCount: verified.filter((f) =>
        ["medium", "high", "critical"].includes(f.riskLevel)
      ).length,
    },
  };
}
