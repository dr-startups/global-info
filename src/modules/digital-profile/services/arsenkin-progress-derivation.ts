/**
 * Классификация задач агента и сверка хранимого прогресса с фактами
 * (шаг 12.4d, дополнено на шаге 16).
 *
 * ## Что здесь оказалось не так
 *
 * Модуль задумывался как «второй способ посчитать прогресс, чтобы потом
 * перевести на него читателей» (задача K1). Разбор показал, что задача
 * поставлена неверно, и это стоит записать, потому что ошибка того же класса,
 * что чинился весь план: **один вопрос, отвечаемый в двух местах**.
 *
 * Блоб `arsenkinEnrichmentState` вторым независимым ответом **не является**.
 * На живом пути он строится `progressFromTasks` → `buildArsenkinEnrichmentState`
 * из тех же строк `ProviderTask`. Отдельного алгоритма, на который надо
 * «переключаться», не существует.
 *
 * Хуже: прежний вывод здесь считал завершённым агента, все задачи которого
 * `FAILED`, — а настоящее правило относит такого агента к `failedAgents` и
 * `enrichmentComplete` не даёт. Перевод читателей на прежний вывод пропустил бы
 * конвейер мимо упавшего агента. Не расхождение, а регресс.
 *
 * И детектор сравнивал разные величины: на прогоне, где `URL_AUDIT` упал, он
 * поднял бы ложную тревогу. Ровно ошибка I2, только уровнем глубже.
 *
 * ## Что здесь на самом деле нужно
 *
 * 1. **Одно правило классификации** — `classifyAgentTasks`. Им пользуется и
 *    тик (`progressFromTasks`), и сверка. Пока правил было два, они и
 *    разъезжались.
 *
 * 2. **Односторонняя сверка на устаревание.** Читатели, не запускающие тик
 *    (`unified-suggestions-gap`, эвристика восстановления, сводка качества),
 *    читают **сохранённый** блоб, и он бывает старше строк задач. Это и есть
 *    оставшийся риск — не другой алгоритм, а отставание.
 *
 *    Сверка асимметрична намеренно: строки задач знают **меньше**, чем блоб.
 *    Из них не видно ни ошибки схемы (`DONE`, но нагрузка не разбирается), ни
 *    статуса исполнения, ни того, принята ли нагрузка. Поэтому тревога
 *    поднимается, только когда блоб заявляет **больше** готовности, чем
 *    подтверждают факты. Обратное — блоб знает про отказ, которого в строках
 *    не видно — норма и не тревога.
 */

import {
  ARSENKIN_REAL_AGENT_NAMES,
  enabledArsenkinAgentNames,
} from "../agents/real/real-arsenkin-agents";
import type { ArsenkinEnrichmentState } from "./arsenkin-enrichment-state";

/** Состояния, в которых задача ещё в работе. */
export const NON_TERMINAL_TASK_STATES: ReadonlySet<string> = new Set([
  "QUEUED",
  "SUBMITTING",
  "RUNNING",
  "RATE_LIMITED",
  "WAITING",
  "POLLING",
  "SUBMITTED",
]);

/** Терминальные отказы отправки: composite/render они разблокировать не должны. */
export const TERMINAL_SUBMIT_FAILURE_STATES: ReadonlySet<string> = new Set([
  "SUBMIT_UNKNOWN",
  "SUBMIT_REJECTED_RETRYABLE",
]);

/** Строка задачи провайдера в том объёме, в каком нужна для вывода прогресса. */
export type ProviderTaskFact = {
  /** Прогон агента, которому принадлежит задача. */
  reportRunId: string;
  /** PENDING | RUNNING | DONE | FAILED | … */
  state: string;
};

export type AgentTaskClassification = {
  pendingCount: number;
  doneCount: number;
  submitRejectedCount: number;
  failedCount: number;
  /** Терминален по одним строкам задач. */
  terminal: boolean;
  /**
   * Отказной исход, если он **определяется строками задач**. Ошибка схемы сюда
   * не попадает: у неё задачи `DONE`, и увидеть её можно только разобрав
   * нагрузку — это делает тик.
   */
  failureKind: "FAILED" | "SUBMIT_UNKNOWN_UNRECONCILED" | null;
};

/**
 * Единственное правило «в каком состоянии агент по его задачам».
 *
 * Порядок веток повторяет тик и осмыслен: живая задача важнее отказавшего
 * соседа (целевой повтор оставляет отклонённый Google suggest, пока Yandex
 * ещё в работе), а `DONE` важнее отказа отправки — нагрузка уже получена.
 */
export function classifyAgentTasks(
  tasks: readonly { state: string }[]
): AgentTaskClassification {
  const upper = tasks.map((t) => String(t.state ?? "").toUpperCase());
  const pendingCount = upper.filter((s) => NON_TERMINAL_TASK_STATES.has(s)).length;
  const doneCount = upper.filter((s) => s === "DONE").length;
  const submitRejectedCount = upper.filter((s) => TERMINAL_SUBMIT_FAILURE_STATES.has(s)).length;
  const failedCount = upper.filter((s) => /FAIL|ERROR|TIMEOUT|CANCEL/.test(s)).length;

  const base = { pendingCount, doneCount, submitRejectedCount, failedCount };

  if (pendingCount > 0) {
    return { ...base, terminal: false, failureKind: null };
  }
  if (submitRejectedCount > 0 && doneCount === 0) {
    return { ...base, terminal: true, failureKind: "SUBMIT_UNKNOWN_UNRECONCILED" };
  }
  if (failedCount > 0 && doneCount === 0) {
    return { ...base, terminal: true, failureKind: "FAILED" };
  }
  if (doneCount > 0) {
    return { ...base, terminal: true, failureKind: null };
  }
  // Задач нет вовсе: об агенте по строкам сказать нечего.
  return { ...base, terminal: false, failureKind: null };
}

