/**
 * Шаг 13, пункт B4 (docs/rework/13-regression-run-findings.md).
 *
 * Какие действия предлагать оператору по состоянию прогона.
 *
 * Правило одно: **пока прогон работает, вмешиваться не предлагают**. Нарушение
 * этого правила стоит денег — на живом прогоне UI показывал активную кнопку
 * «начать новый аудит с повторным сбором» на стадии `ARSENKIN_ENRICHMENT`
 * со статусом `RUNNING`, то есть предлагал выбросить 20 минут оплаченной
 * работы и заплатить заново.
 *
 * Причина была в том, что «работой» считалась ровно одна причина отказа в
 * восстановлении — `JOB_PROGRESSING`. Активно исполняемый прогон даёт другие:
 * `JOB_ALREADY_RUNNING`, когда работает стадия, и `ACTIVE_LEASE`, когда шаг
 * держит воркер. Перечисление их в одном месте закрывает класс целиком.
 */

/**
 * Причины отказа в восстановлении, означающие «прогон в работе».
 *
 * Это именно «работает», а не «застрял»: застой даёт либо разрешённое
 * восстановление, либо отсутствие блокера.
 */
export const JOB_WORKING_BLOCKERS: ReadonlySet<string> = new Set([
  // Активная стадия в статусе WAITING, тик которой ещё не просрочен.
  "JOB_PROGRESSING",
  // Стадия исполняется прямо сейчас.
  "JOB_ALREADY_RUNNING",
  // Лизу держит воркер или процесс восстановления.
  "ACTIVE_LEASE",
]);

export function isJobWorking(recoveryBlockerReason: string | null | undefined): boolean {
  const reason = String(recoveryBlockerReason ?? "").trim();
  return reason.length > 0 && JOB_WORKING_BLOCKERS.has(reason);
}

export type UnifiedActionState = {
  /** У прогона есть сохранённые стадии, которые новый сбор выбросит. */
  preserved: boolean;
  recoveryAllowed: boolean;
  recoveryBlockerReason: string | null;
  suggestionsMissingResult: boolean;
};

/**
 * Нужно ли предлагать повторный платный сбор.
 *
 * Только когда продолжить нечем: стадии сохранены, восстановление недоступно,
 * и прогон при этом не работает. Завершённый прогон сюда попадает намеренно —
 * обновить готовый отчёт можно лишь новым сбором, и подтверждение оплаты для
 * этого уместно.
 */
export function paidRecollectionRequired(state: UnifiedActionState): boolean {
  if (!state.preserved) return false;
  if (state.recoveryAllowed) return false;
  return !isJobWorking(state.recoveryBlockerReason);
}

/**
 * Почему главное действие недоступно. Порядок важен: сначала называется то,
 * что оператор может сделать, и лишь потом — то, чего он ждёт.
 */
export function fullAuditBlockReason(state: UnifiedActionState): string {
  if (state.suggestionsMissingResult) return "USE_SUGGESTIONS_TARGETED_RETRY";
  if (state.recoveryAllowed) return "USE_RECOVERY";
  if (isJobWorking(state.recoveryBlockerReason)) return "JOB_ACTIVE";
  if (state.preserved) return "PRESERVED_STAGES_REQUIRE_PAID_RECOLLECTION";
  return "JOB_ACTIVE";
}
