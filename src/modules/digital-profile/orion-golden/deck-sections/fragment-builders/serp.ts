/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType, SlideBody, SlideContentContract } from "../contracts";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "../contracts";
import { DECK_TEMPLATE_REGISTRY, RED_MARKER_LABEL } from "../template-registry";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import type { Finding } from "../../contracts/finding";
import { clientSafeDomain, clientSafeDomains } from "../../../services/composite-serp-merge";
import { ADVERSE_PATTERNS, NOT_FOUND_PATTERNS } from "../../analytics/surface-analyzers";
import type { FragmentBuildOutput, FragmentExtras } from "./shared";
import {
  RISK_ORDER,
  VISUAL_ASSET_UNAVAILABLE,
  assetsFor,
  buildPageEvidenceView,
  chunk,
  claimText,
  clampClientText,
  composePageRowComposition,
  coverageContent,
  distribute,
  domainOfUrl,
  emptyStatusForReason,
  fitClientSentences,
  findingForVisibleRow,
  isAdverse,
  makeSlotSlide,
  pageFindingBlocks,
  pageRowCompositionBlocks,
  pageScopedConclusion,
  pageSourceLine,
  riskLabel,
  sourceLine,
  splitClientParagraphs,
  enumerateRu,
  statusLine,
  uniqueRefs,
  visualSlide,
  withContinuations,
} from "./shared";

/**
 * Ключ материала для таблицы выдачи (шаг 13, D7).
 *
 * Один и тот же материал приходит из разных запросов с разными идентификаторами
 * наблюдения, поэтому объединяем по тому, что видит читатель: домен и
 * заголовок. Без заголовка ориентируемся на адрес — иначе в одну строку
 * склеились бы разные страницы одного сайта.
 */
export function serpMaterialKey(e: {
  url?: string;
  domain?: string;
  title?: string;
}): string {
  const domain = String(e.domain ?? domainOfUrl(e.url) ?? "")
    .toLowerCase()
    .replace(/^www\./u, "");
  const title = String(e.title ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, " ");
  if (title) return `${domain}|${title}`;
  const url = String(e.url ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "")
    .replace(/^www\./u, "")
    .replace(/\/+$/u, "");
  return url ? `url:${url}` : `domain:${domain}`;
}

/** Наблюдения одного материала — в одну строку, в порядке первого появления. */
export function mergeSerpRowsByMaterial(
  refs: string[],
  scoped: ScopedFragmentInput
): Array<{ key: string; refs: string[] }> {
  const order: string[] = [];
  const byKey = new Map<string, string[]>();
  for (const ref of refs) {
    const key = serpMaterialKey(scoped.evidenceIndex[ref] ?? {});
    const list = byKey.get(key);
    if (list) {
      list.push(ref);
      continue;
    }
    byKey.set(key, [ref]);
    order.push(key);
  }
  return order.map((key) => ({ key, refs: byKey.get(key)! }));
}

