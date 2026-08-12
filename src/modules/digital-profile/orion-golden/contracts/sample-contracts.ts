/**
 * Minimal valid Stage-1 contract samples for offline schema tests.
 */

import type { AssembledDeckModel } from "./assembled-deck-model";
import type { CompositeDataset } from "./composite-dataset";
import type { ExecutiveSummary } from "./executive-summary";
import type { Finding } from "./finding";
import type { CanonicalClaimsBundle } from "./canonical-claim";
import type { ObservationDispositionLedger } from "./observation-disposition";
import type { ClientSummaryPack } from "./client-summary-pack";
import type { ComposedClientSummary } from "./composed-client-summary";
import type { RepresentativeEvidenceSelection } from "./representative-evidence";
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

export function sampleObservationDispositionLedger(): ObservationDispositionLedger {
  return {
    ...envelope,
    schemaVersion: "observation-disposition-ledger-v1",
    inventoryReportRunId: "base-run-1",
    rawObservationCount: 1,
    entries: [
      {
        rawObservationId: "inventory:obs-sample",
        normalizedObservationId: "q|YANDEX|RU|organic|example.com/a",
        disposition: "KEEP_PRIMARY",
        reasonCode: "finding:P1_P2_primary_evidence",
        subjectDecision: "SUBJECT_MATCH",
        confidence: 0.9,
        themeCandidates: ["criminal_legal"],
        materialitySignals: ["adverse_text", "theme:criminal_legal"],
        duplicateOf: null,
        duplicateGroupId: null,
        evidenceRefs: ["inventory:obs-sample", "searchResult:1"],
        provenance: {
          source: "serp_observation",
          provider: "yandex",
          reportRunId: "base-run-1",
          region: "RU",
          surface: "organic",
          observationKey: "q|YANDEX|RU|organic|example.com/a",
          sourceEvidenceRefs: ["searchResult:1"],
        },
        originalTitle: "Уголовное дело — sample",
        originalSnippet: "полный исходный сниппет без обрезки",
        fullTextRef: "url:https://example.com/a",
        decidedBy: {
          stage: "finding-synthesis",
          functionName: "synthesizeFindings",
        },
      },
    ],
    gates: {
      RAW_OBSERVATION_ACCOUNTING: 100,
      UNREASONED_DROPS: 0,
      P1_P2_SILENT_DROPS: 0,
      OTHER_SUBJECT_IN_SUBJECT_KPI: 0,
    },
  };
}

export function sampleCanonicalClaimsBundle(): CanonicalClaimsBundle {
  return {
    ...envelope,
    schemaVersion: "canonical-claims-v1",
    subjectId: "subject-sample",
    claims: [
      {
        claimId: "claim-sample-1",
        subjectId: "subject-sample",
        fullClaimText:
          "Найдены публикации о коррупционном расследовании: «Sample investigation» — источник news.example",
        displayExcerpt:
          "Найдены публикации о коррупционном расследовании: «Sample investigation» — источник news.example",
        claimKind: "SOURCE_ALLEGATION",
      evidenceTypes: ["search_result"],
        subjectMatch: "SUBJECT_MATCH",
        confidence: 0.85,
        themeIds: ["corruption_integrity", "political_public_exposure"],
        adverseType: "adverse_media_or_legal",
        materialityLevel: "HIGH",
        materialityReasons: ["theme_severity:corruption_integrity", "summary_override:corruption_integrity"],
        namedEntities: ["Sample investigation"],
        dates: ["2024"],
        regions: ["RU"],
        contradictions: [],
        evidenceRefs: ["inventory:obs-sample"],
        sourceDomains: ["news.example"],
        provenance: {
          providers: ["yandex"],
          reportRunIds: ["base-run-1"],
          findingIds: ["finding-political_exposure-subject_match-sample"],
        },
        originalTitle: "Sample investigation",
        originalFullTextRef: "url:https://news.example/a",
        clientQualification:
          "Публикация (news.example) содержит утверждения источника; подтверждение по первичным документам требуется. Наличие публикации не подтверждает изложенные обвинения.",
        recommendedAction: "Сверить с первоисточником.",
        dispositionRef: "inventory:obs-sample",
        summaryOverrideRequired: true,
      },
    ],
    gates: {
      CANONICAL_CLAIM_TRACE_COMPLETE: true,
      MATERIAL_ADVERSE_WITHOUT_THEME: 0,
      UNQUALIFIED_MEDIA_ALLEGATIONS: 0,
      SUBJECT_UNIVERSALITY_PASS: true,
    },
  };
}

