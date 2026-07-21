/**
 * Orchestrates the independent-section deck build:
 * SectionPacks (independent, cached) → report-section-manifest →
 * DeckAssembler → unified slide model → validation reports.
 *
 * Persistence layout matches the required artifact tree (section-packs/...).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FragmentKey, ReportDeckManifest, ReportSectionManifest, SectionPackV2 } from "./contracts";
import { FRAGMENT_ARTIFACT_PATHS, SectionPackV2Schema } from "./contracts";
import { buildAllSections, type SectionBuildContext } from "./section-builders";
import { validateSectionPack, type SectionValidationReport } from "./section-validation";
import { buildReportSectionManifest } from "./section-manifest";
import { assembleDeck, type DeckAssemblyResult, type RendererSlide } from "./deck-assembler";
import { validateAssembly, type AssemblyValidationReport } from "./assembly-validation";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import { getClientTextContract } from "../client/load-client-text-contract";

export type DeckBuildResult = {
  packs: SectionPackV2[];
  validationReports: Map<FragmentKey, SectionValidationReport>;
  manifest: ReportSectionManifest;
  assembly: DeckAssemblyResult;
  assemblyValidation: AssemblyValidationReport | null;
  buildLog: Array<{ fragmentKey: FragmentKey; action: "REGENERATED" | "REUSED_CACHE" }>;
  artifacts: Record<string, string>;
};

export function loadPreviousPacks(outputRoot: string): Map<FragmentKey, SectionPackV2> {
  const previous = new Map<FragmentKey, SectionPackV2>();
  for (const [key, rel] of Object.entries(FRAGMENT_ARTIFACT_PATHS)) {
    const path = join(outputRoot, rel);
    if (!existsSync(path)) continue;
    try {
      const parsed = SectionPackV2Schema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      if (parsed.success) previous.set(key as FragmentKey, parsed.data);
    } catch {
      // unreadable pack — rebuild
    }
  }
  return previous;
}

/**
 * Drop persisted gptCopy stamps from section-packs on disk so a subsequent
 * full prepare cannot revive SKIPPED_CACHED if forceRefresh is skipped.
 * Used by unified «Пересобрать отчёт».
 */
export function stripGptCopyFromSectionPacksOnDisk(outputRoot: string): number {
  let stripped = 0;
  for (const rel of Object.values(FRAGMENT_ARTIFACT_PATHS)) {
    const path = join(outputRoot, rel);
    if (!existsSync(path)) continue;
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      if (!raw || typeof raw !== "object" || !("gptCopy" in raw)) continue;
      const { gptCopy: _drop, ...rest } = raw;
      writeFileSync(path, `${JSON.stringify(rest, null, 2)}\n`, "utf8");
      stripped += 1;
    } catch {
      // leave pack for rebuild / schema validation
    }
  }
  return stripped;
}

