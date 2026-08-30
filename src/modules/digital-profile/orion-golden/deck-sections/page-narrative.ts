/**
 * Абзац страницы — то, что действительно уезжает рендереру.
 *
 * Абзац собирается в два приёма: построитель кладёт `content.narrative`, а
 * нагрузка приклеивает к нему прозу находки. Пока эти два приёма мерили в двух
 * местах, бюджет листа применялся к двум разным величинам: сверка пакета
 * видела 416 знаков построителя, а на лист уезжало 620 — и на живых прогонах
 * 1013, 1014, 1101, 1178 при ёмкости 998. Оба сторожа спрашивают теперь одну
 * функцию отсюда.
 *
 * Модуль отдельный не ради красоты: `run-deck-build.ts` уже импортирует
 * `fragment-builders/shared.ts`, поэтому склейку, нужную и разбивке в
 * `shared.ts`, и нагрузке, из `run-deck-build.ts` не достать — импорты
 * замкнулись бы в кольцо. Здесь нет ни рендера, ни ввода-вывода: только текст
 * и реестр.
 */

import { getClientTextFieldBudgets } from "../client/load-client-text-contract";
import {
  DECK_TEMPLATE_REGISTRY,
  SILENTLY_CLIPPED_NARRATIVE_TEMPLATES,
  type DeckTemplateId,
} from "./template-registry";
import { withoutRepeatedSentences } from "./text-compare";

const TEXT_BUDGETS = getClientTextFieldBudgets();

/**
 * Макеты, которые рисуют поля карточками, а не одним склеенным абзацем.
 *
 * У них рекомендация печатается своей карточкой, поэтому во вклейку нарратива
 * она не идёт (иначе «Мы предлагаем …» стоит на странице дважды), а буллеты
 * остаются списком: фолд «нарратив первым буллетом» здесь и погубил страницу
 * Википедии — 1387-символьный буллет ножницы рендерера превратили в пустоту.
 */
export const CARD_STRUCTURED_TEMPLATES = new Set([
  "orion_golden_no_data_compact",
  "orion_golden_wikipedia_check",
]);
/** Оканчивается ли фраза знаком конца предложения. */
function endsSentence(text: string): boolean {
  return /[.!?…»)]\s*$/u.test(text.trim());
}

/** Приписывает точку, если её нет: куски склеиваются в связный абзац. */
function asSentence(text: string): string {
  const t = text.trim();
  if (!t) return "";
  return endsSentence(t) ? t : `${t}.`;
}

/**
 * Текст находки одним абзацем — вместо анкеты из подписей.
 *
 * Прежде эти же поля уезжали в буллеты префиксами «Что обнаружено: …»,
 * «Почему важно: …», «Что проверить: …», одинаково на каждой странице с
 * данными. Читатель получал бланк проверки, повторённый тридцать раз, и ни одна
 * страница не читалась как связный текст.
 *
 * Найденное и его значение — это одна мысль, а не две графы, поэтому они
 * склеиваются в абзац. Рекомендация остаётся отдельным предложением в конце:
 * это вывод, и по нему принимают решение.
 */
export function composeFindingProse(s: {
  whatWasFound?: string;
  whyItMatters?: string;
  whatToCheck?: string;
  /** Уже показанный на странице текст: вводный абзац и буллеты. */
  narrative?: string;
  bullets?: string[];
  /**
   * Ячейки таблицы этого слайда. Страница печатает свою таблицу, значит всё,
   * что в ней стоит, на странице уже есть: у профильных карточек комплаенса
   * «Почему важно» и «Что сделать» — это строки «Параметр | Значение», и тем
   * же текстом они уезжали в абзац.
   */
  tableCells?: string[];
}): string | undefined {
  /*
   * Дедупликация обязательна, а не желательна.
   *
   * Строители нередко кладут в `whatWasFound` ровно то, что уже стоит первым
   * буллетом. Пока текст ехал под подписью «Что обнаружено:», повтор выглядел
   * как отдельная графа и в глаза не бросался. Стоило подпись убрать — и один
   * и тот же факт пошёл в абзаце дважды подряд.
   *
   * Сравнение идёт **по предложениям**, а не по целому полю. Целыми полями оно
   * срабатывало только при побайтном равенстве `narrative` и `whatWasFound`:
   * на прогоне без записанного запроса выдачи лида нет, поля совпадают и
   * повтора не видно, а на любом прогоне с записанным запросом лид сдвигает
   * строку — и вывод страницы печатается вторым экземпляром подряд.
   */
  const said = new Set<string>();
  for (const shown of [s.narrative ?? "", ...(s.bullets ?? []), ...(s.tableCells ?? [])]) {
    withoutRepeatedSentences(shown, said);
  }
  const take = (part?: string): string => {
    const kept = withoutRepeatedSentences(part, said);
    return kept ? asSentence(kept) : "";
  };

  const paragraph = [take(s.whatWasFound), take(s.whyItMatters)].filter(Boolean).join(" ");
  const closing = take(s.whatToCheck);
  const blocks = [paragraph, closing].filter(Boolean);
  return blocks.length ? blocks.join("\n") : undefined;
}

