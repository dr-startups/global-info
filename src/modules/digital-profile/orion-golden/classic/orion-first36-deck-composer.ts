/**
 * First36 CEO deck: map classic rich content into fixed ORION-like slots 1–36.
 */

import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import type {
  OrionGoldenDeckManifest,
  OrionGoldenDeckSlide,
  VisualSlideAnalysis,
} from "../composer/orion-deck-composer";
import { composeOrionClassicAuditDeck } from "./orion-classic-audit-deck-composer";
import type { OrionClassicAuditReportSpec } from "./orion-classic-client-content-to-report-spec";
import {
  assertFirst36RegistryIntegrity,
  FIRST36_EXACT_PAGE_COUNT,
  ORION_FIRST36_REGISTRY_V1,
  type First36SlotDef,
} from "./orion-first36-registry.v1";
import { scrubClientFacingProse, truncateAtWordBoundary } from "./orion-classic-text-utils";
import { sanitizeOrionGoldenClientText } from "../client/client-text-sanitizer";

function scrub(s: string): string {
  return scrubClientFacingProse(sanitizeOrionGoldenClientText(s));
}

function hasImageBytes(asset: ReportAssetV1 | undefined): boolean {
  return Boolean(asset && String(asset.imageData ?? "").trim().length >= 800);
}

function provenanceLabel(asset: ReportAssetV1): string {
  if (
    asset.evidenceRefs.some((r) => r.startsWith("serp_observation:")) ||
    /provider_serp|serper_organic|yandex_organic/i.test(asset.assetRef) ||
    asset.caption === "Синтетический снимок на основе сохранённых результатов API"
  ) {
    return "Визуализация сохранённой выдачи API";
  }
  if (asset.kind === "live_serp" || asset.kind === "captured_serp") {
    return "Снимок поисковой выдачи";
  }
  if (asset.kind === "lexis_visual_page") {
    return "Импортированная страница LexisNexis";
  }
  if (asset.kind === "compliance_visual_page") {
    if (/world_check/i.test(asset.assetRef)) return "Approved World-Check screenshot";
    if (/dow_jones/i.test(asset.assetRef)) return "Approved Dow Jones screenshot";
    return "Approved compliance screenshot";
  }
  if (asset.kind === "image_grid") return "Сводка изображений поиска";
  if (asset.kind === "video_cards") return "Сводка видеоматериалов";
  if (asset.kind === "knowledge_panel") {
    return /wikipedia/i.test(asset.assetRef) || /Wikipedia/i.test(asset.caption ?? "")
      ? "Справочная карточка Wikipedia"
      : "Справочная панель";
  }
  if (asset.kind === "surface_panel") return "Визуализация поисковой поверхности";
  return "Визуальный материал";
}