export function runDeckBuild(input: {
  ctx: Omit<SectionBuildContext, "previousPacks" | "buildLog">;
  bundleForValidation: VerifiedFindingBundle;
  knownEvidenceRefs: Set<string>;
  outputRoot: string;
  baseObservationCountBefore: number;
  baseObservationCountAfter: number;
  /** Packs already built (and possibly GPT-enhanced) by a wrapper stage. */
  prebuiltPacks?: SectionPackV2[];
  prebuiltBuildLog?: DeckBuildResult["buildLog"];
  /** Level 2.5 — slideId → layout variant picked by the GPT composer. */
  layoutVariants?: ReadonlyMap<string, string>;
}): DeckBuildResult {
  const buildLog: DeckBuildResult["buildLog"] = input.prebuiltBuildLog ?? [];
  const artifacts: Record<string, string> = {};
  const previousPacks = loadPreviousPacks(input.outputRoot);
  const ctx: SectionBuildContext = { ...input.ctx, previousPacks, buildLog };

  // 1. Independent SectionPacks (cache-aware) — or the prebuilt set.
  const packs = input.prebuiltPacks ?? buildAllSections(ctx);

  // 2. Section-level QA before assembly.
  const validationReports = new Map<FragmentKey, SectionValidationReport>();
  for (const pack of packs) {
    const report = validateSectionPack({
      pack,
      expectedCaseId: ctx.caseId,
      expectedReportRunId: ctx.reportRunId,
      expectedDatasetId: ctx.sourceDatasetId,
      bundle: input.bundleForValidation,
      knownEvidenceRefs: input.knownEvidenceRefs,
      evidenceIndex: ctx.evidenceIndex,
    });
    pack.validation = { passed: report.passed, issues: report.issues };
    validationReports.set(pack.fragmentKey, report);
  }

  // 3. Persist every SectionPack independently.
  for (const pack of packs) {
    const rel = FRAGMENT_ARTIFACT_PATHS[pack.fragmentKey];
    const path = join(input.outputRoot, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(pack, null, 2), "utf8");
    artifacts[rel] = path;
  }
  const sectionReportsPath = join(input.outputRoot, "section-validation-reports.json");
  writeFileSync(
    sectionReportsPath,
    JSON.stringify([...validationReports.values()], null, 2),
    "utf8"
  );
  artifacts["section-validation-reports.json"] = sectionReportsPath;

  // 4. Manifest (fail-closed for required sections).
  const manifest = buildReportSectionManifest({
    caseId: ctx.caseId,
    reportRunId: ctx.reportRunId,
    sourceDatasetId: ctx.sourceDatasetId,
    packs,
    validationReports,
  });
  const manifestPath = join(input.outputRoot, "report-section-manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  artifacts["report-section-manifest.json"] = manifestPath;

  // 5. Deterministic assembly.
  const assembly = assembleDeck({
    manifest,
    packs,
    expectedCaseId: ctx.caseId,
    expectedReportRunId: ctx.reportRunId,
    expectedDatasetId: ctx.sourceDatasetId,
    layoutVariants: input.layoutVariants,
  });
  const deckManifestPath = join(input.outputRoot, "report-deck-manifest.json");
  writeFileSync(deckManifestPath, JSON.stringify(assembly.deckManifest, null, 2), "utf8");
  artifacts["report-deck-manifest.json"] = deckManifestPath;
  const assembledPath = join(input.outputRoot, "assembled-deck.json");
  writeFileSync(
    assembledPath,
    JSON.stringify(
      {
        version: "deck-sections-assembled-v1",
        caseId: ctx.caseId,
        reportRunId: ctx.reportRunId,
        datasetId: ctx.sourceDatasetId,
        sourceDatasetId: ctx.sourceDatasetId,
        slides: assembly.rendererSlides,
        rejections: assembly.rejections,
      },
      null,
      2
    ),
    "utf8"
  );
  artifacts["assembled-deck.json"] = assembledPath;

  // 6. Global assembly validation.
  let assemblyValidation: AssemblyValidationReport | null = null;
  if (assembly.errors.length === 0) {
    assemblyValidation = validateAssembly({
      manifest,
      deckManifest: assembly.deckManifest,
      rendererSlides: assembly.rendererSlides,
      packs,
      bundle: input.bundleForValidation,
      baseObservationCountBefore: input.baseObservationCountBefore,
      baseObservationCountAfter: input.baseObservationCountAfter,
      evidenceIndex: ctx.evidenceIndex,
    });
  }
  const assemblyReportPath = join(input.outputRoot, "assembly-validation-report.json");
  writeFileSync(
    assemblyReportPath,
    JSON.stringify(assemblyValidation ?? { passed: false, issues: assembly.errors, checks: {} }, null, 2),
    "utf8"
  );
  artifacts["assembly-validation-report.json"] = assemblyReportPath;

  const buildLogPath = join(input.outputRoot, "section-build-log.json");
  writeFileSync(buildLogPath, JSON.stringify(buildLog, null, 2), "utf8");
  artifacts["section-build-log.json"] = buildLogPath;

  return { packs, validationReports, manifest, assembly, assemblyValidation, buildLog, artifacts };
}

/** Raw asset entry in the existing report-assets store (imageData base64). */
export type RendererAssetEntry = {
  assetRef: string;
  kind?: string;
  title?: string;
  caption?: string;
  imageData?: string;
  storageKey?: string;
} & Record<string, unknown>;

/** Convert the assembled model to the existing renderer's payload shape. */
export function toRendererPayload(input: {
  deckManifest: ReportDeckManifest;
  rendererSlides: RendererSlide[];
  subjectName: string;
  /** Existing report assets; slides reference them via visualAssetRefs. */
  assets?: RendererAssetEntry[];
}): Record<string, unknown> {
  const clientTextContract = getClientTextContract();
  const assetByRef = new Map((input.assets ?? []).map((a) => [a.assetRef, a]));
  // Traceability markers ([finding-…]) stay in SectionPacks for validation,
  // but are internal IDs and never reach the client-facing renderer payload.
  const stripFindingMarkers = (text: string): string =>
    text.replace(/\s*\[finding-[^\]]+\]/gu, "").trim();
  // Renderer layouts that expect visual assets draw sidebar boxes; when a
  // slide carries no bound asset (explicit VISUAL_ASSET_UNAVAILABLE fallback)
  // we downgrade to the plain text layout — the renderer itself is untouched.
  const VISUAL_TEMPLATES = new Set([
    "orion_golden_serp_screenshot",
    "orion_golden_knowledge_panel",
    "orion_golden_surface_panel",
    "orion_golden_image_grid",
  ]);
  const RISK_TONES: Record<string, string> = {
    Критический: "danger",
    Высокий: "danger",
    Средний: "warn",
    Низкий: "neutral",
    Нет: "neutral",
    "Требует подтверждения": "warn",
  };
  const usedAssetRefs = new Set<string>();
  const finalSlides = input.rendererSlides.map((raw) => {
    const s: RendererSlide = {
      ...raw,
      narrative: raw.narrative ? stripFindingMarkers(raw.narrative) : raw.narrative,
      bullets: raw.bullets?.map(stripFindingMarkers),
    };
    const boundAssets = s.visualAssetRefs.filter((r) => assetByRef.has(r));
    for (const r of boundAssets) usedAssetRefs.add(r);
    const hasVisual = boundAssets.length > 0;
    const narrative = [s.subtitle, s.narrative].filter(Boolean).join("\n") || undefined;
    const bullets = buildRendererBullets(s);
    // Default renderer layouts stack narrative and bullet boxes in the same
    // region; when both exist, fold narrative into the list to avoid overlap.
    const mergedBullets = narrative && bullets ? [narrative, ...bullets] : bullets;

    // Structured fields for renderer layouts that consume dashboards, not
    // plain bullet lists (existing renderer contracts, unchanged).
    let keyFindings: Array<Record<string, string>> | undefined;
    let actions: Array<Record<string, string>> | undefined;
    let metrics: Array<Record<string, string>> | undefined;
    let dashboardNarrative: string | undefined;
    if (s.template === "orion_golden_executive_dashboard") {
      dashboardNarrative = narrative;
      keyFindings = (s.bullets ?? []).slice(0, 2).map((b) => ({ detail: b, tone: "warn" }));
      if (s.whatToCheck) actions = [{ label: s.whatToCheck }];
      // Right-column KPI cards (audit headline numbers) — same wire contract
      // as the metrics dashboard.
      if (s.kpis?.length) {
        metrics = s.kpis.map((k) => ({ label: k.label, value: k.value, tone: k.tone ?? "neutral" }));
      }
    }
    if (s.template === "orion_golden_risk_matrix_grid" && s.table) {
      // bullets[i] carries the rich per-theme explanation aligned with rows[i]
      // (what was found + why risky + advice); level/priority is the fallback.
      keyFindings = s.table.rows.slice(0, 6).map((row, i) => ({
        headline: row[0] ?? "Тема",
        detail: s.bullets?.[i] ?? `Уровень риска: ${row[1] ?? "—"}; приоритет: ${row[2] ?? "—"}.`,
        status: row[1] ?? "",
        tone: RISK_TONES[row[1] ?? ""] ?? "warn",
      }));
    }
    // KPI cards for the metrics dashboard layout (label/value/tone contract).
    if (s.template === "orion_golden_metrics_dashboard" && s.kpis?.length) {
      metrics = s.kpis.map((k) => ({ label: k.label, value: k.value, tone: k.tone ?? "neutral" }));
      if (s.whatToCheck) actions = [{ label: s.whatToCheck }];
    }
    const isDashboard = keyFindings !== undefined;
    const isMetricsDashboard = metrics !== undefined;

    // The compact no-data layout draws only `narrative`; fold the honest
    // coverage explanation (why the surface matters + recommendation) into it
    // so empty states keep their full ORION-style client copy.
    if (s.template === "orion_golden_no_data_compact" && mergedBullets?.length) {
      return {
        slideKey: s.slideKey,
        sectionKey: s.sectionKey,
        template: s.template,
        title: s.title,
        pageNumber: s.pageNumber,
        totalPageCount: s.totalPageCount,
        baseSlotId: s.baseSlotId,
        isContinuation: s.isContinuation,
        continuationOf: s.continuationOf,
        continuationIndex: s.continuationIndex,
        narrative: mergedBullets.join("\n"),
        evidenceRefs: s.evidenceRefs,
        assetRefs: boundAssets,
      };
    }

    // Analytical sidebar next to a bound visual: the renderer's unified
    // sidebar panel consumes `visualAnalysis` (headline conclusion, adverse
    // highlight explanations, meaning, action, provenance) — an empty titled
    // panel is a validation failure upstream.
    const visualAnalysis = hasVisual ? buildVisualAnalysis(s) : undefined;

    return {
      slideKey: s.slideKey,
      sectionKey: s.sectionKey,
      template:
        VISUAL_TEMPLATES.has(s.template) && !hasVisual ? "orion_golden_prose" : s.template,
      layoutVariant: s.layoutVariant,
      title: s.title,
      pageNumber: s.pageNumber,
      totalPageCount: s.totalPageCount,
      baseSlotId: s.baseSlotId,
      isContinuation: s.isContinuation,
      continuationOf: s.continuationOf,
      continuationIndex: s.continuationIndex,
      narrative: isDashboard
        ? dashboardNarrative
        : isMetricsDashboard || hasVisual
          ? isMetricsDashboard
            ? narrative
            : undefined
          : narrative && bullets && !s.table
            ? undefined
            : narrative,
      // Visual layouts render the structured sidebar panel; the KPI dashboard
      // draws narrative/KPI/action cards; plain layouts get the merged list.
      bullets: isDashboard || hasVisual ? undefined : isMetricsDashboard ? s.bullets : mergedBullets,
      keyFindings,
      actions,
      metrics,
      visualAnalysis,
      table: s.table ? { headers: s.table.headers, rows: s.table.rows } : undefined,
      evidenceRefs: s.evidenceRefs,
      assetRefs: boundAssets,
    };
  });
  return {
    reportSpec: {
      version: "deck-sections-report-spec-v1",
      subjectName: input.subjectName,
      title: `Отчёт о цифровом профиле — ${input.subjectName}`,
    },
    deckManifest: {
      version: "r10-orion-golden-deck-manifest-v1",
      slideCount: finalSlides.length,
      totalSlideCount: finalSlides.length,
      finalSlides,
      toc: input.deckManifest.toc,
      pageNumberMap: Object.fromEntries(finalSlides.map((s) => [s.slideKey, s.pageNumber])),
      sectionManifests: input.deckManifest.sectionPageRanges.map((r) => ({
        sectionKey: r.sectionType,
        slideCount: r.lastPage - r.firstPage + 1,
        slides: [],
      })),
    },
    /** REMEDIATION §6.1 — renderer must not depend on app FS for text rules. */
    clientTextContract,
    clientTextContractVersion: clientTextContract.version,
    assets: (input.assets ?? [])
      .filter((a) => usedAssetRefs.has(a.assetRef))
      // image_grid captions render at the page bottom and collide with the
      // full-bleed grid image; the grids carry their own baked-in labels.
      .map((a) => (a.kind === "image_grid" ? { ...a, caption: "" } : a)),
  };
}

