/**
 * Вычистка повторов по белому списку: снимается только объявленная присказка.
 *
 * Прежняя вычистка сравнивала **любые** предложения по всей деке и молча
 * выбрасывала совпавшие. На прогоне 14.08 из 205 предложений пакетов до деки не
 * дошло 38, и 24 из них несли цитату, источник или число:
 *
 *   - страница `p24_uae_summary` опустела целиком (424 → 0 символов): цитата
 *     «Timati has been suspected in Ukraine», её источник и счётчики темы были
 *     сняты как «уже сказанное» — они встречались в российском разделе;
 *   - на `p07_ru_summary__cont2` цитата оборвалась на середине предложения,
 *     потому что вторая её половина и строка «Где видно: xfirm.ru» совпали с
 *     напечатанными выше.
 *
 * Правило перевёрнуто. Не «убираем всё, кроме защищённого», а «убираем только
 * то, что объявлено присказкой»: восемь пояснений тем из синтезатора находок и
 * столько же из сборщика клиентского резюме. Всё остальное — цитата, источник,
 * «Где видно», счётчики, идентификатор находки — неприкосновенно **по
 * устройству**, а не потому, что его удалось распознать эвристикой.
 *
 * Присказка на то и присказка, что отсылать к ней незачем: её просто не
 * печатают второй раз, ссылок «см. стр. N» вычистка не оставляет.
 */

import { CLIENT_THEME_WHY } from "../analytics/finding-synthesizer";
import {
  CLIENT_SUMMARY_THEME_WHY,
  CLIENT_SUMMARY_THEME_WHY_FALLBACK,
} from "../analytics/client-summary-pack-builder";
import { normalizeForCompare } from "./text-compare";

/**
 * Полный список присказок, которые вычистка имеет право снять.
 *
 * Собирается из объявлений построителей, а не переписывается сюда руками:
 * добавили тему — присказка попадает в список сама, и забыть синхронизировать
 * два места невозможно.
 */
export const BOILERPLATE_COMMENTARY: readonly string[] = [
  ...Object.values(CLIENT_THEME_WHY),
  ...Object.values(CLIENT_SUMMARY_THEME_WHY),
  CLIENT_SUMMARY_THEME_WHY_FALLBACK,
];

const BOILERPLATE_KEYS: ReadonlySet<string> = new Set(
  BOILERPLATE_COMMENTARY.map((s) => normalizeForCompare(s)).filter(Boolean)
);

/**
 * Идентификатор находки в конце строки — маркер, а не предложение.
 *
 * `bulletWithFindingId` приклеивает его к последней строке блока, а разбивка по
 * предложениям отрывает: точка присказки оказывается границей, и маркер
 * становится «отдельным предложением». Сняв присказку, вычистка оставляла бы
 * строку из одного `[finding-…]` — по этой связи читатель сверяет вывод с
 * доказательной базой, и осиротить её нельзя.
 */
const TRAILING_FINDING_ID = /\s*(\[finding-[^\]]*\]\s*)+$/u;

/** Правда для предложения, объявленного шаблонной присказкой. */
export function isBoilerplateCommentary(sentence: string): boolean {
  const body = sentence.replace(TRAILING_FINDING_ID, "").trim();
  if (body !== sentence.trim()) return false;
  const key = normalizeForCompare(body);
  return key.length > 0 && BOILERPLATE_KEYS.has(key);
}

export type BoilerplateCleanup = {
  /** Текст после вычистки; при отказе от вычистки — исходный. */
  text: string;
  /** Снятые предложения — для разбора сборки. */
  removed: string[];
};

/**
 * Убирает из текста присказки, уже встречавшиеся выше, и запоминает
 * оставшиеся.
 *
 * Разбор идёт построчно, а внутри строки — по предложениям: присказка не всегда
 * занимает свою строку, на прогоне она приклеивалась к «Где видно: руни.рф,
 * prima-inform.ru.» через пробел. Соседи по строке при этом остаются на месте.
 *
 * Пустым результат не бывает: если снять пришлось бы всё, вычистка отменяется
 * целиком — блок без текста хуже блока с повтором.
 */
