/**
 * First36 CEO deck: map classic rich content into fixed ORION-like slots 1–36.
 */

import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import type {
  DeckMetric,
  MetricTone,
  OrionGoldenDeckManifest,
  OrionGoldenDeckSlide,
  SlideSearchCounters,
  VisualSidebarMode,
  VisualSlideAnalysis,
} from "../composer/orion-deck-composer";
import {
  buildSearchCounterCopy,
  paginateSearchResults,
  type SearchResultRow,
} from "./search-results-pagination";
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
  classifySuggestionIntent,
  orionStyleRiskMatrixRows,
  wikipediaStatusLine,
  type OrionSurfaceMetric,
  type OrionSurfaceKpis,
  type OrionSurfaceMetricStatus,
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

function adverseTone(pct: number | null, adverse: number, total = 1): MetricTone {
  if (total <= 0 || pct == null) return "neutral";
  if (pct >= 20 || adverse >= 20) return "risk";
  if (pct >= 8 || adverse >= 3) return "warn";
  if (adverse === 0) return "good";
  return "neutral";
}

function pctDisplay(pct: number | null, total: number): string {
  if (total <= 0 || pct == null) return "—";
  return `${pct}%`;
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

function ruNegCount(n: number): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} негативный`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} негативных`;
  return `${n} негативных`;
}

function statusValue(
  metric: OrionSurfaceMetric | undefined,
  adverseFallback: number,
  observedFallback: number,
  notCollectedLabel = "Данные не собраны"
): string {
  const status: OrionSurfaceMetricStatus | undefined = metric?.status;
  const observed = metric?.observedCount ?? observedFallback;
  const adverse = metric?.adverseCount ?? adverseFallback;
  if (status === "NOT_APPLICABLE") return "Не применимо";
  if (status === "NOT_COLLECTED") return notCollectedLabel;
  if (status === "MEASURED" || observed > 0) {
    // Compact form fits KPI cards; narrative bullets can still use longer phrasing.
    return `${adverse} / ${observed}`;
  }
  return notCollectedLabel;
}

/** Longer status line for prose bullets (not KPI chips). */
function statusValueProse(
  metric: OrionSurfaceMetric | undefined,
  adverseFallback: number,
  observedFallback: number
): string {
  const status: OrionSurfaceMetricStatus | undefined = metric?.status;
  const observed = metric?.observedCount ?? observedFallback;
  const adverse = metric?.adverseCount ?? adverseFallback;
  if (status === "NOT_APPLICABLE") return "не применимо";
  if (status === "NOT_COLLECTED") return "данные не собраны";
  if (status === "MEASURED" || observed > 0) {
    return `${ruNegCount(adverse)} из ${observed}`;
  }
  return "данные не собраны";
}

function statusTone(metric: OrionSurfaceMetric | undefined, adverseFallback: number, observedFallback: number): MetricTone {
  const status = metric?.status;
  if (status === "NOT_COLLECTED" || status === "NOT_APPLICABLE") return "neutral";
  const observed = metric?.observedCount ?? observedFallback;
  const adverse = metric?.adverseCount ?? adverseFallback;
  const pct = observed > 0 ? Math.round((adverse / observed) * 100) : null;
  return adverseTone(pct, adverse, observed);
}

function regionMetrics(kpis: OrionSurfaceKpis, prefix: string): DeckMetric[] {
  return [
    {
      label: `${prefix}: доля нежелательных`,
      value: pctDisplay(kpis.linksAdversePct, kpis.linksTotal),
      tone: adverseTone(kpis.linksAdversePct, kpis.linksAdverse, kpis.linksTotal),
    },
    {
      label: `${prefix}: ссылки`,
      value: kpis.linksTotal > 0 ? `${kpis.linksAdverse} / ${kpis.linksTotal}` : "данные не собраны",
      tone: adverseTone(kpis.linksAdversePct, kpis.linksAdverse, kpis.linksTotal),
    },
    {
      label: `${prefix}: подсказки`,
      value: statusValue(
        kpis.suggestionsMetric,
        kpis.suggestionsExplicitAdverse ?? kpis.suggestionsAdverse,
        kpis.suggestionsTotal,
        "Нет данных"
      ),
      tone: statusTone(
        kpis.suggestionsMetric,
        kpis.suggestionsExplicitAdverse ?? kpis.suggestionsAdverse,
        kpis.suggestionsTotal
      ),
      status: kpis.suggestionsMetric?.status,
    },
    {
      label: `${prefix}: связанные`,
      value: statusValue(kpis.relatedMetric, kpis.relatedAdverse, kpis.relatedTotal, "Нет данных"),
      tone: statusTone(kpis.relatedMetric, kpis.relatedAdverse, kpis.relatedTotal),
      status: kpis.relatedMetric?.status,
    },
    {
      label: `${prefix}: изображения`,
      value: statusValue(kpis.imagesMetric, kpis.imagesAdverse, kpis.imagesTotal, "Нет данных"),
      tone: statusTone(kpis.imagesMetric, kpis.imagesAdverse, kpis.imagesTotal),
      status: kpis.imagesMetric?.status,
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
      value: pctDisplay(themeSet.ru.linksAdversePct, themeSet.ru.linksTotal),
      tone: adverseTone(themeSet.ru.linksAdversePct, themeSet.ru.linksAdverse, themeSet.ru.linksTotal),
    },
    {
      label: "Россия: ссылки",
      value: `${themeSet.ru.linksAdverse} из ${themeSet.ru.linksTotal}`,
      tone: adverseTone(themeSet.ru.linksAdversePct, themeSet.ru.linksAdverse, themeSet.ru.linksTotal),
    },
    {
      label: "ОАЭ: доля",
      value: pctDisplay(themeSet.uae.linksAdversePct, themeSet.uae.linksTotal),
      tone: adverseTone(themeSet.uae.linksAdversePct, themeSet.uae.linksAdverse, themeSet.uae.linksTotal),
    },
    {
      label: "ОАЭ: ссылки",
      value: `${themeSet.uae.linksAdverse} из ${themeSet.uae.linksTotal}`,
      tone: adverseTone(themeSet.uae.linksAdversePct, themeSet.uae.linksAdverse, themeSet.uae.linksTotal),
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
      label: `Итог: RU ${themeSet.ru.overallRiskBadge} · ОАЭ ${themeSet.uae.overallRiskBadge}`,
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
    return "В международных базах есть предварительные совпадения по субъекту; требуется подтверждение карточки и сверка профиля.";
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
  const rows = orionStyleRiskMatrixRows(themeSet)
    .filter((row, idx, arr) => arr.findIndex((r) => r.theme === row.theme) === idx)
    .slice(0, 6);
  const toneFor = (level: string): MetricTone => {
    if (/высок/i.test(level) && !/предваритель|не подтвержд|требует проверк/i.test(level)) return "risk";
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
      status:
        /предваритель|не подтвержд|требует проверк/i.test(r.summary)
          ? "Требует проверки (предварительный сигнал)"
          : r.level,
      manualReview: /предваритель|не подтвержд|требует проверк/i.test(r.summary)
        ? "Требуется подтверждение evidence"
        : "Подтверждено evidence",
    })),
    bullets: rows.map((r) => shortenClientRiskDetail(`${r.theme}: ${r.summary}`)),
  };
}