export function buildDeterministicVisualAnalysis(
  asset: ReportAssetV1,
  slot: First36SlotDef
): VisualSlideAnalysis {
  const title = scrub(asset.title || slot.title);
  const caption = scrub(asset.caption || "");
  const regionLabel =
    slot.region === "RU" ? "Россия" : slot.region === "UAE" ? "ОАЭ" : slot.region === "COMPLIANCE" ? "Комплаенс" : "Обзор";
  const isApiSynthetic =
    asset.kind === "synthetic_serp" ||
    provenanceLabel(asset).includes("API") ||
    /синтетич|реконструкц|визуализация сохранённой выдачи/i.test(caption);

  let headlineConclusion = title;
  let whatIsVisible: string;
  let whyItMatters: string;
  let recommendedActions: string[];
  let limitations: string[];

  if (slot.kind === "serp_visual") {
    headlineConclusion = isApiSynthetic
      ? `Первый экран выдачи (${regionLabel}): синтетическая визуализация API`
      : `Первый экран поисковой выдачи (${regionLabel})`;
    whatIsVisible = isApiSynthetic
      ? scrub(
          [
            `На слайде — реконструкция поисковой выдачи по сохранённым результатам API для региона «${regionLabel}» (не браузерный live-скриншот: прокси для захвата недоступен).`,
            caption ? `Контекст: ${caption}` : "",
            "Показаны заголовки, домены и сниппеты; при наличии риск-сигналы выделены в карточке выдачи.",
          ]
            .filter(Boolean)
            .join(" ")
        )
      : scrub(
          caption ||
            `На слайде показана поисковая выдача по субъекту (${regionLabel}): заголовки, домены и сниппеты первого экрана.`
        );
    whyItMatters = scrub(
      "Клиент видит, какие источники и формулировки формируют первое впечатление о субъекте в поиске, и может сверить совпадение персоны без опоры только на текстовое резюме."
    );
    recommendedActions = [
      "Сверить домены и заголовки с ручной проверкой выдачи",
      "Зафиксировать, какие результаты относятся к субъекту, а какие — к однофамильцам",
    ];
    limitations = isApiSynthetic
      ? [
          "Это реконструкция API-результатов, а не live-скриншот страницы браузера.",
          "Порядок и оформление могут отличаться от актуальной выдачи в браузере.",
        ]
      : ["Визуал отражает доступный снимок на момент сбора."];
  } else if (slot.kind === "image_visual") {
    const hasAdverseFrame = /красн|нежелательн/i.test(caption);
    headlineConclusion = hasAdverseFrame
      ? `В выдаче изображений (${regionLabel}) есть нежелательные кадры`
      : `Изображения в поиске (${regionLabel})`;
    whatIsVisible = scrub(
      caption ||
        "На слайде — подборка изображений из поиска; нежелательные при наличии отмечены красной рамкой."
    );
    whyItMatters = scrub(
      hasAdverseFrame
        ? "Красная рамка означает, что кадр связан с компрометирующим, санкционным или иным нежелательным контекстом (домен, подпись или риск-тема). Такие изображения усиливают репутационный риск и требуют отделения от нейтральных/профильных кадров и однофамильцев."
        : "Изображения влияют на узнаваемость субъекта; ошибочные совпадения и однофамильцев нужно отделять от подтверждённых кадров."
    );
    recommendedActions = hasAdverseFrame
      ? [
          "Проверить, относится ли обведённый кадр именно к субъекту аудита",
          "Зафиксировать домен и причину нежелательности в выводе",
        ]
      : [
          "Сверить совпадение лица/контекста с субъектом",
          "При появлении нежелательных кадров — пересобрать страницу после ручной разметки",
        ];
    limitations = [
      "Сетка собрана из сохранённых результатов поиска изображений; превью зависят от доступности URL.",
    ];
  } else if (slot.kind === "suggestions_visual") {
    const savedOnly = /сохранено|не подтвержд/i.test(`${caption} ${title} ${provenanceLabel(asset)}`);
    const engine =
      /google/i.test(`${asset.assetRef} ${title}`)
        ? "Google"
        : /yandex|яндекс/i.test(`${asset.assetRef} ${title}`)
          ? "Яндекс"
          : "поиска";
    headlineConclusion = scrub(
      savedOnly
        ? `Подсказки поиска (${regionLabel}): сохранённые строки без подтверждённого движка`
        : `Подсказки ${engine} (${regionLabel}): ассоциации вокруг имени`
    );
    whatIsVisible = scrub(
      [
        `На слайде — панель сохранённых подсказок автодополнения по субъекту (${regionLabel}).`,
        caption || `Источник панели: ${provenanceLabel(asset)}.`,
        "Это не live-скриншот выпадающего списка в браузере, а визуализация сохранённых строк поверхности.",
      ].join(" ")
    );
    whyItMatters = scrub(
      "Подсказки показывают, какие темы поиск связывает с именем субъекта (биография, компании, скандалы, санкции и т.п.). Это ранний сигнал репутационного и комплаенс-контекста до разбора полной выдачи."
    );
    recommendedActions = [
      "Отметить подсказки с негативным или санкционным оттенком",
      "Сверить, относятся ли формулировки к субъекту аудита",
    ];
    limitations = savedOnly
      ? ["Движок подсказок не подтверждён; строки взяты из сохранённой поверхности кейса."]
      : ["Панель собрана из сохранённых SUGGESTION-строк, а не из live autocomplete."];
  } else if (slot.kind === "related_visual") {
    const isFallback = /дополнительн|fallback|подсказ/i.test(`${caption} ${title}`);
    headlineConclusion = scrub(
      isFallback
        ? `Дополнительные поисковые ассоциации (${regionLabel})`
        : `Связанные запросы (${regionLabel}): соседние темы в выдаче`
    );
    whatIsVisible = scrub(
      [
        isFallback
          ? `Отдельные RELATED_QUERY для региона «${regionLabel}» не сохранены; показан второй набор подсказок как ближайший аналог «похожих запросов».`
          : `На слайде — связанные / похожие запросы из поисковой поверхности (${regionLabel}).`,
        caption ? `Контекст: ${caption}` : "",
      ]
        .filter(Boolean)
        .join(" ")
    );
    whyItMatters = scrub(
      "Связанные запросы раскрывают, в каком тематическом окружении поиск удерживает субъекта: бизнес, семья, споры, санкции. Это помогает отделить релевантный контекст от шума и однофамильцев."
    );
    recommendedActions = [
      "Выделить запросы с риск-тематикой для ручной проверки",
      "Сопоставить связанные темы с выводами по SERP и медиа",
    ];
    limitations = isFallback
      ? ["Это fallback из подсказок: отдельных related-строк в кейсе не было."]
      : ["Строки взяты из сохранённой поверхности, без live-снимка блока «похожие запросы»."];
  } else if (slot.kind === "knowledge_visual") {
    const fromWiki = /wikipedia|википед/i.test(`${caption} ${title} ${provenanceLabel(asset)}`);
    headlineConclusion = scrub(
      fromWiki
        ? `Справочная карточка Wikipedia (${regionLabel})`
        : `Панель знаний в поиске (${regionLabel})`
    );
    whatIsVisible = scrub(
      fromWiki
        ? `На слайде — справочная карточка на основе проверки Wikipedia по субъекту (${regionLabel}). ${caption || "Показаны название страницы и краткий статус наличия публичной статьи."}`
        : `На слайде — справочная панель/блок знаний из поисковой поверхности (${regionLabel}). ${caption || "Сводка фактов и заголовков, сохранённых по субъекту."}`
    );
    whyItMatters = scrub(
      fromWiki
        ? "Наличие или отсутствие Wikipedia-страницы влияет на «официальность» публичного профиля и на то, как третьи лица идентифицируют субъекта в открытых источниках."
        : "Панель знаний концентрирует краткие факты, которые поиск показывает рядом с выдачей; ошибки или чужой профиль здесь особенно заметны клиенту."
    );
    recommendedActions = fromWiki
      ? [
          "Проверить URL и язык статьи",
          "Убедиться, что страница относится к субъекту аудита, а не к однофамильцу",
        ]
      : [
          "Сверить факты панели с первичными источниками",
          "Отметить расхождения с резюме аудита",
        ];
    limitations = fromWiki
      ? ["Это карточка по результату wiki-check, а не скриншот knowledge graph в браузере."]
      : ["Панель собрана из сохранённых knowledge-строк поверхности."];
  } else {
    whatIsVisible =
      caption ||
      (slot.kind === "db_visual"
        ? "На слайде — страница комплаенс-базы или статусный блок раздела."
        : `На слайде — визуальный материал раздела «${slot.title}».`);
    whyItMatters =
      slot.kind === "db_visual"
        ? "Страница базы подтверждает или уточняет комплаенс-сигнал без опоры только на текстовый пересказ."
        : "Визуальное доказательство снижает риск неверной интерпретации текстового резюме.";
    recommendedActions = [
      "Сверить совпадение субъекта с карточкой/доменом на слайде",
      "Зафиксировать вывод после ручной проверки источника",
    ];
    limitations = [
      provenanceLabel(asset).includes("API")
        ? "Это реконструкция API-результатов, а не браузерный скриншот страницы."
        : "Визуал отражает доступный снимок/сводку на момент сбора.",
    ];
  }

  return {
    assetRef: asset.assetRef,
    headlineConclusion: truncateAtWordBoundary(scrub(headlineConclusion), 140),
    whatIsVisible: truncateAtWordBoundary(scrub(whatIsVisible), 420),
    metrics: [
      { label: "Регион", value: regionLabel },
      { label: "Источник", value: provenanceLabel(asset) },
    ],
    whyItMatters: truncateAtWordBoundary(scrub(whyItMatters), 360),
    recommendedActions,
    confidence: hasImageBytes(asset) ? "medium" : "low",
    limitations,
    provenanceLabel: provenanceLabel(asset),
  };
}

