/**
 * Страницы «Связанные запросы» (Россия — три листа, ОАЭ — один).
 *
 * Правило страницы одно: **описание считает то, что напечатано**. Раньше в
 * буллеты уходил один набор (отобранные риск-строки), а в описание — счёт
 * другого (все ссылки поверхности, до отбора и до обрезки по ёмкости листа).
 * На приёмке это видно сразу: показаны четыре запроса, под ними написано «три»,
 * на соседнем листе показаны два и написано «три». Поэтому страница теперь
 * строится от строк: сколько строк напечатано, столько и названо.
 *
 * Вывод по находке здесь не печатается намеренно. Находки формулируются про
 * публикации («найдены материалы, в которых…»), а на этой странице не
 * публикации, а запросы — фразы, которые поисковик предлагает набрать следующими.
 */

import type { FragmentKey, SectionType, SlideBody } from "../contracts";
import type { ScopedEvidenceIndex, ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import { getAdversePatterns } from "../../../config/finding-themes";
import { pluralRu } from "../../../report/i18n/plural-ru";
import type { FragmentBuildOutput, FragmentExtras } from "./shared";
import { collapseEmptySurfaceSlots } from "../empty-surface-collapse";
import {
  buildPageEvidenceView,
  clampClientText,
  countsTowardSubjectNegative,
  distribute,
  isAdverse,
  makeSlotSlide,
  otherSubjectBulletText,
  otherSubjectExclusionSentence,
  pageSourceLine,
  panelComposition,
  panelCompositionLine,
  panelRows,
  visualSlide,
} from "./shared";

/** Сколько запросов помещается на лист — ёмкость шаблона `related-queries`. */
export const RELATED_QUERIES_PER_PAGE = 10;

export type RelatedRow = {
  ref: string;
  /** Текст запроса — то, что печатается строкой на листе. */
  text: string;
  adverse: boolean;
  /** Принадлежность строки субъекту, если она известна. */
  decision?: string;
};

function normalizeQueryText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[«»"'`?!.,]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Строки поверхности: по одной на запрос, без повторов.
 *
 * Один и тот же связанный запрос приходит от двух поисковых систем и от
 * нескольких запросов набора. В отчёте он должен стоять один раз: повтор в
 * списке читается как отдельная находка.
 */
export function uniqueRelatedRows(
  refs: string[],
  evidenceIndex: ScopedEvidenceIndex,
  adverseRefs: ReadonlySet<string>
): RelatedRow[] {
  const seen = new Set<string>();
  const rows: RelatedRow[] = [];
  for (const ref of refs) {
    const entry = evidenceIndex[ref];
    const text = String(entry?.title ?? "").trim();
    if (!text) continue;
    const key = normalizeQueryText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push({
      ref,
      text,
      adverse: entry?.adverse === true || adverseRefs.has(ref) || getAdversePatterns().test(text),
      decision: entry?.subjectDecision,
    });
  }
  return rows;
}

/**
 * Обрезка по ёмкости раздела: сначала все запросы с негативной формулировкой,
 * затем остальные по порядку выдачи. Порядок внутри отчёта сохраняется — это
 * список, а не рейтинг.
 *
 * Молча терять строки нельзя: сколько собрано и сколько вошло, страница
 * называет отдельно.
 */
export function fitRelatedRows(
  rows: RelatedRow[],
  capacity: number
): { rows: RelatedRow[]; dropped: number } {
  if (capacity <= 0) return { rows: [], dropped: rows.length };
  if (rows.length <= capacity) return { rows, dropped: 0 };
  const keep = new Set<number>();
  rows.forEach((row, i) => {
    if (row.adverse && keep.size < capacity) keep.add(i);
  });
  rows.forEach((_, i) => {
    if (keep.size < capacity) keep.add(i);
  });
  const kept = rows.filter((_, i) => keep.has(i));
  return { rows: kept, dropped: rows.length - kept.length };
}

/**
 * Описание страницы. Считает ровно напечатанные строки; собранное по региону
 * названо отдельным числом, чтобы «10» на листе не читалось как «всего десять».
 */
export function relatedCompositionBlocks(input: {
  rows: readonly RelatedRow[];
  collected: number;
  /** Строки взяты со снимка панели — значит, и говорим о панели. */
  fromPanel: boolean;
}): Partial<SlideBody> {
  const composition = panelComposition(input.rows);
  const adverseShown = composition.adverse;
  // Чужая негативная строка напечатана, но профиль субъекта не утяжеляет —
  // статус говорит об этом словами, иначе исключение выглядит как пропажа.
  const excluded = composition.adverseOther;
  const exclusion = excluded > 0 ? ` ${otherSubjectExclusionSentence(excluded)}` : "";
  return {
    whatWasFound: clampClientText(
      panelCompositionLine({
        composition,
        collected: input.collected,
        nounOne: "связанный запрос",
        nounFew: "связанных запроса",
        nounMany: "связанных запросов",
        place: input.fromPanel ? "на панели" : "на этой странице",
      }),
      400
    ),
    whyItMatters: clampClientText(
      adverseShown > 0
        ? "Связанные запросы поисковик предлагает набрать следующими: негативная формулировка в этом блоке уводит читателя к нежелательным материалам ещё до того, как он их искал."
        : "Связанные запросы поисковик предлагает набрать следующими: негативных формулировок среди них нет, к нежелательным материалам блок не уводит.",
      320
    ),
    whatToCheck: clampClientText(
      "Проверять блок при обновлении: состав связанных запросов меняется вместе с выдачей.",
      220
    ),
    statusNote:
      adverseShown > 0
        ? `На этой странице ${adverseShown} ${pluralRu(
            adverseShown,
            "запрос",
            "запроса",
            "запросов"
          )} с негативной формулировкой.${exclusion}`
        : excluded > 0
          ? `Негативных формулировок о проверяемом лице на этой странице нет.${exclusion}`
          : "Запросов с негативной формулировкой на этой странице нет.",
  };
}

export function buildRelatedQueriesFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const slots = slotsForFragment(key);
  const units = scoped.surfaceUnits.filter((u) => u.surface === "paa_related");
  const refs = units.flatMap((u) => u.evidenceRefs);
  const adverseRefs = new Set<string>();
  for (const f of scoped.findings.filter(isAdverse)) {
    for (const r of f.evidenceRefs) adverseRefs.add(r);
  }
  const collected = uniqueRelatedRows(refs, scoped.evidenceIndex, adverseRefs);
  const fitted = fitRelatedRows(collected, slots.length * RELATED_QUERIES_PER_PAGE);
  // Страниц под запросы — сколько нужно, а не сколько слотов: два запроса,
  // разложенные на три листа, оставляют третий лист без единой строки.
  const usedPages = Math.min(slots.length, Math.max(1, fitted.rows.length));
  const pages = distribute(fitted.rows, usedPages);

  const slides = slots.map((slot, i) => {
    /*
     * Показанные строки берём со снимка панели, когда он есть.
     *
     * Панель рисуется отдельно от построителя и раскладывает запросы по
     * страницам по-своему: на третьем листе она нарисовала две строки, а
     * описание рядом считало три — свои. Клиент сверяет текст с картинкой,
     * поэтому источник чисел — картинка.
     */
    const fromPanel = panelRows(slot.slotId, extras, scoped);
    const rows: RelatedRow[] = fromPanel.length > 0 ? fromPanel : (pages[i] ?? []);
    if (rows.length === 0 && collected.length > 0) {
      // Слот блока, на который материала не хватило. Статус «не собиралось»
      // здесь был бы неправдой: собрано, показано, просто уместилось раньше.
      return makeSlotSlide({
        slot,
        sectionId,
        content: {
          narrative: `Все связанные запросы, собранные по региону «${regionLabel}», показаны на предыдущих страницах блока: их ${collected.length}.`,
          sourceNote: pageSourceLine(buildPageEvidenceView(scoped, [])),
        },
        evidenceRefs: [],
        findingIds: [],
        metrics: { items: 0, adverseQueries: 0 },
      });
    }
    const pageRefs = rows.map((r) => r.ref);
    const view = buildPageEvidenceView(scoped, pageRefs);
    return visualSlide({
      slot,
      sectionId,
      extras,
      scoped,
      content: {
        bullets: rows.map((r) =>
          clampClientText(otherSubjectBulletText(r.text, r.decision), 220)
        ),
        ...relatedCompositionBlocks({
          rows,
          collected: collected.length,
          fromPanel: fromPanel.length > 0,
        }),
        sourceNote: pageSourceLine(view),
      },
      evidenceRefs: pageRefs,
      findingIds: view.findings.map((f) => f.findingId),
      metrics: {
        items: rows.length,
        adverseQueries: rows.filter(countsTowardSubjectNegative).length,
      },
      noUnderlyingData: collected.length === 0,
      noDataReason: "no-related",
      noDataScopeLabel: regionLabel,
    });
  });
  // Пустая поверхность занимает одну страницу, а не три одинаковые (шаг 15, E2).
  const collapsed = collapseEmptySurfaceSlots(slides);
  return { slides: collapsed.slides, status: "READY" };
}

// ---------------------------------------------------------------------------
// COMPLIANCE (p33..p36) — existing content, no source expansion