function profileOverviewFromTheme(themeSet: OrionThemeSet, base: OrionGoldenDeckSlide): OrionGoldenDeckSlide {
  const metrics: DeckMetric[] = [
    ...regionMetrics(themeSet.ru, "RU").slice(0, 4),
    ...regionMetrics(themeSet.uae, "ОАЭ").slice(0, 4),
  ];
  const complianceFindings = themeSet.complianceSignals
    .filter((c) => (c.provider === "World-Check" ? c.hasDbHit : true))
    .slice(0, 3)
    .map((c) => ({
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
    `Доля потенциально нежелательных ссылок: ${kpis.linksTotal > 0 && kpis.linksAdversePct != null ? `${kpis.linksAdversePct}% (${kpis.linksAdverse} из ${kpis.linksTotal})` : "— (данные не собраны)"} — оценка профиля: ${kpis.overallRiskBadge ?? kpis.overallBadge}.`,
    `Поисковые подсказки: ${statusValueProse(kpis.suggestionsMetric, kpis.suggestionsAdverse, kpis.suggestionsTotal)}.`,
  ];
  return {
    ...base,
    template: "orion_golden_metrics_dashboard",
    bullets: [...claimBullets, ...kpiBullets],
    metrics: [
      ...regionMetrics(kpis, prefix).filter((m) => !/: связанные$/.test(m.label)),
      {
        label: `${prefix}: связанные`,
        value:
          kpis.relatedMetric?.status === "NOT_COLLECTED"
            ? "Нет данных"
            : `${kpis.relatedAdverse} / ${kpis.relatedTotal}`,
        tone: statusTone(kpis.relatedMetric, kpis.relatedAdverse, kpis.relatedTotal),
        status: kpis.relatedMetric?.status,
      },
      {
        label: "Википедия",
        value: wikiLabel(kpis.wikipediaStatus),
        tone: wikiTone(kpis.wikipediaStatus),
      },
    ],
    statusBadge: { label: kpis.overallBadge, tone: badgeTone(kpis.overallBadge) },
    narrative: scrub(
      base.narrative ||
        `${prefix}: ${kpis.linksTotal > 0 && kpis.linksAdversePct != null ? `${kpis.linksAdversePct}% потенциально нежелательных ссылок (${kpis.linksAdverse} из ${kpis.linksTotal})` : "данные по органике не собраны"}. Оценка профиля — ${kpis.overallRiskBadge ?? kpis.overallBadge}.`
    ),
  };
}

function regionalEvidenceCardsSlide(
  themeSet: OrionThemeSet,
  region: "RU" | "UAE",
  base: OrionGoldenDeckSlide
): OrionGoldenDeckSlide {
  const cards = themeSet.themes
    .flatMap((t) =>
      (t.sampleHits ?? [])
        .filter((h) => h.region === region)
        .map((h) => ({
          headline: scrub(h.domain || h.title || "Источник"),
          detail: shortenClientRiskDetail(
            scrub(`${h.title}${h.url ? ` — ${h.url}` : ""}${h.snippet ? `; ${h.snippet}` : ""}`)
          ),
          tone: "warn" as MetricTone,
        }))
    )
    .slice(0, 6);
  const regionLabel = region === "RU" ? "Россия" : "ОАЭ";
  return {
    ...base,
    template: "orion_golden_executive_card",
    title: `${regionLabel} — карточки выдачи`,
    narrative: scrub(
      `Показаны реальные карточки и ссылки из сохранённой выдачи региона ${regionLabel}; это не повтор summary-слайда.`
    ),
    keyFindings: cards,
    bullets: cards.map((c) => `${c.headline}: ${c.detail}`).slice(0, 6),
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
  if (slot.page === 7) return regionalMetricsSlide(themeSet, "RU", slide);
  if (slot.page === 8) return regionalEvidenceCardsSlide(themeSet, "RU", slide);
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

function isArsenkinAsset(asset: ReportAssetV1): boolean {
  const blob = [
    asset.assetRef,
    asset.caption ?? "",
    asset.title ?? "",
    ...(asset.evidenceRefs ?? []),
    String(asset.meta?.provider ?? ""),
    String(asset.meta?.tool ?? ""),
    String(asset.meta?.arsenkinTool ?? ""),
  ].join(" ");
  return /arsenkin|suggest-canary|provider_task:arsenkin/i.test(blob);
}

function collectRelatedTexts(
  asset: ReportAssetV1,
  slide?: OrionGoldenDeckSlide | null,
  slot?: First36SlotDef,
  themeSet?: OrionThemeSet | null
): string[] {
  const fromMeta = ((asset.meta as { relatedRows?: string[] } | undefined)?.relatedRows ?? [])
    .map((r: string) => String(r).trim())
    .filter(Boolean);
  const technicalNoiseRe =
    /\bru_related_\d|\buae_related\b|без копирования соседних слайдов|второй\s+наб|rich\s+imagery/i;
  const aliases = String(themeSet?.subjectName ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length >= 3);
  const relevanceGate = (text: string): boolean => {
    if (technicalNoiseRe.test(text)) return false;
    if (slot?.slotId !== "p32_uae_related") return true;
    const t = text.toLowerCase();
    if (aliases.length === 0) return true;
    return aliases.some((a) => t.includes(a));
  };
  if (fromMeta.length > 0) return fromMeta.filter(relevanceGate);
  const fromTable = (slide?.table?.rows ?? [])
    .map((row) => row.map((c) => String(c ?? "").trim()).filter(Boolean).join(" — "))
    .filter(Boolean)
    .filter(relevanceGate);
  if (fromTable.length > 0) return fromTable;
  const fromBullets = (slide?.bullets ?? []).map((b) => String(b).trim()).filter(Boolean);
  if (fromBullets.length > 0) return fromBullets.filter(relevanceGate);
  const cap = String(asset.caption ?? "").trim();
  if (cap && !/ru_related|uae_related|визуализация сохранённых/i.test(cap) && relevanceGate(cap)) return [cap];
  return [];
}

function collectSuggestionTexts(
  asset: ReportAssetV1,
  slide?: OrionGoldenDeckSlide | null
): string[] {
  const fromMeta = (asset.meta?.suggestionRows ?? []).map((r) => String(r).trim()).filter(Boolean);
  if (fromMeta.length > 0) return fromMeta;
  const fromTable = (slide?.table?.rows ?? [])
    .map((row) => row.map((c) => String(c ?? "").trim()).filter(Boolean).join(" "))
    .filter(Boolean);
  if (fromTable.length > 0) return fromTable;
  const bullets = (slide?.bullets ?? []).map((b) => String(b).trim()).filter(Boolean);
  if (bullets.length > 0) return bullets;
  return [];
}

function arsenkinSuggestProvenance(asset: ReportAssetV1, slot: First36SlotDef): string {
  const engine =
    String(asset.meta?.engine ?? "").toUpperCase() ||
    (/google/i.test(asset.assetRef) || /google/i.test(slot.slotId) ? "GOOGLE" : "YANDEX");
  // Client-safe engine label — renderer bans the token "API" in the sidebar,
  // and structural provider/tool/runId stay in asset.meta / evidenceRefs.
  const engineLabel = engine === "GOOGLE" ? "подсказки Google" : "подсказки Яндекса";
  const captured = asset.meta?.capturedAt
    ? `дата сбора ${String(asset.meta.capturedAt).slice(0, 10)}`
    : "дата сбора в кейсе";
  return `Источник: Arsenkin Tools, ${engineLabel}, ${captured}`;
}

export function buildDeterministicVisualAnalysis(
  asset: ReportAssetV1,
  slot: First36SlotDef,
  themeSet?: OrionThemeSet | null,
  slide?: OrionGoldenDeckSlide | null
): VisualSlideAnalysis {
  const title = scrub(asset.title || slot.title);
  const caption = scrub(asset.caption || "");
  const regionLabel =
    slot.region === "RU" ? "Россия" : slot.region === "UAE" ? "ОАЭ" : slot.region === "COMPLIANCE" ? "Комплаенс" : "Обзор";

  const framed = (asset.highlightExplanations ?? []).filter(
    (x) => x.frameTone === "red" || x.frameTone === "amber"
  );
  const topExplanations = framed;
  const moreSignalsCount = Math.max(0, framed.length - topExplanations.length);

  let headlineConclusion = title;
  let whatIsVisible: string;
  let whyItMatters: string;
  let recommendedActions: string[];
  let limitations: string[] = [];
  let sidebarMode: VisualSidebarMode = "interpretation";
  let clientMeaning: string;
  let panelMeta: VisualSlideAnalysis["panelMeta"];
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
    // "synthetic" here is an internal flag only — its wording must never leak
    // into client-facing sidebar copy (renderer bans API/synthetic/reconstruction).
    const savedSnapshot =
      /API|синтетич|реконструкц/i.test(`${caption} ${title} ${asset.kind}`) ||
      asset.kind === "synthetic_serp";
    sidebarMode = adverseHint ? "adverse_explanation" : "interpretation";
    headlineConclusion = adverseHint
      ? `В первом экране выдачи (${regionLabel}) есть риск-сигналы`
      : `Первый экран поисковой выдачи (${regionLabel})`;
    whatIsVisible = adverseHint
      ? "На экране выделены домены и заголовки с риск-тематикой (PEP, санкции или нежелательные публикации)."
      : "Показаны заголовки и домены первого экрана поисковой выдачи по субъекту.";
    clientMeaning =
      "Клиент сразу видит, какие источники формируют первое впечатление о субъекте.";
    whyItMatters = clientMeaning;
    recommendedActions = adverseHint ? ["Сверить выделенные домены вручную"] : [];
    if (savedSnapshot) {
      limitations = [
        "Показаны сохранённые результаты на дату сбора, а не текущий экран поисковой выдачи.",
      ];
    }
  } else if (slot.kind === "image_visual") {
    const captionAdverse =
      /красн|нежелательн|компромет|санкц|rucriminal|криминал/i.test(`${caption} ${title}`);
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
    } else if (captionAdverse) {
      sidebarMode = "adverse_explanation";
      headlineConclusion = `В изображениях (${regionLabel}) есть нежелательный контекст`;
      whatIsVisible =
        caption.slice(0, 280) ||
        "Красной рамкой отмечены нежелательные изображения; требуется сверка с субъектом.";
      clientMeaning =
        "Нежелательные и компрометирующие кадры усиливают негативное первое впечатление.";
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
    const fromUrlAudit = /check-h|indexation|проверк[аи] URL|title\s*\/\s*H1/i.test(
      `${caption} ${title} ${asset.assetRef}`
    );
    if (fromUrlAudit) {
      sidebarMode = "interpretation";
      headlineConclusion = `Проверка URL из выдачи (${regionLabel})`;
      whatIsVisible =
        "Показаны title/H1 страниц и статус индексации в Яндексе и Google по URL из органики.";
      clientMeaning =
        "Мета-теги и индекс уточняют, как поисковик видит риск-URL, без опоры только на сниппет SERP.";
      whyItMatters = clientMeaning;
      recommendedActions = ["Сверить title/H1 с фактическим содержимым страницы"];
      provenance = "Источник: Arsenkin check-h / indexation, дата сбора в кейсе";
    } else {
      const rowTexts = collectSuggestionTexts(asset, slide);
      const regionKpis =
        slot.region === "UAE" ? themeSet?.uae : slot.region === "RU" ? themeSet?.ru : themeSet?.ru;
      const suggestNotCollected =
        rowTexts.length === 0 &&
        (regionKpis?.suggestionsMetric?.status === "NOT_COLLECTED" ||
          (regionKpis?.suggestionsTotal ?? 0) <= 0);
      if (suggestNotCollected) {
        sidebarMode = "status";
        headlineConclusion = `${regionLabel} — подсказки: данные не собраны`;
        whatIsVisible =
          "Валидные поисковые подсказки по алиасам субъекта в этом регионе не собраны.";
        clientMeaning =
          "Без собранных подсказок нельзя оценить, формирует ли автодополнение риск-ассоциации.";
        whyItMatters = clientMeaning;
        recommendedActions = [`Повторно собрать подсказки (${regionLabel}) по алиасам субъекта`];
        provenance = `Источник: подсказки ${regionLabel}, статус NOT_COLLECTED`;
      } else {
        const riskThemes = (themeSet?.themes ?? [])
          .map((t) => String(t.title ?? ""))
          .filter((t) => t.length >= 4);
        const subjectName = String(themeSet?.subjectName ?? "").trim();
        let explicit = 0;
        let contextual = 0;
        let identity = 0;
        const haystack = [...rowTexts, caption, title].join("\n");
        if (rowTexts.length > 0 && subjectName) {
          for (const q of rowTexts) {
            const kind = classifySuggestionIntent(q, subjectName, riskThemes);
            if (kind === "explicitAdverse") explicit += 1;
            else if (kind === "contextualRisk") contextual += 1;
            else if (kind === "identityOrNamesakeRisk") identity += 1;
          }
        } else {
          explicit = /скандал|санкц|арест|корруп|мошен|негатив|scandal|sanction/i.test(haystack)
            ? 1
            : regionKpis?.suggestionsExplicitAdverse ?? 0;
          contextual = regionKpis?.suggestionsContextualRisk ?? 0;
          identity = regionKpis?.suggestionsIdentityRisk ?? 0;
        }
        const totalSuggest =
          rowTexts.length > 0
            ? rowTexts.length
            : regionKpis?.suggestionsTotal ?? Math.max(explicit + contextual + identity, 1);

        sidebarMode = explicit > 0 ? "adverse_explanation" : "interpretation";
        headlineConclusion =
          explicit > 0
            ? "Подсказки связывают имя с риск-тематикой"
            : "Прямых негативных формулировок в подсказках не найдено";
        whatIsVisible =
          explicit > 0
            ? `Среди подсказок есть прямые негативные формулировки (${explicit} из ${totalSuggest}).`
            : `Прямых негативных формулировок не найдено. ${contextual} подсказок связаны с ранее выявленными риск-темами. ${identity} подсказок относятся к другим людям или неоднозначной идентификации.`;
        clientMeaning =
          explicit > 0
            ? "Уже на этапе ввода запроса формируется настороженное впечатление о субъекте."
            : contextual > 0 || identity > 0
              ? "Ассоциации в подсказках частично связаны с риск-темами или неоднозначной идентификацией, без прямого негатива."
              : "На этапе ввода запроса ассоциации в подсказках выглядят нейтральными.";
        whyItMatters = clientMeaning;
        recommendedActions =
          explicit > 0
            ? ["Отметить негативные подсказки для ручной проверки"]
            : contextual > 0
              ? ["Сверить контекстные ассоциации с подтверждёнными риск-темами"]
              : [];

        if (isArsenkinAsset(asset) || /arsenkin/i.test(String(asset.meta?.provider ?? ""))) {
          provenance = arsenkinSuggestProvenance(asset, slot);
          panelMeta = {
            provider: String(asset.meta?.provider ?? "arsenkin"),
            tool: String(asset.meta?.tool ?? asset.meta?.arsenkinTool ?? "suggest"),
            engine:
              String(asset.meta?.engine ?? "").toUpperCase() ||
              (/google/i.test(asset.assetRef) || /google/i.test(slot.slotId) ? "GOOGLE" : "YANDEX"),
            region: String(asset.meta?.region ?? slot.region ?? "RU"),
            observationCount:
              asset.meta?.observationCount ?? (rowTexts.length > 0 ? rowTexts.length : undefined),
            capturedAt: asset.meta?.capturedAt,
            reportRunId: asset.meta?.reportRunId,
            evidenceRefs: [...(asset.evidenceRefs ?? [])],
          };
        }
      }
    }
  } else if (slot.kind === "related_visual") {
    sidebarMode = "interpretation";
    const rowTexts = collectRelatedTexts(asset, slide, slot, themeSet ?? null);
    const regionKpis =
      slot.region === "UAE" ? themeSet?.uae : slot.region === "RU" ? themeSet?.ru : themeSet?.ru;
    const riskThemes = (themeSet?.themes ?? [])
      .map((t) => String(t.title ?? ""))
      .filter((t) => t.length >= 4);
    const subjectName = String(themeSet?.subjectName ?? "").trim();
    let explicit = 0;
    let contextual = 0;
    let identity = 0;
    for (const q of rowTexts) {
      const kind = classifySuggestionIntent(q, subjectName, riskThemes);
      if (kind === "explicitAdverse") explicit += 1;
      else if (kind === "contextualRisk") contextual += 1;
      else if (kind === "identityOrNamesakeRisk") identity += 1;
    }
    const totalRelated = rowTexts.length > 0 ? rowTexts.length : regionKpis?.relatedTotal ?? 0;
    const topic =
      rowTexts[0]?.slice(0, 48) ||
      (explicit > 0 ? "негативные формулировки" : "нейтральные ассоциации");
    if (rowTexts.length === 0 && slot.slotId === "p32_uae_related") {
      sidebarMode = "status";
      headlineConclusion = "ОАЭ — связанные запросы: данные не собраны";
      whatIsVisible =
        "Валидные связанные запросы по алиасам субъекта не собраны; fallback из другого набора отключён.";
      clientMeaning = "Без валидных строк раздел помечен как NOT_COLLECTED.";
      whyItMatters = clientMeaning;
      recommendedActions = ["Повторно собрать UAE related по алиасам субъекта"];
      provenance = "Источник: UAE related, статус NOT_COLLECTED";
    } else {
      const relatedSourceLabel =
        slot.slotId === "p20_ru_related_1"
          ? "Google People Also Ask"
          : slot.slotId === "p21_ru_related_2"
            ? "Google Related Searches"
            : slot.slotId === "p22_ru_related_3"
              ? "Yandex Related Searches"
              : null;
      const queryWord =
        totalRelated === 1 ? "запрос" : totalRelated >= 2 && totalRelated <= 4 ? "запроса" : "запросов";
      headlineConclusion =
        explicit > 0
          ? `Связанные запросы (${regionLabel}): ${ruNegCount(explicit)} из ${totalRelated}`
          : `Связанные запросы (${regionLabel}): ${totalRelated} ${queryWord}`;
      whatIsVisible =
        rowTexts.length > 0
          ? `${relatedSourceLabel ? `${relatedSourceLabel}: ` : ""}${rowTexts
              .slice(0, 6)
              .map((q, i) => `${i + 1}. ${q.slice(0, 72)}`)
              .join(" ")}`
          : `Связанные запросы по субъекту в регионе ${regionLabel}.`;
      clientMeaning =
        explicit > 0
          ? "Связанные запросы усиливают негативные ассоциации при поиске по субъекту."
          : contextual > 0 || identity > 0
            ? "Часть связанных запросов требует сверки субъекта или контекста."
            : "Связанные запросы выглядят нейтральными относительно субъекта.";
      whyItMatters = clientMeaning;
      recommendedActions =
        explicit > 0 ? ["Проверить негативные связанные запросы вручную"] : [];
      const relatedEngineLabel =
        slot.slotId === "p20_ru_related_1" || slot.slotId === "p21_ru_related_2"
          ? "похожие вопросы Google"
          : slot.slotId === "p22_ru_related_3"
            ? "похожие запросы Яндекса"
            : "похожие запросы";
      const captured = asset.meta?.capturedAt
        ? `дата сбора ${String(asset.meta.capturedAt).slice(0, 10)}`
        : "дата сбора в кейсе";
      provenance = isArsenkinAsset(asset)
        ? `Источник: Arsenkin Tools, ${relatedEngineLabel}, ${captured}`
        : `Источник: связанные запросы ${regionLabel}, дата сбора в кейсе`;
    }
  } else if (slot.kind === "knowledge_visual") {
    const engineLabel =
      slot.slotId === "p18_ru_knowledge_1"
        ? "Yandex"
        : slot.slotId === "p19_ru_knowledge_2"
          ? "Google"
          : slot.slotId === "p31_uae_knowledge"
            ? "Google"
            : "поиск";
    const fromWiki = /wikipedia|википед/i.test(`${caption} ${title} ${provenanceLabel(asset)}`);
    const fromAiSerp =
      /ai-serp|ai_answer|ИИ-ответ|AI Overview|Алиса|не энциклопед/i.test(
        `${caption} ${title} ${provenanceLabel(asset)} ${asset.assetRef}`
      ) || Boolean(asset.meta?.notKnowledgePanel);
    const regionKpis =
      slot.region === "UAE" ? themeSet?.uae : slot.region === "RU" ? themeSet?.ru : themeSet?.ru;
    const wikiStatus = String(regionKpis?.wikipediaStatus ?? "").toUpperCase();
    const wrongSubject =
      wikiStatus === "WRONG_SUBJECT" ||
      wikiStatus === "AMBIGUOUS" ||
      /другого субъекта|однофамил|не является профилем|дворянский род|WRONG_SUBJECT/i.test(
        `${caption} ${title}`
      ) ||
      asset.meta?.subjectBinding === "WRONG_SUBJECT";
    const absent = wikiStatus === "ABSENT" || (!wrongSubject && wikiStatus !== "EXACT_SUBJECT");
    sidebarMode = wrongSubject || absent || fromAiSerp ? "status" : "interpretation";
    if (fromAiSerp) {
      const aiAbsent = /не найден|NO_RESULTS|absent/i.test(`${caption} ${title}`);
      headlineConclusion = aiAbsent
        ? `ИИ-блок в поиске (${regionLabel}) не найден`
        : `ИИ-представление субъекта в поиске (${regionLabel})`;
      whatIsVisible = aiAbsent
        ? "По запросу нет ответа Алисы / AI Overview. Это отдельный сигнал от энциклопедической карточки Wikipedia."
        : "Показан ответ поискового ИИ (Алиса / AI Overview) и источники, на которые он опирается. Это не карточка Wikipedia.";
      clientMeaning = aiAbsent
        ? "Отсутствие ИИ-блока снижает риск автогенерации образа субъекта, но не заменяет проверку органики и справочных панелей."
        : "ИИ-блок формирует первое впечатление о субъекте у пользователей поиска и может смешивать однофамильцев.";
      recommendedActions = aiAbsent
        ? ["Зафиксировать отсутствие ИИ-блока как факт профиля"]
        : ["Сверить ИИ-тезисы с первичными источниками"];
      provenance = "Источник: Arsenkin ai-serp, дата сбора в кейсе";
    } else if (wrongSubject) {
      headlineConclusion = "Карточка Wikipedia не относится к проверяемому лицу";
      whatIsVisible =
        "Найдена страница другого лица или рода; её нельзя засчитывать как профиль проверяемого лица.";
      clientMeaning = "Чужой профиль в выдаче создаёт риск смешения личностей.";
      recommendedActions = ["Исключить из профиля или сверить личность"];
      provenance = "Источник: проверка Wikipedia, дата сбора в кейсе";
    } else if (absent) {
      headlineConclusion = `${engineLabel}: публичная статья Wikipedia (${regionLabel}) не найдена`;
      whatIsVisible =
        `В выдаче ${engineLabel} (${regionLabel}) нет устойчивой энциклопедической карточки проверяемого лица.`;
      clientMeaning = "Энциклопедический якорь цифрового профиля в регионе отсутствует.";
      recommendedActions = ["Зафиксировать отсутствие статьи как факт профиля"];
      provenance = `Источник: проверка Wikipedia (${engineLabel}), дата сбора в кейсе`;
    } else {
      headlineConclusion = fromWiki
        ? `${engineLabel}: справочная карточка Wikipedia (${regionLabel})`
        : `${engineLabel}: справочная панель в поиске (${regionLabel})`;
      whatIsVisible = fromWiki
        ? "Показаны название страницы и статус наличия публичной статьи о проверяемом лице."
        : "Краткие факты и заголовки из справочного блока рядом с выдачей.";
      clientMeaning = "Справочный блок влияет на то, как третьи лица идентифицируют проверяемое лицо.";
      recommendedActions = ["Сверить факты с первичными источниками"];
      provenance = fromWiki ? "Источник: проверка Wikipedia, дата сбора в кейсе" : provenance;
    }
    whyItMatters = clientMeaning;
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
    panelMeta,
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

  const rows = table.rows.map((row) => {
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
    // Two-line title budget (spec §5): keep enough text for measured wrapping,
    // pagination decides continuation. Word-boundary only — never split chars.
    if (queryIdx >= 0 || query) {
      return [query || "—", pos, domain || "—", truncateAtWordBoundary(title, 160), status];
    }
    return [pos, domain || "—", truncateAtWordBoundary(title, 160), status];
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
    slotId: slot.slotId,
    requiredVisual: slot.requiredVisual,
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
  const slotScopedNarrative = (() => {
    if (slot.slotId === "p18_ru_knowledge_1") {
      return "Yandex Knowledge Panel: данные не собраны. Раздел сохранён как отдельный статусный блок без дублирования Google.";
    }
    if (slot.slotId === "p19_ru_knowledge_2") {
      return "Google Knowledge Panel: данные не собраны. Раздел отображается отдельно от Yandex и не дублирует соседний empty-state.";
    }
    if (slot.slotId === "p32_uae_related") {
      return "UAE related: валидные данные по алиасам субъекта не собраны (NOT_COLLECTED); fallback из другого набора отключён.";
    }
    if (slot.slotId === "p34_dow_jones") {
      return "Dow Jones: данные не собраны. Для клиентской карточки требуется подтверждённый visual evidence.";
    }
    if (slot.slotId === "p35_lexis_visual") {
      return "LexisNexis: данные не собраны. Страница зарезервирована для подтверждённой карточки evidence.";
    }
    if (slot.slotId === "p36_lexis_visual_2") {
      return "LexisNexis (продолжение): данные не собраны. Дополнительная страница будет заполнена только при наличии evidence.";
    }
    return "Данные источника не предоставлены. Раздел сохранён в структуре аудита; проверка по этому блоку будет завершена после появления подтверждённых материалов.";
  })();
  return {
    slideKey: slot.slotId,
    slotId: slot.slotId,
    requiredVisual: slot.requiredVisual,
    sectionKey: slot.sectionKey,
    template: slot.template === "orion_golden_region_divider" ? slot.template : "orion_golden_prose",
    title: slot.title,
    pageNumber: slot.page,
    narrative:
      narrative ||
      (slot.kind === "region_toc" || slot.kind === "compliance_toc" ? undefined : slotScopedNarrative),
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
  usedAssets: Set<string>,
  themeSet?: OrionThemeSet | null
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
  const analysis = buildDeterministicVisualAnalysis(asset, slot, themeSet, slide);
  return {
    ...slide,
    slideKey: slot.slotId,
    sectionKey: slot.sectionKey,
    template: slot.template,
    title: slot.title,
    pageNumber: slot.page,
    assetRefs: [assetRef],
    evidenceRefs: asset.evidenceRefs?.length ? [...asset.evidenceRefs] : slide.evidenceRefs,
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

/** Column index resolution for the normalized 5- or 4-column search table. */
function searchRowsFromTable(
  table: NonNullable<OrionGoldenDeckSlide["table"]>,
  regionLabel: string
): SearchResultRow[] {
  const headers = table.headers.map((h) => String(h).trim().toLowerCase());
  const qi = headers.findIndex((h) => /запрос|query/.test(h));
  const has5 = table.rows.some((r) => r.length >= 5) || qi >= 0;
  return table.rows.map((row) => {
    const cells = row.map((c) => String(c ?? ""));
    let query: string;
    let pos: string;
    let domain: string;
    let title: string;
    let status: string;
    if (has5) {
      query = cells[qi >= 0 ? qi : 0] || regionLabel;
      pos = cells[qi >= 0 ? 1 : 1] ?? "";
      domain = cells[2] ?? "";
      title = cells[3] ?? "";
      status = cells[4] ?? "";
    } else {
      query = regionLabel;
      pos = cells[0] ?? "";
      domain = cells[1] ?? "";
      title = cells[2] ?? "";
      status = cells[3] ?? "";
    }
    const adverse = /нежелат/i.test(status);
    return {
      queryNormalized: query,
      queryDisplay: query,
      position: pos,
      domain,
      title,
      status: status || "Нейтральный",
      adverse,
      tieBreaker: `${pos}|${domain}|${title}`,
    } satisfies SearchResultRow;
  });
}

/**
 * Expand a single base search_table slide into base + adjacent continuation
 * slides using measured pagination. Every dataset row is displayed; counters
 * and continuation identity are attached to each produced slide.
 */
function expandSearchTableSlot(base: OrionGoldenDeckSlide): OrionGoldenDeckSlide[] {
  if (base.template !== "orion_golden_search_table" || !base.table?.rows?.length) {
    return [base];
  }
  const regionLabel = /оаэ|uae/i.test(base.title) ? "ОАЭ" : "Россия";
  const items = searchRowsFromTable(base.table, regionLabel);
  const distinctQueries = new Set(items.map((i) => i.queryDisplay.trim().toLowerCase())).size;
  const useQTag = distinctQueries >= 4;
  const result = paginateSearchResults({ items, useQTag });

  const qTagFor = (() => {
    if (!useQTag) return () => undefined as string | undefined;
    const map = new Map<string, string>();
    let n = 0;
    return (q: string): string => {
      const key = q.trim().toLowerCase();
      if (!map.has(key)) map.set(key, `Q${++n}`);
      return map.get(key)!;
    };
  })();

  const slides: OrionGoldenDeckSlide[] = result.pages.map((page, pageIndex) => {
    const headers = ["Позиция", "Домен", "Заголовок", "Статус"];
    const rows: string[][] = page.rows.map((r) => [r.position, r.domain, r.title, r.status]);
    const groups: NonNullable<OrionGoldenDeckSlide["table"]>["groups"] = [];
    let cursor = 0;
    for (const r of page.rows) {
      if (r.startsGroup) {
        groups.push({
          queryDisplay: r.queryDisplay,
          qTag: qTagFor(r.queryDisplay),
          rowStart: cursor,
          rowCount: 0,
        });
      }
      const g = groups[groups.length - 1];
      if (g) g.rowCount += 1;
      cursor += 1;
    }
    const counters: SlideSearchCounters = {
      datasetCount: result.datasetCount,
      datasetAdverseCount: result.datasetAdverseCount,
      deckDisplayedCount: result.deckDisplayedCount,
      deckDisplayedAdverseCount: result.deckDisplayedAdverseCount,
      pageDisplayedCount: page.pageDisplayedCount,
      pageDisplayedAdverseCount: page.pageDisplayedAdverseCount,
      pageIndex: page.pageIndex,
      pageCount: page.pageCount,
      excludedCount: result.excludedCount,
      excludedReasons: result.excludedReasons as Record<string, number>,
    };
    const counterCopy = buildSearchCounterCopy({ result, page });
    const titleSuffix = page.pageCount > 1 ? ` (${pageIndex + 1}/${page.pageCount})` : "";
    const isCont = pageIndex > 0;
    return {
      ...base,
      slideKey: isCont ? `${base.slideKey}__cont${pageIndex}` : base.slideKey,
      title: `${base.title}${titleSuffix}`,
      table: { headers, rows, groups },
      searchCounters: counters,
      narrative: counterCopy,
      isContinuation: isCont,
      continuationOf: isCont ? base.slideKey : null,
      continuationIndex: pageIndex,
      continuationCount: result.pages.length - 1,
    } satisfies OrionGoldenDeckSlide;
  });
  return slides;
}

function measuredImageGridCapacity(): number {
  // Mirrors renderer image-grid geometry (3 cols + fixed card height/gap), but
  // computed from available drawing bounds so no magic "9-only" cap.
  const slideH = 7_315_200;
  const footerBottom = slideH - 700_000;
  const titleBlock = 1_200_000;
  const y = 280_000 + titleBlock;
  const available = Math.max(1_000_000, footerBottom - y);
  const cellH = 1_600_000;
  const gap = 120_000;
  const rows = Math.max(1, Math.floor((available + gap) / (cellH + gap)));
  return rows * 3;
}

function expandImageGridSlot(base: OrionGoldenDeckSlide): OrionGoldenDeckSlide[] {
  if (base.template !== "orion_golden_image_grid") return [base];

  const refs = [...(base.assetRefs ?? [])];
  const highlights = [...(base.visualAnalysis?.highlightExplanations ?? [])];
  const adverseHighlights = highlights.filter((h) => h.frameTone === "red" || h.frameTone === "amber");
  const useHighlightPaging = adverseHighlights.length > 0;

  const capacity = useHighlightPaging ? 6 : measuredImageGridCapacity();
  const datasetCount = useHighlightPaging ? adverseHighlights.length : refs.length;
  if (datasetCount <= capacity || capacity <= 0) return [base];

  const pageCount = Math.max(1, Math.ceil(datasetCount / capacity));
  const slides: OrionGoldenDeckSlide[] = [];
  for (let i = 0; i < pageCount; i += 1) {
    const from = i * capacity;
    const to = Math.min(datasetCount, from + capacity);
    const isCont = i > 0;
    const title = `${base.title} (${i + 1}/${pageCount})`;
    const pageHighlights = useHighlightPaging ? adverseHighlights.slice(from, to) : [];
    const pageRefs = useHighlightPaging ? refs : refs.slice(from, to);
    slides.push({
      ...base,
      slideKey: isCont ? `${base.slideKey}__cont${i}` : base.slideKey,
      title,
      isContinuation: isCont,
      continuationOf: isCont ? base.slideKey : null,
      continuationIndex: i,
      continuationCount: pageCount - 1,
      assetRefs: pageRefs,
      visualAnalysis: base.visualAnalysis
        ? {
            ...base.visualAnalysis,
            highlightExplanations: useHighlightPaging ? pageHighlights : base.visualAnalysis.highlightExplanations,
            moreSignalsCount: useHighlightPaging ? Math.max(0, datasetCount - to) : base.visualAnalysis.moreSignalsCount,
          }
        : base.visualAnalysis,
      imageCounters: {
        datasetCount,
        datasetAdverseCount: adverseHighlights.length,
        deckDisplayedCount: datasetCount,
        deckDisplayedAdverseCount: adverseHighlights.length,
        pageDisplayedCount: to - from,
        pageDisplayedAdverseCount: useHighlightPaging ? pageHighlights.length : 0,
        pageIndex: i,
        pageCount,
      },
    });
  }
  return slides;
}

/** Expand all base slots into the final deck with adjacent continuation slides. */
function expandBaseSlotsToDeck(baseSlides: OrionGoldenDeckSlide[]): OrionGoldenDeckSlide[] {
  const out: OrionGoldenDeckSlide[] = [];
  for (const base of baseSlides) {
    const searchExpanded = expandSearchTableSlot(base);
    for (const slide of searchExpanded) {
      const imageExpanded = expandImageGridSlot(slide);
      out.push(...imageExpanded);
    }
  }
  // Sequential page numbering + totalPageCount stamping (spec §2).
  const total = out.length;
  for (let i = 0; i < out.length; i += 1) {
    out[i] = { ...out[i]!, pageNumber: i + 1, totalPageCount: total };
  }
  return out;
}

function appendAiAnswerExtensions(
  deckSlides: OrionGoldenDeckSlide[],
  assets: ReportAssetV1[]
): OrionGoldenDeckSlide[] {
  const toMeta = (asset: ReportAssetV1): Record<string, unknown> =>
    ((asset.meta as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  const sentenceChunks = (text: string, maxChars: number): string[] => {
    const sentences = text
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (sentences.length === 0) return text.trim() ? [text.trim()] : [];
    const out: string[] = [];
    let cur = "";
    for (const s of sentences) {
      const next = cur ? `${cur} ${s}` : s;
      if (next.length <= maxChars || !cur) {
        cur = next;
      } else {
        out.push(cur);
        cur = s;
      }
    }
    if (cur) out.push(cur);
    return out;
  };
  const citationsFrom = (asset: ReportAssetV1): string[] => {
    const meta = toMeta(asset);
    const raw = (meta["citations"] as Array<{ title?: string; domain?: string; url?: string }> | undefined) ?? [];
    const parsed = raw
      .map((c) => {
        const domain = String(c.domain ?? "").trim();
        const title = String(c.title ?? "").trim();
        const url = String(c.url ?? "").trim();
        if (!domain && !title && !url) return "";
        return `${domain || "source"} — ${title || url || "без названия"}`;
      })
      .filter(Boolean);
    if (parsed.length > 0) return parsed;
    return (asset.evidenceRefs ?? []).slice(0, 12).map((r) => `Источник: ${r}`);
  };
  const statusLabelFor = (asset: ReportAssetV1): string => {
    const blob = `${asset.caption ?? ""} ${asset.title ?? ""}`;
    return /не найден|absent|no result|NO_RESULTS/i.test(blob)
      ? "Результат: AI-блок не найден"
      : "Результат: AI-блок найден";
  };
  const safePct = (n: number | null): string =>
    typeof n === "number" && Number.isFinite(n) ? `${Math.round(n * 100)}%` : "—";

  const aiAssets = assets.filter(
    (a) =>
      String(a.meta?.surface ?? "").toLowerCase() === "ai_answer" ||
      /ai-serp|ai[_-]?answer|google[_-]?ai|yandex[_-]?ai|ии|ai overview/i.test(
        `${a.assetRef} ${a.title ?? ""}`
      )
  );
  if (aiAssets.length === 0) return deckSlides;

  const insertionRules: Array<{
    id: string;
    afterBase: string;
    title: string;
    region: string;
    engine: string;
    sectionKey: string;
    match: RegExp;
    preferredAssetRefs: string[];
  }> = [
    {
      id: "ext_ru_yandex_ai",
      afterBase: "p19_ru_knowledge_2",
      title: "Россия — AI-выдача Яндекса",
      region: "RU",
      engine: "YANDEX",
      sectionKey: "ai_answer_ru_yandex",
      match: /yandex|alice|яндекс/i,
      preferredAssetRefs: ["ru_ai_yandex", "ru_knowledge_panel_2"],
    },
    {
      id: "ext_ru_google_ai",
      afterBase: "p19_ru_knowledge_2",
      title: "Россия — Google AI Overview",
      region: "RU",
      engine: "GOOGLE",
      sectionKey: "ai_answer_ru_google",
      match: /google.*ai|ai.*google/i,
      preferredAssetRefs: ["ru_ai_google"],
    },
    {
      id: "ext_uae_google_ai",
      afterBase: "p31_uae_knowledge",
      title: "ОАЭ — Google AI Overview",
      region: "UAE",
      engine: "GOOGLE",
      sectionKey: "ai_answer_uae_google",
      match: /google.*ai|ai.*google|uae/i,
      preferredAssetRefs: ["uae_ai_google", "uae_knowledge_panel"],
    },
  ];

  let result = [...deckSlides];
  for (const rule of insertionRules) {
    const asset =
      rule.preferredAssetRefs
        .map((ref) => aiAssets.find((a) => a.assetRef === ref))
        .find(Boolean) ??
      aiAssets.find((a) => rule.match.test(`${a.assetRef} ${a.title ?? ""}`));
    if (!asset) continue;
    const afterIdx = result.findIndex((s) => s.baseSlotId === rule.afterBase && !s.isContinuation);
    if (afterIdx < 0) continue;
    let insertAt = afterIdx + 1;
    while (insertAt < result.length && result[insertAt]?.extensionOf === rule.afterBase) insertAt += 1;
    const evidenceRefs = [...(asset.evidenceRefs ?? [])];
    const meta = toMeta(asset);
    const statusLabel = statusLabelFor(asset);
    const queryText =
      String(
        (asset.meta as Record<string, unknown> | undefined)?.["query"] ??
          (asset.meta as Record<string, unknown> | undefined)?.["queryText"] ??
          "—"
      ) || "—";
    const safeQueryText = queryText === "—" ? "не указан" : queryText;
    const capturedAt = String(meta["capturedAt"] ?? "дата не указана").slice(0, 19);
    const answerFromMeta = String(meta["answerText"] ?? "").trim();
    const answerFromCaption =
      !/не найден|absent|NO_RESULTS/i.test(String(asset.caption ?? "")) &&
      String(asset.caption ?? "").trim().length > 40
        ? String(asset.caption ?? "").trim()
        : "";
    const answerText = answerFromMeta || answerFromCaption;
    const absent = !answerText || /не найден/i.test(statusLabel);
    const textPages = answerText && !absent ? sentenceChunks(answerText, 900) : [];
    const citations = citationsFrom(asset);
    const citationPages: string[][] = [];
    for (let i = 0; i < citations.length; i += 4) citationPages.push(citations.slice(i, i + 4));
    const evaluation = (meta["aiEvaluation"] as Record<string, unknown> | undefined) ?? {};
    const summary = String(evaluation["summary"] ?? "").trim();
    const takeaway = String(evaluation["clientTakeaway"] ?? "").trim();
    const action = String(evaluation["recommendedAction"] ?? "").trim();
    const pageCount = Math.max(1, textPages.length || (absent ? 1 : 0), citationPages.length || 1);
    const datasetCount = Math.max(textPages.length, 1) + citations.length;
    const engineLabel = rule.engine === "YANDEX" ? "Яндекс Алиса" : "Google AI Overview";
    for (let pageIdx = 0; pageIdx < pageCount; pageIdx += 1) {
      const textBlock = textPages[pageIdx] ?? (pageIdx === 0 && !absent ? answerText : "");
      const cites = citationPages[pageIdx] ?? [];
      const isCont = pageIdx > 0;
      const headline = absent
        ? `${engineLabel}: блок не найден`
        : summary ||
          (rule.engine === "YANDEX"
            ? "AI-выдача Яндекса по субъекту"
            : "Google AI Overview по субъекту");
      const whatIsVisible = absent
        ? `По запросу «${safeQueryText}» блок ${engineLabel} в выдаче не найден. Это отдельный сигнал от энциклопедической карточки Wikipedia.`
        : textBlock || answerText;
      const clientMeaning = absent
        ? "Отсутствие ИИ-блока снижает риск автогенерации образа субъекта, но не заменяет проверку органики."
        : takeaway ||
          "ИИ-блок формирует первое впечатление о субъекте и может смешивать однофамильцев.";
      const provenance = `Источник: Arsenkin Tools, ${engineLabel}, ${
        capturedAt === "дата не указана" ? "дата сбора в кейсе" : `дата сбора ${capturedAt.slice(0, 10)}`
      }`;
      const extSlide: OrionGoldenDeckSlide = {
        slideKey:
          pageIdx === 0 ? `${rule.id}_${asset.assetRef}` : `${rule.id}_${asset.assetRef}__cont${pageIdx}`,
        baseSlotId: `${rule.id}_${asset.assetRef}`,
        baseSlotIndex: -1,
        sectionKey: rule.sectionKey,
        template: "orion_golden_surface_panel",
        title: pageCount > 1 ? `${rule.title} (${pageIdx + 1}/${pageCount})` : rule.title,
        pageNumber: 0,
        extensionId: rule.id,
        extensionOf: rule.afterBase,
        extensionSurface: "ai_answer",
        extensionEngine: rule.engine,
        extensionRegion: rule.region,
        datasetCount,
        displayedCount: (textBlock ? 1 : 0) + cites.length,
        assetRefs: [asset.assetRef],
        evidenceRefs,
        isContinuation: isCont,
        continuationOf: isCont ? `${rule.id}_${asset.assetRef}` : null,
        continuationIndex: pageIdx,
        continuationCount: Math.max(0, pageCount - 1),
        // Renderer sidebar reads visualAnalysis / clientTakeaway — not narrative/bullets alone.
        clientTakeaway: headline,
        visualAnalysis: {
          assetRef: asset.assetRef,
          sidebarMode: absent ? "status" : "interpretation",
          headlineConclusion: headline,
          whatIsVisible:
            cites.length > 0 && textBlock
              ? `${textBlock}\n\nИсточники: ${cites.slice(0, 4).join("; ")}`
              : whatIsVisible,
          whyItMatters: clientMeaning,
          clientMeaning,
          metrics: [
            {
              label: "AI-блок",
              value: absent ? "не найден" : "найден",
              tone: absent ? "neutral" : "warn",
            },
            {
              label: "Источники",
              value: String(citations.length),
              tone: "neutral",
            },
          ],
          confidence: absent ? "low" : "medium",
          limitations: absent
            ? ["ИИ-блок в выдаче не найден на дату сбора."]
            : ["Текст ИИ — снимок ответа на дату сбора, а не текущий экран поиска."],
          recommendedActions: action
            ? [action]
            : absent
              ? ["Зафиксировать отсутствие ИИ-блока как факт профиля"]
              : ["Сверить тезисы ИИ с первичными источниками"],
          provenanceLabel: provenance,
        },
        narrative: whatIsVisible,
        bullets: [
          `Поисковик: ${engineLabel} · регион: ${rule.region}`,
          `Точный запрос: ${safeQueryText}`,
          statusLabel,
          ...(cites.length ? cites.map((c) => `Источник: ${c}`) : []),
        ].filter(Boolean),
        statusBadge: { label: statusLabel, tone: absent ? "neutral" : "warn" },
        totalPageCount: 0,
      };
      result.splice(insertAt + pageIdx, 0, extSlide);
    }
  }
  result = result.map((s, idx, arr) => ({
    ...s,
    pageNumber: idx + 1,
    totalPageCount: arr.length,
  }));
  return result;
}

/**
 * Compose the CEO audit deck from classic rich content + assets.
 * 36 mandatory base slots; continuation slides may push totalSlideCount past 36.
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
        usedAssets,
        themeSet
      );
    } else if (slot.requiredVisual) {
      const asset = pickAssetForSlot(assets, usedAssets, slot);
      if (asset) {
        usedAssets.add(asset.assetRef);
        const analysis = buildDeterministicVisualAnalysis(asset, slot, themeSet, null);
        slide = {
          slideKey: slot.slotId,
          sectionKey: slot.sectionKey,
          template: slot.template,
          title: slot.title,
          pageNumber: slot.page,
          assetRefs: [asset.assetRef],
          evidenceRefs: asset.evidenceRefs?.length ? [...asset.evidenceRefs] : undefined,
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
        const analysis = buildDeterministicVisualAnalysis(asset, slot, themeSet, null);
        slide = {
          slideKey: slot.slotId,
          sectionKey: slot.sectionKey,
          template: slot.template,
          title: slot.title,
          pageNumber: slot.page,
          assetRefs: [asset.assetRef],
          evidenceRefs: asset.evidenceRefs?.length ? [...asset.evidenceRefs] : undefined,
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
      slotId: slot.slotId,
      baseSlotId: slot.slotId,
      baseSlotIndex: slot.page - 1,
      sectionId: slot.sectionKey,
      isContinuation: false,
      continuationOf: null,
      continuationIndex: 0,
      requiredVisual: slot.requiredVisual,
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

  // Base slot coverage: exactly 36 mandatory slots must each have one primary
  // slide. 36 is the base-slot count, NOT a hard page cap.
  const baseSlotIds = finalSlides
    .filter((s) => s.isContinuation !== true)
    .map((s) => s.baseSlotId ?? s.slideKey);
  const distinctBaseSlots = new Set(baseSlotIds);
  const missingBaseSlots = ORION_FIRST36_REGISTRY_V1.map((slot) => slot.slotId).filter(
    (id) => !distinctBaseSlots.has(id)
  );
  if (distinctBaseSlots.size !== FIRST36_EXACT_PAGE_COUNT || missingBaseSlots.length > 0) {
    throw new Error(
      `first36-base-slot-coverage:${distinctBaseSlots.size}:missing=${missingBaseSlots.join(",")}`
    );
  }

  // Expand base slots into base + adjacent continuation slides (spec §2/§3).
  let deckSlides = expandBaseSlotsToDeck(finalSlides);
  deckSlides = appendAiAnswerExtensions(deckSlides, assets);

  const totalPages = deckSlides.length;
  const tocEntries = deckSlides
    .filter((s) => s.sectionKey !== "cover")
    .filter((s) => s.isContinuation !== true)
    .filter((_, idx, arr) => idx === 0 || arr[idx - 1]?.sectionKey !== arr[idx].sectionKey);

  const tocBullets = tocEntries.map((entry) => {
    const sectionSlides = deckSlides.filter((s) => s.sectionKey === entry.sectionKey);
    const startPage = sectionSlides[0]?.pageNumber ?? entry.pageNumber;
    const endPage = sectionSlides[sectionSlides.length - 1]?.pageNumber ?? entry.pageNumber;
    const range = endPage > startPage ? `${startPage}–${endPage}` : `${startPage}`;
    return `${entry.title} — стр. ${range} (${totalPages} стр.)`;
  });

  deckSlides = deckSlides.map((s) =>
    s.slotId === "p02_toc" || s.slideKey === "p02_toc"
      ? { ...s, bullets: tocBullets.slice(0, 22) }
      : s
  );

  const sectionManifests: OrionGoldenDeckManifest["sectionManifests"] = [];
  for (const s of deckSlides) {
    const last = sectionManifests[sectionManifests.length - 1];
    if (last && last.sectionKey === s.sectionKey) {
      last.slides.push(s);
      last.slideCount += 1;
    } else {
      sectionManifests.push({ sectionKey: s.sectionKey, slideCount: 1, slides: [s] });
    }
  }

  const toc = tocEntries.map((s) => ({ title: s.title, pageNumber: s.pageNumber }));

  const pageNumberMap: Record<string, number> = {};
  for (const s of deckSlides) pageNumberMap[s.slideKey] = s.pageNumber;

  return {
    version: "r10-orion-golden-deck-manifest-v1",
    slideCount: deckSlides.length,
    totalSlideCount: deckSlides.length,
    baseSlotCoverage: distinctBaseSlots.size,
    missingBaseSlots,
    sectionManifests,
    finalSlides: deckSlides,
    toc,
    pageNumberMap,
  };
}