export function withoutRepeatedBoilerplate(
  text: string | undefined,
  said: Set<string>
): BoilerplateCleanup {
  const src = (text ?? "").trim();
  if (!src) return { text: "", removed: [] };

  const removed: string[] = [];
  const lines: string[] = [];
  for (const line of src.split("\n")) {
    // Маркер находки снимается со строки до разбора и возвращается на место:
    // иначе он отрывается в самостоятельное «предложение» и остаётся сиротой.
    const idMatch = line.match(TRAILING_FINDING_ID);
    const idTail = idMatch ? idMatch[0].trim() : "";
    const body = idTail ? line.slice(0, line.length - idMatch![0].length) : line;

    const kept: string[] = [];
    const droppedHere: string[] = [];
    for (const sentence of body.split(/(?<=[.!?…])\s+/u)) {
      const piece = sentence.trim();
      if (!piece) continue;
      if (!isBoilerplateCommentary(piece)) {
        kept.push(piece);
        continue;
      }
      const key = normalizeForCompare(piece);
      if (said.has(key)) {
        droppedHere.push(piece);
        continue;
      }
      said.add(key);
      kept.push(piece);
    }

    if (kept.length === 0 && idTail) {
      // Строка была одной присказкой с маркером находки. Снять её значит
      // оставить маркер без текста — оставляем строку как была.
      lines.push(line.trim());
      for (const piece of droppedHere) said.add(normalizeForCompare(piece));
      continue;
    }
    removed.push(...droppedHere);
    const joined = [kept.join(" ").trim(), idTail].filter(Boolean).join(" ");
    if (joined) lines.push(joined);
  }

  const out = lines.join("\n").trim();
  if (!out) {
    // Блок состоял из одной присказки и ничего больше. Снимать нечего:
    // возвращаем как было и не считаем это вычисткой.
    for (const piece of removed) said.add(normalizeForCompare(piece));
    return { text: src, removed: [] };
  }
  return { text: out, removed };
}

/**
 * Доля текста страницы, больше которой вычистка снять не вправе.
 *
 * Потолок — предохранитель, а не рабочий режим: снимаются только объявленные
 * присказки, и на здоровой странице их доля заметно меньше трети. Если порог
 * всё-таки перейдён, вычистка на этой странице отменяется целиком — молча
 * укорачивать страницу нельзя, о таком случае должен узнать разбор сборки.
 */
export const DEDUP_PAGE_SHARE_CEILING = 1 / 3;

export type SlideDedupResult = {
  bullets: string[];
  /** Снятые предложения; пусто, если вычистка отменена потолком. */
  removed: string[];
  /** Сколько символов сняли бы, если бы не потолок. */
  wouldRemoveChars: number;
  /** Правда, если потолок перейдён и вычистка на странице не применена. */
  skippedByCeiling: boolean;
};

/**
 * Вычистка присказок на одной странице — вместе с потолком.
 *
 * Отдельной функцией, а не внутри сборщика: потолок — это предохранитель, и
 * проверять его надо в лоб, не собирая ради этого манифест с пакетами.
 */
export function dedupSlideBullets(
  bullets: readonly string[],
  said: Set<string>
): SlideDedupResult {
  const cleaned = bullets.map((b) => withoutRepeatedBoilerplate(b, said));
  const removed = cleaned.flatMap((c) => c.removed);
  const before = bullets.join("\n").length;
  const after = cleaned.map((c) => c.text).join("\n").length;
  const wouldRemoveChars = Math.max(0, before - after);

  if (removed.length === 0) {
    return { bullets: [...bullets], removed: [], wouldRemoveChars: 0, skippedByCeiling: false };
  }
  if (before > 0 && wouldRemoveChars > before * DEDUP_PAGE_SHARE_CEILING) {
    return { bullets: [...bullets], removed: [], wouldRemoveChars, skippedByCeiling: true };
  }
  return {
    bullets: cleaned.map((c) => c.text).filter((b) => b.trim().length > 0),
    removed,
    wouldRemoveChars,
    skippedByCeiling: false,
  };
}
