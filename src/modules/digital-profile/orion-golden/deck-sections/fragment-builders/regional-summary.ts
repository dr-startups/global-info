/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType, SlideBody, SlideContentContract } from "../contracts";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "../contracts";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import { pluralRu } from "../../analytics/finding-synthesizer";
import type { FragmentBuildOutput, FragmentExtras, UncategorizedMaterialsExtras } from "./shared";
import {
  bulletWithFindingId,
  claimText,
  clampClientText,
  coverageContent,
  emptyStatusForReason,
  findingBlocks,
  fitClientSentences,
  isAdverse,
  localizedThemedClaim,
  makeSlotSlide,
  sourceLine,
  splitClientParagraphs,
  statusLine,
  uniqueRefs,
  withContinuations,
} from "./shared";

function uncategorizedBulletForRegion(
  regionKey: string,
  extras?: FragmentExtras
): { bullet: string; evidenceRefs: string[]; count: number } | null {
  const block = extras?.uncategorizedMaterials;
  if (!block) return null;
  const regionAliases =
    regionKey === "RU" ? ["RU"] : ["UAE", "INTERNATIONAL", "GLOBAL"];
  let count = 0;
  const examples: Array<{ title: string; evidenceRef: string; domain?: string }> = [];
  for (const alias of regionAliases) {
    const bucket = block.byRegion[alias];
    if (!bucket) continue;
    count += bucket.count;
    for (const ex of bucket.examples) {
      if (examples.length >= 4) break;
      examples.push(ex);
    }
  }
  if (count === 0) return null;
  const titles = examples
    .map((e) => e.title.trim())
    .filter(Boolean)
    .slice(0, 3);
  const examplesNote = titles.length
    ? ` (примеры: ${titles.map((t) => clampClientText(t, 80)).join(" · ")})`
    : "";
  return {
    bullet: `Другие материалы о субъекте: ${count}${examplesNote}`,
    evidenceRefs: examples.map((e) => e.evidenceRef),
    count,
  };
}