function enrichNonVisualSlotProse(slide: OrionGoldenDeckSlide, slot: First36SlotDef): OrionGoldenDeckSlide {
  if (slot.kind === "search_table") {
    const regionLabel = slot.region === "UAE" ? "ОАЭ" : slot.region === "RU" ? "Россия" : "Обзор";
    const takeaway = scrub(
      `Позиции в SERP (${regionLabel}): какие домены занимают верх выдачи по субъекту`
    );
    const narrative = scrub(
      slide.narrative ||
        `Таблица фиксирует сохранённые позиции поисковой выдачи для региона «${regionLabel}». Это основа для сверки с синтетическим снимком SERP на соседнем слайде.`
    );
    const bullets =
      slide.bullets && slide.bullets.length > 0
        ? slide.bullets
        : [
            scrub("Строки собраны из сохранённых результатов поиска, а не из live-браузера."),
            scrub("Сверьте домены с визуальным снимком выдачи и риск-выводами резюме."),
          ];
    return {
      ...slide,
      clientTakeaway: slide.clientTakeaway || takeaway,
      narrative,
      bullets,
    };
  }
  if (slot.kind === "summary" || slot.kind === "metrics") {
    const regionLabel = slot.region === "UAE" ? "ОАЭ" : slot.region === "RU" ? "Россия" : "Обзор";
    if (!slide.narrative && !(slide.bullets && slide.bullets.length)) {
      return {
        ...slide,
        narrative: scrub(
          slot.kind === "metrics"
            ? `Краткие показатели поискового покрытия по региону «${regionLabel}» на основе сохранённых результатов кейса.`
            : `Резюме аудита по региону «${regionLabel}»: ключевые наблюдения по открытым источникам без коммерческого блока.`
        ),
      };
    }
  }
  return slide;
}

