/**
 * Шаг 08.0-bis плана.
 *
 * Регистрация агента и отправка его задачи провайдеру — два разных события, и
 * между ними есть промежуток. Рестарт процесса, пришедшийся в этот промежуток,
 * оставлял джобу в состоянии «пять прогонов зарегистрированы, задач отправлено
 * две». Возобновление опиралось на число прогонов, включало режим импорта и
 * опрашивало результаты задач, которых не существует, пока не исчерпывало
 * бюджет в 40 попыток. Повторное восстановление приводило туда же — выхода из
 * состояния не было вовсе.
 *
 * Признак отправки здесь намеренно консервативный: **наличие строки
 * `ProviderTask`**, а не подтверждённого `externalTaskId`. Строка без
 * `externalTaskId` означает неподтверждённую отправку — задача у провайдера
 * могла быть создана, и повторная отправка стоила бы денег дважды. Такой агент
 * остаётся на опросе, а не уходит на повторную отправку.
 */

import {
  ARSENKIN_REAL_AGENT_NAMES,
  isArsenkinAgentEnabled,
} from "../agents/real/real-arsenkin-agents";
import { agentNameFromEnrichmentRunId, toolMatchesAgent } from "./unified-enrichment-sibling-remap";

export type SubmissionGapTask = {
  reportRunId?: string | null;
  toolName?: string | null;
  externalTaskId?: string | null;
};

export type ArsenkinSubmissionGap = {
  /** Агенты без единой строки ProviderTask — провайдер о них не знает. */
  needsSubmit: string[];
  /** Агенты, у которых есть хотя бы одна задача: их опрашивают, не отправляют. */
  submitted: string[];
  /** Из needsSubmit: те, у кого нет и enrichmentRunId. */
  unregistered: string[];
  /** Из needsSubmit: зарегистрированы, но задача не ушла — тот самый случай. */
  registeredWithoutTask: string[];
  /** Отключены составом `ARSENKIN_TOOLS`: не отправляются и не ждутся. */
  disabled: string[];
};

function hasText(value: string | null | undefined): boolean {
  return String(value ?? "").trim().length > 0;
}

/**
 * Задача принадлежит агенту, если её инструмент относится к этому агенту либо
 * её прогон опознаётся как прогон этого агента. Опора на инструмент важна:
 * идентификатор прогона может прийти из ручного sibling-запуска и не следовать
 * шаблону `unified-<job>-<agent>`.
 */
function tasksOfAgent(
  agentName: string,
  runIds: readonly string[],
  tasks: readonly SubmissionGapTask[]
): SubmissionGapTask[] {
  const owned = new Set(runIds);
  return tasks.filter((t) => {
    if (toolMatchesAgent(t.toolName, agentName)) return true;
    const runId = String(t.reportRunId ?? "");
    if (!owned.has(runId)) return false;
    // Прогон агента, инструмент которого не опознан, всё равно его задача.
    const attributed = agentNameFromEnrichmentRunId(runId);
    return attributed === null || attributed === agentName;
  });
}

export function computeArsenkinSubmissionGap(input: {
  enrichmentRunIds: readonly string[];
  tasks: readonly SubmissionGapTask[];
  env?: NodeJS.ProcessEnv;
}): ArsenkinSubmissionGap {
  const runIds = input.enrichmentRunIds.map((id) => String(id ?? "").trim()).filter(Boolean);
  const gap: ArsenkinSubmissionGap = {
    needsSubmit: [],
    submitted: [],
    unregistered: [],
    registeredWithoutTask: [],
    disabled: [],
  };

  for (let i = 0; i < ARSENKIN_REAL_AGENT_NAMES.length; i += 1) {
    const agentName = ARSENKIN_REAL_AGENT_NAMES[i]!;
    const attributed = runIds.filter((id) => agentNameFromEnrichmentRunId(id) === agentName);
    // Позиционный запасной вариант повторяет разрешение агента в тике: когда
    // идентификаторы не следуют шаблону, агент берёт прогон по своему индексу.
    const positional = attributed.length === 0 && runIds[i] ? [runIds[i]!] : [];
    const agentRunIds = attributed.length > 0 ? attributed : positional;

    if (tasksOfAgent(agentName, agentRunIds, input.tasks).length > 0) {
      // Задачи уже отправлены и оплачены. Их результат забирается независимо от
      // того, что говорит состав сейчас: состав мог измениться посреди прогона,
      // а оплаченный сбор не перестаёт быть оплаченным.
      gap.submitted.push(agentName);
      continue;
    }
    if (!isArsenkinAgentEnabled(agentName, input.env)) {
      // Отключённый составом агент не отправляется. Именно этой проверки не
      // было: на живом прогоне все пять агентов уходили в работу, включая тех,
      // кого интерфейс показывал как «Отключено», — и их поверхности
      // оплачивались.
      gap.disabled.push(agentName);
      continue;
    }
    gap.needsSubmit.push(agentName);
    if (agentRunIds.length === 0) gap.unregistered.push(agentName);
    else gap.registeredWithoutTask.push(agentName);
  }

  return gap;
}

/** Диагностика для журнала джобы: коротко и без внутренних идентификаторов. */
export function describeSubmissionGap(gap: ArsenkinSubmissionGap): string[] {
  const out: string[] = [];
  if (gap.registeredWithoutTask.length > 0) {
    out.push(`arsenkin-registered-without-task:${gap.registeredWithoutTask.join(",")}`);
  }
  if (gap.unregistered.length > 0) {
    out.push(`arsenkin-unregistered:${gap.unregistered.join(",")}`);
  }
  if (gap.disabled.length > 0) {
    out.push(`arsenkin-disabled-by-tools:${gap.disabled.join(",")}`);
  }
  return out;
}

/** Число задач с подтверждённым идентификатором у провайдера. */
export function confirmedTaskCount(tasks: readonly SubmissionGapTask[]): number {
  return tasks.filter((t) => hasText(t.externalTaskId)).length;
}
