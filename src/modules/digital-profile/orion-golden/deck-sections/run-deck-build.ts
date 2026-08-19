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
import {
  validateAssembly,
  type AssemblyValidationReport,
  type SerpObservationForGate,
} from "./assembly-validation";
import { buildLinkUsageTrace, linkUsageLogLine } from "./link-usage-trace";
import type { VerifiedFindingBundle } from "../contracts/verified-finding-bundle";
import { getClientTextContract } from "../client/load-client-text-contract";
import { reflowNarrativeParagraphs, reflowThemeBullet } from "./fragment-builders/shared";
import { normalizeForCompare } from "./text-compare";
import {
  SIDEBAR_HIGHLIGHT_BUDGET,
  SIDEBAR_HIGHLIGHT_SLOTS,
} from "./template-registry";

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
  /** Наблюдения выдачи для сверки печатной таблицы с артефактом. */
  serpObservations?: ReadonlyArray<SerpObservationForGate>;
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
        // Что сняла вычистка повторов — чтобы укоротившуюся страницу было с чем
        // сверить, а не только заметить, что она стала короче.
        dedupRemovals: assembly.dedupRemovals,
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
      visualAssets: ctx.extras.visualAssets,
      serpObservations: input.serpObservations,
    });
  }
  const assemblyReportPath = join(input.outputRoot, "assembly-validation-report.json");
  writeFileSync(
    assemblyReportPath,
    JSON.stringify(assemblyValidation ?? { passed: false, issues: assembly.errors, checks: {} }, null, 2),
    "utf8"
  );
  artifacts["assembly-validation-report.json"] = assemblyReportPath;

  /*
   * След «что сказала модель о ссылке → что дошло до отчёта».
   *
   * Между решением по прочитанной странице и напечатанной страницей лежит
   * десяток отборов, и по готовому отчёту нельзя понять, почему ссылки в нём
   * нет: её не прочитали, вывод понизили или цитату забраковали. След отвечает
   * на это одной строкой на ссылку и живёт рядом с декой.
   */
  const usageTrace = buildLinkUsageTrace({
    evidenceIndex: ctx.evidenceIndex,
    slides: assembly.rendererSlides,
  });
  const usagePath = join(input.outputRoot, "link-usage-trace.json");
  writeFileSync(usagePath, JSON.stringify(usageTrace, null, 2), "utf8");
  artifacts["link-usage-trace.json"] = usagePath;
  if (usageTrace.summary.total > 0) console.log(linkUsageLogLine(usageTrace));

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

/**
 * Макеты, которые рисуют поля карточками, а не одним склеенным абзацем.
 *
 * У них рекомендация печатается своей карточкой, поэтому во вклейку нарратива
 * она не идёт (иначе «Мы предлагаем …» стоит на странице дважды), а буллеты
 * остаются списком: фолд «нарратив первым буллетом» здесь и погубил страницу
 * Википедии — 1387-символьный буллет ножницы рендерера превратили в пустоту.
 */
