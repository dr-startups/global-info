/**
 * Прогресс обогащения выводится из фактов, а не хранится вторым экземпляром
 * (шаг 12.4d).
 *
 * Разбор блоба `arsenkinEnrichmentState` показал, что план смешивал **две
 * разные вещи**:
 *
 * 1. **Прогресс** — какие агенты запланированы, завершены, приняты, сколько
 *    наблюдений. Всё это выводится из строк `ProviderTask` и сохранённых
 *    наблюдений, и именно его второй экземпляр порождал расхождения 08.0-bis
 *    («пять прогонов зарегистрировано, задач две») и 11.1.
 * 2. **Журнал ровно однократного приёма** — `ingestedResultHashes`,
 *    `externalTaskIdToResultHash`. Он **не выводится ниоткуда**: это запись о
 *    том, какие полезные нагрузки уже приняты, и обнаружение случая, когда
 *    провайдер вернул другую нагрузку для той же задачи. Убрать его — значит
 *    открыть дорогу двойному приёму.
 *
 * Поэтому «удалить блоб» целиком нельзя: удалять надо (1), а (2) остаётся и
 * заслуживает собственного места.
 *
 * Здесь живёт вывод (1). Сначала он работает **детектором**: считает ответ по
 * фактам и сравнивает с хранимым, а расхождение выносит в предупреждения. Так
 * же поступили со стадией в 12.4a, и это дало увидеть расхождение до того, как
 * на него положились. Переключение читателей — следующим шагом, после того как
 * живой прогон покажет, что ответы совпадают.
 *
 * Модуль чистый: принимает строки задач и наблюдения, возвращает прогресс.
 */

import { ARSENKIN_REAL_AGENT_NAMES } from "../agents/real/real-arsenkin-agents";
import type { ArsenkinEnrichmentState } from "./arsenkin-enrichment-state";

/** Строка задачи провайдера в том объёме, в каком нужна для вывода прогресса. */
export type ProviderTaskFact = {
  /** Прогон агента, которому принадлежит задача. */
  reportRunId: string;
  /** PENDING | RUNNING | DONE | FAILED | … */
  state: string;
};

export type DerivedEnrichmentProgress = {
  scheduledAgents: string[];
  completedAgents: string[];
  pendingAgents: string[];
  observationCount: number;
  enrichmentComplete: boolean;
};

/**
 * Прогресс по фактам.
 *
 * `enrichmentRunIdByAgent` — связь агента с его прогоном; она уже хранится в
 * джобе (`enrichmentRunIds`) и восстанавливается по имени агента, поэтому
 * вторым источником правды не является.
 */
export function deriveEnrichmentProgress(input: {
  enrichmentRunIdByAgent: Readonly<Record<string, string | null>>;
  tasks: readonly ProviderTaskFact[];
  observationCount: number;
}): DerivedEnrichmentProgress {
  const tasksByRun = new Map<string, ProviderTaskFact[]>();
  for (const t of input.tasks) {
    const key = String(t.reportRunId ?? "");
    if (!key) continue;
    const list = tasksByRun.get(key);
    if (list) list.push(t);
    else tasksByRun.set(key, [t]);
  }

  const scheduledAgents: string[] = [];
  const completedAgents: string[] = [];
  const pendingAgents: string[] = [];

  for (const agent of ARSENKIN_REAL_AGENT_NAMES) {
    const runId = input.enrichmentRunIdByAgent[agent] ?? null;
    const tasks = runId ? (tasksByRun.get(runId) ?? []) : [];
    // Запланирован — это «задача провайдеру отправлена», то есть есть строка.
    // Признаком служит именно строка, а не запись в сводке: на этом и
    // спотыкался шаг 08.0-bis.
    if (tasks.length === 0) continue;
    scheduledAgents.push(agent);
    const unfinished = tasks.filter((t) => t.state !== "DONE" && t.state !== "FAILED");
    if (unfinished.length > 0) pendingAgents.push(agent);
    else completedAgents.push(agent);
  }

  return {
    scheduledAgents,
    completedAgents,
    pendingAgents,
    observationCount: Math.max(0, Number(input.observationCount ?? 0)),
    // Полнота — это «все пять агентов отправлены и ни один не в работе».
    enrichmentComplete:
      scheduledAgents.length === ARSENKIN_REAL_AGENT_NAMES.length && pendingAgents.length === 0,
  };
}

export type EnrichmentProgressDrift = {
  field: string;
  stored: string;
  derived: string;
};

/**
 * Расхождение хранимого прогресса с выведенным.
 *
 * Пустой список — ответы совпадают. Непустой означает, что второй экземпляр
 * состояния разошёлся с фактами, и это дефект, а не предупреждение о вкусах.
 */
export function detectEnrichmentProgressDrift(
  stored: ArsenkinEnrichmentState | null | undefined,
  derived: DerivedEnrichmentProgress
): EnrichmentProgressDrift[] {
  if (!stored) return [];
  const drift: EnrichmentProgressDrift[] = [];
  const compareSets = (field: string, a: readonly string[], b: readonly string[]): void => {
    const left = [...new Set(a)].sort().join(",");
    const right = [...new Set(b)].sort().join(",");
    if (left !== right) drift.push({ field, stored: left || "—", derived: right || "—" });
  };

  compareSets("scheduledAgents", stored.scheduledAgents ?? [], derived.scheduledAgents);
  compareSets("completedAgents", stored.completedAgents ?? [], derived.completedAgents);
  if (Boolean(stored.enrichmentComplete) !== derived.enrichmentComplete) {
    drift.push({
      field: "enrichmentComplete",
      stored: String(Boolean(stored.enrichmentComplete)),
      derived: String(derived.enrichmentComplete),
    });
  }
  return drift;
}

/** Предупреждения прогона о расхождении; пустой список — расхождения нет. */
export function enrichmentDriftWarnings(drift: readonly EnrichmentProgressDrift[]): string[] {
  return drift.map((d) => `enrichment-progress-drift:${d.field}:${d.stored}!=${d.derived}`);
}
