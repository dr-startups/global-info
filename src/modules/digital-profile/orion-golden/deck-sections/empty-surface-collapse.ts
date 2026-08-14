/**
 * Пустая поверхность занимает одну страницу, а не все свои слоты (шаг 15, E2).
 *
 * На регрессионном прогоне страницы 31–33 «Россия — связанные запросы (1..3)»
 * были дословно одинаковы: «Поверхность не собиралась в этом прогоне». Тот же
 * дефект был с четырьмя страницами «изображения» в шаге 13. Причина одна:
 * построитель отдаёт слайд на каждый канонический слот фрагмента независимо от
 * того, есть ли данные.
 *
 * Три одинаковые страницы не сообщают втрое больше — они сообщают то же самое и
 * заставляют читателя проверять, не пропустил ли он разницу.
 *
 * Схлопывание не значит «потерять слот». Канонический слот остаётся учтённым:
 * он попадает в `mergedSlots` манифеста с причиной, покрытие остаётся полным, и
 * сверка страниц по-прежнему отвечает за каждую каноническую позицию. Разница
 * только в том, что пустота печатается один раз.
 *
 * Модуль чистый.
 */

import { VISUAL_ASSET_UNAVAILABLE } from "./slide-markers";

export type SlotMerge = {
  baseSlotId: string;
  mergedInto: string;
  reason: string;
};

export type CollapsibleSlide = {
  baseSlotId: string;
  emptyStateReason?: string;
};

export type CollapseResult<T> = {
  slides: T[];
  mergedSlots: SlotMerge[];
};

/**
 * Схлопывает подряд идущие пустые слайды фрагмента в первый из них.
 *
 * Схлопывание происходит **только когда пусты все слайды фрагмента**: если
 * часть страниц содержательна, каждая остаётся на своём месте — это уже не
 * дубль, а разбиение материала.
 */
export function collapseEmptySurfaceSlots<T extends CollapsibleSlide>(
  slides: readonly T[]
): CollapseResult<T> {
  if (slides.length <= 1) return { slides: [...slides], mergedSlots: [] };
  const allEmpty = slides.every((s) => isMissingSurfacePage(s));
  if (!allEmpty) return { slides: [...slides], mergedSlots: [] };

  const [first, ...rest] = slides;
  return {
    slides: [first!],
    mergedSlots: rest.map((s) => ({
      baseSlotId: s.baseSlotId,
      mergedInto: first!.baseSlotId,
      reason: emptySurfaceMergeReason(),
    })),
  };
}

/**
 * Страница «поверхность не дала материала».
 *
 * Пометка «нет картинки» (`VISUAL_ASSET_UNAVAILABLE`) сюда не относится:
 * материал на такой странице есть, он показан текстом. На прогоне без снимков
 * это стоило содержимого — четырнадцать связанных запросов схлопывались в одну
 * страницу с пятью строками, а причина слияния сообщала клиенту, что
 * поверхность ничего не дала.
 */
function isMissingSurfacePage(slide: CollapsibleSlide): boolean {
  const reason = slide.emptyStateReason;
  return Boolean(reason) && reason !== VISUAL_ASSET_UNAVAILABLE;
}

/** Причина слияния для поверхности, у которой не оказалось данных. */
export function emptySurfaceMergeReason(): string {
  return (
    "Поверхность не дала материала, и все её страницы показали бы один и тот же " +
    "статус сбора. Статус приведён один раз на первой странице поверхности; " +
    "страницы-дубли не печатаются."
  );
}