function blockedSlide(slot: First36SlotDef, reason: string): OrionGoldenDeckSlide {
  const clientNarrative =
    "Визуальный материал по этому разделу пока недоступен. Статус совпадения и выводы требуют ручной проверки источника.";
  return {
    slideKey: slot.slotId,
    sectionKey: slot.sectionKey,
    template: "orion_golden_no_data_compact",
    title: slot.title,
    pageNumber: slot.page,
    narrative: clientNarrative,
    bullets: [
      "Слот зарезервирован в структуре аудита.",
      "После загрузки утверждённого визуала раздел будет обновлён.",
    ],
    // Internal gate code — must not be copied into client-facing narrative.
    blockedReason: reason,
    clientTakeaway: clientNarrative,
  };
}

function placeholderSlide(slot: First36SlotDef, narrative?: string): OrionGoldenDeckSlide {
  return {
    slideKey: slot.slotId,
    sectionKey: slot.sectionKey,
    template: slot.template === "orion_golden_region_divider" ? slot.template : "orion_golden_prose",
    title: slot.title,
    pageNumber: slot.page,
    narrative:
      narrative ||
      (slot.kind === "region_toc" || slot.kind === "compliance_toc"
        ? undefined
        : "Раздел будет дополнен при наличии подтверждённых данных по субъекту."),
    bullets:
      slot.kind === "region_toc" || slot.kind === "compliance_toc"
        ? undefined
        : ["Данных для полного заполнения слота пока недостаточно."],
  };
}

function slideMatchesSlot(slide: OrionGoldenDeckSlide, slot: First36SlotDef): boolean {
  const { match } = slot;
  const sectionHit = Boolean(
    match.sectionKeys?.some((k) => slide.sectionKey === k || slide.sectionKey.includes(k))
  );
  if (sectionHit) return true;

  // Template fallback only when the slot does not pin sectionKeys (avoid cross-slot surface_panel bleed).
  if (match.sectionKeys?.length) return false;

  if (match.templates?.includes(slide.template)) {
    if (slot.region === "RU" && /uae|оаэ/i.test(`${slide.sectionKey} ${slide.title}`)) return false;
    if (
      slot.region === "UAE" &&
      /(?:^|_)ru_|росси/i.test(`${slide.sectionKey} ${slide.title}`) &&
      !/uae/i.test(slide.sectionKey)
    ) {
      return false;
    }
    return true;
  }
  return false;
}

function pickFromPool(
  pool: OrionGoldenDeckSlide[],
  used: Set<string>,
  slot: First36SlotDef
): OrionGoldenDeckSlide | null {
  const candidates = pool.filter((s) => !used.has(s.slideKey) && slideMatchesSlot(s, slot));
  if (candidates.length === 0) return null;
  // Prefer slides that already carry assets for visual slots
  if (slot.requiredVisual || slot.kind.endsWith("visual") || slot.kind.includes("visual")) {
    const withAssets = candidates.filter((s) => (s.assetRefs?.length ?? 0) > 0);
    if (withAssets.length > 0) return withAssets[0];
  }
  return candidates[0];
}

