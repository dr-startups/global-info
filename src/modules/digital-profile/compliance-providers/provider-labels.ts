/**
 * Название комплаенс-базы для читателя — один ответ на весь продукт.
 *
 * Функция жила в построителе комплаенс-страниц деки, а карта названий — ещё и
 * в сервисе провайдеров. Когда понадобилось назвать базу в слое доказательств,
 * копий стало бы три; вместо этого ответ перенесён сюда, к самому домену
 * провайдеров, и переиспользуется.
 *
 * Незнакомый провайдер раньше печатался как есть, и в отчёт попадал внутренний
 * код: на живом прогоне в колонке «База данных» стояло `OPEN_SANCTIONS`
 * (шаг 15). Подстановка кода — не запасной вариант, а дефект текста, поэтому
 * неизвестное имя приводится к читаемому виду, а не выводится дословно.
 */

const COMPLIANCE_PROVIDER_LABELS: Record<string, string> = {
  OPEN_SANCTIONS: "OpenSanctions",
  DOW_JONES: "Dow Jones",
  LEXISNEXIS: "LexisNexis",
  WORLD_CHECK: "World-Check",
};

export function complianceProviderLabel(raw: string | null | undefined): string {
  const key = String(raw ?? "").trim();
  if (!key) return "База данных";
  const known = COMPLIANCE_PROVIDER_LABELS[key.toUpperCase()];
  if (known) return known;
  // ВНУТРЕННИЙ_КОД → «Внутренний код»: читаемо и не выдаёт себя за название.
  if (/^[A-Z][A-Z0-9_]*$/u.test(key)) {
    const words = key.toLowerCase().replace(/_+/gu, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
  }
  return key;
}
