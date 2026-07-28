/**
 * Строка прогресса Arsenkin в кабинете.
 *
 * Знаменатель был записан числом: шесть литералов `5` и три `Math.min(5, …)`
 * в одной функции `CaseHeader`. При составе по умолчанию (ADR-0005 — работает
 * только первая стадия) в деле три агента, и панель показывала
 * «scheduled 3/5 · completed 3/5 · ingested 3/5 (complete)»: исправный
 * завершённый прогон выглядел недоделанным, причём в интерфейсе, который
 * показывают заказчику.
 *
 * Сколько агентов в деле — вопрос к составу, и отвечает на него сервер
 * (`enabledArsenkinAgentNames`). Здесь знаменатель только печатается.
 *
 * Вынесено из компонента, потому что проверять строку прогресса в разметке
 * дороже, чем в чистой функции, а ошибка в ней видна клиенту сразу.
 */

export type ArsenkinProgressCounts = {
  /** Агенты, включённые составом прогона. Приходит с сервера. */
  plannedAgents?: string[];
  scheduledAgents?: string[];
  completedAgents?: string[];
  ingestedAgents?: string[];
  pendingAgents?: string[];
  enrichmentComplete?: boolean;
};

/**
 * Знаменатель — состав, а не литерал.
 *
 * Если состав почему-то не назван (старый ответ без поля), знаменатель берётся
 * из тех же данных: сколько агентов вообще встретилось в прогоне. Выдумывать
 * пятёрку здесь больше нечему — это и был второй ответ на один вопрос.
 */
export function arsenkinAgentTotal(counts: ArsenkinProgressCounts): number {
  const planned = counts.plannedAgents?.length ?? 0;
  if (planned > 0) return planned;
  const seen = new Set<string>([
    ...(counts.scheduledAgents ?? []),
    ...(counts.completedAgents ?? []),
    ...(counts.ingestedAgents ?? []),
    ...(counts.pendingAgents ?? []),
  ]);
  return seen.size;
}

/** Числитель не может обогнать знаменатель: это читалось бы как ошибка счёта. */
function capped(value: number, total: number): number {
  return Math.max(0, Math.min(total, value));
}

export function arsenkinProgressLine(counts: ArsenkinProgressCounts): string {
  const total = arsenkinAgentTotal(counts);
  const s = capped(counts.scheduledAgents?.length ?? 0, total);
  const c = capped(counts.completedAgents?.length ?? 0, total);
  const i = capped(counts.ingestedAgents?.length ?? 0, total);
  const base = `scheduled ${s}/${total} · completed ${c}/${total} · ingested ${i}/${total}`;
  if (counts.enrichmentComplete === undefined) return base;
  const suffix = counts.enrichmentComplete
    ? "complete"
    : counts.pendingAgents?.length
      ? "pending"
      : "incomplete";
  return `${base} (${suffix})`;
}