function pickAssetForSlot(
  assets: ReportAssetV1[],
  usedAssets: Set<string>,
  slot: First36SlotDef
): ReportAssetV1 | null {
  const re = slot.match.assetRefRe;
  const ready = assets.filter(
    (a) => a.status === "ready" && hasImageBytes(a) && !usedAssets.has(a.assetRef)
  );
  const matched = re ? ready.filter((a) => re.test(a.assetRef)) : ready;
  return matched[0] ?? null;
}

function attachVisual(
  slide: OrionGoldenDeckSlide,
  slot: First36SlotDef,
  assets: ReportAssetV1[],
  usedAssets: Set<string>
): OrionGoldenDeckSlide {
  const visualTemplates = new Set([
    "orion_golden_serp_screenshot",
    "orion_golden_image_grid",
    "orion_golden_video_cards",
    "orion_golden_knowledge_panel",
    "orion_golden_surface_panel",
    "orion_golden_lexis_visual_page",
    "orion_golden_compliance_visual_page",
  ]);
  if (!visualTemplates.has(slide.template) && !visualTemplates.has(slot.template)) {
    return { ...slide, slideKey: slot.slotId, pageNumber: slot.page, title: slide.title || slot.title };
  }

  let assetRef = slide.assetRefs?.[0];
  let asset = assetRef ? assets.find((a) => a.assetRef === assetRef) : undefined;
  const re = slot.match.assetRefRe;
  if (asset && re && !re.test(asset.assetRef)) {
    asset = undefined;
    assetRef = undefined;
  }
  if (!hasImageBytes(asset)) {
    asset = pickAssetForSlot(assets, usedAssets, slot) ?? undefined;
    assetRef = asset?.assetRef;
  }
  if (!asset || !assetRef || !hasImageBytes(asset)) {
    if (slot.requiredVisual) {
      return blockedSlide(slot, `REQUIRED_VISUAL_ASSET_MISSING:${slot.sectionKey}`);
    }
    // Keep prose/status content when approved visual is not available.
    // Drop mismatched assetRefs so the wrong panel is not rendered on this slot.
    return {
      ...slide,
      slideKey: slot.slotId,
      pageNumber: slot.page,
      title: slot.title,
      assetRefs: undefined,
      visualAnalysis: undefined,
      template:
        slide.template === "orion_golden_compliance_visual_page" ||
        slide.template === "orion_golden_lexis_visual_page" ||
        slide.template === "orion_golden_surface_panel" ||
        slide.template === "orion_golden_image_grid" ||
        slide.template === "orion_golden_knowledge_panel" ||
        slide.template === "orion_golden_serp_screenshot"
          ? "orion_golden_prose"
          : slide.template || "orion_golden_prose",
    };
  }

  usedAssets.add(assetRef);
  const analysis = buildDeterministicVisualAnalysis(asset, slot);
  return {
    ...slide,
    slideKey: slot.slotId,
    sectionKey: slot.sectionKey,
    template: slot.template,
    title: slot.title,
    pageNumber: slot.page,
    assetRefs: [assetRef],
    clientTakeaway: analysis.headlineConclusion,
    visualAnalysis: analysis,
    bullets: [
      analysis.whatIsVisible,
      analysis.whyItMatters,
      ...(analysis.limitations?.slice(0, 1) ?? []),
      ...(analysis.provenanceLabel ? [analysis.provenanceLabel] : []),
    ].slice(0, 4),
  };
}

/**
 * Compose exactly 36 CEO audit slides from classic rich content + assets.
 */
