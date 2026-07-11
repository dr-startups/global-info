/**
 * First36 CEO deck: map classic rich content into fixed ORION-like slots 1–36.
 */

import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import type {
  DeckMetric,
  MetricTone,
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
import {
  orionStyleRiskMatrixRows,
  wikipediaStatusLine,
  type OrionSurfaceKpis,
  type OrionThemeSet,
} from "./orion-classic-theme-set";

function scrub(s: string): string {
  return scrubClientFacingProse(sanitizeOrionGoldenClientText(s));
}

function badgeTone(badge: OrionSurfaceKpis["overallBadge"]): MetricTone {
  if (badge === "Крайне негативный" || badge === "Нежелательный") return "risk";
  if (badge === "Смешанный") return "warn";
  if (badge === "Нейтральный") return "good";
  return "neutral";
}

function adverseTone(pct: number, adverse: number): MetricTone {
  if (pct >= 20 || adverse >= 20) return "risk";
  if (pct >= 8 || adverse >= 3) return "warn";
  if (adverse === 0) return "good";
  return "neutral";
}

function wikiTone(status: OrionSurfaceKpis["wikipediaStatus"]): MetricTone {
  if (status === "WRONG_SUBJECT") return "risk";
  if (status === "AMBIGUOUS") return "warn";
  if (status === "EXACT_SUBJECT") return "good";
  return "neutral";
}

function wikiLabel(status: OrionSurfaceKpis["wikipediaStatus"]): string {
  switch (status) {
    case "EXACT_SUBJECT":
      return "субъект";
    case "WRONG_SUBJECT":
      return "другой субъект";
    case "AMBIGUOUS":
      return "неоднозначно";
    default:
      return "нет статьи";
  }
}

function regionMetrics(kpis: OrionSurfaceKpis, prefix: string): DeckMetric[] {
  return [
    {
      label: `${prefix}: доля нежел.`,
      value: `${kpis.linksAdversePct}%`,
      tone: adverseTone(kpis.linksAdversePct, kpis.linksAdverse),
    },
    {
      label: `${prefix}: ссылки`,
      value: `${kpis.linksAdverse} / ${kpis.linksTotal}`,
      tone: adverseTone(kpis.linksAdversePct, kpis.linksAdverse),
    },
    {
      label: `${prefix}: подсказки`,
      value: `${kpis.suggestionsAdverse} / ${kpis.suggestionsTotal}`,
      tone: adverseTone(
        kpis.suggestionsTotal > 0
          ? Math.round((kpis.suggestionsAdverse / Math.max(kpis.suggestionsTotal, 1)) * 100)
          : 0,
        kpis.suggestionsAdverse
      ),
    },
    {
      label: `${prefix}: изображения`,
      value: `${kpis.imagesAdverse} / ${kpis.imagesTotal}`,
      tone: adverseTone(
        kpis.imagesTotal > 0 ? Math.round((kpis.imagesAdverse / Math.max(kpis.imagesTotal, 1)) * 100) : 0,
        kpis.imagesAdverse
      ),
    },
  ];
}

function executiveDashboardFromTheme(themeSet: OrionThemeSet, base: OrionGoldenDeckSlide): OrionGoldenDeckSlide {
  const paras = scrub(themeSet.executiveNarrative || base.narrative || "")
    .split(/(?<=[.!?])\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 40)
    .slice(0, 3);
  const narrative =
    paras.length > 0
      ? paras.join("\n")
      : scrub(base.narrative || themeSet.executiveNarrative || "").slice(0, 1200);
  const metrics: DeckMetric[] = [
    {
      label: "Россия: доля",
      value: `${themeSet.ru.linksAdversePct}%`,
      tone: adverseTone(themeSet.ru.linksAdversePct, themeSet.ru.linksAdverse),
    },
    {
      label: "Россия: ссылки",
      value: `${themeSet.ru.linksAdverse} из ${themeSet.ru.linksTotal}`,
      tone: adverseTone(themeSet.ru.linksAdversePct, themeSet.ru.linksAdverse),
    },
    {
      label: "ОАЭ: доля",
      value: `${themeSet.uae.linksAdversePct}%`,
      tone: adverseTone(themeSet.uae.linksAdversePct, themeSet.uae.linksAdverse),
    },
    {
      label: "ОАЭ: ссылки",
      value: `${themeSet.uae.linksAdverse} из ${themeSet.uae.linksTotal}`,
      tone: adverseTone(themeSet.uae.linksAdversePct, themeSet.uae.linksAdverse),
    },
  ];
  const matrixTop = orionStyleRiskMatrixRows(themeSet).slice(0, 2);
  const keyFindings =
    matrixTop.length > 0
      ? matrixTop.map((r) => ({
          headline: scrub(r.theme).slice(0, 40),
          detail: scrub(r.summary).slice(0, 170),
          tone: (/высок/i.test(r.level) ? "risk" : "warn") as MetricTone,
        }))
      : (themeSet.executiveBullets.length > 0 ? themeSet.executiveBullets : base.bullets ?? [])
          .slice(0, 2)
          .map((b) => {
            const clean = scrub(b);
            return {
              headline: clean.split(/[—–.:]/)[0]?.slice(0, 40) || "Риск",
              detail: truncateAtWordBoundary(clean, 160),
              tone: "warn" as MetricTone,
            };
          });
  return {
    ...base,
    template: "orion_golden_executive_dashboard",
    narrative,
    metrics,
    keyFindings,
    actions: [
      {
        label: scrub(
          truncateAtWordBoundary(
            themeSet.nextStep || "Провести ручную сверку ключевых источников",
            140
          )
        ),
      },
    ],
    statusBadge: {
      label: `Профиль: ${themeSet.ru.overallBadge} / ${themeSet.uae.overallBadge}`,
      tone: badgeTone(
        themeSet.ru.overallBadge === "Крайне негативный" || themeSet.uae.overallBadge === "Крайне негативный"
          ? "Крайне негативный"
          : themeSet.ru.overallBadge === "Нежелательный" || themeSet.uae.overallBadge === "Нежелательный"
            ? "Нежелательный"
            : themeSet.ru.overallBadge === "Смешанный" || themeSet.uae.overallBadge === "Смешанный"
              ? "Смешанный"
              : themeSet.ru.overallBadge
      ),
    },
  };
}

function riskMatrixFromTheme(themeSet: OrionThemeSet, base: OrionGoldenDeckSlide): OrionGoldenDeckSlide {
  const rows = orionStyleRiskMatrixRows(themeSet).slice(0, 6);
  const toneFor = (level: string): MetricTone => {
    if (/высок/i.test(level)) return "risk";
    if (/средн/i.test(level)) return "warn";
    return "neutral";
  };
  return {
    ...base,
    template: "orion_golden_risk_matrix_grid",
    keyFindings: rows.map((r) => ({
      headline: scrub(r.theme),
      detail: scrub(
        r.summary.replace(new RegExp(`^${r.theme.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[—–:-]?\\s*`, "i"), "")
      ).slice(0, 180),
      tone: toneFor(r.level),
      severity: r.level,
      status: r.level,
      manualReview: /требует/i.test(r.level) ? "Маркер: ручная проверка" : undefined,
    })),
    bullets: rows.map((r) => `${r.theme} — ${r.level}: ${r.summary}`),
  };
}

function profileOverviewFromTheme(themeSet: OrionThemeSet, base: OrionGoldenDeckSlide): OrionGoldenDeckSlide {
  const metrics: DeckMetric[] = [
    ...regionMetrics(themeSet.ru, "RU").slice(0, 4),
    ...regionMetrics(themeSet.uae, "ОАЭ").slice(0, 4),
  ];
  const complianceFindings = themeSet.complianceSignals.slice(0, 3).map((c) => ({
    headline: c.provider,
    detail: scrub(c.statusLine.replace(new RegExp(`^${c.provider}:\\s*`, "i"), "") || c.detail).slice(0, 120),
    tone: (c.hasDbHit ? "warn" : "neutral") as MetricTone,
  }));
  return {
    ...base,
    template: "orion_golden_profile_overview",
    metrics,
    statusBadge: {
      label: `Итог: RU ${themeSet.ru.overallBadge} · ОАЭ ${themeSet.uae.overallBadge}`,
      tone: badgeTone(themeSet.ru.overallBadge),
    },
    keyFindings:
      complianceFindings.length > 0
        ? [
            {
              headline: "Wikipedia RU",
              detail: scrub(wikipediaStatusLine(themeSet.ru)).slice(0, 140),
              tone: wikiTone(themeSet.ru.wikipediaStatus),
            },
            ...complianceFindings,
          ].slice(0, 3)
        : [
            {
              headline: "Wikipedia RU",
              detail: scrub(wikipediaStatusLine(themeSet.ru)).slice(0, 140),
              tone: wikiTone(themeSet.ru.wikipediaStatus),
            },
          ],
  };
}

function regionalMetricsSlide(
  themeSet: OrionThemeSet,
  region: "RU" | "UAE",
  base: OrionGoldenDeckSlide
): OrionGoldenDeckSlide {
  const kpis = region === "RU" ? themeSet.ru : themeSet.uae;
  const prefix = region === "RU" ? "Россия" : "ОАЭ";
  return {
    ...base,
    template: "orion_golden_metrics_dashboard",
    metrics: [
      ...regionMetrics(kpis, prefix),
      {
        label: `${prefix}: related`,
        value: `${kpis.relatedAdverse} / ${kpis.relatedTotal}`,
        tone: adverseTone(
          kpis.relatedTotal > 0 ? Math.round((kpis.relatedAdverse / Math.max(kpis.relatedTotal, 1)) * 100) : 0,
          kpis.relatedAdverse
        ),
      },
      {
        label: "Wikipedia",
        value: wikiLabel(kpis.wikipediaStatus),
        tone: wikiTone(kpis.wikipediaStatus),
      },
    ],
    statusBadge: { label: kpis.overallBadge, tone: badgeTone(kpis.overallBadge) },
    narrative: scrub(
      base.narrative ||
        `${prefix}: ${kpis.linksAdversePct}% потенциально нежелательных ссылок (${kpis.linksAdverse} из ${kpis.linksTotal}). Оценка профиля — ${kpis.overallBadge}.`
    ),
  };
}

function enrichSlideWithThemeSet(
  slide: OrionGoldenDeckSlide,
  slot: First36SlotDef,
  themeSet: OrionThemeSet | null | undefined
): OrionGoldenDeckSlide {
  if (!themeSet) return slide;
  if (slot.page === 3) return executiveDashboardFromTheme(themeSet, slide);
  if (slot.page === 4) return riskMatrixFromTheme(themeSet, slide);
  if (slot.page === 5) return profileOverviewFromTheme(themeSet, slide);
  if (slot.page === 7 || slot.page === 8) return regionalMetricsSlide(themeSet, "RU", slide);
  if (slot.page === 24 || slot.page === 25) return regionalMetricsSlide(themeSet, "UAE", slide);
  if (slot.page === 13 || slot.kind === "wikipedia") {
    const kpis = themeSet.ru;
    return {
      ...slide,
      template: "orion_golden_metrics_dashboard",
      statusBadge: {
        label: `Wikipedia: ${wikiLabel(kpis.wikipediaStatus)}`,
        tone: wikiTone(kpis.wikipediaStatus),
      },
      metrics: [
        {
          label: "Статус",
          value: wikiLabel(kpis.wikipediaStatus),
          tone: wikiTone(kpis.wikipediaStatus),
        },
        {
          label: "Статья",
          value: kpis.wikipediaTitle ? scrub(kpis.wikipediaTitle).slice(0, 28) : "нет",
          tone: wikiTone(kpis.wikipediaStatus),
        },
      ],
      narrative: scrub(
        wikipediaStatusLine(kpis) +
          (kpis.wikipediaStatus === "WRONG_SUBJECT"
            ? " Карточка не является профилем проверяемого лица — исключить из digital profile либо проверить identity."
            : "")
      ),
      actions:
        kpis.wikipediaStatus === "WRONG_SUBJECT" || kpis.wikipediaStatus === "AMBIGUOUS"
          ? [{ label: "Исключить из digital profile либо сверить identity по URL" }]
          : undefined,
      bullets: slide.bullets?.slice(0, 3),
    };
  }
  return slide;
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
    const themeMatch = caption.match(/тем[аы][:\s]+([^.;]+)/i);
    const themeHint = themeMatch?.[1]?.trim();
    const adverseHint = /нежелат|PEP|RCA|санкц/i.test(caption);
    headlineConclusion = isApiSynthetic
      ? `Первый экран выдачи (${regionLabel}): API-реконструкция`
      : `Первый экран поисковой выдачи (${regionLabel})`;
    whatIsVisible = scrub(
      adverseHint || themeHint
        ? [
            themeHint
              ? `Красным выделены результаты по теме: ${themeHint}.`
              : "Красным выделены результаты с риск-сигналами (PEP/RCA, санкции, нежелательные публикации).",
            "Это не общий фон выдачи, а конкретные домены/заголовки первого экрана.",
          ].join(" ")
        : caption ||
            `Показаны заголовки и домены первого экрана поиска (${regionLabel}).`
    );
    whyItMatters = scrub(
      "Клиент сразу видит, какие источники формируют первое впечатление о субъекте."
    );
    recommendedActions = [
      "Сверить выделенные домены с ручной проверкой выдачи",
      "Отделить результаты субъекта от однофамильцев",
    ];
    limitations = isApiSynthetic
      ? [
          "Реконструкция на основе сохранённых результатов API; интерфейс браузера может отличаться.",
        ]
      : ["Визуал отражает доступный снимок на момент сбора."];
  } else if (slot.kind === "image_visual") {
    const hasAdverseFrame = /красн|нежелательн|санкц/i.test(caption);
    // Prefer concrete domain/theme reasons from caption after the count sentence.
    const afterCount = caption.replace(/^.*?отмечены[^.]*\.\s*/i, "");
    const reasonBits = afterCount
      .split(/[.;]/)
      .map((s) => s.trim())
      .filter(
        (s) =>
          s.length > 8 &&
          !/остальн|нейтральн|требуется сверк|подборка/i.test(s) &&
          (/—|:|санкц|нежелат|компромат|watchlist|PEP|RCA|домен/i.test(s) || /\.[a-z]{2,}/i.test(s))
      )
      .slice(0, 3);
    const countMatch = caption.match(/\((\d+)\)/) || caption.match(/отмечены[^\d]*(\d+)/i);
    const adverseCount = countMatch?.[1];
    headlineConclusion = hasAdverseFrame
      ? scrub(
          adverseCount
            ? `${adverseCount} кадра отмечены как нежелательные (${regionLabel})`
            : `В выдаче изображений (${regionLabel}) есть нежелательные кадры`
        )
      : `Изображения в поиске (${regionLabel})`;
    whatIsVisible = scrub(
      reasonBits.length > 0
        ? `Почему красная рамка: ${reasonBits.join("; ")}.`
        : hasAdverseFrame
          ? "Красная рамка — кадр из нежелательного/санкционного контекста (домен, подпись или риск-тема)."
          : caption || "Подборка изображений из поиска; красных рамок на странице нет."
    );
    whyItMatters = scrub(
      hasAdverseFrame
        ? "Нужно сверить: это субъект аудита или однофамилец/чужой контекст."
        : "Изображения влияют на узнаваемость; ошибочные совпадения отделяют от профиля."
    );
    recommendedActions = hasAdverseFrame
      ? ["Проверить, относится ли обведённый кадр к субъекту аудита"]
      : ["Сверить совпадение лица/контекста с субъектом"];
    limitations = [
      "Сетка из сохранённых результатов поиска изображений; превью зависят от URL.",
    ];
  } else if (slot.kind === "suggestions_visual") {
    const savedOnly = /сохранено|не подтвержд/i.test(`${caption} ${title} ${provenanceLabel(asset)}`);
    const engine =
      /google/i.test(`${asset.assetRef} ${title}`)
        ? "Google"
        : /yandex|яндекс/i.test(`${asset.assetRef} ${title}`)
          ? "Яндекс"
          : "поиска";
    const adverseSuggest = /скандал|санкц|арест|корруп|негатив|scandal|sanction/i.test(
      `${caption} ${title}`
    );
    headlineConclusion = scrub(
      adverseSuggest
        ? `Подсказки ${engine} (${regionLabel}): есть риск-ассоциации`
        : savedOnly
          ? `Подсказки (${regionLabel}): сохранённые строки`
          : `Подсказки ${engine} (${regionLabel})`
    );
    whatIsVisible = scrub(
      adverseSuggest
        ? "Среди сохранённых подсказок есть формулировки с негативным/санкционным оттенком рядом с именем."
        : caption ||
            `Панель сохранённых подсказок автодополнения (${regionLabel}); не live-список браузера.`
    );
    whyItMatters = scrub(
      "Подсказки показывают, какие темы поиск связывает с именем до разбора полной выдачи."
    );
    recommendedActions = [
      "Отметить подсказки с негативным или санкционным оттенком",
    ];
    limitations = savedOnly
      ? ["Движок не подтверждён; строки из сохранённой поверхности кейса."]
      : ["Панель из сохранённых SUGGESTION-строк, не live autocomplete."];
  } else if (slot.kind === "related_visual") {
    const isSecondarySuggest = /дополнительн|подсказ/i.test(`${caption} ${title}`);
    headlineConclusion = scrub(
      isSecondarySuggest
        ? `Дополнительные поисковые ассоциации (${regionLabel})`
        : `Связанные запросы (${regionLabel}): соседние темы в выдаче`
    );
    whatIsVisible = scrub(
      [
        isSecondarySuggest
          ? `Отдельные связанные запросы для региона «${regionLabel}» не сохранены; показан второй набор подсказок как ближайший аналог «похожих запросов».`
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
    limitations = isSecondarySuggest
      ? ["Показан второй набор подсказок: отдельных related-строк в кейсе не было."]
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

  const shortProv =
    provenanceLabel(asset).includes("API")
      ? "API"
      : provenanceLabel(asset).includes("Wikipedia")
        ? "Wikipedia"
        : provenanceLabel(asset).includes("изображ")
          ? "Images"
          : provenanceLabel(asset).slice(0, 18);

  return {
    assetRef: asset.assetRef,
    headlineConclusion: truncateAtWordBoundary(scrub(headlineConclusion), 140),
    whatIsVisible: truncateAtWordBoundary(scrub(whatIsVisible), 420),
    metrics: [
      { label: "Регион", value: regionLabel, tone: "neutral" as const },
      { label: "Источник", value: shortProv, tone: "neutral" as const },
    ],
    whyItMatters: truncateAtWordBoundary(scrub(whyItMatters), 220),
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
  assets: ReportAssetV1[] = [],
  options?: { themeSet?: OrionThemeSet | null }
): OrionGoldenDeckManifest {
  assertFirst36RegistryIntegrity();

  const themeSet = options?.themeSet ?? null;
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
    slide = enrichSlideWithThemeSet(slide, slot, themeSet);
    const preserveNarrativeBreaks = [3, 5, 7, 8, 24, 25].includes(slot.page);
    slide = {
      ...slide,
      slideKey: slot.slotId,
      pageNumber: slot.page,
      title: scrub(slide.title || slot.title),
      narrative: slide.narrative
        ? preserveNarrativeBreaks
          ? slide.narrative
              .split("\n")
              .map((line) => scrub(line))
              .filter(Boolean)
              .join("\n")
          : scrub(slide.narrative)
        : undefined,
      bullets: slide.bullets?.map((b) => scrub(b)).filter(Boolean),
      clientTakeaway: slide.clientTakeaway ? scrub(slide.clientTakeaway) : undefined,
      metrics: slide.metrics,
      statusBadge: slide.statusBadge,
      keyFindings: slide.keyFindings?.map((f) => ({
        ...f,
        headline: scrub(f.headline),
        detail: scrub(f.detail),
      })),
      actions: slide.actions?.map((a) => ({
        label: scrub(a.label),
        rationale: a.rationale ? scrub(a.rationale) : undefined,
      })),
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
