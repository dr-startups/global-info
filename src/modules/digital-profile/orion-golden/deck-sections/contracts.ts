/**
 * Prompt 3 — independent report sections architecture.
 *
 * Level 1: report section packs (FRONT_MATTER, EXECUTIVE, RU_PROFILE,
 * UAE_PROFILE, COMPLIANCE, APPENDIX). Level 2: surface fragments inside
 * RU/UAE/EXECUTIVE. Every fragment/section is persisted independently and a
 * deterministic DeckAssembler concatenates validated packs into one deck.
 */

import { z } from "zod";

/** Current self-contained pack schema (carries explicit caseId/datasetId). */
export const SECTION_PACK_SCHEMA_VERSION = "section-pack-v3" as const;
/** Legacy pack schema (no caseId/datasetId) — accepted only by the offline migration. */
export const SECTION_PACK_V2_SCHEMA_VERSION = "section-pack-v2" as const;
export const SLIDE_CONTENT_SCHEMA_VERSION = "slide-content-v1" as const;
export const REPORT_SECTION_MANIFEST_VERSION = "report-section-manifest-v1" as const;
export const REPORT_DECK_MANIFEST_VERSION = "report-deck-manifest-v2" as const;

export const SectionTypeSchema = z.enum([
  "FRONT_MATTER",
  "EXECUTIVE",
  "RU_PROFILE",
  "UAE_PROFILE",
  "COMPLIANCE",
  "APPENDIX",
]);
export type SectionType = z.infer<typeof SectionTypeSchema>;

export const FragmentKeySchema = z.enum([
  // EXECUTIVE
  "EXECUTIVE_SUMMARY",
  "RISK_MATRIX",
  "DIGITAL_PROFILE_OVERVIEW",
  // RU_PROFILE
  "RU_SUMMARY",
  "RU_SERP",
  "RU_SERP_SCREENSHOT",
  "RU_SUGGESTIONS",
  "RU_IMAGES",
  "RU_IDENTITY_WIKIPEDIA",
  "RU_KNOWLEDGE_AI",
  "RU_RELATED",
  // UAE_PROFILE
  "UAE_SUMMARY",
  "UAE_SERP",
  "UAE_SERP_SCREENSHOT",
  "UAE_SUGGESTIONS",
  "UAE_IMAGES",
  "UAE_IDENTITY_WIKIPEDIA",
  "UAE_KNOWLEDGE_AI",
  "UAE_RELATED",
  // Single-fragment sections
  "FRONT_MATTER_MAIN",
  "COMPLIANCE_MAIN",
  "APPENDIX_MAIN",
]);
export type FragmentKey = z.infer<typeof FragmentKeySchema>;

export const SectionPackStatusSchema = z.enum([
  "READY",
  "EMPTY_VALID",
  "INSUFFICIENT_DATA",
  "FAILED",
]);
export type SectionPackStatus = z.infer<typeof SectionPackStatusSchema>;

/** Dynamic client content of a slide. Static framework text lives in templates. */
export const SlideBodySchema = z.object({
  narrative: z.string().optional(),
  bullets: z.array(z.string()).optional(),
  table: z
    .object({
      headers: z.array(z.string()),
      rows: z.array(z.array(z.string())),
    })
    .optional(),
  /** «Что обнаружено» — dynamic finding text under the static label. */
  whatWasFound: z.string().optional(),
  /** «Почему важно» — dynamic client impact under the static label. */
  whyItMatters: z.string().optional(),
  /** «Что проверить» — dynamic recommended action under the static label. */
  whatToCheck: z.string().optional(),
  /** «Источник» — dynamic provenance line under the static label. */
  sourceNote: z.string().optional(),
  /** Confidence/status line: confirmed theme vs preliminary signal + level. */
  statusNote: z.string().optional(),
  /**
   * Client-safe explanation for every red/adverse highlight visible on the
   * bound visual (SERP screenshots). Rendered in the adjacent analysis panel.
   */
  highlightExplanations: z
    .array(
      z.object({
        clientReason: z.string().min(1),
        frameTone: z.enum(["red", "amber"]),
      })
    )
    .optional(),
  /** KPI cards for dashboard layouts (label/value/tone; no coordinates). */
  kpis: z
    .array(
      z.object({
        label: z.string().min(1),
        value: z.string().min(1),
        tone: z.enum(["neutral", "risk", "warn", "good", "accent"]).optional(),
      })
    )
    .optional(),
});
export type SlideBody = z.infer<typeof SlideBodySchema>;

