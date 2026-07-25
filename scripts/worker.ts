/**
 * Точка входа сервиса-воркера (шаг 12.2).
 *
 * Тот же образ, что и веб-приложение, другая команда запуска. Веб-процесс
 * только создаёт прогон и отдаёт статус; двигает работу вперёд этот процесс.
 *
 * До этого продвижение держалось на цепочке `setTimeout` внутри Next.js, и
 * обычный деплой посреди сбора бросал оплаченную работу: расписание жило в
 * памяти и умирало вместе с процессом. Теперь расписание лежит в
 * `dp_workflow_steps.nextRunAt`, и перезапуск не теряет ничего — следующий
 * цикл подберёт всё просроченное.
 *
 * Run: npm run worker
 */

import { runStepWorker } from "../src/modules/digital-profile/workflow/step-runner";
import {
  NOT_SHARED_MESSAGE,
  probeSharedStorage,
  storageRoot,
} from "../src/modules/digital-profile/workflow/shared-storage-probe";
import {
  reconcileStageAfterStep,
  unifiedStepHandlers,
} from "../src/modules/digital-profile/workflow/unified-step-handlers";

const IDLE_MS = Number(process.env.WORKFLOW_WORKER_IDLE_MS ?? 1_000);
const LEASE_MS = Number(process.env.WORKFLOW_WORKER_LEASE_MS ?? 120_000);

async function main(): Promise<void> {
  const controller = new AbortController();

  // Останавливаемся, доделав текущий шаг: обрыв посередине оставил бы платную
  // задачу отправленной, но не записанной.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`[worker] ${signal} — завершаю текущий шаг и выхожу`);
      controller.abort();
    });
  }

  console.log(
    `[worker] запущен (pid ${process.pid}, пауза ${IDLE_MS} мс, лиза ${LEASE_MS} мс)`
  );
  console.log(`[worker] хранилище: ${storageRoot()}`);

  // Артефакты пишет воркер, а отдаёт приложение. Если диск не общий, это
  // выяснилось бы в конце первого платного прогона.
  const storage = await probeSharedStorage();
  if (storage.kind === "not_shared") {
    console.error(NOT_SHARED_MESSAGE);
    console.error(`[worker] проверено путей: ${storage.checked}, не найдено ни одного`);
  } else if (storage.kind === "ok") {
    console.log(`[worker] хранилище общее с приложением (проверено путей: ${storage.checked})`);
  } else {
    console.log(`[worker] проверка общего хранилища пропущена: ${storage.reason}`);
  }

  await runStepWorker({
    handlers: unifiedStepHandlers(),
    idleDelayMs: IDLE_MS,
    leaseMs: LEASE_MS,
    signal: controller.signal,
    onStepSettled: reconcileStageAfterStep,
    onError: (err, step) => {
      const where = step ? `${step.jobId}/${step.name}` : "цикл";
      console.error(`[worker] сбой в ${where}:`, err);
    },
  });

  console.log("[worker] остановлен");
  process.exit(0);
}

void main().catch((err) => {
  console.error("[worker] не удалось запуститься:", err);
  process.exit(1);
});