const CARD_STRUCTURED_TEMPLATES = new Set([
  "orion_golden_no_data_compact",
  "orion_golden_wikipedia_check",
]);

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
    // Вводный абзац и текст находки склеиваются до переноса строк: перенос
    // должен видеть весь абзац целиком, иначе он ломает его по границе кусков.
    //
    // Рекомендация в этот абзац не подмешивается там, где макет печатает её
    // собственной карточкой: на странице пустого состояния «Мы предлагаем …»
    // стояло дважды — в «Статусе сбора» и в «Что проверить».
    const composedNarrative = [
      raw.narrative,
      composeFindingProse(
        CARD_STRUCTURED_TEMPLATES.has(raw.template) ? { ...raw, whatToCheck: undefined } : raw
      ),
    ]
      .filter((part): part is string => Boolean(part && part.trim()))
      .join("\n");
    const s: RendererSlide = {
      ...raw,
      narrative: composedNarrative
        ? reflowNarrativeParagraphs(stripFindingMarkers(composedNarrative))
        : raw.narrative,
      bullets: raw.bullets?.map((b) => reflowThemeBullet(stripFindingMarkers(b))),
    };
    const boundAssets = s.visualAssetRefs.filter((r) => assetByRef.has(r));
    for (const r of boundAssets) usedAssetRefs.add(r);
    const hasVisual = boundAssets.length > 0;
    const narrative = composeSlideNarrative(s.subtitle, s.narrative);
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
      // C.3 — одна тема может встретиться дважды (подтверждённая и спорная).
      // Различает их бейдж статуса, который карточка и так печатает; дублировать
      // его в заголовке не нужно. Приписанный суффикс к тому же обрезался по
      // ширине: «Внимание по линии безопасности / оборонный контур — требует»
      // (шаг 15, E4).
      // Сколько тем на листе — решает построитель по реестру шаблонов; маппинг
      // маппит. Срез на шесть строк был вторым ответом на тот же вопрос и при
      // подъёме ёмкости молча срезал бы хвост страницы.
      keyFindings = s.table.rows.map((row, i) => ({
        headline: row[0] ?? "Тема",
        detail: s.bullets?.[i] ?? `Уровень риска: ${row[1] ?? "—"}; приоритет: ${row[2] ?? "—"}.`,
        status: row[1] ?? "",
        tone: RISK_TONES[row[1] ?? ""] ?? "warn",
      }));
    }
    // KPI cards for the metrics dashboard layout (label/value/tone contract).
    // PDF-40 G.1 — the template itself is the dashboard even without KPIs.
    // Previously `isMetricsDashboard` required kpis, so regional-summary fell
    // through to mergedBullets and glued «Что обнаружено / Методология» onto
    // theme cards — text then overflowed the footer (PDF 40 p10–11, p30–31).
    const isMetricsDashboard = s.template === "orion_golden_metrics_dashboard";
    if (isMetricsDashboard && s.kpis?.length) {
      metrics = s.kpis.map((k) => ({ label: k.label, value: k.value, tone: k.tone ?? "neutral" }));
    }
    if (isMetricsDashboard && s.whatToCheck) {
      actions = [{ label: s.whatToCheck }];
    }
    const isDashboard = keyFindings !== undefined;

    // C.2 — honest empty states go to the renderer as STRUCTURED fields
    // (status narrative / why-bullets / recommendation / methodology), and the
    // no-data layout draws them as separate cards instead of one glued
    // paragraph on a 90%-empty page.
    if (CARD_STRUCTURED_TEMPLATES.has(s.template)) {
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
        narrative,
        bullets: s.bullets?.length ? s.bullets : undefined,
        actions: s.whatToCheck ? [{ label: s.whatToCheck }] : undefined,
        methodologyNote: s.methodologyNote,
        sourceNote: s.sourceNote,
        evidenceRefs: s.evidenceRefs,
        assetRefs: boundAssets,
      };
    }

    // Section dividers draw only the title and the narrative lead (hero
    // variant); the default narrative→bullets folding would hide the lead in
    // a field the divider layout never renders.
    if (s.template === "orion_golden_region_divider") {
      return {
        slideKey: s.slideKey,
        sectionKey: s.sectionKey,
        template: s.template,
        layoutVariant: s.layoutVariant,
        title: s.title,
        pageNumber: s.pageNumber,
        totalPageCount: s.totalPageCount,
        baseSlotId: s.baseSlotId,
        isContinuation: s.isContinuation,
        continuationOf: s.continuationOf,
        continuationIndex: s.continuationIndex,
        narrative,
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
      // Статусная строка (доля прочитанного на странице региона) печатается
      // только там, где макет её рисует. Отдать её остальным шаблонам значило
      // бы передать текст, который никто не нарисует, — та самая беззвучная
      // потеря, ради которой этот носитель и заводился.
      statusNote: isMetricsDashboard ? s.statusNote : undefined,
      keyFindings,
      actions,
      metrics,
      visualAnalysis,
      table: s.table
        ? { headers: s.table.headers, rows: s.table.rows, groups: s.table.groups }
        : undefined,
      evidenceRefs: s.evidenceRefs,
      assetRefs: boundAssets,
    };
  });
  // Портрет на обложку. Обложка — структурный шаблон без аналитической боковой
  // панели, поэтому привязка ассета здесь не включает проверки, которые следят
  // за соответствием панели её доказательствам.
  if (assetByRef.has("cover_portrait")) {
    usedAssetRefs.add("cover_portrait");
    for (const slide of finalSlides) {
      if (slide.template === "orion_golden_cover") {
        slide.assetRefs = ["cover_portrait"];
      }
    }
  }
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