export function buildSerpFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput
): FragmentBuildOutput {
  const [slot] = slotsForFragment(key);
  const organic = scoped.surfaceUnits.filter((u) => u.surface === "organic");
  // NO_RESULTS / «не найден» markers are not real SERP rows — treat as empty
  // so GPT cannot later paint global findings over a phantom table.
  const refs = organic
    .flatMap((u) => u.evidenceRefs)
    .filter((ref) => {
      const e = scoped.evidenceIndex[ref];
      if (!e) return true;
      return !NOT_FOUND_PATTERNS.test(`${e.title ?? ""} ${e.domain ?? ""}`);
    });
  if (refs.length === 0) {
    return {
      slides: [
        makeSlotSlide({
          slot,
          sectionId,
          templateId: "coverage-empty-state",
          content: coverageContent(
            "no-organic-data",
            emptyStatusForReason(scoped, "no-organic-data")
          ),
          evidenceRefs: [],
          findingIds: [],
          emptyStateReason: "no-organic-data",
        }),
      ],
      status: "READY",
    };
  }
  const adverseRefSet = new Set<string>();
  for (const f of scoped.findings.filter(isAdverse)) for (const r of f.evidenceRefs) adverseRefSet.add(r);
  // Шаг 13, D7 — одна и та же страница, найденная несколькими запросами,
  // печаталась как несколько разных «позиций» (ru.wikipedia.org на 1 и 19,
  // instagram.com на 2, 21 и 28), а у одного ролика соседние строки несли
  // противоположные оценки. Материал в таблице один; оценка у него —
  // сильнейшая из всех наблюдений этого материала.
  const merged = mergeSerpRowsByMaterial(refs, scoped);
  const displayed = merged.slice(0, 36);
  const displayedRefs = displayed.flatMap((g) => g.refs);
  const rows = displayed.map((group, i) => {
    const e = scoped.evidenceIndex[group.refs[0]!] ?? {};
    // A row is marked when its evidence backs an adverse finding OR its own
    // title carries an adverse pattern (sanctions/criminal/court wording) —
    // clearly negative rows must never show a green "Нейтральный" badge.
    const adverse = group.refs.some((ref) => {
      const ev = scoped.evidenceIndex[ref] ?? {};
      return (
        ev.adverse === true ||
        adverseRefSet.has(ref) ||
        ADVERSE_PATTERNS.test(String(ev.title ?? ""))
      );
    });
    const likely = group.refs.some(
      (ref) => scoped.evidenceIndex[ref]?.subjectDecision === "LIKELY_SUBJECT"
    );
    // Red marker must always carry its label; domain comes from evidence URL.
    // LIKELY (§2.1) → «Вероятно» — visible but not confirmed-subject KPI.
    const rating = adverse ? RED_MARKER_LABEL : likely ? "Вероятно" : "Нейтральный";
    return [
      String(i + 1),
      e.domain ?? domainOfUrl(e.url),
      e.title ?? "(без заголовка)",
      rating,
    ];
  });
  // §7.1: each continuation page gets its own row-scoped sidebar (not a blank
  // strip of the first page's finding blocks).
  const maxRows =
    DECK_TEMPLATE_REGISTRY["serp-table"].maxTableRowsPerSlide > 0
      ? DECK_TEMPLATE_REGISTRY["serp-table"].maxTableRowsPerSlide
      : 12;
  const rowChunks = chunk(rows, maxRows);
  // Ссылки страницы — все наблюдения её строк: доказательная трасса не должна
  // терять дубли, даже когда читателю они показаны одной строкой.
  const refChunks = chunk(
    displayed.map((g) => g.refs),
    maxRows
  ).map((c) => c.flat());
  const slides: SlideContentContract[] = [];
  const baseSlideId = slot.slotId;
  for (let i = 0; i < rowChunks.length; i += 1) {
    const pageRefs = refChunks[i] ?? [];
    const pageRows = rowChunks[i] ?? [];
    const view = buildPageEvidenceView(scoped, pageRefs);
    // Renderer `orion_golden_search_table` paints only `narrative` above the
    // table (not whatWasFound/bullets when rows exist) — put the §7.1 sidebar
    // conclusion there so the page composition is visible in PDF/PPTX.
    const pageBlocks = pageFindingBlocks(scoped, view);
    const slide = makeSlotSlide({
      slot,
      sectionId,
      title:
        i === 0
          ? undefined
          : `${slot.title} (продолжение ${i + 1}/${rowChunks.length})`,
      content: {
        table: { headers: ["№", "Домен", "Заголовок", "Оценка"], rows: pageRows },
        ...pageBlocks,
        narrative: pageBlocks.whatWasFound,
      },
      evidenceRefs: pageRefs,
      findingIds: view.findings.map((f) => f.findingId),
      metrics: {
        datasetCount: refs.length,
        uniqueMaterials: merged.length,
        displayedCount: pageRows.length,
        adverseDisplayed: pageRows.filter((r) => r[3] === RED_MARKER_LABEL).length,
        likelyDisplayed: pageRows.filter((r) => r[3] === "Вероятно").length,
        pageIndex: i + 1,
        pageCount: rowChunks.length,
      },
    });
    if (i === 0) {
      slides.push(slide);
    } else {
      slides.push({
        ...slide,
        slideId: `${baseSlideId}__cont${i}`,
        isContinuation: true,
        continuationOf: baseSlideId,
        continuationIndex: i,
      });
    }
  }
  return { slides, status: "READY" };
}

