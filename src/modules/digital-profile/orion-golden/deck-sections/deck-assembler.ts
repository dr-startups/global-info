/**
 * Deterministic DeckAssembler — a pure module.
 *
 * It performs ZERO LLM calls, does not analyze evidence and does not write
 * client conclusions. It validates lineage, rejects foreign/stale packs,
 * keeps continuations adjacent, concatenates slide contracts in manifest
 * order, computes global page numbers / section ranges, generates the TOC
 * and produces report-deck-manifest.json plus a unified slide model in the
 * shape the EXISTING renderer consumes (OrionGoldenDeckSlide-compatible).
 */

import { createHash } from "node:crypto";
import type {
  DeckSlideRef,
  FragmentKey,
  ReportDeckManifest,
  ReportSectionManifest,
  SectionPackV2,
  SlideContentContract,
} from "./contracts";
import { REPORT_DECK_MANIFEST_VERSION, SECTION_TITLES, type PageKind } from "./contracts";
import {
  DECK_TEMPLATE_REGISTRY,
  isAllowedLayoutVariant,
  type DeckTemplateId,
} from "./template-registry";
import {
  CANONICAL_BASE_SLOTS,
  CANONICAL_SLOT_IDS,
  EXPLICIT_SLOT_MERGES,
} from "./canonical-slots";
import { withoutRepeatedSentences } from "./run-deck-build";
import { emptySurfaceMergeReason } from "./empty-surface-collapse";
import { dropEmptyContinuations } from "./continuation-cleanup";

/**
 * Страницы, где строки — данные, а не наша проза.
 *
 * Вычистка повторов заведена против одного и того же **пояснения темы**,
 * напечатанного в матрице рисков, в обзоре профиля и в резюме региона. Списки
 * поверхностей — другое: подсказка Google, дословно совпавшая с подсказкой
 * Яндекса, это два факта, а не повтор. На прогоне вычистка съедала такие
 * строки, и на странице оставалось три запроса из десяти нарисованных на
 * панели — при том, что описание рядом считало десять.
 */
export function isDataRowTemplate(templateId: string): boolean {
  return DATA_ROW_TEMPLATES.has(templateId);
}

const DATA_ROW_TEMPLATES = new Set<string>([
  "related-queries",
  "suggestions",
  "ai-overview",
  "image-grid",
  "serp-table",
]);

export type AssemblyRejection = {
  fragmentKey: string;
  reason:
    | "FOREIGN_CASE"
    | "FOREIGN_REPORT_RUN"
    | "STALE_DATASET"
    | "SECTION_QA_FAILED"
    | "EMPTY_VALID_OMITTED"
    /** Продолжение осталось без содержимого после вычистки повторов. */
    | "EMPTY_CONTINUATION_DROPPED";
  detail: string;
};

/** Unified slide model in the existing renderer's slide shape. */
export type RendererSlide = {
  slideKey: string;
  sectionKey: string;
  template: string;
  /**
   * Level 2.5 — named pre-built layout variant picked by the composer stage.
   * Absent → the renderer's default layout; always a registered variant.
   */
  layoutVariant?: string;
  title: string;
  subtitle?: string;
  pageNumber: number;
  totalPageCount: number;
  baseSlotId: string;
  isContinuation: boolean;
  continuationOf?: string;
  continuationIndex?: number;
  narrative?: string;
  bullets?: string[];
  table?: {
    headers: string[];
    rows: string[][];
    groups?: Array<{ rowStart: number; rowCount: number; queryDisplay: string; qTag?: string }>;
  };
  evidenceRefs: string[];
  findingIds: string[];
  metrics: Record<string, number | string>;
  visualAssetRefs: string[];
  staticBlocks: string[];
  methodologyNote?: string;
  legend?: string[];
  whatWasFound?: string;
  whyItMatters?: string;
  whatToCheck?: string;
  sourceNote?: string;
  statusNote?: string;
  highlightExplanations?: Array<{ clientReason: string; frameTone: "red" | "amber" }>;
  kpis?: Array<{ label: string; value: string; tone?: string }>;
  emptyStateReason?: string;
};

export type DeckAssemblyResult = {
  deckManifest: ReportDeckManifest;
  rendererSlides: RendererSlide[];
  rejections: AssemblyRejection[];
  errors: string[];
};