/** Dangling tails after a word-boundary cut («…относящийся к», «…и ещё»). */
const SIDEBAR_DANGLING_RE =
  /(?:\s+(?:и|а|но|или|же|то|что|как|при|про|для|без|под|над|из|из-за|от|до|по|к|ко|в|во|на|с|со|о|об|обо|у|за|ещё|еще|также|более|менее|чем|котор\p{L}*|относящ\p{L}*|связанн\p{L}*|требующ\p{L}*))+$/iu;

/**
 * Sidebar text must be complete sentences without ellipsis (renderer QA).
 * PDF-36 D.1 — cut ONLY on sentence boundaries: a shorter complete thought
 * beats a longer broken one («…зафиксирован 1 результат, относящийся к.»).
 * Exported for unit tests.
 */
export function sidebarSafe(text: string | undefined, budget = 240): string | undefined {
  if (!text) return undefined;
  const out = text.replace(/\s*(\.\.\.|…)\s*/gu, ". ").replace(/\.\s*\./gu, ".").trim();
  if (out.length <= budget) return out || undefined;
  // Keep whole sentences that fit the budget.
  const sentences = out.split(/(?<=[.!?…])\s+/u);
  const kept: string[] = [];
  let used = 0;
  for (const s of sentences) {
    const extra = (kept.length > 0 ? 1 : 0) + s.length;
    if (used + extra > budget) break;
    kept.push(s);
    used += extra;
  }
  if (kept.length > 0) return kept.join(" ");
  // First sentence alone is over budget: word-boundary cut + dangling trim,
  // closed with a period so the renderer QA sees a complete sentence.
  const slice = out.slice(0, budget);
  let head = slice.slice(0, Math.max(slice.lastIndexOf(" "), 0)) || slice;
  head = head.replace(/[\s;,.:—–-]+$/u, "").replace(SIDEBAR_DANGLING_RE, "").replace(/[\s;,.:—–-]+$/u, "");
  return head ? `${head}.` : undefined;
}

/**
 * Structured content of the analytical sidebar next to a bound visual:
 * static context (template methodology), dynamic conclusion, why relevant or
 * why adverse, confidence/status and recommended action.
 */
