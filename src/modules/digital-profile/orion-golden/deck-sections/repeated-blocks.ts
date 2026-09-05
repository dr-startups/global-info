/**
 * Повтор блока на странице: как его узнают и как чинят.
 *
 * Единица сравнения — то, что видит клиент. На карточной странице матрицы
 * рисков буллет — это тело карточки, а её заголовок стоит строкой таблицы: в
 * буллет он намеренно не входит, иначе печатался бы дважды. Пока сравнивалось
 * одно тело, две разные темы с одинаковым телом («Всего по теме: 3 материала»
 * плюс постоянная оговорка) объявлялись повтором — прогон DPA-2026-0053.
 *
 * Здесь же живёт починка: второй одинаковый блок снимается со страницы до
 * проверки и называется в разборе сборки. Ворота «страница не печатает один и
 * тот же текст дважды» правы в том, что это дефект, и неправы в том, что цена
 * дефекта — отчёт, не выданный клиенту. Модуль нейтрален: его читают и
 * сборщик, и проверка сборки, и ответ у них один.
 */

import { withoutFindingMarkers } from "./slide-markers";
import { normalizeForCompare } from "./text-compare";

export type PrintedBlock = { key: string; excerpt: string; field: string };

type PrintedSlide = {
  narrative?: string | undefined;
  bullets?: string[] | undefined;
  sourceNote?: string | undefined;
  table?: { rows: string[][] } | undefined;
};

/**
 * Блоки клиентского текста страницы — в том виде, в каком их сравнивают на повтор.
 *
 * Заголовки карточек берутся, только когда строк таблицы ровно столько же,
 * сколько буллетов: иначе соответствие карточки и строки неизвестно, а
 * выдумывать его значит сравнивать не то, что напечатано. Блок, от которого
 * после нормализации не осталось ни слова (одно тире, многоточие), клиенту
 * текстом не виден и в сравнение не идёт.
 */
export function printedBlocksForRepeatCheck(slide: PrintedSlide, templateId: string): PrintedBlock[] {
  const bullets = slide.bullets ?? [];
  const rows = slide.table?.rows ?? [];
  const headlineOf = (index: number): string =>
    templateId === "risk-matrix" && rows.length === bullets.length
      ? String(rows[index]?.[0] ?? "")
      : "";
  const raw: Array<{ text: string; headline: string; field: string }> = [
    { text: String(slide.narrative ?? ""), headline: "", field: "narrative" },
    ...bullets.map((b, i) => ({ text: String(b ?? ""), headline: headlineOf(i), field: `bullets[${i}]` })),
    { text: String(slide.sourceNote ?? ""), headline: "", field: "sourceNote" },
  ];
  const out: PrintedBlock[] = [];
  for (const block of raw) {
    const text = withoutFindingMarkers(block.text);
    if (!text) continue;
    const key = normalizeForCompare(`${block.headline} ${text}`);
    if (!key) continue;
    out.push({ key, excerpt: text.replace(/\s+/gu, " ").slice(0, 90), field: block.field });
  }
  return out;
}

export type RepeatRepair = { slideKey: string; field: string; excerpt: string };

/**
 * Снять со страниц повторные блоки — на месте, до проверки сборки.
 *
 * Снимается всегда **поздний** блок: абзац стоит первым и остаётся, пункт,
 * повторяющий его, уходит; подпись источников, повторяющая пункт, уходит.
 * Страницы с данными провайдера не трогаются тем же предикатом, что и у
 * проверки: две одинаковые подсказки — два факта, а не повтор.
 */
export function repairRepeatedBlocks(
  slides: Array<PrintedSlide & { slideKey: string; templateId: string }>,
  isDataRow: (templateId: string) => boolean
): RepeatRepair[] {
  const repairs: RepeatRepair[] = [];
  for (const slide of slides) {
    if (isDataRow(slide.templateId)) continue;
    const seen = new Set<string>();
    const dropBullets = new Set<number>();
    let dropSourceNote = false;
    for (const block of printedBlocksForRepeatCheck(slide, slide.templateId)) {
      if (!seen.has(block.key)) {
        seen.add(block.key);
        continue;
      }
      repairs.push({ slideKey: slide.slideKey, field: block.field, excerpt: block.excerpt });
      const bullet = /^bullets\[(\d+)\]$/u.exec(block.field);
      if (bullet) dropBullets.add(Number(bullet[1]));
      else if (block.field === "sourceNote") dropSourceNote = true;
    }
    if (dropBullets.size > 0) {
      slide.bullets = (slide.bullets ?? []).filter((_, i) => !dropBullets.has(i));
    }
    if (dropSourceNote) slide.sourceNote = undefined;
  }
  return repairs;
}
