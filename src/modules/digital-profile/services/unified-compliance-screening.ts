/**
 * Проверка по санкционным базам внутри платного прогона (шаг 04.3).
 *
 * Раздел комплаенса наполнялся только по отдельному нажатию, поэтому в
 * автоматическом прогоне он всегда оставался пустым. С появлением источника,
 * не требующего контракта (OpenSanctions), проверка становится частью сбора.
 *
 * Два правила определяют поведение:
 *
 * 1. **Отказ источника не убивает прогон.** Это тот же урок, что B1: один
 *    неответивший провайдер не должен обнулять уже оплаченную работу. Неудача
 *    записывается предупреждением и видна в отчёте как «проверка не выполнена».
 * 2. **Отсутствие совпадения — это результат, а не пустота.** «Не найден в
 *    санкционных перечнях» — содержательный вывод, и он отличается от «проверка
 *    не проводилась». Раздел обязан различать эти два состояния.
 */

/** Чем закончилась проверка с точки зрения отчёта. */
export type ComplianceScreeningOutcome =
  | { kind: "hits"; provider: string; count: number }
  | { kind: "clean"; provider: string }
  | { kind: "not_performed"; provider: string; reason: string };

export interface ScreeningResultLike {
  status: string;
  provider: string;
  hits: readonly unknown[];
  error?: { code: string; message: string } | undefined;
}

/**
 * Итог проверки для отчёта.
 *
 * `SUCCESS` без совпадений — это `clean`, а не пустота: провайдер ответил, и
 * отсутствие записей о субъекте есть содержательный результат проверки.
 * Любой другой статус означает, что проверка не выполнялась, и выдавать её
 * за чистый результат нельзя — иначе отчёт сообщит банку, что человек проверен,
 * когда он не проверен.
 */
export function screeningOutcome(result: ScreeningResultLike): ComplianceScreeningOutcome {
  const provider = String(result.provider ?? "");
  if (result.status === "SUCCESS") {
    return result.hits.length > 0
      ? { kind: "hits", provider, count: result.hits.length }
      : { kind: "clean", provider };
  }
  const reason = result.error?.message?.trim() || result.error?.code?.trim() || result.status;
  return { kind: "not_performed", provider, reason };
}

/** Предупреждение прогона; `null` — сообщать нечего. */
export function screeningWarning(outcome: ComplianceScreeningOutcome): string | null {
  switch (outcome.kind) {
    case "not_performed":
      return `compliance-screening-skipped:${outcome.provider}:${outcome.reason}`;
    case "hits":
      // Совпадения требуют сверки аналитиком — это видно и в списке задач.
      return `compliance-hits-pending-review:${outcome.provider}:${outcome.count}`;
    case "clean":
      return null;
  }
}

export interface RunUnifiedComplianceScreeningInput {
  caseId: string;
  actorId?: string | null;
  /** Подменяется в тестах; по умолчанию — настоящая проверка. */
  screen?: (caseId: string, actorId?: string | null) => Promise<ScreeningResultLike>;
}

/**
 * Выполняет проверку и возвращает её итог, никогда не выбрасывая наружу.
 *
 * Исключение здесь означало бы, что сбой открытого справочника прерывает
 * оплаченный сбор — цена ошибки несопоставима с ценностью раздела.
 */
export async function runUnifiedComplianceScreening(
  input: RunUnifiedComplianceScreeningInput
): Promise<ComplianceScreeningOutcome> {
  const screen =
    input.screen ??
    (async (caseId: string, actorId?: string | null) => {
      const { runComplianceScreening } = await import("../compliance-providers");
      return (await runComplianceScreening(caseId, "OPEN_SANCTIONS", {
        actorId: actorId ?? null,
      })) as ScreeningResultLike;
    });

  try {
    return screeningOutcome(await screen(input.caseId, input.actorId));
  } catch (err) {
    return {
      kind: "not_performed",
      provider: "OPEN_SANCTIONS",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