function buildVisualAnalysis(s: RendererSlide): Record<string, unknown> {
  // PDF-36 D.1 — budgets mirror the measured sidebar capacity (~0.38 page
  // width × content height ≈ 1300–1500 chars across all blocks). The old
  // 130–200-char budgets pre-truncated GPT text the panel could easily hold;
  // the renderer still sentence-fits each block, so overflow degrades safely.
  const explanations = (s.highlightExplanations ?? []).map((h) => ({
    clientReason: sidebarSafe(h.clientReason, SIDEBAR_HIGHLIGHT_BUDGET),
    frameTone: h.frameTone,
  }));
  // On adverse pages the "why adverse" is carried by the highlight
  // explanations; the meaning block keeps significance (incl. any visible
  // coverage limitation) and the confidence/status line. The renderer trims
  // to complete sentences and fails closed on true overflow.
  const meaning = (
    explanations.length
      ? [sidebarSafe(s.whyItMatters, 300), sidebarSafe(s.statusNote, 140)]
      : [sidebarSafe(s.whyItMatters, 260), sidebarSafe(s.statusNote, 140)]
  )
    .filter(Boolean)
    .join(" ");
  /*
   * Каждый блок панели говорит своё.
   *
   * Три блока берутся из полей, которые выше по течению перекрываются:
   * `narrative` начинается с того же, что лежит в `whatWasFound`, а его хвост —
   * это `whyItMatters`, из которого собран третий блок. На боевом прогоне
   * 28.07 страница «ОАЭ — изображения в поиске» печатала одно предложение
   * трижды подряд, и таких страниц в отчёте полтора десятка. Для клиента,
   * который платит за отчёт, это самый заметный признак халтуры.
   *
   * Правило простое: предложение, уже сказанное выше, ниже не повторяется.
   * Порядок обхода — порядок чтения, поэтому наверху остаётся вывод, а ниже —
   * только то, что к нему добавляет.
   */
  const said = new Set<string>();
  const headlineConclusion = withoutRepeatedSentences(
    sidebarSafe(s.whatWasFound, 300) ?? sidebarSafe(s.narrative, 300),
    said
  );
  const whatIsVisible = withoutRepeatedSentences(
    sidebarSafe(s.narrative, 420) ?? sidebarSafe(s.methodologyNote, 420),
    said
  );
  const clientMeaning = withoutRepeatedSentences(meaning || undefined, said);
  return {
    sidebarMode: explanations.length ? "adverse_explanation" : "context",
    headlineConclusion,
    whatIsVisible,
    clientMeaning,
    highlightExplanations: explanations.slice(0, SIDEBAR_HIGHLIGHT_SLOTS),
    moreSignalsCount: Math.max(0, explanations.length - SIDEBAR_HIGHLIGHT_SLOTS),
    // Рекомендация тоже подчиняется правилу «каждый блок говорит своё». На
    // странице «AI-ответы» она дословно повторяла нарратив: одна и та же
    // фраза печаталась дважды на одном экране.
    recommendedActions: (() => {
      const action = withoutRepeatedSentences(sidebarSafe(s.whatToCheck, 260), said);
      return action ? [action] : [];
    })(),
    provenanceLabel: sidebarSafe(s.sourceNote, 140),
  };
}

/**
 * Убирает из текста предложения, уже встречавшиеся раньше, и запоминает
 * оставшиеся.
 *
 * Сравнение — по нормализованному виду (`normalizeForCompare`): кавычки, тире и
 * регистр у одного и того же предложения в разных блоках отличаются, а смысл
 * нет. Пустой остаток возвращается как `undefined`, чтобы не осталось
 * заголовка блока без текста под ним.
 */
export function withoutRepeatedSentences(
  text: string | undefined,
  said: Set<string>
): string | undefined {
  const src = (text ?? "").trim();
  if (!src) return undefined;
  const kept: string[] = [];
  for (const sentence of src.split(/(?<=[.!?…])\s+/u)) {
    const piece = sentence.trim();
    if (!piece) continue;
    const key = normalizeForCompare(piece);
    if (!key) continue;
    if (said.has(key)) continue;
    said.add(key);
    kept.push(piece);
  }
  return kept.length > 0 ? kept.join(" ") : undefined;
}

/**
 * Нормализатор живёт в `text-compare`, чтобы им могли пользоваться и сборщик
 * деки, и вычистка присказок, не замыкая импорты в кольцо. Здесь оставлен
 * ре-экспорт: на него ссылаются проверки панели.
 */
export { normalizeForCompare };

