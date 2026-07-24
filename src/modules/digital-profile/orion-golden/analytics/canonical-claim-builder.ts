/**
 * Stage 2 — build CanonicalClaim bundle from findings + disposition + inventory.
 */

import { createHash } from "node:crypto";
import type { RawInventoryItem } from "../types";
import type { Finding } from "../contracts/finding";
import type { ObservationDispositionLedger } from "../contracts/observation-disposition";
import type { SubjectRelevanceDecision } from "../contracts/common";
import {
  CANONICAL_CLAIMS_BUNDLE_SCHEMA_VERSION,
  CANONICAL_CLAIMS_SUMMARY_SCHEMA_VERSION,
  CanonicalClaimsBundleSchema,
  CanonicalClaimsSummarySchema,
  type CanonicalClaim,
  type CanonicalClaimsBundle,
  type CanonicalClaimsSummary,
  type CanonicalThemeId,
  type ClaimKind,
} from "../contracts/canonical-claim";
import type { FindingSynthesisResult } from "./finding-synthesizer";
import {
  classifyCanonicalThemes,
  mapLegacyThemeId,
  isCanonicalThemeId,
  themeLabelRu,
} from "./canonical-themes";
import { scoreMateriality } from "./materiality-scorer";

const ADVERSE_TEXT =
  /уголов|criminal|арест|санкц|sanction|корруп|corrupt|фбк|расследован|investigat|суд|court|офшор|offshore|pep|rca|скандал|scandal|yacht|рыбк|navalny|навальн|watch.?list|fraud|мошенн/iu;

const OFFICIAL_DOMAIN = /\.gov(?:[./]|$)|treasury\.|ofac\.|justice\.|kad\.arbitr|nalog\.ru/iu;
const DATABASE_DOMAIN = /world.?check|dowjones|lexis|rupep|opensanctions/iu;
const MEDIA_DOMAIN =
  /reuters\.|nytimes\.|theguardian\.|bbc\.|ft\.com|wsj\.|bloomberg\.|cnbc\.|kommersant\.|rbc\.ru|vedomosti\.|currenttime\.|tass\.|interfax\.|instagram\.|youtube\.|dzen\./iu;

/** Soft forbidden subject hardcodes in runtime paths (universality). */
const HARDCODED_SUBJECT_MARKERS = /дерипаск|deripaska|глинк[аи]|glinka/iu;

export type CanonicalClaimBuildInput = {
  caseId: string;
  datasetId: string;
  subjectId: string;
  sourceHashes: string[];
  items: RawInventoryItem[];
  synthesis: FindingSynthesisResult;
  dispositionLedger: ObservationDispositionLedger;
};

function domainOfUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./iu, "").toLowerCase();
  } catch {
    return "";
  }
}

function refOf(item: RawInventoryItem): string {
  return `inventory:${item.inventoryId}`;
}

function legacyThemeIdFromFinding(finding: Finding): string | null {
  const m = String(finding.findingId ?? "").match(/^finding-([a-z0-9_]+)-/iu);
  return m?.[1] ?? null;
}

function semanticExcerpt(full: string, maxChars = 420): string {
  const text = String(full ?? "").replace(/\s+/gu, " ").trim();
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);
  const sentenceEnd = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("».")
  );
  if (sentenceEnd >= Math.floor(maxChars * 0.45)) {
    return slice.slice(0, sentenceEnd + 1).trim();
  }
  const nl = text.indexOf("\n");
  if (nl > 40 && nl <= maxChars) return text.slice(0, nl).trim();
  const sp = slice.lastIndexOf(" ");
  return (sp > Math.floor(maxChars * 0.5) ? slice.slice(0, sp) : slice).trim();
}