export function buildRegionalSummaryFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras = {}
): FragmentBuildOutput {
  const slots = slotsForFragment(key);
  const divider = slots.find((s) => s.templateId === "section-divider")!;
  const summarySlot = slots.find((s) => s.templateId === "regional-summary")!;
  const metricsSlot = slots.find((s) => s.templateId === "serp-table")!;
  const regionKey = key.startsWith("RU_") ? "RU" : "UAE";
  const materialCount = scoped.metricSnapshot.perRegionCounts[regionKey] ?? 0;
  const uncategorized = uncategorizedBulletForRegion(regionKey, extras);

  const slides: SlideContentContract[] = [
    makeSlotSlide({
      slot: divider,
      sectionId,
      content: {
        // PDF-40 G.4 — divider as a client lead, not a catalog sentence.
        narrative: `Раздел показывает, что увидит банк, инвестор или контрагент в выдаче по региону «${regionLabel}»: какие темы формируют риск и что проверить в первую очередь.`,
      },
      evidenceRefs: [],
      findingIds: [],
    }),
  ];

  if (scoped.findings.length === 0 && materialCount === 0 && !uncategorized) {
    slides.push(
      makeSlotSlide({
        slot: summarySlot,
        sectionId,
        templateId: "coverage-empty-state",
        content: coverageContent(
          "no-regional-findings",
          emptyStatusForReason(scoped, "no-regional-findings")
        ),
        evidenceRefs: [],
        findingIds: [],
        emptyStateReason: "no-regional-findings",
      })
    );
  } else if (scoped.findings.length === 0) {
    // Materials exist but none reached a verified finding: an honest summary
    // (ORION style) instead of a coverage placeholder.
    const ambiguous = scoped.metricSnapshot.ambiguousCount;
    const likely = scoped.metricSnapshot.likelySubjectCount ?? 0;
    slides.push(
      makeSlotSlide({
        slot: summarySlot,
        sectionId,
        content: {
          narrative: `По региону ${regionLabel} собрано и проанализировано материалов: ${materialCount}. Подтверждённых тем повышенного внимания, однозначно связанных с проверяемым лицом, по итогам идентификации не выявлено.`,
          bullets: [
            "Каждый материал прошёл проверку принадлежности: учитываются только публикации, уверенно связанные с проверяемым лицом.",
            ...(uncategorized ? [uncategorized.bullet] : []),
            ...(likely > 0
              ? [
                  `Материалы, вероятно относящиеся к субъекту: ${likely} — не входят в подтверждённые выводы, пока принадлежность не уточнена.`,
                ]
              : []),
            ...(ambiguous > 0
              ? [
                  `Часть материалов (${ambiguous} по всему набору) требует дополнительной идентификации — они не включаются в выводы, пока принадлежность не подтверждена.`,
                ]
              : []),
          "Отсутствие подтверждённых тем — результат идентификации на дату отчёта, а не гарантия отсутствия рисков.",
        ],
          whatToCheck:
            "Рекомендуем плановое обновление мониторинга: состав выдачи и подсказок меняется, а материалы, требующие идентификации, могут быть подтверждены при появлении дополнительных признаков.",
          sourceNote: sourceLine(scoped, extras),
        },
        evidenceRefs: uncategorized?.evidenceRefs ?? [],
        findingIds: [],
        metrics: {
          materials: materialCount,
          findings: 0,
          uncategorized: uncategorized?.count ?? 0,
        },
      })
    );
  } else {
    // Региональная страница печатает региональное число: глобальное давало
    // одинаковое «31» и России, и ОАЭ (шаг 13, C10).
    const likelyN =
      scoped.metricSnapshot.perRegionLikelyCounts?.[regionKey] ??
      scoped.metricSnapshot.likelySubjectCount ??
      0;
    // B.2 — one formula for both counters: total confirmed themes vs the
    // high-attention subset. Adjacent pages print the subset (M), so the
    // summary must explain the relationship instead of a bare N.
    const adverseN = scoped.findings.filter(isAdverse).length;
    const themesPhrase =
      adverseN === scoped.findings.length
        ? `подтверждённых тем: ${scoped.findings.length}, все — повышенного внимания`
        : `подтверждённых тем: ${scoped.findings.length}, из них повышенного внимания: ${adverseN}`;
    const topThemes = [...scoped.findings]
      .filter(isAdverse)
      .slice(0, 3)
      .map((f) => f.theme.replace(/\s*\/\s*/gu, " / "));
    const themeLead =
      topThemes.length > 0
        ? `Ключевые темы для проверки: ${topThemes.join("; ")}.`
        : "Подтверждённых тем повышенного внимания в регионе немного — смотрите детализацию ниже.";
    // PDF-40 G.4 / PDF-46 I.3–I.4 — full multi-line claims; paginate via
    // withContinuations (2/page with KPI chrome). Never flatten+mid-cut.
    const bullets = [
      ...scoped.findings
        .slice(0, 8)
        .map((f) => bulletWithFindingId(localizedThemedClaim(f, scoped), f.findingId, 900)),
      ...(uncategorized ? [uncategorized.bullet] : []),
      ...(likelyN > 0
        ? [
            `Материалы, вероятно относящиеся к субъекту: ${likelyN} — пока не включаем в подтверждённый итог до уточнения идентификации.`,
          ]
        : []),
    ];
    const materialWord = pluralRu(materialCount, "материал", "материала", "материалов");
    const base = makeSlotSlide({
      slot: summarySlot,
      sectionId,
      content: {
        narrative: fitClientSentences(
          [
            `В выдаче по региону «${regionLabel}» проверяющий увидит ${materialCount} ${materialWord}.`,
            `${themesPhrase.charAt(0).toUpperCase()}${themesPhrase.slice(1)}.`,
            themeLead,
          ],
          500
        ),
        // Scorecard-lite KPIs (ORION GSM regional audit vibe).
        kpis: [
          { label: "Материалов региона", value: String(materialCount), tone: "neutral" },
          {
            label: "Тем повышенного внимания",
            value: String(adverseN),
            tone: adverseN > 0 ? "risk" : "good",
          },
          {
            label: "Тем подтверждено",
            value: String(scoped.findings.length),
            tone: "accent",
          },
          {
            label: "Вероятно о субъекте",
            value: String(likelyN),
            tone: likelyN > 0 ? "warn" : "neutral",
          },
        ],
        bullets,
        // Keep action; omit whatWasFound/whyItMatters from findingBlocks so the
        // page stays «итог → темы → действие», not a second technical essay.
        whatToCheck: findingBlocks(scoped, undefined, extras).whatToCheck,
        sourceNote: sourceLine(scoped, extras),
      },
      evidenceRefs: [
        ...uniqueRefs(scoped),
        ...(uncategorized?.evidenceRefs ?? []),
      ],
      findingIds: scoped.findings.map((f) => f.findingId),
      metrics: {
        materials: materialCount,
        findings: scoped.findings.length,
        likely: likelyN,
        adverse: adverseN,
        uncategorized: uncategorized?.count ?? 0,
      },
    });
    slides.push(...withContinuations(base, "regional-summary"));
  }

  // Metrics slot: full per-surface coverage breakdown (what was collected on
  // each search surface and how much of it is negative), plus URL-audit and
  // region totals — a nearly empty two-row table reads as a defect to clients.
  const urlAuditUnits = scoped.surfaceUnits.filter((u) => u.surface === "url_audit");
  const rows: string[][] = [];
  // Provider tokens (e.g. enrichment vendor names) are internal — client sees
  // only search-engine labels.
  const engineLabel = (raw: string | undefined): string => {
    const e = String(raw ?? "").toUpperCase();
    if (/YANDEX/.test(e)) return "Яндекс";
    if (/GOOGLE|SERPER/.test(e)) return "Google";
    return "Поисковые системы";
  };
  const SURFACE_TABLE_LABELS: Record<string, string> = {
    organic: "Результаты поиска",
    suggestions: "Поисковые подсказки",
    paa_related: "Связанные запросы",
    images: "Изображения в поиске",
    wikipedia: "Википедия и справочники",
    ai_answers: "ИИ-ответы и панели знаний",
  };
  const metricOf = (u: (typeof scoped.surfaceUnits)[number], key: string): number => {
    const m = u.metrics.find((x) => x.key === key);
    return typeof m?.value === "number" ? m.value : Number(m?.value ?? 0) || 0;
  };
  for (const u of scoped.surfaceUnits) {
    const label = SURFACE_TABLE_LABELS[u.surface];
    if (!label) continue;
    const total = metricOf(u, "totalCount");
    if (total === 0) continue;
    const adverse = metricOf(u, "adverseSubjectCount");
    const matched = metricOf(u, "subjectMatchCount");
    const comment =
      adverse > 0
        ? `негативных: ${adverse}; подтверждена связь с лицом: ${matched}`
        : matched > 0
          ? `подтверждена связь с лицом: ${matched}`
          : "негативных сигналов не выявлено";
    rows.push([engineLabel(u.engine), label, String(total), comment]);
  }
  for (const u of urlAuditUnits) {
    const checked = u.evidenceRefs.length;
    // Metric keys are internal (totalCount/…); the client sees a plain summary.
    const audited = metricOf(u, "totalCount");
    rows.push([
      engineLabel(u.engine),
      "Проверка URL / индексация",
      String(checked),
      audited > 0 ? `проверено адресов: ${audited}` : "—",
    ]);
  }
  rows.push(["Все системы", "Материалы региона", String(materialCount), "по составному набору данных"]);
  rows.push([
    "Все системы",
    "Темы повышенного внимания",
    String(scoped.findings.filter(isAdverse).length),
    "см. матрицу рисков",
  ]);
  slides.push(
    makeSlotSlide({
      slot: metricsSlot,
      sectionId,
      content: {
        table: { headers: ["Система", "Показатель", "Объём", "Комментарий"], rows },
        sourceNote: sourceLine(scoped, extras),
      },
      evidenceRefs: urlAuditUnits.flatMap((u) => u.evidenceRefs),
      findingIds: [],
      metrics: { urlAuditRows: urlAuditUnits.length, materials: materialCount },
    })
  );

  return { slides, status: "READY" };
}

// ---------------------------------------------------------------------------
// SERP (p09 / p26) + SCREENSHOT (p10 / p27)
// ---------------------------------------------------------------------------
