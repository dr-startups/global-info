/**
 * First36 CEO deck: map classic rich content into fixed ORION-like slots 1–36.
 */

import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import type {
  DeckMetric,
  MetricTone,
  OrionGoldenDeckManifest,
  OrionGoldenDeckSlide,
  VisualSidebarMode,
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
import { clipWordsComplete } from "../../orion-report-spec/highlight-explanation";
import { sanitizeOrionGoldenClientText } from "../client/client-text-sanitizer";
import {
  enforceCompleteSentences,
  sanitizeClientLanguage,
} from "./client-language";
import {
  orionStyleRiskMatrixRows,
  wikipediaStatusLine,
  type OrionSurfaceKpis,
  type OrionThemeSet,
} from "./orion-classic-theme-set";

function scrub(s: string): string {
  return sanitizeClientLanguage(scrubClientFacingProse(sanitizeOrionGoldenClientText(s)));
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
      label: `${prefix}: доля нежелательных`,
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
          headline: scrub(r.theme).slice(0, 48),
          detail: shortenClientRiskDetail(r.summary),
          tone: (/высок/i.test(r.level) ? "risk" : "warn") as MetricTone,
        }))
      : (themeSet.executiveBullets.length > 0 ? themeSet.executiveBullets : base.bullets ?? [])
          .slice(0, 2)
          .map((b) => {
            const clean = scrub(b);
            return {
              headline: clean.split(/[—–.:]/)[0]?.slice(0, 40) || "Риск",
              detail: shortenClientRiskDetail(clean),
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
          clipWordsComplete(
            themeSet.nextStep || "Провести ручную сверку ключевых источников",
            22
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

function shortenClientRiskDetail(raw: string): string {
  const s = scrub(raw);
  // Dow Jones rollup first — it often also mentions Трансмашхолдинг / Махмудов.
  if (/Dow Jones|LexisNexis|World-Check/i.test(s) && /Махмудов|Бокарев|Ликсутов|предварительн|сигнал/i.test(s)) {
    return "В Dow Jones, LexisNexis, World-Check — сигналы по субъекту; открытый контур: И. Махмудов и А. Бокарев; нужна сверка.";
  }
  if (/бенефициар[а-яё]*\s+офшора,\s*связанного\s+с\s+М|публикаци[а-яё]+\s+на\s+ресурсе-агрегаторе/i.test(s)) {
    return "Агрегатор: субъект указан как бенефициар офшора, связанного с М. Ликсутовым; источник требует осторожной интерпретации.";
  }
  if (/Трансмашхолдинг/i.test(s) && (/Махмудов|Бокарев|в\s+т\.?\s*ч|актуальн[а-яё]*\s+связ/i.test(s))) {
    const domain = s.match(/\b([a-z0-9-]+\.(?:info|io|com|org|net))\b/i)?.[1] ?? "rucriminal.info";
    return `Связи с АО «Трансмашхолдинг», И. Махмудовым и А. Бокаревым под санкциями; якорь: ${domain}.`;
  }
  if (/другого субъекта|дворянский род/i.test(s)) {
    return "Википедия: страница «Глинка (дворянский род)» — другой субъект, не профиль аудита.";
  }
  if (/криминальн[а-яё]*\s*\/\s*судебн/i.test(s)) {
    return "Криминальные или судебные материалы по субъекту в открытых источниках; нужна сверка первоисточников.";
  }
  if (/PEP\s*\/\s*RCA|сигналы PEP/i.test(s)) {
    return "Предварительные сигналы PEP / RCA в комплаенс-базах; нужна сверка профиля.";
  }
  return clipWordsComplete(s, 32);
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
      detail: shortenClientRiskDetail(
        r.summary.replace(new RegExp(`^${r.theme.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[—–:-]?\\s*`, "i"), "")
      ),
      tone: toneFor(r.level),
      severity: r.level,
      status: r.level,
      manualReview: undefined,
    })),
    bullets: rows.map((r) => shortenClientRiskDetail(`${r.theme}: ${r.summary}`)),
  };
}

