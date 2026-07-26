/**
 * Конфликт по отчеству (шаг 13, C9).
 *
 * В отчёт попал материал «ИП Дуров Павел **Юрьевич** — ОГРНИП: 324774600790305»
 * под деловым профилем субъекта, у которого отчество Валерьевич. Фамилия и имя
 * совпали, и классификатор выдал `SUBJECT_MATCH`.
 *
 * Отрицательные признаки личности (`wrongPatronymics`) в системе есть, но их
 * заполняет оператор вручную. На свежем кейсе они пусты, поэтому защиты не было
 * вовсе. При этом конфликт **выводится**: если рядом с фамилией субъекта стоит
 * отчество, отличное от его собственного, речь идёт о другом человеке. В
 * русской именной тройке это решающий признак, а не повод для сомнений.
 *
 * Модуль чистый: ни сети, ни БД, ни модели.
 */

/**
 * Окончания русских отчеств.
 *
 * Границы слова заданы просмотром по буквам, а не `\b`: в JavaScript `\b`
 * определён на ASCII, и с кириллицей границ не находит вовсе — регулярное
 * выражение молча не срабатывало бы ни на одном отчестве.
 */
const PATRONYMIC_RE =
  /(?<!\p{L})(\p{L}{2,}(?:ович|евич|ьевич|ич|овна|евна|ьевна|ична|инична))(?!\p{L})/gu;

/** Насколько близко к фамилии отчество считается относящимся к ней. */
const ADJACENCY_CHARS = 40;

function norm(text: string): string {
  return text.toLowerCase().replace(/ё/gu, "е").replace(/\s+/gu, " ").trim();
}

/**
 * Отчества, стоящие рядом с фамилией субъекта и отличные от его собственных.
 *
 * Соседство обязательно: в тексте, где упомянут и субъект, и посторонний
 * «Иванов Пётр Сергеевич», чужое отчество не относится к субъекту и конфликтом
 * не является.
 */
export function conflictingPatronymics(
  text: string,
  subject: { lastName: string; lastNameVariants?: string[]; patronymics: string[] }
): string[] {
  const haystack = norm(text);
  if (!haystack) return [];

  const own = new Set(
    subject.patronymics.map(norm).filter((p) => p.length > 3)
  );
  // Без собственного отчества сравнивать не с чем: молчим, а не гадаем.
  if (own.size === 0) return [];

  const surnames = [subject.lastName, ...(subject.lastNameVariants ?? [])]
    .map(norm)
    .filter((s) => s.length > 2);
  if (surnames.length === 0) return [];

  const windows: Array<[number, number]> = [];
  for (const surname of surnames) {
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(surname, from);
      if (at < 0) break;
      windows.push([
        Math.max(0, at - ADJACENCY_CHARS),
        Math.min(haystack.length, at + surname.length + ADJACENCY_CHARS),
      ]);
      from = at + surname.length;
    }
  }
  if (windows.length === 0) return [];

  const found = new Set<string>();
  for (const [start, end] of windows) {
    const slice = haystack.slice(start, end);
    for (const m of slice.matchAll(PATRONYMIC_RE)) {
      const candidate = norm(m[1] ?? "");
      if (candidate.length <= 3) continue;
      if (own.has(candidate)) continue;
      found.add(candidate);
    }
  }
  return [...found];
}

/** Есть ли рядом с фамилией субъекта чужое отчество. */
export function hasPatronymicConflict(
  text: string,
  subject: { lastName: string; lastNameVariants?: string[]; patronymics: string[] }
): boolean {
  return conflictingPatronymics(text, subject).length > 0;
}