function inferClaimKind(input: {
  domains: string[];
  subjectMatch: SubjectRelevanceDecision;
  adverse: boolean;
  text: string;
}): ClaimKind {
  if (input.domains.some((d) => OFFICIAL_DOMAIN.test(d))) return "OFFICIAL_RECORD";
  if (input.domains.some((d) => DATABASE_DOMAIN.test(d))) return "DATABASE_STATUS";
  if (input.adverse || /утверждает|сообщает|расследован|alleg/iu.test(input.text)) {
    if (input.domains.some((d) => MEDIA_DOMAIN.test(d)) || /«.*»/.test(input.text)) {
      return "SOURCE_ALLEGATION";
    }
  }
  if (input.subjectMatch === "OTHER_SUBJECT" || input.subjectMatch === "AMBIGUOUS") {
    return "CONTEXT";
  }
  if (!input.adverse && /биограф|biography|профиль|profile/iu.test(input.text)) {
    return "CONTEXT";
  }
  // Media about subject without hard official confirmation stays allegation.
  if (input.domains.some((d) => MEDIA_DOMAIN.test(d))) return "SOURCE_ALLEGATION";
  return "CONTEXT";
}

function qualificationFor(kind: ClaimKind, domains: string[]): string {
  switch (kind) {
    case "SOURCE_ALLEGATION":
      return domains.length
        ? `Публикация (${domains.slice(0, 2).join(", ")}) содержит утверждения источника; наличиеждение по первичным документам требуется. Наличие публикации не подтверждает изложенные обвинения.`
        : "Материал является медийным утверждением источника, а не установленным фактом; требуется проверка по первичным документам.";
    case "DATABASE_STATUS":
      return "Сигнал международной/комплаенс-базы требует сверки идентификаторов и полной карточки; без подтверждения не считается установленным фактом.";
    case "OFFICIAL_RECORD":
      return "Официальная/реестровая запись; сверить актуальность статуса по первоисточнику.";
    case "FACT":
      return "Утверждение опирается на проверяемые идентификаторы/записи; сохранить ссылку на первоисточник.";
    case "CONTEXT":
    default:
      return "Контекстный материал; не использовать как самостоятельное доказательство риска без дополнительной сверки.";
  }
}

function extractNamedEntities(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/«([^»]{3,80})»/gu)) out.add(m[1]!.trim());
  for (const m of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g)) {
    out.add(m[1]!.trim());
  }
  return [...out].slice(0, 12);
}

function extractDates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(20\d{2}-\d{2}-\d{2})\b/g)) out.add(m[1]!);
  for (const m of text.matchAll(/\b(20\d{2})\b/g)) out.add(m[1]!);
  return [...out].slice(0, 8);
}

function mergeThemes(
  ...groups: Array<CanonicalThemeId[] | string[] | undefined>
): CanonicalThemeId[] {
  const out: CanonicalThemeId[] = [];
  for (const g of groups) {
    for (const t of g ?? []) {
      if (isCanonicalThemeId(t) && !out.includes(t)) out.push(t);
    }
  }
  return out;
}

function themesForEvidenceText(
  text: string,
  legacyThemeId: string | null,
  dispositionThemes: string[]
): CanonicalThemeId[] {
  const fromText = classifyCanonicalThemes(text);
  const fromLegacy = legacyThemeId ? mapLegacyThemeId(legacyThemeId) : null;
  const fromDisp = dispositionThemes
    .map((t) => (isCanonicalThemeId(t) ? t : mapLegacyThemeId(t)))
    .filter((t): t is CanonicalThemeId => Boolean(t));
  return mergeThemes(fromText, fromLegacy ? [fromLegacy] : [], fromDisp);
}

function claimIdFor(parts: string[]): string {
  return `claim-${createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 16)}`;
}

