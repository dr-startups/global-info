/**
 * Чистые правила вкладки предпросмотра отчёта — без React, чтобы их можно было
 * проверить тестом (шаг 11.5 плана).
 *
 * Отчёт, который получает клиент, собирает unified-прогон, а не легаси-версии
 * из `dp_report_versions`. Панель смотрела только на вторые и на готовом кейсе
 * сообщала «отчёта нет», подталкивая нажать «Сгенерировать отчёт» — то есть
 * запустить другой пайплайн вместо того, чтобы открыть уже собранный результат.
 */

import type { UnifiedCollectionJobStatus } from "./api";

/** Есть ли у прогона готовый артефакт, который можно показать и скачать. */
export function unifiedArtifactsReady(job: UnifiedCollectionJobStatus | null): boolean {
  if (!job) return false;
  if (job.stage !== "REPORT_READY" && job.stage !== "COMPLETED_PARTIAL") return false;
  return Boolean(
    job.downloadArtifacts?.pdf ||
      job.downloadArtifacts?.pptx ||
      job.reportLinks?.pdf ||
      job.reportLinks?.pptx
  );
}
