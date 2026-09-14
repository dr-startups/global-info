/**
 * Автор действий проверки с сайта.
 *
 * Кейс, панель персоны, решение и записи аудита подписаны проверкой:
 * `self-check:<id>`. По этому же префиксу список дел отбирает дела «с сайта» —
 * колонки происхождения у дела нет, и префикс у автора и у фильтра обязан быть
 * один.
 */

export const SELF_CHECK_ACTOR_PREFIX = "self-check:";

export function selfCheckActor(checkId: string): string {
  return `${SELF_CHECK_ACTOR_PREFIX}${checkId}`;
}