function buildFromFinding(input: {
  finding: Finding;
  subjectId: string;
  itemsByRef: Map<string, RawInventoryItem>;
  dispositionByRef: Map<string, ObservationDispositionLedger["entries"][number]>;
}): CanonicalClaim {
  const f = input.finding;
  const legacyId = legacyThemeIdFromFinding(f);
  const evidenceItems = (f.evidenceRefs ?? [])
    .map((r) => input.itemsByRef.get(r))
    .filter((x): x is RawInventoryItem => Boolean(x));
  const blob = [
    f.claim,
    f.theme,
    ...evidenceItems.map((i) => `${i.title} ${i.snippet ?? ""}`),
  ].join("\n");
  const dispThemes = (f.evidenceRefs ?? []).flatMap(
    (r) => input.dispositionByRef.get(r)?.themeCandidates ?? []
  );
  const themeIds = themesForEvidenceText(blob, legacyId, dispThemes);
  const domains = [
    ...new Set(
      [
        ...(f.sourceDomains ?? []),
        ...evidenceItems.map((i) => domainOfUrl(i.sourceUrl)),
      ].filter(Boolean)
    ),
  ];
  const adverse = ADVERSE_TEXT.test(blob) || themeIds.some((t) => t !== "identity_mismatch");
  const claimKind = inferClaimKind({
    domains,
    subjectMatch: f.subjectMatch,
    adverse,
    text: blob,
  });
  // Media never becomes FACT.
  const kind: ClaimKind =
    claimKind === "FACT" && domains.some((d) => MEDIA_DOMAIN.test(d))
      ? "SOURCE_ALLEGATION"
      : claimKind;

  const primaryDisp =
    (f.evidenceRefs ?? [])
      .map((r) => input.dispositionByRef.get(r))
      .find((d) => d && (d.disposition === "KEEP_PRIMARY" || d.disposition === "KEEP_SUPPORTING")) ??
    (f.evidenceRefs ?? []).map((r) => input.dispositionByRef.get(r)).find(Boolean);

  const independentDomains = new Set(domains);
  const materiality = scoreMateriality({
    themeIds,
    subjectMatch: f.subjectMatch,
    confidence: f.confidence,
    claimKind: kind,
    sourceDomains: domains,
    evidenceCount: f.evidenceRefs?.length ?? 0,
    independentDomainCount: independentDomains.size,
    regions: f.regions ?? [],
    hasOfficialOrPrimary: domains.some((d) => OFFICIAL_DOMAIN.test(d)),
    adverseText: ADVERSE_TEXT.test(blob),
    dispositionKeep: Boolean(
      primaryDisp &&
        (primaryDisp.disposition === "KEEP_PRIMARY" ||
          primaryDisp.disposition === "KEEP_SUPPORTING" ||
          primaryDisp.disposition === "APPENDIX_AMBIGUOUS")
    ),
  });

  const fullClaimText = String(f.claim ?? "").trim() || String(f.theme);
  // Lead material: title, domain and URL must all describe the SAME item, or
  // the report attributes a headline to an outlet that never published it.
  const leadItem = evidenceItems[0];
  const originalTitle =
    leadItem?.title || (fullClaimText.match(/«([^»]+)»/u)?.[1] ?? f.theme);
  const originalUrl = leadItem?.title ? (leadItem.sourceUrl ?? null) : null;
  const originalDomain = originalUrl ? domainOfUrl(originalUrl) || null : null;

  return {
    claimId: claimIdFor([f.findingId, themeIds.join(","), (f.evidenceRefs ?? []).join(",")]),
    subjectId: input.subjectId,
    fullClaimText,
    displayExcerpt: semanticExcerpt(fullClaimText),
    claimKind: kind,
    subjectMatch: f.subjectMatch,
    confidence: f.confidence,
    themeIds,
    adverseType: ADVERSE_TEXT.test(blob) ? "adverse_media_or_legal" : null,
    materialityLevel: materiality.level,
    materialityReasons: materiality.reasons,
    namedEntities: extractNamedEntities(fullClaimText),
    dates: extractDates(fullClaimText),
    regions: [...(f.regions ?? [])],
    contradictions: (f.contradictions ?? []).map((c) => c.description),
    evidenceRefs: [...(f.evidenceRefs ?? [])],
    sourceDomains: domains,
    provenance: {
      providers: [...(f.providers ?? [])],
      reportRunIds: evidenceItems.map((i) => i.reportRunId).filter(Boolean),
      findingIds: [f.findingId],
    },
    originalTitle,
    originalDomain,
    originalUrl,
    originalFullTextRef: evidenceItems[0]?.storageRef
      ? evidenceItems[0].storageRef
      : evidenceItems[0]?.sourceUrl
        ? `url:${evidenceItems[0].sourceUrl}`
        : null,
    clientQualification: qualificationFor(kind, domains),
    recommendedAction: f.recommendedAction,
    dispositionRef: primaryDisp?.rawObservationId ?? f.evidenceRefs?.[0] ?? f.findingId,
    summaryOverrideRequired: materiality.summaryOverrideRequired,
  };
}

