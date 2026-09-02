/**
 * Правила слежения за живым прогоном — без React, чтобы их можно было проверить
 * тестом.
 *
 * Наблюдалось на боевом прогоне: страница кейса открыта, прогон идёт, а в
 * шапке через семнадцать минут по-прежнему «Этап: Базовый сбор» и
 * «Arsenkin scheduled 0/5». Слежение было устроено циклом
 * `for (let i = 0; i < 120; i++) { await sleep(500); … }` — ровно **шестьдесят
 * секунд**, после чего он молча заканчивался. Прогон при этом идёт около
 * двадцати минут. Пользователю оставалось обновлять страницу руками, чтобы
 * узнать, жив ли сбор.
 *
 * Два отдельных дефекта, и оба здесь закрываются правилами:
 *
 *   1. **Ограничение по числу оборотов.** Следить нужно до конца прогона, а не
 *      заданное число раз. Счётчик оборотов — это не срок; он отвечает на
 *      другой вопрос, чем «закончился ли прогон».
 *   2. **Пауза 500 мс.** Двадцатиминутный прогон при таком шаге — это две
 *      тысячи запросов статуса, и всё равно ни один из них не приносит
 *      новостей: сервер сам знает, когда вернётся к работе, и говорит это в
 *      `nextPollAt` / `autoResumeAt`. Спрашиваем к этому сроку, а не чаще.
 */

import type { UnifiedCollectionJobStatus } from "./api";

/** Прогон закончился — следить больше не за чем. */
export function isUnifiedRunTerminal(job: UnifiedCollectionJobStatus | null): boolean {
  if (!job) return false;
  return (
    job.stage === "REPORT_READY" ||
    job.stage === "COMPLETED_PARTIAL" ||
    job.stage === "FAILED_TERMINAL" ||
    job.stage === "FAILED_RETRYABLE" ||
    job.stage === "CANCELLED" ||
    job.status === "COMPLETED"
  );
}

/** Нижняя и верхняя границы паузы: чаще — впустую, реже — уже незаметно. */
export const FOLLOW_MIN_DELAY_MS = 2_000;
export const FOLLOW_MAX_DELAY_MS = 15_000;

/**
 * Через сколько спрашивать статус снова.
 *
 * Срок берётся у самого прогона: он назначает `nextPollAt` (опрос провайдера) и
 * `autoResumeAt` (возврат к работе), и раньше этого момента новостей быть не
 * может. Ближайший из них и есть ответ; границы защищают от двух крайностей —
 * пустого долбления и минутных пауз из-за одной цифры в поле.
 */
export function nextFollowDelayMs(
  job: UnifiedCollectionJobStatus | null,
  nowMs: number = Date.now()
): number {
  const candidates = [job?.nextPollAt, job?.autoResumeAt]
    .map((v) => (v ? Date.parse(String(v)) : Number.NaN))
    .filter((ms) => Number.isFinite(ms) && ms > nowMs)
    .map((ms) => ms - nowMs);

  if (candidates.length === 0) return FOLLOW_MIN_DELAY_MS;
  return Math.min(FOLLOW_MAX_DELAY_MS, Math.max(FOLLOW_MIN_DELAY_MS, Math.min(...candidates)));
}

/**
 * Нужно ли следить за прогоном прямо сейчас.
 *
 * Прогон, начатый в другой вкладке или до перезагрузки страницы, — такой же
 * живой прогон. Слежение поэтому опирается на состояние, а не на то, нажимал ли
 * пользователь кнопку в этой сессии.
 */
export function shouldFollowUnifiedRun(job: UnifiedCollectionJobStatus | null): boolean {
  if (!job) return false;
  return !isUnifiedRunTerminal(job);
}
