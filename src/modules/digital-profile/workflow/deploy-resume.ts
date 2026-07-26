/**
 * Возобновление работы после деплоя — в процессе воркера, а не веб-сервера.
 *
 * Раньше это жило в `scripts/start-with-arsenkin-readiness.ts`: веб-процесс
 * перед стартом сервера поднимал legacy-оркестратор, возобновлял прогоны и
 * заводил два `setInterval` по пять секунд. Три следствия:
 *
 * 1. **Порт не слушался, пока шла подготовка**, а healthcheck Railway уже
 *    опрашивал контейнер;
 * 2. работу двигали двое — эти таймеры и воркер шагов из шага 12, — то есть
 *    ровно тот дубль, ради устранения которого воркер и делался;
 * 3. таймеры жили в памяти веб-процесса, и деплой их терял.
 *
 * Здесь то же самое, но в правильном процессе: воркер и так переживает деплой,
 * держит расписание в БД и обрабатывает SIGTERM.
 *
 * Поведение сохранено дословно — это перенос, а не переделка: набор вызовов и
 * их периодичность те же. Меняется только то, кто их выполняет.
 */

/** Однократно при старте воркера: подобрать всё, что осталось от прошлого процесса. */
export async function resumeAfterDeploy(): Promise<void> {
  await runQuietly("возобновление unified-прогонов", async () => {
    const { resumeUnifiedCollectionsOnStartup } = await import(
      "../services/unified-orion-collection-orchestrator"
    );
    await resumeUnifiedCollectionsOnStartup();
  });

  await runQuietly("возобновление исполнений CaseAgent", async () => {
    const { resumeArsenkinCaseAgentExecutions } = await import(
      "../services/arsenkin-case-agent-execution"
    );
    const n = await resumeArsenkinCaseAgentExecutions();
    if (n > 0) console.log(`[worker] возобновлено исполнений CaseAgent: ${n}`);
  });

  await runQuietly("возобновление legacy-оркестраций Arsenkin", async () => {
    const { resumeActiveArsenkinOrchestrations } = await import(
      "../providers/arsenkin/full-audit-orchestrator"
    );
    resumeActiveArsenkinOrchestrations();
  });
}

/**
 * Периодическая подборка: то, что не выражено шагами `dp_workflow_steps`.
 *
 * Шаги воркер забирает сам по `nextRunAt`. Здесь — джобы прежнего контура и
 * завершение исполнений CaseAgent, у которых своего расписания в шагах нет.
 */
export async function maintenanceTick(): Promise<void> {
  await runQuietly("подборка unified-прогонов", async () => {
    const { pumpResumableUnifiedCollections } = await import(
      "../services/unified-orion-collection-orchestrator"
    );
    const n = await pumpResumableUnifiedCollections();
    if (n > 0) console.log(`[worker] подобрано прогонов: ${n}`);
  });

  await runQuietly("завершение исполнений CaseAgent", async () => {
    const { resumeArsenkinCaseAgentExecutions, tickArsenkinCaseAgentFinalizations } = await import(
      "../services/arsenkin-case-agent-execution"
    );
    await resumeArsenkinCaseAgentExecutions();
    await tickArsenkinCaseAgentFinalizations();
  });
}

/**
 * Сбой подборки не должен ронять воркер: он двигает платные прогоны, и упасть
 * из-за вспомогательной задачи — потерять их все.
 */
async function runQuietly(what: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.error(`[worker] ${what}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
