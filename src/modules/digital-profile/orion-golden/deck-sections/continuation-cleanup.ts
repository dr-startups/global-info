/**
 * Продолжение без содержимого — это пустой лист в отчёте.
 *
 * Блок с длинным перечнем разбивается на страницу-основу и продолжения
 * (`withContinuations`). Уже после разбивки сборка вычищает из отчёта
 * повторяющиеся дословно абзацы: одно и то же пояснение темы печаталось в
 * матрице рисков, в обзоре профиля и в резюме региона. Если на продолжении
 * стоял ровно такой повтор, страница оставалась с одним заголовком — на
 * приёмке это лист «ОАЭ», на котором нет ничего.
 *
 * Числа блока (KPI), вывод и рекомендация принадлежат его первой странице,
 * поэтому у продолжения нет и их: если перечень с него исчез, спасать нечего.
 * Такую страницу убираем и перенумеровываем подписи «(продолжение 2/3)» —
 * иначе читатель увидит «2/3, 4/3».
 *
 * Основу блока не трогаем никогда: это канонический слот отчёта, и его
 * отсутствие означало бы пропущенный раздел, а не сэкономленный лист.
 */

import type { SlideContentContract } from "./contracts";
import {
  continuationNumberInTitle,
  continuationTitle,
  stripContinuationSuffix,
} from "./continuation-slide";

/**
 * Есть ли на странице то, ради чего её печатают.
 *
 * Список полей совпадает с проверкой сборки `noMateriallyEmptyPages`: правило
 * одно, и вычистка обязана оставлять после себя дек, который эта проверка
 * признаёт непустым. Сноска об источнике и методическая врезка сюда не входят
 * — страница из одной сноски пустая.
 */
export function slideHasClientContent(slide: SlideContentContract): boolean {
  const c = slide.content;
  return Boolean(
    c.narrative?.trim() ||
      (c.bullets ?? []).some((b) => b.trim()) ||
      (c.table?.rows.length ?? 0) > 0 ||
      (c.kpis?.length ?? 0) > 0 ||
      (c.highlightExplanations?.length ?? 0) > 0 ||
      slide.visualAssetRefs.length > 0 ||
      c.whatWasFound?.trim() ||
      c.whyItMatters?.trim() ||
      c.whatToCheck?.trim() ||
      c.statusNote?.trim()
  );
}

/**
 * Убрать продолжения, оставшиеся без содержимого, и перенумеровать подписи
 * уцелевших. Порядок страниц сохраняется: вычистка не переставляет слайды.
 */
export function dropEmptyContinuations(slides: SlideContentContract[]): {
  slides: SlideContentContract[];
  dropped: string[];
} {
  const dropped: string[] = [];
  const affected = new Set<string>();
  const kept = slides.filter((slide) => {
    if (!slide.isContinuation || slideHasClientContent(slide)) return true;
    dropped.push(slide.slideId);
    if (slide.continuationOf) affected.add(slide.continuationOf);
    return false;
  });
  if (dropped.length === 0) return { slides, dropped };
  return { slides: renumberContinuations(kept, slides, affected), dropped };
}

/**
 * Пересчитать номера продолжений в блоках, потерявших страницу.
 *
 * Блоки, у которых ничего не выброшено, не трогаем: у построителей разные
 * договорённости о счёте — один нумерует продолжения от «2/4», считая первой
 * страницей саму основу, другой от «1/2», считая только продолжения. Единое
 * правило, применённое ко всем, переписало бы чужие подписи без надобности.
 * Поэтому счёт блока читается из его же подписей и сохраняется.
 *
 * Подпись переписывается только там, где она имеет вид «(продолжение i/N)»:
 * у таблиц выдачи продолжение называется своим заголовком («Россия — Google,
 * ТОП-20 (2/2)»), и переписывать его нечем и незачем.
 */
function renumberContinuations(
  slides: SlideContentContract[],
  before: SlideContentContract[],
  affected: ReadonlySet<string>
): SlideContentContract[] {
  // «Основа считается первой страницей блока?» — по первой подписи до вычистки.
  const startsAt = new Map<string, number>();
  for (const slide of before) {
    if (!slide.isContinuation || !slide.continuationOf) continue;
    if (startsAt.has(slide.continuationOf)) continue;
    const n = continuationNumberInTitle(slide.title);
    if (n !== undefined) startsAt.set(slide.continuationOf, n);
  }
  const familySize = new Map<string, number>();
  for (const slide of slides) {
    if (!slide.isContinuation || !slide.continuationOf) continue;
    familySize.set(slide.continuationOf, (familySize.get(slide.continuationOf) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  return slides.map((slide) => {
    if (!slide.isContinuation || !slide.continuationOf) return slide;
    const baseId = slide.continuationOf;
    const index = (seen.get(baseId) ?? 0) + 1;
    seen.set(baseId, index);
    if (!affected.has(baseId)) return { ...slide, continuationIndex: index };
    const offset = Math.max(0, (startsAt.get(baseId) ?? 2) - 1);
    const title =
      continuationNumberInTitle(slide.title) === undefined
        ? slide.title
        : continuationTitle(
            stripContinuationSuffix(slide.title),
            index + offset,
            (familySize.get(baseId) ?? 0) + offset
          );
    return { ...slide, continuationIndex: index, title };
  });
}
