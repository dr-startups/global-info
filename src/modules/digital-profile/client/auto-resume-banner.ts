/**
 * Показывать ли плашку «сбор продолжается: система сама вернётся к работе».
 *
 * `autoResumePending` значит «шаг с назначенным сроком воркер подберёт сам» — этим
 * прячется кнопка восстановления, и это верно для любого ожидающего шага. Но слова
 * плашки обещают возврат **после сбоя**, и на здоровом прогоне сразу после старта
 * они лгали (QA 14.09.2026). Плашка нужна, только когда есть от чего возвращаться:
 * стадия повторяемого отказа либо код ошибки на джобе.
 */
export function autoResumeBannerVisible(job: {
  autoResumePending?: boolean | null;
  stage?: string | null;
  lastErrorCode?: string | null;
}): boolean {
  if (!job.autoResumePending) return false;
  return job.stage === "FAILED_RETRYABLE" || Boolean(job.lastErrorCode);
}