export const SlideContentContractSchema = z.object({
  schemaVersion: z.literal(SLIDE_CONTENT_SCHEMA_VERSION),
  slideId: z.string().min(1),
  baseSlotId: z.string().min(1),
  sectionId: z.string().min(1),

  isContinuation: z.boolean(),
  continuationOf: z.string().nullable(),
  continuationIndex: z.number().int().nonnegative().nullable(),

  templateId: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().optional(),

  content: SlideBodySchema,
  evidenceRefs: z.array(z.string()),
  findingIds: z.array(z.string()),
  metrics: z.record(z.string(), z.union([z.number(), z.string()])),

  /** Bound visual assets (typed refs into the existing report-assets store). */
  visualAssetRefs: z.array(z.string()),

  emptyStateReason: z.string().optional(),
});
export type SlideContentContract = z.infer<typeof SlideContentContractSchema>;

/**
 * Self-contained SectionPack (v3). Every pack carries its OWN lineage —
 * `caseId`, `datasetId`, `reportRunId`, `schemaVersion`, `contentHash` — and
 * its top-level `sourceFindingIds`/`evidenceRefs`. `caseId` is never inferred
 * from the dataset string or the owning manifest at assembly time.
 */
export const SectionPackV2Schema = z
  .object({
    schemaVersion: z.literal(SECTION_PACK_SCHEMA_VERSION),
    sectionId: z.string().min(1),
    sectionType: SectionTypeSchema,
    fragmentKey: FragmentKeySchema,
    caseId: z.string().min(1),
    datasetId: z.string().min(1),
    reportRunId: z.string().min(1),
    /** Retained alias of datasetId for lineage checks; must equal datasetId. */
    sourceDatasetId: z.string().min(1),
    contentVersion: z.string().min(1),
    promptVersion: z.string().min(1),
    /** Hash of generated slides content (reuse detection). */
    contentHash: z.string().min(1),
    /** Hash of scoped inputs (cache key together with promptVersion). */
    inputHash: z.string().min(1),
    generatedAt: z.string().min(1),

    required: z.boolean(),
    status: SectionPackStatusSchema,

    /** Explicit top-level scope (mirrors inputs.findingIds/evidenceRefs). */
    sourceFindingIds: z.array(z.string()),
    evidenceRefs: z.array(z.string()),

    inputs: z.object({
      findingIds: z.array(z.string()),
      evidenceRefs: z.array(z.string()),
      metricSnapshotId: z.string().min(1),
    }),

    slides: z.array(SlideContentContractSchema),

    metrics: z.object({
      datasetCount: z.number().int().nonnegative(),
      displayedCount: z.number().int().nonnegative(),
      adverseDatasetCount: z.number().int().nonnegative(),
      adverseDisplayedCount: z.number().int().nonnegative(),
    }),

    provenance: z.object({
      providers: z.array(z.string()),
      reportRunIds: z.array(z.string()),
      evidenceRefs: z.array(z.string()),
    }),

    validation: z.object({
      passed: z.boolean(),
      issues: z.array(z.string()),
    }),

    /** GPT client-copy layer marker (stage 2); absent on deterministic packs. */
    gptCopy: z
      .object({
        promptVersion: z.string().min(1),
        appliedSlides: z.number().int().nonnegative(),
      })
      .optional(),
  })
  .superRefine((pack, ctx) => {
    if (pack.datasetId !== pack.sourceDatasetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `datasetId !== sourceDatasetId (${pack.datasetId} != ${pack.sourceDatasetId})`,
      });
    }
    const sameSet = (a: string[], b: string[]): boolean =>
      a.length === b.length && new Set(a).size === new Set([...a, ...b]).size;
    if (!sameSet(pack.sourceFindingIds, pack.inputs.findingIds)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sourceFindingIds must equal inputs.findingIds",
      });
    }
    if (!sameSet(pack.evidenceRefs, pack.inputs.evidenceRefs)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "top-level evidenceRefs must equal inputs.evidenceRefs",
      });
    }
  });
export type SectionPackV2 = z.infer<typeof SectionPackV2Schema>;

/**
 * Legacy pack (v2, no caseId/datasetId/sourceFindingIds/evidenceRefs).
 * Recognized ONLY by the offline migration script — never accepted by
 * production build/assembly, which require v3 self-contained packs.
 */