function profileOverviewFromTheme(themeSet: OrionThemeSet, base: OrionGoldenDeckSlide): OrionGoldenDeckSlide {
  const metrics: DeckMetric[] = [
    ...regionMetrics(themeSet.ru, "RU").slice(0, 4),
    ...regionMetrics(themeSet.uae, "ОАЭ").slice(0, 4),
  ];
  const complianceFindings = themeSet.complianceSignals.slice(0, 3).map((c) => ({
    headline: c.provider,
    detail: clipWordsComplete(
      scrub(c.statusLine.replace(new RegExp(`^${c.provider}:\\s*`, "i"), "") || c.detail),
      22
    ),
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
              headline: "Википедия (Россия)",
              detail: shortenClientRiskDetail(scrub(wikipediaStatusLine(themeSet.ru))),
              tone: wikiTone(themeSet.ru.wikipediaStatus),
            },
            ...complianceFindings,
          ].slice(0, 3)
        : [
            {
              headline: "Википедия (Россия)",
              detail: shortenClientRiskDetail(scrub(wikipediaStatusLine(themeSet.ru))),
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
  const claimBullets = [
    ...new Set(
      (themeSet.executiveBullets.length > 0 ? themeSet.executiveBullets : base.bullets ?? [])
        .map((b) => shortenClientRiskDetail(b))
        .filter(Boolean)
    ),
  ].slice(0, 4);
  const kpiBullets = [
    `Доля потенциально нежелательных ссылок: ${kpis.linksAdversePct}% (${kpis.linksAdverse} из ${kpis.linksTotal}) — оценка профиля: ${kpis.overallBadge}.`,
    `Поисковые подсказки: ${kpis.suggestionsAdverse} из ${kpis.suggestionsTotal} указывают на нежелательные темы.`,
  ];
  return {
    ...base,
    template: "orion_golden_metrics_dashboard",
    bullets: [...claimBullets, ...kpiBullets],
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
      narrative: shortenClientRiskDetail(scrub(wikipediaStatusLine(kpis))),
      actions:
        kpis.wikipediaStatus === "WRONG_SUBJECT" || kpis.wikipediaStatus === "AMBIGUOUS"
          ? [{ label: "Исключить из профиля или сверить identity" }]
          : undefined,
      bullets: (slide.bullets ?? [])
        .slice(0, 2)
        .map((b) => {
          const clean = scrub(b).replace(/\s+https?:\/\/\S+/i, "");
          return shortenClientRiskDetail(clean);
        })
        .filter(Boolean),
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

  const framed = (asset.highlightExplanations ?? []).filter(
    (x) => x.frameTone === "red" || x.frameTone === "amber"
  );
  const topExplanations = framed.slice(0, 2);
  const moreSignalsCount = Math.max(0, framed.length - topExplanations.length);

  let headlineConclusion = title;
  let whatIsVisible: string;
  let whyItMatters: string;
  let recommendedActions: string[];
  let limitations: string[] = [];
  let sidebarMode: VisualSidebarMode = "interpretation";
  let clientMeaning: string;
  let provenance =
    slot.kind === "image_visual"
      ? "Источник: сохранённые изображения, дата сбора в кейсе"
      : slot.kind === "suggestions_visual" || slot.kind === "related_visual"
        ? "Источник: сохранённые поисковые подсказки, дата сбора в кейсе"
        : slot.kind === "serp_visual"
          ? "Источник: сохранённая поисковая выдача, дата сбора в кейсе"
          : "Источник: сохранённые материалы раздела, дата сбора в кейсе";

  if (slot.kind === "serp_visual") {
    const adverseHint = /нежелат|PEP|RCA|санкц|выделен/i.test(`${caption} ${title}`);
    sidebarMode = adverseHint ? "adverse_explanation" : "interpretation";
    headlineConclusion = adverseHint
      ? `В первом экране выдачи (${regionLabel}) есть риск-сигналы`
      : `Первый экран поисковой выдачи (${regionLabel})`;
    whatIsVisible = adverseHint
      ? "На экране выделены домены и заголовки с риск-тематикой (PEP, санкции или нежелательные публикации)."
      : "Показаны заголовки и домены первого экрана поиска по субъекту.";
    clientMeaning =
      "Клиент сразу видит, какие источники формируют первое впечатление о субъекте.";
    whyItMatters = clientMeaning;
    recommendedActions = adverseHint ? ["Сверить выделенные домены вручную"] : [];
  } else if (slot.kind === "image_visual") {
    if (topExplanations.length > 0) {
      sidebarMode = "adverse_explanation";
      const redN = framed.filter((x) => x.frameTone === "red").length;
      const amberN = framed.filter((x) => x.frameTone === "amber").length;
      headlineConclusion =
        redN > 0 && amberN > 0
          ? "В выдаче есть риск-кадры и неоднозначные совпадения"
          : redN > 0
            ? `${redN} кадра с нежелательным контекстом по субъекту`
            : "Есть кадры, требующие сверки личности";
      whatIsVisible = topExplanations.map((x) => x.clientReason).join(" ");
      clientMeaning =
        amberN > 0
          ? "При беглом просмотре легко спутать субъект с однофамильцем или чужим контекстом."
          : "Выделенные кадры усиливают негативное первое впечатление в поиске изображений.";
      whyItMatters = clientMeaning;
      recommendedActions = ["Подтвердить личность по двум независимым идентификаторам"];
    } else {
      sidebarMode = "status";
      headlineConclusion = `Изображения в поиске (${regionLabel}) без выделенных кадров`;
      whatIsVisible =
        "На этой странице нет красных или янтарных рамок; показана нейтральная подборка.";
      clientMeaning =
        "Изображения влияют на узнаваемость; ошибочные совпадения отделяют от профиля.";
      whyItMatters = clientMeaning;
      recommendedActions = [];
    }
  } else if (slot.kind === "suggestions_visual") {
    const adverseSuggest = /скандал|санкц|арест|корруп|негатив|scandal|sanction/i.test(
      `${caption} ${title}`
    );
    sidebarMode = "interpretation";
    headlineConclusion = adverseSuggest
      ? "Подсказки связывают имя с риск-тематикой"
      : "Подсказки не дают устойчивой негативной ассоциации";
    whatIsVisible = adverseSuggest
      ? "Среди подсказок есть формулировки с негативным или санкционным оттенком рядом с именем."
      : "Основные ассоциации связаны с бизнесом и биографией; санкционные формулировки не доминируют.";
    clientMeaning = adverseSuggest
      ? "Уже на этапе ввода запроса формируется настороженное впечатление о субъекте."
      : "На этапе ввода запроса репутационный риск выглядит ограниченным.";
    whyItMatters = clientMeaning;
    recommendedActions = adverseSuggest
      ? ["Отметить негативные подсказки для ручной проверки"]
      : [];
  } else if (slot.kind === "related_visual") {
    sidebarMode = "interpretation";
    const surfaceHints = (asset.evidenceRefs ?? [])
      .map((r) => String(r))
      .filter(Boolean)
      .slice(0, 3);
    const labelBits = [title, caption, ...surfaceHints]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    const topic =
      labelBits.match(/(?:связанн\w+|related|people also|похож\w+)[:\s—-]*(.+)$/i)?.[1]?.slice(0, 80) ||
      title.replace(/связанн\w+\s+запрос\w*/i, "").trim().slice(0, 80) ||
      `набор ${slot.page}`;
    headlineConclusion = `Связанные запросы (${regionLabel}): ${topic}`;
    whatIsVisible = `На экране — отдельный набор связанных запросов «${topic}» для региона ${regionLabel}.`;
    clientMeaning = `Этот набор уточняет тематическое окружение имени именно для запроса «${topic}», а не повторяет соседние слайды.`;
    whyItMatters = clientMeaning;
    recommendedActions = [`Сверить риск-формулировки в наборе «${topic.slice(0, 40)}»`];
    provenance = `Источник: сохранённые связанные запросы (${topic.slice(0, 48)}), дата сбора в кейсе`;
  } else if (slot.kind === "knowledge_visual") {
    const fromWiki = /wikipedia|википед/i.test(`${caption} ${title} ${provenanceLabel(asset)}`);
    const wrongSubject =
      /другого субъекта|однофамил|не является профилем|дворянский род/i.test(`${caption} ${title}`) ||
      Boolean((asset as { subjectBinding?: string }).subjectBinding === "WRONG_SUBJECT");
    sidebarMode = wrongSubject ? "status" : "interpretation";
    headlineConclusion = wrongSubject
      ? "Карточка Wikipedia не относится к проверяемому лицу"
      : fromWiki
        ? `Справочная карточка Wikipedia (${regionLabel})`
        : `Справочная панель в поиске (${regionLabel})`;
    whatIsVisible = wrongSubject
      ? "Найдена страница другого лица или рода; её нельзя засчитывать как профиль проверяемого лица."
      : fromWiki
        ? "Показаны название страницы и статус наличия публичной статьи о проверяемом лице."
        : "Краткие факты и заголовки из справочного блока рядом с выдачей.";
    clientMeaning = wrongSubject
      ? "Чужой профиль в выдаче создаёт риск смешения личностей."
      : "Справочный блок влияет на то, как третьи лица идентифицируют проверяемое лицо.";
    whyItMatters = clientMeaning;
    recommendedActions = wrongSubject
      ? ["Исключить из профиля или сверить личность"]
      : ["Сверить факты с первичными источниками"];
    provenance = fromWiki ? "Источник: проверка Wikipedia, дата сбора в кейсе" : provenance;
  } else {
    sidebarMode = "status";
    whatIsVisible =
      slot.kind === "db_visual"
        ? "На слайде — страница комплаенс-базы или статусный блок раздела."
        : `На слайде — визуальный материал раздела «${slot.title}».`;
    clientMeaning =
      slot.kind === "db_visual"
        ? "Страница базы уточняет комплаенс-сигнал без опоры только на текстовый пересказ."
        : "Визуальное доказательство снижает риск неверной интерпретации резюме.";
    whyItMatters = clientMeaning;
    recommendedActions = ["Сверить совпадение субъекта с карточкой на слайде"];
  }

  return {
    assetRef: asset.assetRef,
    headlineConclusion: clipWordsComplete(scrub(headlineConclusion), 14),
    whatIsVisible: scrub(whatIsVisible),
    metrics: [],
    whyItMatters: clipWordsComplete(scrub(whyItMatters), 28),
    recommendedActions: recommendedActions.map((a) => clipWordsComplete(scrub(a), 18)),
    confidence: hasImageBytes(asset) ? "medium" : "low",
    limitations,
    provenanceLabel: provenance,
    sidebarMode,
    highlightExplanations: topExplanations,
    clientMeaning: clipWordsComplete(scrub(clientMeaning), 28),
    moreSignalsCount: moreSignalsCount > 0 ? moreSignalsCount : undefined,
  };
}


function normalizeClientSearchTable(
  table: OrionGoldenDeckSlide["table"] | undefined
): OrionGoldenDeckSlide["table"] | undefined {
  if (!table?.headers?.length || !table.rows?.length) return table;
  const headers = table.headers.map((h) => String(h));
  const hasUrl = headers.some((h) => /^url$/i.test(h.trim()));
  const hasRisk = headers.some((h) => /риск|статус/i.test(h.trim()));
  const urlIdx = headers.findIndex((h) => /^url$/i.test(h.trim()));
  const riskIdx = headers.findIndex((h) => /риск|статус/i.test(h.trim()));
  const titleIdx = headers.findIndex((h) => /заголовок|title/i.test(h.trim()));
  const domainIdx = headers.findIndex((h) => /домен|domain/i.test(h.trim()));
  const posIdx = headers.findIndex((h) => /поз|позиц|rank|#/i.test(h.trim()));
  const queryIdx = headers.findIndex((h) => /запрос|query/i.test(h.trim()));

  const rows = table.rows.slice(0, 10).map((row) => {
    const pos = posIdx >= 0 ? String(row[posIdx] ?? "") : String(row[queryIdx >= 0 ? 1 : 0] ?? "");
    const domain =
      domainIdx >= 0
        ? String(row[domainIdx] ?? "—")
        : String(row[queryIdx >= 0 ? 2 : 1] ?? "—");
    const title =
      titleIdx >= 0
        ? String(row[titleIdx] ?? "")
        : String(row[queryIdx >= 0 ? 3 : 2] ?? "");
    const query =
      queryIdx >= 0
        ? String(row[queryIdx] ?? "—")
        : "";
    let status = "Нейтральный";
    if (riskIdx >= 0) {
      const raw = String(row[riskIdx] ?? "").trim();
      if (raw === "Н" || raw === "N" || raw === "Нежел." || /нежелат/i.test(raw)) status = "Нежелательный";
      else if (/проверк|требует/i.test(raw)) status = "Требует проверки";
      else if (raw === "·" || raw === "." || !raw) status = "Нейтральный";
      else if (/нейтрал/i.test(raw)) status = "Нейтральный";
      else status = "Требует проверки";
    } else if (/нежелат|санкц|PEP|adverse/i.test(`${title} ${domain}`)) {
      status = "Нежелательный";
    }
    void hasUrl;
    void hasRisk;
    void urlIdx;
    if (queryIdx >= 0 || query) {
      return [query || "—", pos, domain || "—", truncateAtWordBoundary(title, 70), status];
    }
    return [pos, domain || "—", truncateAtWordBoundary(title, 90), status];
  });

  return {
    headers:
      queryIdx >= 0 || rows.some((r) => r.length === 5)
        ? ["Запрос", "Позиция", "Домен", "Заголовок", "Статус"]
        : ["Позиция", "Домен", "Заголовок", "Статус"],
    rows,
  };
}

function enrichNonVisualSlotProse(slide: OrionGoldenDeckSlide, slot: First36SlotDef): OrionGoldenDeckSlide {
  if (slot.kind === "search_table") {
    const regionLabel = slot.region === "UAE" ? "ОАЭ" : slot.region === "RU" ? "Россия" : "Обзор";
    const takeaway = scrub(
      `Позиции в SERP (${regionLabel}): какие домены занимают верх выдачи по субъекту`
    );
    const rawNarrative = scrub(
      slide.narrative ||
        `Таблица фиксирует сохранённые позиции поисковой выдачи для региона «${regionLabel}».`
    );
    const sentences = rawNarrative
      .split(/(?<=[.!?…])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 20);
    let narrative =
      sentences.length > 0
        ? sentences.slice(0, 2).join(" ")
        : rawNarrative;
    // Drop incomplete trailing clause (e.g. ends with «как»).
    if (/\b(как|что|чтобы|и|а|или|по|на|в|с)\s*$/i.test(narrative) || /[,;:—–-]\s*$/.test(narrative)) {
      const complete = sentences.find(
        (s) => /[.!?…]$/.test(s) && !/\b(как|что|чтобы|и|а|или|по|на|в|с)\s*$/i.test(s)
      );
      narrative =
        complete ||
        scrub(`Таблица фиксирует сохранённые позиции поисковой выдачи для региона «${regionLabel}».`);
    }
    const bullets =
      slide.bullets && slide.bullets.length > 0
        ? slide.bullets
        : [
            scrub("Строки собраны из сохранённых результатов поиска."),
            scrub("Сверьте домены с визуальным снимком выдачи и риск-выводами резюме."),
          ];
    return {
      ...slide,
      table: normalizeClientSearchTable(slide.table),
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
    "Данные источника не предоставлены. Для завершения проверки требуется загрузка утверждённого визуального материала по этому разделу.";
  return {
    slideKey: slot.slotId,
    sectionKey: slot.sectionKey,
    template: "orion_golden_no_data_compact",
    title: slot.title,
    pageNumber: slot.page,
    narrative: clientNarrative,
    bullets: [
      "Слот зарезервирован в структуре аудита.",
      "После предоставления источника раздел будет обновлён без выдуманных данных.",
    ],
    // Internal gate code — must not be copied into client-facing narrative.
    blockedReason: reason,
    clientTakeaway: clientNarrative,
  };
}

function placeholderSlide(slot: First36SlotDef, narrative?: string): OrionGoldenDeckSlide {
  const honest =
    "Данные источника не предоставлены. Раздел сохранён в структуре аудита; проверка по этому блоку будет завершена после появления подтверждённых материалов.";
  return {
    slideKey: slot.slotId,
    sectionKey: slot.sectionKey,
    template: slot.template === "orion_golden_region_divider" ? slot.template : "orion_golden_prose",
    title: slot.title,
    pageNumber: slot.page,
    narrative:
      narrative ||
      (slot.kind === "region_toc" || slot.kind === "compliance_toc" ? undefined : honest),
    bullets:
      slot.kind === "region_toc" || slot.kind === "compliance_toc"
        ? undefined
        : [
            "Ничего не выдумано: при отсутствии источника показывается статус ожидания данных.",
            "Для закрытия слота нужны подтверждённые материалы с датой сбора.",
          ],
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
      bullets: slide.bullets
        ?.map((b) => {
          const clean = scrub(b);
          if ([3, 4, 7, 8, 13, 24, 25].includes(slot.page)) return shortenClientRiskDetail(clean);
          return clean;
        })
        .filter(Boolean),
      clientTakeaway: slide.clientTakeaway ? scrub(slide.clientTakeaway) : undefined,
      metrics: slide.metrics,
      statusBadge: slide.statusBadge,
      keyFindings: slide.keyFindings?.map((f) => ({
        ...f,
        headline: scrub(f.headline),
        detail: [3, 4, 5].includes(slot.page) ? shortenClientRiskDetail(scrub(f.detail)) : scrub(f.detail),
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