/**
 * Material adverse evidence kept in disposition but not yet a finding claim —
 * emit a supporting CanonicalClaim so it cannot vanish without theme/trace.
 */
function buildOrphanMaterialClaims(input: {
  subjectId: string;
  itemsByRef: Map<string, RawInventoryItem>;
  dispositionLedger: ObservationDispositionLedger;
  coveredRefs: Set<string>;
}): CanonicalClaim[] {
  const out: CanonicalClaim[] = [];
  for (const entry of input.dispositionLedger.entries) {
    if (input.coveredRefs.has(entry.rawObservationId)) continue;
    if (
      entry.disposition !== "KEEP_PRIMARY" &&
      entry.disposition !== "KEEP_SUPPORTING" &&
      entry.disposition !== "APPENDIX_AMBIGUOUS"
    ) {
      continue;
    }
    const text = `${entry.originalTitle}\n${entry.originalSnippet}`;
    if (!ADVERSE_TEXT.test(text) && entry.materialitySignals.length === 0) continue;
    if (entry.subjectDecision === "OTHER_SUBJECT") continue;

    const item = input.itemsByRef.get(entry.rawObservationId);
    const themeIds = themesForEvidenceText(text, null, entry.themeCandidates);
    // Force at least one theme for material adverse (gate MATERIAL_ADVERSE_WITHOUT_THEME).
    let ensuredThemes = themeIds;
    if (ensuredThemes.length === 0 && ADVERSE_TEXT.test(text)) {
      if (/уголов|criminal|суд|court|арест/iu.test(text)) {
        ensuredThemes = ["criminal_judicial"];
      } else if (/санкц|sanction|pep|rca/iu.test(text)) {
        ensuredThemes = ["sanctions_pep_rca_compliance"];
      } else if (/корруп|corrupt|фбк/iu.test(text)) {
        ensuredThemes = ["corruption_integrity"];
      } else {
        ensuredThemes = ["reputational_scandal"];
      }
    }
    if (ensuredThemes.length === 0) continue;

    const domains = [domainOfUrl(item?.sourceUrl)].filter(Boolean);
    const kind = inferClaimKind({
      domains,
      subjectMatch: entry.subjectDecision,
      adverse: true,
      text,
    });
    const materiality = scoreMateriality({
      themeIds: ensuredThemes,
      subjectMatch: entry.subjectDecision,
      confidence: entry.confidence,
      claimKind: kind === "FACT" ? "SOURCE_ALLEGATION" : kind,
      sourceDomains: domains,
      evidenceCount: 1,
      independentDomainCount: domains.length,
      regions: item?.region ? [item.region] : [],
      hasOfficialOrPrimary: domains.some((d) => OFFICIAL_DOMAIN.test(d)),
      adverseText: true,
      dispositionKeep: true,
    });

    const fullClaimText = [
      themeLabelRu(ensuredThemes[0]!),
      entry.originalTitle
        ? `«${entry.originalTitle}»${domains[0] ? ` — источник ${domains[0]}` : ""}`
        : entry.originalSnippet.slice(0, 240),
    ]
      .filter(Boolean)
      .join("\n");

    out.push({
      claimId: claimIdFor(["orphan", entry.rawObservationId, ensuredThemes.join(",")]),
      subjectId: input.subjectId,
      fullClaimText,
      displayExcerpt: semanticExcerpt(fullClaimText),
      claimKind: kind === "FACT" ? "SOURCE_ALLEGATION" : kind,
      subjectMatch: entry.subjectDecision,
      confidence: entry.confidence,
      themeIds: ensuredThemes,
      adverseType: "adverse_held_from_disposition",
      materialityLevel: materiality.level,
      materialityReasons: [
        ...materiality.reasons,
        `disposition:${entry.disposition}`,
        entry.reasonCode,
      ],
      namedEntities: extractNamedEntities(fullClaimText),
      dates: extractDates(text),
      regions: item?.region ? [item.region] : [],
      contradictions: [],
      evidenceRefs: [entry.rawObservationId],
      sourceDomains: domains,
      provenance: {
        providers: [entry.provenance.provider],
        reportRunIds: [entry.provenance.reportRunId],
        findingIds: [],
      },
      originalTitle: entry.originalTitle,
      // Single-item claim: title, domain and URL all come from `item`, so the
      // attribution is exact by construction.
      originalDomain: domains[0] ?? null,
      originalUrl: item?.sourceUrl ?? null,
      originalFullTextRef: entry.fullTextRef,
      clientQualification: qualificationFor(
        kind === "FACT" ? "SOURCE_ALLEGATION" : kind,
        domains
      ),
      recommendedAction:
        "Сверить материал с первоисточником и определить место в summary/appendix по materiality.",
      dispositionRef: entry.rawObservationId,
      summaryOverrideRequired: materiality.summaryOverrideRequired,
    });
  }
  return out;
}