export const LegacySectionPackV2Schema = z.object({
  schemaVersion: z.literal(SECTION_PACK_V2_SCHEMA_VERSION),
  sectionId: z.string().min(1),
  sectionType: SectionTypeSchema,
  fragmentKey: FragmentKeySchema,
  reportRunId: z.string().min(1),
  sourceDatasetId: z.string().min(1),
  contentVersion: z.string().min(1),
  promptVersion: z.string().min(1),
  contentHash: z.string().min(1),
  inputHash: z.string().min(1),
  generatedAt: z.string().min(1),
  required: z.boolean(),
  status: SectionPackStatusSchema,
  inputs: z.object({
    findingIds: z.array(z.string()),
    evidenceRefs: z.array(z.string()),
    metricSnapshotId: z.string().min(1),
  }),
  slides: z.array(SlideContentContractSchema),
  metrics: z.object({
    datasetCount: z.number().int().nonnegative(),
    displayedCount: z.number().int().nonnegative(),
    adverseDatasetCount: z.number().int().nonnegative(),
    adverseDisplayedCount: z.number().int().nonnegative(),
  }),
  provenance: z.object({
    providers: z.array(z.string()),
    reportRunIds: z.array(z.string()),
    evidenceRefs: z.array(z.string()),
  }),
  validation: z.object({
    passed: z.boolean(),
    issues: z.array(z.string()),
  }),
});
export type LegacySectionPackV2 = z.infer<typeof LegacySectionPackV2Schema>;

export const ManifestEntrySchema = z.object({
  order: z.number().int().positive(),
  sectionType: SectionTypeSchema,
  fragmentKey: FragmentKeySchema,
  artifactPath: z.string().min(1),
  required: z.boolean(),
  status: SectionPackStatusSchema,
  contentHash: z.string().min(1),
  slideCount: z.number().int().nonnegative(),
  validationPassed: z.boolean(),
});
export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const ReportSectionManifestSchema = z.object({
  schemaVersion: z.literal(REPORT_SECTION_MANIFEST_VERSION),
  caseId: z.string().min(1),
  reportRunId: z.string().min(1),
  sourceDatasetId: z.string().min(1),
  generatedAt: z.string().min(1),
  sectionOrder: z.array(SectionTypeSchema),
  entries: z.array(ManifestEntrySchema),
  requiredSectionsFailed: z.array(z.string()),
  buildBlocked: z.boolean(),
});
export type ReportSectionManifest = z.infer<typeof ReportSectionManifestSchema>;

/** Explicit accounting for every physical page in the assembled deck. */
export const PageKindSchema = z.enum(["canonical_base", "continuation", "optional_extra"]);
export type PageKind = z.infer<typeof PageKindSchema>;

export const DeckSlideRefSchema = z.object({
  slideId: z.string().min(1),
  baseSlotId: z.string().min(1),
  sectionId: z.string().min(1),
  sectionType: SectionTypeSchema,
  templateId: z.string().min(1),
  title: z.string().min(1),
  pageNumber: z.number().int().positive(),
  isContinuation: z.boolean(),
  continuationOf: z.string().nullable(),
  pageKind: PageKindSchema,
  /** Required for optional_extra pages: why this page exists outside 36+N. */
  pageKindReason: z.string().optional(),
});
export type DeckSlideRef = z.infer<typeof DeckSlideRefSchema>;

export const ReportDeckManifestSchema = z.object({
  schemaVersion: z.literal(REPORT_DECK_MANIFEST_VERSION),
  caseId: z.string().min(1),
  reportRunId: z.string().min(1),
  sourceDatasetId: z.string().min(1),
  generatedAt: z.string().min(1),
  pageCount: z.number().int().nonnegative(),
  baseSlotCount: z.number().int().nonnegative(),
  /** How many of the 36 canonical First36 base slots are present. */
  baseSlotCoverage: z.number().int().nonnegative(),
  continuationCount: z.number().int().nonnegative(),
  sectionPageRanges: z.array(
    z.object({
      sectionType: SectionTypeSchema,
      title: z.string().min(1),
      firstPage: z.number().int().positive(),
      lastPage: z.number().int().positive(),
    })
  ),
  toc: z.array(z.object({ title: z.string().min(1), pageNumber: z.number().int().positive() })),
  slides: z.array(DeckSlideRefSchema),
  /**
   * Every page outside "36 canonical base slots + continuations" must be
   * accounted for here with an explicit kind, owner SectionPack and reason.
   */
  nonCanonicalPages: z.array(
    z.object({
      slideId: z.string().min(1),
      pageNumber: z.number().int().positive(),
      pageKind: PageKindSchema,
      ownerFragment: z.string().min(1),
      ownerSection: SectionTypeSchema,
      reason: z.string().min(1),
    })
  ),
  /** Canonical slots covered via an explicit merge into another slot. */
  mergedSlots: z.array(
    z.object({
      baseSlotId: z.string().min(1),
      mergedInto: z.string().min(1),
      reason: z.string().min(1),
    })
  ),
  sectionContentHashes: z.record(z.string(), z.string()),
  assembledDeckHash: z.string().min(1),
});
export type ReportDeckManifest = z.infer<typeof ReportDeckManifestSchema>;