/** Sidebar text must be complete sentences without ellipsis (renderer QA). */
function sidebarSafe(text: string | undefined, budget = 240): string | undefined {
  if (!text) return undefined;
  let out = text.replace(/\s*(\.\.\.|…)\s*/gu, ". ").replace(/\.\s*\./gu, ".").trim();
  if (out.length > budget) {
    // Cut at a sentence boundary; the narrow sidebar panel cannot fit long
    // paragraphs and the renderer fails closed on incomplete sentences.
    const slice = out.slice(0, budget);
    const cut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("; "));
    out = (cut > budget * 0.3 ? slice.slice(0, cut) : slice.slice(0, slice.lastIndexOf(" ")))
      .replace(/[\s;,.]+$/u, "");
    out = out ? `${out}.` : "";
  }
  return out || undefined;
}

/**
 * Structured content of the analytical sidebar next to a bound visual:
 * static context (template methodology), dynamic conclusion, why relevant or
 * why adverse, confidence/status and recommended action.
 */
function buildVisualAnalysis(s: RendererSlide): Record<string, unknown> {
  // Budgets keep the narrow sidebar panel within its box: the renderer fails
  // closed on any block that cannot fit a complete sentence.
  const explanations = (s.highlightExplanations ?? []).map((h) => ({
    clientReason: sidebarSafe(h.clientReason, 170),
    frameTone: h.frameTone,
  }));
  // On adverse pages the "why adverse" is carried by the highlight
  // explanations; the meaning block keeps significance (incl. any visible
  // coverage limitation) and the confidence/status line. The renderer trims
  // to complete sentences and fails closed on true overflow.
  const meaning = (
    explanations.length
      ? [sidebarSafe(s.whyItMatters, 190), sidebarSafe(s.statusNote, 110)]
      : [sidebarSafe(s.whyItMatters, 130), sidebarSafe(s.statusNote, 90)]
  )
    .filter(Boolean)
    .join(" ");
  return {
    sidebarMode: explanations.length ? "adverse_explanation" : "context",
    headlineConclusion: sidebarSafe(s.whatWasFound, 200) ?? sidebarSafe(s.narrative, 200),
    whatIsVisible: sidebarSafe(s.narrative, 170) ?? sidebarSafe(s.methodologyNote, 170),
    clientMeaning: meaning || undefined,
    highlightExplanations: explanations.slice(0, 2),
    moreSignalsCount: Math.max(0, explanations.length - 2),
    recommendedActions: s.whatToCheck ? [sidebarSafe(s.whatToCheck, 150)] : [],
    provenanceLabel: sidebarSafe(s.sourceNote, 120),
  };
}

function buildRendererBullets(s: RendererSlide): string[] | undefined {
  const bullets: string[] = [...(s.bullets ?? [])];
  if (s.whatWasFound) bullets.push(`Что обнаружено: ${s.whatWasFound}`);
  if (s.whyItMatters) bullets.push(`Почему важно: ${s.whyItMatters}`);
  if (s.whatToCheck) bullets.push(`Что проверить: ${s.whatToCheck}`);
  if (s.sourceNote) bullets.push(s.sourceNote);
  if (s.methodologyNote) bullets.push(`Методология: ${s.methodologyNote}`);
  return bullets.length ? bullets : undefined;
}

export function hashOfFile(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