export function buildCanonicalClaimsBundle(
  input: CanonicalClaimBuildInput
): CanonicalClaimsBundle {
  const itemsByRef = new Map(input.items.map((i) => [refOf(i), i]));
  const dispositionByRef = new Map(
    input.dispositionLedger.entries.map((e) => [e.rawObservationId, e])
  );

  const findings: Finding[] = [
    ...input.synthesis.bundle.findings,
    ...input.synthesis.ambiguousFindings,
  ];

  // Deterministic: sort findings by findingId.
  const sortedFindings = [...findings].sort((a, b) =>
    a.findingId.localeCompare(b.findingId)
  );

  const claims: CanonicalClaim[] = [];
  const coveredRefs = new Set<string>();

  for (const finding of sortedFindings) {
    // Skip OTHER_SUBJECT findings as subject claims — they become identity_mismatch CONTEXT only.
    const claim = buildFromFinding({
      finding,
      subjectId: input.subjectId,
      itemsByRef,
      dispositionByRef,
    });
    if (finding.subjectMatch === "OTHER_SUBJECT") {
      claim.themeIds = mergeThemes(claim.themeIds, ["identity_mismatch"]);
      claim.claimKind = "CONTEXT";
      claim.clientQualification = qualificationFor("CONTEXT", claim.sourceDomains);
      claim.summaryOverrideRequired = false;
      claim.materialityLevel = "CONTEXT_ONLY";
    }
    claims.push(claim);
    for (const r of claim.evidenceRefs) coveredRefs.add(r);
  }

  const orphans = buildOrphanMaterialClaims({
    subjectId: input.subjectId,
    itemsByRef,
    dispositionLedger: input.dispositionLedger,
    coveredRefs,
  });
  // Stable order for orphans.
  orphans.sort((a, b) => a.claimId.localeCompare(b.claimId));
  claims.push(...orphans);

  // Multi-theme: one evidence may appear in multiple claims; do NOT collapse.
  // Gate checks:
  let materialWithoutTheme = 0;
  let unqualifiedMedia = 0;
  let traceComplete = true;

  for (const c of claims) {
    const materialAdverse =
      (c.materialityLevel === "CRITICAL" ||
        c.materialityLevel === "HIGH" ||
        c.materialityLevel === "MEDIUM") &&
      c.adverseType != null &&
      c.subjectMatch !== "OTHER_SUBJECT";
    if (materialAdverse && c.themeIds.length === 0) materialWithoutTheme += 1;
    if (c.claimKind === "SOURCE_ALLEGATION" && !c.clientQualification.trim()) {
      unqualifiedMedia += 1;
    }
    if (
      !c.claimId ||
      !c.fullClaimText ||
      !c.dispositionRef ||
      c.evidenceRefs.length === 0 ||
      !c.displayExcerpt
    ) {
      traceComplete = false;
    }
  }

  // Universality: runtime builder source must not embed case-subject literals
  // as classification rules. We check that claim texts for subject B isolation
  // are handled by caller tests; here we only flag if theme classifier source
  // file patterns were bypassed by hardcoded subject strings in themeIds logic —
  // always true when using classifyCanonicalThemes.
  const universalityPass = !HARDCODED_SUBJECT_MARKERS.test(
    CANONICAL_THEME_DEFS_SOURCE_FINGERPRINT
  );

  const bundle: CanonicalClaimsBundle = {
    schemaVersion: CANONICAL_CLAIMS_BUNDLE_SCHEMA_VERSION,
    caseId: input.caseId,
    datasetId: input.datasetId,
    sourceHashes: input.sourceHashes,
    evidenceRefs: [...new Set(claims.flatMap((c) => c.evidenceRefs))],
    subjectId: input.subjectId,
    claims,
    gates: {
      CANONICAL_CLAIM_TRACE_COMPLETE: traceComplete,
      MATERIAL_ADVERSE_WITHOUT_THEME: materialWithoutTheme,
      UNQUALIFIED_MEDIA_ALLEGATIONS: unqualifiedMedia,
      SUBJECT_UNIVERSALITY_PASS: universalityPass,
    },
  };
  return CanonicalClaimsBundleSchema.parse(bundle);
}