export function buildSerpScreenshotFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const [slot] = slotsForFragment(key);
  const screenshots = Object.entries(scoped.evidenceIndex).filter(
    ([, e]) => e.kind === "serp_screenshot"
  );
  // Rows actually rendered on the bound snapshot, with the SAME red-frame
  // marking the snapshot generator produced. Sidebar copy is derived from
  // these rows only — never from region- or bundle-level findings.
  const visibleRows = (extras.visualAssets?.[slot.slotId] ?? []).flatMap(
    (a) => a.visibleItems ?? []
  );
  const boundAssetRefs = assetsFor(extras, slot.slotId);
  // Fail-closed: no bound visual → never invent «на этом снимке / деловые материалы».
  if (boundAssetRefs.length === 0 && visibleRows.length === 0) {
    const slide = visualSlide({
      slot,
      sectionId,
      extras,
      scoped,
      content: {
        narrative: `Снимок первой страницы выдачи (${regionLabel}) недоступен в текущем наборе.`,
        whatWasFound:
          "Визуальный снимок выдачи недоступен; текстовые выводы по содержимому снимка не формируются.",
        whyItMatters:
          "Без снимка нельзя подтвердить, что именно видит пользователь на первой странице в этом регионе.",
        whatToCheck:
          "Повторить сбор скриншота выдачи или сверить органическую таблицу результатов на соседних страницах.",
        sourceNote: "Источник: снимок поисковой выдачи недоступен.",
      },
      evidenceRefs: screenshots.map(([ref]) => ref),
      findingIds: [],
      metrics: { screenshots: screenshots.length, adverseHighlights: 0 },
      noUnderlyingData: false,
    });
    return { slides: [slide], status: "READY" };
  }
  const adverseRows = visibleRows.filter((v) => v.adverse);

  // One explanation per red-framed row, attributed to the finding whose
  // evidence that row is (dedup by finding+domain).
  const seenExplanation = new Set<string>();
  const explanations: NonNullable<SlideBody["highlightExplanations"]> = [];
  const explainedFindings: Finding[] = [];
  const explainedDomains: string[] = [];
  const explainedRefs: string[] = [];
  for (const row of adverseRows) {
    const f = findingForVisibleRow(row, scoped);
    const theme = f?.theme ?? row.themeTitle ?? "Потенциально нежелательный материал";
    const domain = row.domain ?? "—";
    const dedupKey = `${f?.findingId ?? theme}|${domain}`;
    if (seenExplanation.has(dedupKey)) continue;
    seenExplanation.add(dedupKey);
    const level = f
      ? `уровень: ${riskLabel(f.riskLevel).toLowerCase()}`
      : "требует ручной проверки";
    explanations.push({
      clientReason: clampClientText(`«${theme}» — выделенный результат ${domain}; ${level}.`, 300),
      frameTone: "red" as const,
    });
    if (f && !explainedFindings.some((x) => x.findingId === f.findingId)) explainedFindings.push(f);
    // Демо-домен не называется клиенту даже как подпись к снимку.
    const safeRowDomain = clientSafeDomain(row.domain);
    if (safeRowDomain && !explainedDomains.includes(safeRowDomain)) explainedDomains.push(safeRowDomain);
    if (scoped.evidenceIndex[row.ref]) explainedRefs.push(row.ref);
  }
  explainedFindings.sort((a, b) => (RISK_ORDER[b.riskLevel] ?? 0) - (RISK_ORDER[a.riskLevel] ?? 0));
  const top = explainedFindings[0];

  // Engine coverage limitation visible on the snapshot itself (e.g. Google
  // holds the highlighted result while the Yandex panel has no stored rows).
  const engines = new Set(visibleRows.map((v) => (v.engine ?? "").toUpperCase()).filter(Boolean));
  const engineNote = !engines.has("YANDEX")
    ? " Выделенные результаты — в выдаче Google; по Яндексу сохранённых результатов в наборе нет."
    : !engines.has("GOOGLE")
      ? " Выделенные результаты — в выдаче Яндекса; по Google сохранённых результатов в наборе нет."
      : "";

  // Headline: page-specific summary of what is framed on THIS snapshot —
  // details per theme live in the highlight explanations (no duplication).
  const headlineDomains = explainedDomains.slice(0, 4);
  const whatWasFound = adverseRows.length
    ? clampClientText(
        `На снимке выделено результатов повышенного внимания: ${explanations.length}` +
          (headlineDomains.length
            ? ` (${headlineDomains.join(", ")}${explainedDomains.length > headlineDomains.length ? " и др." : ""})`
            : "") +
          "; остальные результаты — нейтральные или деловые.",
        400
      )
    : visibleRows.length > 0
      ? "Выделенных результатов повышенного внимания на этом снимке нет; зафиксированы деловые и справочные материалы."
      : "На снимке нет сохранённых строк выдачи для описания состава страницы.";

  const neutralVisibleDomains = [
    ...new Set(clientSafeDomains(visibleRows.map((v) => v.domain))),
  ].slice(0, 3);
  // The sidebar footer is narrow: cap the listed domains so the note always
  // ends with a complete phrase instead of clipping mid-sentence.
  // Перечисление через `enumerateRu`: союз перед последним доменом отличает
  // предложение от выгрузки списка (тот же приём, что в pageSourceLine).
  const sourceNote = explainedDomains.length
    ? `Источники на снимке — ${enumerateRu(explainedDomains)}.`
    : neutralVisibleDomains.length
      ? `Видимые на снимке источники — ${enumerateRu(neutralVisibleDomains)}.`
      : "Источник — снимок поисковой выдачи.";

  const slide = visualSlide({
    slot,
    sectionId,
    extras,
    scoped,
    content: {
      narrative: `Состояние первой страницы выдачи (${regionLabel}).${engineNote}`,
      whatWasFound,
      // Coverage limitation is part of "why it matters": it is rendered in the
      // sidebar on adverse pages, unlike the narrative (dropped there).
      whyItMatters: clampClientText(
        (explanations.length
          ? `Выделенные материалы (${explanations.length}) видны при первичной проверке субъекта в этом регионе.`
          : "Первая страница выдачи не формирует негативного фона вокруг субъекта в этом регионе.") +
          engineNote,
        320
      ),
      whatToCheck: clampClientText(
        top?.recommendedAction ?? "Проверить первоисточники выделенных результатов.",
        220
      ),
      statusNote: statusLine(top),
      sourceNote,
      // Every red highlight on the snapshot is explained by the finding whose
      // evidence that row is — strictly page-scoped.
      highlightExplanations: explanations.length ? explanations : undefined,
    },
    evidenceRefs: [
      ...new Set([
        ...screenshots.map(([ref]) => ref),
        ...visibleRows.map((v) => v.ref).filter((r) => Boolean(scoped.evidenceIndex[r])),
        ...explainedRefs,
      ]),
    ],
    findingIds: explainedFindings.map((f) => f.findingId),
    metrics: {
      screenshots: screenshots.length,
      adverseHighlights: explanations.length,
    },
    noUnderlyingData: false,
  });
  return { slides: [slide], status: "READY" };
}