export function sampleRepresentativeEvidenceSelection(): RepresentativeEvidenceSelection {
  return {
    ...envelope,
    schemaVersion: "representative-evidence-selection-v1",
    subjectId: "subject-sample",
    materialThemeIds: ["corruption_integrity", "political_public_exposure"],
    selectedByTheme: {
      corruption_integrity: [
        {
          claimId: "claim-sample-1",
          themeId: "corruption_integrity",
          rankInTheme: 1,
          originalTitle: "Sample investigation",
          sourceDomain: "news.example",
          displayExcerpt:
            "«Sample investigation» — источник news.example. Публикация связывает сюжет с вопросами этики.",
          fullClaimTextRef: "claim:claim-sample-1:fullClaimText",
          claimKind: "SOURCE_ALLEGATION",
          materialityLevel: "HIGH",
          evidenceRefs: ["inventory:obs-sample"],
          selectionReasons: ["coverage_theme:corruption_integrity"],
          plotKey: "plot-sample-1",
        },
      ],
      political_public_exposure: [
        {
          claimId: "claim-sample-1",
          themeId: "political_public_exposure",
          rankInTheme: 1,
          originalTitle: "Sample investigation",
          sourceDomain: "news.example",
          displayExcerpt:
            "«Sample investigation» — источник news.example. Публикация связывает сюжет с вопросами этики.",
          fullClaimTextRef: "claim:claim-sample-1:fullClaimText",
          claimKind: "SOURCE_ALLEGATION",
          materialityLevel: "HIGH",
          evidenceRefs: ["inventory:obs-sample"],
          selectionReasons: ["coverage_theme:political_public_exposure"],
          plotKey: "plot-sample-1",
        },
      ],
    },
    isolatedSignificantItems: [],
    p1p2Account: [
      {
        findingId: "finding-political_exposure-subject_match-sample",
        status: "IN_SUMMARY_SELECTION",
        reasonCode: "represented_via_selected_claim",
        claimIds: ["claim-sample-1"],
      },
    ],
    gates: {
      MATERIAL_THEME_COVERAGE: 100,
      P1_P2_ACCOUNTED: 100,
      SEMANTIC_EXCERPT_TRUNCATIONS: 0,
    },
  };
}

export function sampleClientSummaryPack(): ClientSummaryPack {
  return {
    ...envelope,
    schemaVersion: "client-summary-pack-v1",
    subjectId: "subject-sample",
    scope: {
      regions: ["RU", "UAE"],
      sourceClasses: ["поисковая выдача", "открытые СМИ"],
      surfaces: ["organic", "compliance"],
      searchDepthTopN: 20,
      period: { collectedLabel: "по дате сбора в кейсе", newestLabel: null },
      coverageLimitations: [],
    },
    overallAssessment: {
      riskLevel: "high",
      conclusion:
        "Итоговая оценка: высокий риск. Основные основания: Коррупционные и этические риски; Политические связи и публичная экспозиция.",
      reasons: ["Коррупционные и этические риски: Sample investigation"],
      limitations: [
        "Вывод основан на открытых источниках; первичные документы могут изменить оценку.",
      ],
      evidenceRefs: ["inventory:obs-sample"],
    },
    materialThemes: [
      {
        themeId: "corruption_integrity",
        clientTitle: "Коррупционные и этические риски",
        conclusion:
          "По теме «Коррупционные и этические риски» найдены конкретные материалы, в том числе «Sample investigation» (news.example).",
        concreteClaims: [
          "В выборке: «Sample investigation» (news.example). В материале сообщается о связанных с субъектом обстоятельствах.",
        ],
        representativeArticles: [
          {
            title: "Sample investigation",
            domain: "news.example",
            sourceDate: "2024",
            conciseCompleteDescription:
              "«Sample investigation» — источник news.example. Публикация связывает сюжет с вопросами этики.",
            sourceAllegationOrStatus:
              "В материале сообщается о связанных с субъектом обстоятельствах; утверждения источника не равны установленному факту.",
            evidenceRefs: ["inventory:obs-sample"],
            confidence: 0.85,
            materialityLevel: "HIGH",
            clientQualification:
              "Публикация (news.example) содержит утверждения источника; подтверждение по первичным документам требуется.",
            claimKind: "SOURCE_ALLEGATION",
          },
        ],
        whyItMatters:
          "Коррупционные и этические сюжеты повышают требования к проверке связей, конфликтов интересов и первичных документов.",
        qualification:
          "Публикация (news.example) содержит утверждения источника; подтверждение по первичным документам требуется.",
        recommendedChecks: ["Сверить первоисточники по теме."],
        materialityLevel: "HIGH",
        evidenceRefs: ["inventory:obs-sample"],
        sourceDomains: ["news.example"],
      },
    ],
    isolatedSignificantItems: [],
    internationalDatabases: [],
    changesSinceBaseline: {
      summary: "Сравнение с baseline отражено в отдельном отчёте об изменениях, если он доступен.",
      addedCount: null,
      removedCount: null,
    },
    nextSteps: ["Подготовить единый пакет документов для KYC."],
    trace: {
      claimIds: ["claim-sample-1"],
      findingIds: ["finding-political_exposure-subject_match-sample"],
      dispositionRefs: ["inventory:obs-sample"],
      representativeSelectionRef: "representative-evidence-selection.json",
      canonicalClaimsRef: "canonical-claims.json",
      p1p2Account: [],
    },
    gates: {
      CLIENT_SUMMARY_PACK_VALID: true,
      MATERIAL_THEMES_MISSING: 0,
      CLIENT_ASSERTIONS_WITHOUT_EVIDENCE: 0,
      INTERNAL_TOKENS_IN_CLIENT_FIELDS: 0,
    },
  };
}