/**
 * Сколько знаков абзаца помещается на лист этого шаблона.
 *
 * Для шаблонов, где рендерер режет молча, число берётся у реестра — оно там
 * померено. Для остальных остаётся общий бюджет клиентского поля: их число в
 * реестре — сид раскладки, а не замер, и о потере рендерер сообщает сам.
 *
 * Живёт здесь, рядом со склейкой абзаца, потому что вопрос один: сколько
 * влезает **на страницу**. Сверка пакета ре-экспортирует эту же функцию.
 */
export function narrativeBudgetOf(templateId: string): number {
  const template = DECK_TEMPLATE_REGISTRY[templateId as DeckTemplateId];
  return template && SILENTLY_CLIPPED_NARRATIVE_TEMPLATES.has(templateId as DeckTemplateId)
    ? template.layout.narrativeCharBudget
    : TEXT_BUDGETS.narrative;
}

/** Поля слайда, из которых собирается абзац страницы. */
export type PageNarrativeSource = {
  narrative?: string;
  whatWasFound?: string;
  whyItMatters?: string;
  whatToCheck?: string;
  bullets?: string[];
  table?: { rows?: string[][] };
};

/** Внутренние метки происхождения до клиента не доезжают. */
function stripFindingMarkers(text: string): string {
  return text.replace(/\s*\[finding-[^\]]+\]/gu, "").trim();
}

/**
 * Абзац страницы: вводный абзац построителя плюс проза находки.
 *
 * Ровно то, что кладёт в нагрузку `toRendererPayload` **до** резака абзацев
 * (резак знаков не теряет — за этим следит своя сверка). Эту величину меряют
 * оба сторожа: сверка пакета и последний рубеж перед рендерером.
 */
export function pageNarrativeOf(
  slide: PageNarrativeSource,
  rendererTemplate: string
): string | undefined {
  const composed = [
    slide.narrative,
    composeFindingProse({
      ...(CARD_STRUCTURED_TEMPLATES.has(rendererTemplate)
        ? { ...slide, whatToCheck: undefined }
        : slide),
      tableCells: slide.table?.rows?.flat(),
    }),
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join("\n");
  return composed ? stripFindingMarkers(composed) : undefined;
}

/**
 * Сколько места остаётся построителю на первой странице — оценка **снизу**.
 *
 * Проза находки приклеивается только к первой странице цепочки
 * (`buildContinuationSlide` снимает её поля с продолжений), и её длина считается
 * **без** дедупликации: дедупликация может текст только укоротить, значит
 * комната, посчитанная без неё, никогда не окажется больше настоящей. Ошибаться
 * эта величина обязана в сторону запаса: ею разбивка решает, что оставить на
 * листе, а лишний знак здесь — молчаливая потеря хвоста у рендерера.
 */
export function builderNarrativeRoomOn(
  slide: PageNarrativeSource,
  templateId: string,
  rendererTemplate: string
): number {
  const budget = narrativeBudgetOf(templateId);
  // Пустой набор «уже сказанного»: ничего не дедуплицируется, проза считается
  // во всю длину.
  const prose = composeFindingProse({
    ...(CARD_STRUCTURED_TEMPLATES.has(rendererTemplate)
      ? { ...slide, whatToCheck: undefined }
      : slide),
    narrative: undefined,
    bullets: undefined,
    tableCells: undefined,
  });
  const glued = prose ? stripFindingMarkers(prose).length + 1 : 0;
  return Math.max(0, budget - glued);
}
