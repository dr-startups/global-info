/**
 * Домен публикации — один на весь конвейер (шаг 13, C2).
 *
 * Извлечение домена было написано трижды, и защита от служебных схем стояла
 * только в одной копии. Поисковая подсказка приходит без адреса и получает
 * псевдо-URL `arsenkin://suggestion/<id>`; `new URL(...).hostname` честно
 * отдаёт для него «suggestion», и это слово печаталось клиенту как источник:
 *
 *     В выборке присутствует материал «pavel valeryevich durov arrested» (suggestion)
 *     …— источник suggestion
 *
 * Источник — это публикация, у которой есть адрес. Подсказка поисковика
 * публикацией не является, и приписывать ей домен нельзя.
 */

/**
 * Домен публикации или пустая строка.
 *
 * Пустая строка — законный ответ: вызывающий код опускает атрибуцию, а не
 * выдумывает её.
 */
export function publicDomainOf(url: string | null | undefined): string {
  const raw = String(url ?? "").trim();
  // Только публичные схемы: служебные (`arsenkin://`, `data:`) адресом не являются.
  if (!/^https?:\/\//iu.test(raw)) return "";
  try {
    const host = new URL(raw).hostname.replace(/^www\./iu, "").toLowerCase();
    // Хост без точки — не доменное имя (`localhost`, внутренние алиасы).
    return host.includes(".") ? host : "";
  } catch {
    return "";
  }
}

/** Является ли адрес публичной ссылкой, которую можно показать клиенту. */
export function isPublicUrl(url: string | null | undefined): boolean {
  return publicDomainOf(url).length > 0;
}