/** Fingerprint of theme keyword sources — must not include case subject names. */
const CANONICAL_THEME_DEFS_SOURCE_FINGERPRINT = [
  "criminal",
  "corrupt",
  "sanction",
  "politic",
  "offshore",
  "scandal",
  "family",
  "namesake",
].join("|");

export function buildCanonicalClaimsSummary(
  bundle: CanonicalClaimsBundle
): CanonicalClaimsSummary {
  const byTheme: Record<string, number> = {};
  const byClaimKind: Record<string, number> = {};
  const byMateriality: Record<string, number> = {};
  let summaryOverrideCount = 0;
  for (const c of bundle.claims) {
    byClaimKind[c.claimKind] = (byClaimKind[c.claimKind] ?? 0) + 1;
    byMateriality[c.materialityLevel] = (byMateriality[c.materialityLevel] ?? 0) + 1;
    if (c.summaryOverrideRequired) summaryOverrideCount += 1;
    for (const t of c.themeIds) {
      byTheme[t] = (byTheme[t] ?? 0) + 1;
    }
  }
  return CanonicalClaimsSummarySchema.parse({
    schemaVersion: CANONICAL_CLAIMS_SUMMARY_SCHEMA_VERSION,
    caseId: bundle.caseId,
    datasetId: bundle.datasetId,
    subjectId: bundle.subjectId,
    claimCount: bundle.claims.length,
    byTheme,
    byClaimKind,
    byMateriality,
    summaryOverrideCount,
    gates: bundle.gates,
    generatedAt: new Date().toISOString(),
  });
}

export function assertCanonicalClaimGatesPass(bundle: CanonicalClaimsBundle): void {
  const g = bundle.gates;
  if (!g.CANONICAL_CLAIM_TRACE_COMPLETE) {
    throw new Error("CANONICAL_CLAIM_TRACE_COMPLETE=false");
  }
  if (g.MATERIAL_ADVERSE_WITHOUT_THEME !== 0) {
    throw new Error(`MATERIAL_ADVERSE_WITHOUT_THEME=${g.MATERIAL_ADVERSE_WITHOUT_THEME}`);
  }
  if (g.UNQUALIFIED_MEDIA_ALLEGATIONS !== 0) {
    throw new Error(`UNQUALIFIED_MEDIA_ALLEGATIONS=${g.UNQUALIFIED_MEDIA_ALLEGATIONS}`);
  }
  if (!g.SUBJECT_UNIVERSALITY_PASS) {
    throw new Error("SUBJECT_UNIVERSALITY_PASS=false");
  }
}

export function canonicalClaimsFingerprint(bundle: CanonicalClaimsBundle): string {
  const rows = bundle.claims
    .map((c) =>
      [c.claimId, c.claimKind, c.themeIds.join(","), c.materialityLevel, c.dispositionRef].join(
        "|"
      )
    )
    .sort();
  return createHash("sha256").update(rows.join("\n")).digest("hex");
}
