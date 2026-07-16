/**
 * Minimal valid Stage-1 contract samples for offline schema tests.
 */

import type { AssembledDeckModel } from "./assembled-deck-model";
import type { CompositeDataset } from "./composite-dataset";
import type { ExecutiveSummary } from "./executive-summary";
import type { Finding } from "./finding";
import type { SectionPack } from "./section-pack";
import type { SubjectResolution } from "./subject-resolution";
import type { SurfaceAnalysis } from "./surface-analysis";
import type { SurfaceFragment } from "./surface-fragment";
import type { VerifiedFindingBundle } from "./verified-finding-bundle";

const envelope = {
  caseId: "stage1-sample-case",
  datasetId: "stage1-sample-dataset",
  sourceHashes: ["sha256:sample-source"],
  evidenceRefs: ["evidence:sample-1"],
};

export function sampleCompositeDataset(): CompositeDataset {
  return {
    ...envelope,
    schemaVersion: "composite-dataset-v1",
    baseReportRunId: "base-run-1",
    enrichmentRunIds: ["enrich-run-1"],
    baseCount: 2,
    enrichmentCount: 1,
    compositeCount: 3,
    duplicateCount: 0,
    observations: [
      {
        observationKey: "obs-1",
        provider: "yandex",
        providers: ["yandex"],
        engine: "YANDEX",
        surface: "organic",
        region: "RU",
        url: "https://example.com/a",
        title: "Sample",
        domain: "example.com",
        evidenceRefs: ["evidence:sample-1"],
        provenanceOwner: "base",
      },
    ],
  };
}

export function sampleSubjectResolution(): SubjectResolution {
  return {
    ...envelope,
    schemaVersion: "subject-resolution-v1",
    subjectDisplayName: "Сергей Глинка",
    items: [
      {
        evidenceRef: "evidence:sample-1",
        decision: "SUBJECT_MATCH",
        confidence: 0.9,
        matchedIdentifiers: ["Сергей", "Глинка"],
        conflictingIdentifiers: [],
        reasonCode: "full_name_business_context",
      },
      {
        evidenceRef: "evidence:mikhail",
        decision: "OTHER_SUBJECT",
        confidence: 0.95,
        matchedIdentifiers: ["Глинка"],
        conflictingIdentifiers: ["Михаил", "композитор"],
        reasonCode: "composer_namesake",
        legacyBindingNote: "WRONG_SUBJECT",
      },
    ],
  };
}

export function sampleSurfaceAnalysis(): SurfaceAnalysis {
  return {
    ...envelope,
    schemaVersion: "surface-analysis-v1",
    units: [
      {
        surface: "organic",
        region: "RU",
        engine: "YANDEX",
        metrics: [
          { key: "resultCount", value: 10, sampleStatus: "MEASURED", denominator: 10 },
          { key: "adverseShare", value: 0.2, sampleStatus: "MEASURED", denominator: 10 },
        ],
        claims: [
          {
            claimId: "claim-1",
            text: "Business registry hit for subject",
            subjectMatch: "SUBJECT_MATCH",
            evidenceRefs: ["evidence:sample-1"],
          },
        ],
        evidenceRefs: ["evidence:sample-1"],
      },
    ],
  };
}

export function sampleFinding(): Finding {
  return {
    ...envelope,
    schemaVersion: "finding-v1",
    findingId: "finding-1",
    theme: "offshore",
    claim: "Possible offshore association",
    subjectMatch: "SUBJECT_MATCH",
    riskLevel: "medium",
    confidence: 0.7,
    regions: ["RU"],
    sourceDomains: ["example.com"],
    providers: ["yandex"],
    recommendedAction: "MANUAL_REVIEW",
    contradictions: [],
    limitations: ["Ownership structure not fully disclosed"],
    promotionPriority: "P2",
    surfaceKinds: ["organic"],
  };
}

export function sampleVerifiedFindingBundle(): VerifiedFindingBundle {
  const finding = sampleFinding();
  return {
    ...envelope,
    schemaVersion: "verified-finding-bundle-v1",
    kpiEligibleSubjectMatches: ["SUBJECT_MATCH"],
    findings: [finding],
    excludedFindingIds: ["finding-other"],
    exclusionReasons: { "finding-other": "OTHER_SUBJECT" },
  };
}

export function sampleExecutiveSummary(): ExecutiveSummary {
  return {
    ...envelope,
    schemaVersion: "executive-summary-v1",
    headline: "Sample executive headline",
    summaryParagraphs: ["Paragraph one."],
    keyFindingIds: ["finding-1"],
    overallRiskLevel: "medium",
    limitations: ["Coverage partial"],
    recommendedNextSteps: ["Review offshore claim"],
  };
}

export function sampleSectionPack(): SectionPack {
  return {
    ...envelope,
    schemaVersion: "section-pack-v1",
    sectionKey: "ru_audit_summary",
    title: "RU audit",
    findingIds: ["finding-1"],
    narrativeBullets: ["Bullet"],
    dataSufficiency: "PARTIAL",
    warnings: [],
  };
}

export function sampleSurfaceFragment(): SurfaceFragment {
  return {
    ...envelope,
    schemaVersion: "surface-fragment-v1",
    fragmentId: "frag-1",
    surface: "organic",
    region: "RU",
    slotHint: "serp-table",
    assetRefs: ["asset:serp-1"],
    findingIds: ["finding-1"],
    continuationOf: null,
  };
}

export function sampleAssembledDeckModel(): AssembledDeckModel {
  return {
    ...envelope,
    schemaVersion: "assembled-deck-model-v1",
    pageCount: 2,
    baseSlotCount: 1,
    continuationCount: 1,
    slides: [
      {
        slideId: "cover",
        pageNumber: 1,
        role: "cover",
        fragmentIds: [],
        findingIds: [],
        assetRefs: [],
        title: "Cover",
      },
      {
        slideId: "serp-cont-1",
        pageNumber: 2,
        role: "continuation",
        fragmentIds: ["frag-1"],
        findingIds: ["finding-1"],
        assetRefs: ["asset:serp-1"],
      },
    ],
    executiveSummaryRef: "executive-summary:sample",
    sectionPackRefs: ["section-pack:ru_audit_summary"],
  };
}