export function assembleDeck(input: {
  manifest: ReportSectionManifest;
  packs: SectionPackV2[];
  expectedCaseId: string;
  expectedReportRunId: string;
  expectedDatasetId: string;
  /**
   * Level 2.5 — slideId → layout variant picked by the composer stage
   * upstream. Applied defensively: an unregistered variant is ignored.
   * The assembler itself stays pure — the map is plain validated data.
   */
  layoutVariants?: ReadonlyMap<string, string>;
}): DeckAssemblyResult {
  const rejections: AssemblyRejection[] = [];
  const errors: string[] = [];
  const byKey = new Map(input.packs.map((p) => [p.fragmentKey, p]));

  // 4. Required sections must not be failed.
  if (input.manifest.buildBlocked) {
    errors.push(
      `required sections failed: ${input.manifest.requiredSectionsFailed.join("; ")} — build stopped`
    );
    return { deckManifest: emptyManifest(input), rendererSlides: [], rejections, errors };
  }

  // 1–5. Verify lineage per pack; reject foreign/stale; drop EMPTY_VALID optionals.
  const acceptedSlides: Array<{ slide: SlideContentContract; pack: SectionPackV2 }> = [];
  for (const entry of input.manifest.entries) {
    const pack = byKey.get(entry.fragmentKey);
    if (!pack) {
      if (entry.required) errors.push(`missing pack for required fragment ${entry.fragmentKey}`);
      continue;
    }
    // Self-contained lineage: caseId is read from the pack itself and must
    // match the current job — never inferred from the dataset string or the
    // owning manifest. A caseId=undefined pack fails closed here.
    if (!pack.caseId || pack.caseId !== input.expectedCaseId) {
      rejections.push({
        fragmentKey: pack.fragmentKey,
        reason: "FOREIGN_CASE",
        detail: String(pack.caseId),
      });
      if (entry.required) errors.push(`required fragment ${entry.fragmentKey} has foreign/missing caseId`);
      continue;
    }
    if (pack.reportRunId !== input.expectedReportRunId) {
      rejections.push({
        fragmentKey: pack.fragmentKey,
        reason: "FOREIGN_REPORT_RUN",
        detail: pack.reportRunId,
      });
      if (entry.required) errors.push(`required fragment ${entry.fragmentKey} has foreign reportRunId`);
      continue;
    }
    if (pack.datasetId !== input.expectedDatasetId || pack.sourceDatasetId !== input.expectedDatasetId) {
      rejections.push({
        fragmentKey: pack.fragmentKey,
        reason: "STALE_DATASET",
        detail: pack.sourceDatasetId,
      });
      if (entry.required) errors.push(`required fragment ${entry.fragmentKey} has stale sourceDatasetId`);
      continue;
    }
    if (!entry.validationPassed) {
      rejections.push({
        fragmentKey: pack.fragmentKey,
        reason: "SECTION_QA_FAILED",
        detail: "section validation did not pass",
      });
      if (entry.required) errors.push(`required fragment ${entry.fragmentKey} failed section QA`);
      continue;
    }
    if (pack.status === "EMPTY_VALID") {
      rejections.push({
        fragmentKey: pack.fragmentKey,
        reason: "EMPTY_VALID_OMITTED",
        detail: "optional empty fragment omitted from deck",
      });
      continue;
    }
    // 6/7. Concatenate in manifest order with continuations adjacent to base.
    for (const slide of orderWithContinuations(pack.slides, errors, pack.fragmentKey)) {
      acceptedSlides.push({ slide, pack });
    }
  }

  if (errors.length > 0) {
    return { deckManifest: emptyManifest(input), rendererSlides: [], rejections, errors };
  }

  // 8. slideId / baseSlotId uniqueness.
  const seenSlideIds = new Set<string>();
  const seenBaseSlots = new Set<string>();
  for (const { slide } of acceptedSlides) {
    if (seenSlideIds.has(slide.slideId)) errors.push(`duplicate slideId: ${slide.slideId}`);
    seenSlideIds.add(slide.slideId);
    if (!slide.isContinuation) {
      if (seenBaseSlots.has(slide.baseSlotId)) errors.push(`duplicate baseSlotId: ${slide.baseSlotId}`);
      seenBaseSlots.add(slide.baseSlotId);
    }
  }
  if (errors.length > 0) {
    return { deckManifest: emptyManifest(input), rendererSlides: [], rejections, errors };
  }

  /*
   * Пояснение темы печатается один раз на весь отчёт.
   *
   * Текст находки собирается один раз и переиспользуется всюду, где тема
   * появляется: в матрице рисков, в обзоре профиля и в резюме каждого региона.
   * Из-за этого один и тот же абзац — «Найдены публикации… Для банка или
   * партнёра такие сюжеты обычно становятся первым поводом для расширенной
   * проверки» — печатался в отчёте четыре раза дословно. Для читателя это
   * главный признак отчёта, собранного шаблоном, а не написанного.
   *
   * Порядок обхода — порядок чтения: объяснение остаётся там, где встретилось
   * первым (в матрице рисков), а региональные страницы сохраняют своё —
   * материалы и числа своего контура. Пустая после вычистки строка выбрасывается
   * вместе со своим маркером.
   *
   * Вычистка идёт до нумерации: продолжение, у которого после неё не осталось
   * ничего, кроме заголовка, — пустой лист, и он не должен получить ни номера
   * страницы, ни строки в оглавлении.
   */
  const saidInDeck = new Set<string>();
  const dedupedSlides = acceptedSlides.map(({ slide, pack }) => {
    if (slide.templateId === "toc" || isDataRowTemplate(slide.templateId)) {
      return { slide, pack };
    }
    const bullets = (slide.content.bullets ?? [])
      .map((b) => withoutRepeatedSentences(b, saidInDeck))
      .filter((b): b is string => Boolean(b && b.trim()));
    return { slide: { ...slide, content: { ...slide.content, bullets } }, pack };
  });
  const packBySlideId = new Map(dedupedSlides.map(({ slide, pack }) => [slide.slideId, pack]));
  const cleanup = dropEmptyContinuations(dedupedSlides.map(({ slide }) => slide));
  const finalSlides = cleanup.slides.map((slide) => ({
    slide,
    pack: packBySlideId.get(slide.slideId)!,
  }));
  // Выброшенный лист называется вслух: страница исчезла из отчёта, и это
  // должно быть видно в разборе сборки, а не только в разнице номеров.
  for (const slideId of cleanup.dropped) {
    rejections.push({
      fragmentKey: packBySlideId.get(slideId)?.fragmentKey ?? "UNKNOWN",
      reason: "EMPTY_CONTINUATION_DROPPED",
      detail: slideId,
    });
  }

  // 9/10. Global page index and section page ranges (assembler-owned).
  const total = finalSlides.length;
  const slideRefs: DeckSlideRef[] = [];
  const sectionRanges = new Map<string, { first: number; last: number }>();
  const canonicalIdSet = new Set(CANONICAL_SLOT_IDS);
  finalSlides.forEach(({ slide, pack }, i) => {
    const page = i + 1;
    // Explicit page accounting: every page is a canonical base slot, a
    // continuation of one, or an explained optional extra — never an
    // unexplained insert.
    const pageKind: PageKind = slide.isContinuation
      ? "continuation"
      : canonicalIdSet.has(slide.baseSlotId)
        ? "canonical_base"
        : "optional_extra";
    slideRefs.push({
      slideId: slide.slideId,
      baseSlotId: slide.baseSlotId,
      sectionId: slide.sectionId,
      sectionType: pack.sectionType,
      templateId: slide.templateId,
      title: slide.title,
      pageNumber: page,
      isContinuation: slide.isContinuation,
      continuationOf: slide.continuationOf,
      pageKind,
      pageKindReason:
        pageKind === "optional_extra"
          ? `optional section ${pack.sectionType} (fragment ${pack.fragmentKey}) admitted by the section manifest`
          : undefined,
    });
    const range = sectionRanges.get(pack.sectionType) ?? { first: page, last: page };
    range.last = page;
    if (page < range.first) range.first = page;
    sectionRanges.set(pack.sectionType, range);
  });

  // 11. TOC — generated ONLY after assembly; no "(N стр.)" per line.
  const toc = [...sectionRanges.entries()]
    .filter(([sectionType]) => sectionType !== "FRONT_MATTER")
    .map(([sectionType, r]) => ({
      title: `${SECTION_TITLES[sectionType as keyof typeof SECTION_TITLES]} — стр. ${r.first}–${r.last}`,
      pageNumber: r.first,
    }))
    .sort((a, b) => a.pageNumber - b.pageNumber);

  // 12/13/14. Renderer slide model with global footer counters + manifest.
  const rendererSlides: RendererSlide[] = finalSlides.map(({ slide }, i) => {
    const tpl = DECK_TEMPLATE_REGISTRY[slide.templateId as DeckTemplateId];
    const isToc = slide.templateId === "toc";
    const pickedVariant = input.layoutVariants?.get(slide.slideId);
    const layoutVariant =
      pickedVariant && isAllowedLayoutVariant(slide.templateId, pickedVariant)
        ? pickedVariant
        : undefined;
    return {
      slideKey: slide.slideId,
      sectionKey: slide.sectionId,
      template: tpl?.rendererTemplate ?? "orion_golden_surface_panel",
      ...(layoutVariant ? { layoutVariant } : {}),
      title: slide.title,
      subtitle: slide.subtitle,
      pageNumber: i + 1,
      totalPageCount: total,
      baseSlotId: slide.baseSlotId,
      isContinuation: slide.isContinuation,
      continuationOf: slide.continuationOf ?? undefined,
      continuationIndex: slide.continuationIndex ?? undefined,
      narrative: slide.content.narrative,
      // Повторы уже вычищены выше, до нумерации страниц.
      bullets: isToc ? toc.map((t) => t.title) : (slide.content.bullets ?? []),
      table: slide.content.table,
      evidenceRefs: slide.evidenceRefs,
      findingIds: slide.findingIds,
      metrics: slide.metrics,
      visualAssetRefs: slide.visualAssetRefs,
      staticBlocks: tpl?.staticBlocks ?? [],
      methodologyNote: tpl?.methodologyNote,
      legend: tpl?.legend,
      whatWasFound: slide.content.whatWasFound,
      whyItMatters: slide.content.whyItMatters,
      whatToCheck: slide.content.whatToCheck,
      sourceNote: slide.content.sourceNote,
      statusNote: slide.content.statusNote,
      highlightExplanations: slide.content.highlightExplanations,
      kpis: slide.content.kpis,
      emptyStateReason: slide.emptyStateReason,
    };
  });

  const sectionContentHashes: Record<string, string> = {};
  for (const entry of input.manifest.entries) sectionContentHashes[entry.fragmentKey] = entry.contentHash;

  // Canonical slot coverage: physically present slots plus slots covered via
  // an explicit reviewed merge whose target slot is present.
  const presentSlotIds = new Set(slideRefs.filter((s) => !s.isContinuation).map((s) => s.baseSlotId));
  // Пустая поверхность печатает статус один раз, а остальные её слоты
  // сворачиваются в эту страницу (шаг 15, E2). Слот при этом не теряется:
  // он остаётся в `mergedSlots` с причиной и учитывается в покрытии, поэтому
  // сверка по-прежнему отвечает за каждую каноническую позицию.
  const emptySlotIds = new Set(
    rendererSlides.filter((s) => s.emptyStateReason).map((s) => s.baseSlotId)
  );
  // Слот, уже слитый статическим правилом, второй раз не сливается: два адресата
  // у одного слота — это противоречие, а не полнота (найдено на прогоне).
  const staticallyMerged = new Set(EXPLICIT_SLOT_MERGES.map((m) => m.baseSlotId));
  const dynamicMerges: typeof EXPLICIT_SLOT_MERGES = [];
  for (const slot of CANONICAL_BASE_SLOTS) {
    if (presentSlotIds.has(slot.slotId) || staticallyMerged.has(slot.slotId)) continue;
    const host = CANONICAL_BASE_SLOTS.find(
      (s) => s.fragmentKey === slot.fragmentKey && emptySlotIds.has(s.slotId)
    );
    if (!host) continue;
    dynamicMerges.push({
      baseSlotId: slot.slotId,
      mergedInto: host.slotId,
      reason: emptySurfaceMergeReason(),
    });
  }
  const mergedSlots = [
    ...EXPLICIT_SLOT_MERGES.filter(
      (m) => !presentSlotIds.has(m.baseSlotId) && presentSlotIds.has(m.mergedInto)
    ),
    ...dynamicMerges,
  ];
  const mergedIds = new Set(mergedSlots.map((m) => m.baseSlotId));
  const coveredCanonical = CANONICAL_SLOT_IDS.filter(
    (id) => presentSlotIds.has(id) || mergedIds.has(id)
  ).length;

  // Every page outside "canonical base slots + their continuations" gets an
  // explicit owner and reason (e.g. the optional appendix).
  const packBySlide = new Map(finalSlides.map(({ slide, pack }) => [slide.slideId, pack]));
  const optionalBaseIds = new Set(
    slideRefs.filter((s) => s.pageKind === "optional_extra").map((s) => s.slideId)
  );
  const nonCanonicalPages = slideRefs
    .filter(
      (s) =>
        s.pageKind === "optional_extra" ||
        (s.isContinuation && s.continuationOf != null && optionalBaseIds.has(s.continuationOf))
    )
    .map((s) => {
      const pack = packBySlide.get(s.slideId)!;
      return {
        slideId: s.slideId,
        pageNumber: s.pageNumber,
        pageKind: s.pageKind,
        ownerFragment: pack.fragmentKey,
        ownerSection: pack.sectionType,
        reason: s.isContinuation
          ? "continuation of the optional appendix base slide (adjacency preserved)"
          : "optional APPENDIX section: ambiguous/foreign-subject materials kept for review; admitted by the section manifest, not a canonical First36 slot",
      };
    });

  const deckManifest: ReportDeckManifest = {
    schemaVersion: REPORT_DECK_MANIFEST_VERSION,
    caseId: input.manifest.caseId,
    reportRunId: input.expectedReportRunId,
    sourceDatasetId: input.expectedDatasetId,
    generatedAt: new Date().toISOString(),
    pageCount: total,
    baseSlotCount: slideRefs.filter((s) => !s.isContinuation).length,
    baseSlotCoverage: coveredCanonical,
    continuationCount: slideRefs.filter((s) => s.isContinuation).length,
    sectionPageRanges: [...sectionRanges.entries()]
      .map(([sectionType, r]) => ({
        sectionType: sectionType as ReportDeckManifest["sectionPageRanges"][number]["sectionType"],
        title: SECTION_TITLES[sectionType as keyof typeof SECTION_TITLES],
        firstPage: r.first,
        lastPage: r.last,
      }))
      .sort((a, b) => a.firstPage - b.firstPage),
    toc,
    slides: slideRefs,
    nonCanonicalPages,
    mergedSlots,
    sectionContentHashes,
    assembledDeckHash: `sha256:${createHash("sha256")
      .update(JSON.stringify(slideRefs.map((s) => `${s.slideId}:${s.pageNumber}`)))
      .digest("hex")}`,
  };

  return { deckManifest, rendererSlides, rejections, errors };
}