/**
 * Подзаголовок перед абзацем — но не тогда, когда абзац им же и начинается.
 *
 * На резюме получалось «Итоговая оценка: Высокий риск / Итоговая оценка:
 * высокий риск. Основные основания: …» — одна и та же фраза дважды подряд,
 * потому что подзаголовок и первое предложение говорят одно и то же разным
 * регистром. Склейка «в лоб» этого не видела.
 */
export function composeSlideNarrative(
  subtitle: string | undefined,
  narrative: string | undefined
): string | undefined {
  const sub = (subtitle ?? "").trim();
  const body = (narrative ?? "").trim();
  if (!sub) return body || undefined;
  if (!body) return sub;
  const subKey = normalizeForCompare(sub);
  // Повтором считается только начало абзаца: совпадение где-то в середине —
  // это законное упоминание темы, а не дубль заголовка.
  if (subKey && normalizeForCompare(body).startsWith(subKey)) return body;
  return `${sub}\n${body}`;
}

/** Оканчивается ли фраза знаком конца предложения. */
function endsSentence(text: string): boolean {
  return /[.!?…»)]\s*$/u.test(text.trim());
}

/** Приписывает точку, если её нет: куски склеиваются в связный абзац. */
function asSentence(text: string): string {
  const t = text.trim();
  if (!t) return "";
  return endsSentence(t) ? t : `${t}.`;
}

/**
 * Текст находки одним абзацем — вместо анкеты из подписей.
 *
 * Прежде эти же поля уезжали в буллеты префиксами «Что обнаружено: …»,
 * «Почему важно: …», «Что проверить: …», одинаково на каждой странице с
 * данными. Читатель получал бланк проверки, повторённый тридцать раз, и ни одна
 * страница не читалась как связный текст.
 *
 * Найденное и его значение — это одна мысль, а не две графы, поэтому они
 * склеиваются в абзац. Рекомендация остаётся отдельным предложением в конце:
 * это вывод, и по нему принимают решение.
 */
export function composeFindingProse(s: {
  whatWasFound?: string;
  whyItMatters?: string;
  whatToCheck?: string;
  /** Уже показанный на странице текст: вводный абзац и буллеты. */
  narrative?: string;
  bullets?: string[];
}): string | undefined {
  /*
   * Дедупликация обязательна, а не желательна.
   *
   * Строители нередко кладут в `whatWasFound` ровно то, что уже стоит первым
   * буллетом. Пока текст ехал под подписью «Что обнаружено:», повтор выглядел
   * как отдельная графа и в глаза не бросался. Стоило подпись убрать — и один
   * и тот же факт пошёл в абзаце дважды подряд.
   */
  const seen = new Set<string>();
  for (const shown of [s.narrative ?? "", ...(s.bullets ?? [])]) {
    const k = normalizeForCompare(shown);
    if (k) seen.add(k);
  }
  const take = (part?: string): string => {
    if (!part || !part.trim()) return "";
    const k = normalizeForCompare(part);
    if (!k || seen.has(k)) return "";
    seen.add(k);
    return asSentence(part);
  };

  const paragraph = [take(s.whatWasFound), take(s.whyItMatters)].filter(Boolean).join(" ");
  const closing = take(s.whatToCheck);
  const blocks = [paragraph, closing].filter(Boolean);
  return blocks.length ? blocks.join("\n") : undefined;
}

function buildRendererBullets(s: RendererSlide): string[] | undefined {
  const bullets: string[] = [...(s.bullets ?? [])];
  // PDF-40 G.1e — methodology stays on the structured no-data layout only;
  // never append it into the client bullet stream (reads as internal jargon
  // and pushes theme cards into the footer).
  //
  // Текст находки больше сюда не попадает: он идёт абзацем в narrative
  // (см. composeFindingProse). Происхождение остаётся отдельной строкой —
  // это не утверждение о субъекте, а ссылка на источник.
  if (s.sourceNote) bullets.push(s.sourceNote);
  return bullets.length ? bullets : undefined;
}

export function hashOfFile(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
