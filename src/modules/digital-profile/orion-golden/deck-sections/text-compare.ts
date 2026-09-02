/**
 * Приведение текста к сравнимому виду — общий знаменатель для всех мест, где
 * ищется дубль.
 *
 * Живёт отдельным модулем, потому что им пользуются и сборка деки, и вычистка
 * присказок ([[boilerplate-commentary]]). Раньше он лежал в `run-deck-build`, а
 * сборщик деки импортировал его оттуда — при том, что `run-deck-build` сам
 * импортирует сборщик. Кольцо работало по случайности порядка загрузки.
 */

/**
 * Регистр, пунктуация и тире отбрасываются, пробелы схлопываются.
 *
 * Строители расставляют кавычки и тире по-разному («тема» — уровень: …), и
 * сравнение «в лоб» пропускает повтор из-за одного дефиса.
 */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.,;:!?…«»"'()‐-―-]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Убирает из текста предложения, уже встречавшиеся раньше, и запоминает
 * оставшиеся.
 *
 * Сравнение — по нормализованному виду (`normalizeForCompare`): кавычки, тире и
 * регистр у одного и того же предложения в разных блоках отличаются, а смысл
 * нет. Пустой остаток возвращается как `undefined`, чтобы не осталось
 * заголовка блока без текста под ним.
 */
export function withoutRepeatedSentences(
  text: string | undefined,
  said: Set<string>
): string | undefined {
  const src = (text ?? "").trim();
  if (!src) return undefined;
  const kept: string[] = [];
  for (const sentence of src.split(/(?<=[.!?…])\s+/u)) {
    const piece = sentence.trim();
    if (!piece) continue;
    const key = normalizeForCompare(piece);
    if (!key) continue;
    if (said.has(key)) continue;
    said.add(key);
    kept.push(piece);
  }
  return kept.length > 0 ? kept.join(" ") : undefined;
}
