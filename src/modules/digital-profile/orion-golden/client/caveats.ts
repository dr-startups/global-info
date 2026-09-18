/**
 * Оговорки клиентского текста — один словарь, в контракте (шаг 0105).
 *
 * Оговорка — законченное предложение без факта внутри, которое квалифицирует
 * источник или сигнал: «Наличие публикации не подтверждает изложенные
 * обвинения», «Принадлежность материала проверяемому лицу требует
 * подтверждения». Рендерер узнаёт такую строку по словарю раздела
 * `typography.caveats` и печатает её серым кеглем тела — поэтому текст берётся
 * из того же словаря, а не из константы рядом с построителем: два экземпляра
 * одного предложения разойдутся молча, и строка на странице снова станет
 * чёрной без единого предупреждения.
 *
 * `{domains}` — единственная подстановка: список доменов, названных клиенту,
 * в скобках. Незаполненная подстановка и домены для шаблона без неё — ошибка
 * сборки, а не фигурные скобки на странице клиента.
 */

import rawContract from "./client-text-contract.json";
import { getClientTextContract } from "./load-client-text-contract";

export type CaveatKey = keyof typeof rawContract.typography.caveats;

const PLACEHOLDER = "{domains}";

export function caveatText(key: CaveatKey, vars?: { domains?: string }): string {
  const caveats: Record<string, string> = getClientTextContract().typography?.caveats ?? {};
  const template = caveats[key];
  if (!template) {
    throw new Error(`client-text-contract: оговорки «${key}» нет в typography.caveats`);
  }
  const domains = vars?.domains?.trim();
  if (template.includes(PLACEHOLDER)) {
    if (!domains) throw new Error(`client-text-contract: оговорка «${key}» требует domains`);
    return template.replace(PLACEHOLDER, domains);
  }
  if (domains !== undefined) {
    throw new Error(`client-text-contract: оговорка «${key}» не принимает domains`);
  }
  return template;
}