/** Fragment keys per section, in deck order. */
export const SECTION_FRAGMENTS: Record<SectionType, FragmentKey[]> = {
  FRONT_MATTER: ["FRONT_MATTER_MAIN"],
  EXECUTIVE: ["EXECUTIVE_SUMMARY", "RISK_MATRIX", "DIGITAL_PROFILE_OVERVIEW"],
  RU_PROFILE: [
    "RU_SUMMARY",
    "RU_SERP",
    "RU_SERP_SCREENSHOT",
    "RU_SUGGESTIONS",
    "RU_IMAGES",
    "RU_IDENTITY_WIKIPEDIA",
    "RU_KNOWLEDGE_AI",
    "RU_RELATED",
  ],
  UAE_PROFILE: [
    "UAE_SUMMARY",
    "UAE_SERP",
    "UAE_SERP_SCREENSHOT",
    "UAE_SUGGESTIONS",
    "UAE_IMAGES",
    "UAE_IDENTITY_WIKIPEDIA",
    "UAE_KNOWLEDGE_AI",
    "UAE_RELATED",
  ],
  COMPLIANCE: ["COMPLIANCE_MAIN"],
  APPENDIX: ["APPENDIX_MAIN"],
};

export const DEFAULT_SECTION_ORDER: SectionType[] = [
  "FRONT_MATTER",
  "EXECUTIVE",
  "RU_PROFILE",
  "UAE_PROFILE",
  "COMPLIANCE",
  "APPENDIX",
];

export const REQUIRED_SECTIONS: SectionType[] = [
  "FRONT_MATTER",
  "EXECUTIVE",
  "RU_PROFILE",
  "UAE_PROFILE",
  "COMPLIANCE",
];

export const SECTION_TITLES: Record<SectionType, string> = {
  FRONT_MATTER: "Титульный раздел",
  EXECUTIVE: "Резюме для руководства",
  RU_PROFILE: "Цифровой профиль — Россия",
  UAE_PROFILE: "Цифровой профиль — ОАЭ и международный контур",
  COMPLIANCE: "Комплаенс-проверка",
  APPENDIX: "Приложение",
};

/** Artifact relative paths per fragment (section-packs/...). */
export const FRAGMENT_ARTIFACT_PATHS: Record<FragmentKey, string> = {
  FRONT_MATTER_MAIN: "section-packs/front-matter.json",
  EXECUTIVE_SUMMARY: "section-packs/executive/summary.json",
  RISK_MATRIX: "section-packs/executive/risk-matrix.json",
  DIGITAL_PROFILE_OVERVIEW: "section-packs/executive/overview.json",
  RU_SUMMARY: "section-packs/ru/summary.json",
  RU_SERP: "section-packs/ru/serp.json",
  RU_SERP_SCREENSHOT: "section-packs/ru/serp-screenshot.json",
  RU_SUGGESTIONS: "section-packs/ru/suggestions.json",
  RU_IMAGES: "section-packs/ru/images.json",
  RU_IDENTITY_WIKIPEDIA: "section-packs/ru/identity.json",
  RU_KNOWLEDGE_AI: "section-packs/ru/ai.json",
  RU_RELATED: "section-packs/ru/related.json",
  UAE_SUMMARY: "section-packs/uae/summary.json",
  UAE_SERP: "section-packs/uae/serp.json",
  UAE_SERP_SCREENSHOT: "section-packs/uae/serp-screenshot.json",
  UAE_SUGGESTIONS: "section-packs/uae/suggestions.json",
  UAE_IMAGES: "section-packs/uae/images.json",
  UAE_IDENTITY_WIKIPEDIA: "section-packs/uae/identity.json",
  UAE_KNOWLEDGE_AI: "section-packs/uae/ai.json",
  UAE_RELATED: "section-packs/uae/related.json",
  COMPLIANCE_MAIN: "section-packs/compliance.json",
  APPENDIX_MAIN: "section-packs/appendix.json",
};