export type DerivedEnrichmentProgress = {
  scheduledAgents: string[];
  completedAgents: string[];
  failedAgents: string[];
  pendingAgents: string[];
  observationCount: number;
  enrichmentComplete: boolean;
};

/**
 * Прогресс по строкам задач.
 *
 * `enrichmentRunIdByAgent` — связь агента с его прогоном; она уже хранится в
 * джобе (`enrichmentRunIds`) и восстанавливается по имени агента, поэтому
 * вторым источником правды не является.
 *
 * Это **нижняя граница** знания об отказах: ошибка схемы и статус исполнения
 * отсюда не видны. Как ответ для читателей не годится и для этого не
 * предназначен — только для сверки (см. заголовок модуля).
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
  const failedAgents: string[] = [];
  const pendingAgents: string[] = [];

  for (const agent of ARSENKIN_REAL_AGENT_NAMES) {
    const runId = input.enrichmentRunIdByAgent[agent] ?? null;
    const tasks = runId ? (tasksByRun.get(runId) ?? []) : [];
    // Запланирован — это «задача провайдеру отправлена», то есть есть строка.
    // Признаком служит именно строка, а не запись в сводке: на этом и
    // спотыкался шаг 08.0-bis.
    if (tasks.length === 0) continue;
    scheduledAgents.push(agent);
    const c = classifyAgentTasks(tasks);
    if (!c.terminal) pendingAgents.push(agent);
    else if (c.failureKind) failedAgents.push(agent);
    else completedAgents.push(agent);
  }

  // Полнота меряется по **составу прогона**, а не по длине каталога.
  //
  // Здесь стояло `scheduledAgents.length === ARSENKIN_REAL_AGENT_NAMES.length`,
  // то есть «все пять». Составом по умолчанию после ADR-0005 работают трое, и
  // условие не могло стать истинным никогда. На боевом прогоне 28.07 это
  // выглядело так: три агента отдали 522 наблюдения, все задачи DONE, а
  // состояние показывало `pendingAgents` из пяти и `enrichmentComplete: false`.
  // Стадия ждала продвижения, которого уже не могло быть, счётчик простоя дошёл
  // до сорока и прогон упал с `ARSENKIN_POLL_ATTEMPTS_EXCEEDED`.
  //
  // Отключённый составом агент не отправляется и не ждётся (0f0b2b1) — значит и
  // в знаменателе полноты ему делать нечего.
  const composition = enabledArsenkinAgentNames();
  const expected = composition.length > 0 ? composition : [...ARSENKIN_REAL_AGENT_NAMES];
  const missing = expected.filter((a) => !scheduledAgents.includes(a));

  return {
    scheduledAgents,
    completedAgents,
    failedAgents,
    pendingAgents,
    observationCount: Math.max(0, Number(input.observationCount ?? 0)),
    // Приём нагрузки отсюда не виден, поэтому полнота здесь — необходимое
    // условие, а не достаточное.
    enrichmentComplete:
      missing.length === 0 && pendingAgents.length === 0 && failedAgents.length === 0,
  };
}

export type EnrichmentProgressDrift = {
  field: string;
  stored: string;
  derived: string;
};

/**
 * Устаревание сохранённого прогресса относительно строк задач.
 *
 * Пустой список — блоб не заявляет ничего сверх фактов. Непустой означает, что
 * блоб **опережает** факты: это либо отставшая запись, либо чужая, и в обоих
 * случаях дефект.
 *
 * Сверка односторонняя (см. заголовок модуля): строки задач знают меньше блоба,
 * и «блоб говорит про отказ, которого в строках не видно» — норма.
 */
export function detectEnrichmentProgressDrift(
  stored: ArsenkinEnrichmentState | null | undefined,
  derived: DerivedEnrichmentProgress
): EnrichmentProgressDrift[] {
  if (!stored) return [];
  const drift: EnrichmentProgressDrift[] = [];

  // `scheduledAgents` из сравнения исключён намеренно (шаг 15, I2). В сводке
  // это «намерены запустить», в выводе — «есть строка задачи»: разные величины,
  // и расхождение между ними — норма, пока задачи создаются по очереди.
  //
  // Признак «зарегистрирован, но задачи нет» измеряется отдельно и по делу —
  // `computeArsenkinSubmissionGap.registeredWithoutTask`.

  // Завершённым блоб вправе называть агента, которого факты завершённым не
  // видят, **только** если факты видят его отказавшим: там блоб знает про
  // схему больше. Агент, ещё работающий по строкам задач, завершённым назван
  // быть не может.
  const stillWorking = new Set(derived.pendingAgents);
  const prematurelyCompleted = (stored.completedAgents ?? []).filter((a) => stillWorking.has(a));
  if (prematurelyCompleted.length > 0) {
    drift.push({
      field: "completedAgents",
      stored: [...prematurelyCompleted].sort().join(","),
      derived: "ещё-в-работе",
    });
  }

  // Полнота, объявленная при незакрытых или упавших задачах, — самый опасный
  // вид отставания: он открывает composite и рендер.
  if (Boolean(stored.enrichmentComplete) && !derived.enrichmentComplete) {
    drift.push({
      field: "enrichmentComplete",
      stored: "true",
      derived: `pending=${derived.pendingAgents.length} failed=${derived.failedAgents.length} scheduled=${derived.scheduledAgents.length}`,
    });
  }
  return drift;
}

/** Предупреждения прогона о расхождении; пустой список — расхождения нет. */
export function enrichmentDriftWarnings(drift: readonly EnrichmentProgressDrift[]): string[] {
  return drift.map((d) => `enrichment-progress-drift:${d.field}:${d.stored}!=${d.derived}`);
}