/**
 * Keep pack-internal order but assert continuation adjacency: every
 * continuation must directly follow its base (or previous continuation).
 */
function orderWithContinuations(
  slides: SlideContentContract[],
  errors: string[],
  fragmentKey: FragmentKey
): SlideContentContract[] {
  const bases = slides.filter((s) => !s.isContinuation);
  const ordered: SlideContentContract[] = [];
  for (const base of bases) {
    ordered.push(base);
    const conts = slides
      .filter((s) => s.isContinuation && s.continuationOf === base.slideId)
      .sort((a, b) => (a.continuationIndex ?? 0) - (b.continuationIndex ?? 0));
    ordered.push(...conts);
  }
  if (ordered.length !== slides.length) {
    errors.push(`orphan continuation slides in fragment ${fragmentKey}`);
  }
  return ordered;
}

function emptyManifest(input: {
  manifest: ReportSectionManifest;
  expectedReportRunId: string;
  expectedDatasetId: string;
}): ReportDeckManifest {
  return {
    schemaVersion: REPORT_DECK_MANIFEST_VERSION,
    caseId: input.manifest.caseId,
    reportRunId: input.expectedReportRunId,
    sourceDatasetId: input.expectedDatasetId,
    generatedAt: new Date().toISOString(),
    pageCount: 0,
    baseSlotCount: 0,
    baseSlotCoverage: 0,
    continuationCount: 0,
    sectionPageRanges: [],
    toc: [],
    slides: [],
    nonCanonicalPages: [],
    mergedSlots: [],
    sectionContentHashes: {},
    assembledDeckHash: "sha256:empty",
  };
}