export function sampleComposedClientSummary(): ComposedClientSummary {
  return {
    ...envelope,
    schemaVersion: "composed-client-summary-v1",
    subjectId: "subject-sample",
    fullText:
      "Итоговая оценка: высокий риск. Основные основания: Коррупционные и этические риски.\n\n" +
      "Исследованы поисковая выдача, открытые СМИ по регионам RU, UAE. Данные сформированы по дате сбора в кейсе.\n\n" +
      "Коротко по итогам аудита\n\n" +
      "Коррупционные и этические риски. По теме найдены конкретные материалы, в том числе «Sample investigation» (news.example). " +
      "«Sample investigation» — источник news.example. Публикация связывает сюжет с вопросами этики. " +
      "В материале сообщается о связанных с субъектом обстоятельствами; утверждения источника не равны установленному факту. " +
      "Коррупционные и этические сюжеты повышают требования к проверке связей. " +
      "Что проверить: Сверить первоисточники по теме. " +
      "Публикация (news.example) содержит утверждения источника; подтверждение по первичным документам требуется.\n\n" +
      "Единичные существенные публикации вне устойчивых тем в текущем наборе отдельно не выделены.\n\n" +
      "Отдельные подтверждённые карточки международных баз в клиентском резюме не сформированы либо требуют отдельной сверки.\n\n" +
      "Изменения относительно baseline. Сравнение с baseline отражено в отдельном отчёте об изменениях, если он доступен.\n\n" +
      "Следующие проверки. 1) Подготовить единый пакет документов для KYC.",
    sections: {
      scope:
        "Исследованы поисковая выдача, открытые СМИ по регионам RU, UAE. Данные сформированы по дате сбора в кейсе.",
      overallAssessment:
        "Итоговая оценка: высокий риск. Основные основания: Коррупционные и этические риски.",
      auditShortHeading: "Коротко по итогам аудита",
      themes: [
        {
          themeId: "corruption_integrity",
          heading: "Коррупционные и этические риски",
          body:
            "Коррупционные и этические риски. По теме найдены конкретные материалы, в том числе «Sample investigation» (news.example). " +
            "«Sample investigation» — источник news.example. Публикация связывает сюжет с вопросами этики. " +
            "В материале сообщается о связанных с субъектом обстоятельствами; утверждения источника не равны установленному факту. " +
            "Коррупционные и этические сюжеты повышают требования к проверке связей. " +
            "Что проверить: Сверить первоисточники по теме. " +
            "Публикация (news.example) содержит утверждения источника; подтверждение по первичным документам требуется.",
          materialityLevel: "HIGH",
          evidenceRefs: ["inventory:obs-sample"],
          articleTitles: ["Sample investigation"],
          articleDomains: ["news.example"],
        },
      ],
      isolatedItems:
        "Единичные существенные публикации вне устойчивых тем в текущем наборе отдельно не выделены.",
      internationalDatabases:
        "Отдельные подтверждённые карточки международных баз в клиентском резюме не сформированы либо требуют отдельной сверки.",
      changesSinceBaseline:
        "Изменения относительно baseline. Сравнение с baseline отражено в отдельном отчёте об изменениях, если он доступен.",
      nextSteps: "Следующие проверки. 1) Подготовить единый пакет документов для KYC.",
    },
    continuationThemeIds: [],
    gates: {
      SUMMARY_MATERIAL_THEME_COVERAGE: 100,
      SUMMARY_CONCRETE_EXAMPLES_PRESENT: true,
      SUMMARY_UNSUPPORTED_ASSERTIONS: 0,
      SUMMARY_TECHNICAL_COPY_TOKENS: 0,
      SUMMARY_INCOMPLETE_SENTENCES: 0,
    },
  };
}