export function composeOrionFirst36CeoDeck(
  reportSpec: OrionClassicAuditReportSpec,
  assets: ReportAssetV1[] = []
): OrionGoldenDeckManifest {
  assertFirst36RegistryIntegrity();

  const classic = composeOrionClassicAuditDeck(reportSpec, assets, { includeCommercial: false });
  const pool = [...classic.finalSlides];
  const used = new Set<string>();
  const usedAssets = new Set<string>();
  const finalSlides: OrionGoldenDeckSlide[] = [];

  for (const slot of ORION_FIRST36_REGISTRY_V1) {
    const picked = pickFromPool(pool, used, slot);
    let slide: OrionGoldenDeckSlide;
    if (picked) {
      used.add(picked.slideKey);
      slide = attachVisual(
        {
          ...picked,
          title: picked.title || slot.title,
          template: slot.template.startsWith("orion_golden_") ? slot.template : picked.template,
        },
        slot,
        assets,
        usedAssets
      );
    } else if (slot.requiredVisual) {
      const asset = pickAssetForSlot(assets, usedAssets, slot);
      if (asset) {
        usedAssets.add(asset.assetRef);
        const analysis = buildDeterministicVisualAnalysis(asset, slot);
        slide = {
          slideKey: slot.slotId,
          sectionKey: slot.sectionKey,
          template: slot.template,
          title: slot.title,
          pageNumber: slot.page,
          assetRefs: [asset.assetRef],
          clientTakeaway: analysis.headlineConclusion,
          visualAnalysis: analysis,
          bullets: [
            analysis.whatIsVisible,
            analysis.whyItMatters,
            ...(analysis.limitations?.slice(0, 1) ?? []),
            analysis.provenanceLabel ?? "",
          ].filter(Boolean),
        };
      } else {
        slide = blockedSlide(slot, `REQUIRED_VISUAL_ASSET_MISSING:${slot.sectionKey}`);
      }
    } else if (
      slot.kind === "suggestions_visual" ||
      slot.kind === "related_visual" ||
      slot.kind === "image_visual" ||
      slot.kind === "knowledge_visual" ||
      slot.kind === "serp_visual" ||
      slot.kind === "db_visual"
    ) {
      const asset = pickAssetForSlot(assets, usedAssets, slot);
      if (asset) {
        usedAssets.add(asset.assetRef);
        const analysis = buildDeterministicVisualAnalysis(asset, slot);
        slide = {
          slideKey: slot.slotId,
          sectionKey: slot.sectionKey,
          template: slot.template,
          title: slot.title,
          pageNumber: slot.page,
          assetRefs: [asset.assetRef],
          clientTakeaway: analysis.headlineConclusion,
          visualAnalysis: analysis,
          bullets: [
            analysis.whatIsVisible,
            analysis.whyItMatters,
            ...(analysis.limitations?.slice(0, 1) ?? []),
            analysis.provenanceLabel ?? "",
          ].filter(Boolean),
        };
      } else {
        slide = placeholderSlide(slot);
      }
    } else if (slot.kind === "cover") {
      slide = {
        slideKey: slot.slotId,
        sectionKey: "cover",
        template: "orion_golden_cover",
        title: reportSpec.subject.reportTitle || slot.title,
        pageNumber: slot.page,
        narrative: reportSpec.subject.displayName,
      };
    } else if (slot.kind === "toc") {
      slide = {
        slideKey: slot.slotId,
        sectionKey: "global_toc",
        template: "orion_golden_toc",
        title: slot.title,
        pageNumber: slot.page,
        bullets: reportSpec.globalToc.map((t) => t.title).slice(0, 14),
      };
    } else {
      slide = placeholderSlide(slot);
    }

    // Ensure page identity
    slide = enrichNonVisualSlotProse(slide, slot);
    slide = {
      ...slide,
      slideKey: slot.slotId,
      pageNumber: slot.page,
      title: scrub(slide.title || slot.title),
      narrative: slide.narrative ? scrub(slide.narrative) : undefined,
      bullets: slide.bullets?.map((b) => scrub(b)).filter(Boolean),
      clientTakeaway: slide.clientTakeaway ? scrub(slide.clientTakeaway) : undefined,
    };
    finalSlides.push(slide);
  }

  if (finalSlides.length !== FIRST36_EXACT_PAGE_COUNT) {
    throw new Error(`first36-slide-count:${finalSlides.length}`);
  }

  const sectionManifests: OrionGoldenDeckManifest["sectionManifests"] = [];
  for (const s of finalSlides) {
    const last = sectionManifests[sectionManifests.length - 1];
    if (last && last.sectionKey === s.sectionKey) {
      last.slides.push(s);
      last.slideCount += 1;
    } else {
      sectionManifests.push({ sectionKey: s.sectionKey, slideCount: 1, slides: [s] });
    }
  }

  const toc = finalSlides
    .filter((s) => s.sectionKey !== "cover")
    .filter((_, idx, arr) => idx === 0 || arr[idx - 1]?.sectionKey !== arr[idx].sectionKey)
    .slice(0, 36)
    .map((s) => ({ title: s.title, pageNumber: s.pageNumber }));

  const pageNumberMap: Record<string, number> = {};
  for (const s of finalSlides) pageNumberMap[s.slideKey] = s.pageNumber;

  return {
    version: "r10-orion-golden-deck-manifest-v1",
    slideCount: finalSlides.length,
    sectionManifests,
    finalSlides,
    toc,
    pageNumberMap,
  };
}
