/**
 * Неудачная пересборка — словами, а не молчанием.
 *
 * Пересборка, упавшая на тексте, возвращает джобу к прежнему готовому отчёту
 * (готовый PDF не должен пропадать из-за сбоя сборки) и оставляет причину
 * двумя строками предупреждений: `report-rebuild-failed:<код>` и
 * `report-rebuild-failed-detail:<текст>`. До шага 0083 (QA 14.09.2026,
 * «Усманов») клиент их получал и не показывал: «Выпустить» дважды заканчивался
 * ASSEMBLY_QA_FAILED, а страница дела показывала готовый отчёт без ошибки.
 *
 * Разбор один; шапка дела печатает его словарём.
 */

export const REBUILD_FAILED_PREFIX = "report-rebuild-failed:";
const REBUILD_FAILED_DETAIL_PREFIX = "report-rebuild-failed-detail:";

export type RebuildFailure = { code: string; detail: string };

export function rebuildFailureOf(warnings: readonly string[] | undefined): RebuildFailure | null {
  const code = (warnings ?? []).find(
    (w) => w.startsWith(REBUILD_FAILED_PREFIX) && !w.startsWith(REBUILD_FAILED_DETAIL_PREFIX)
  );
  if (!code) return null;
  const detail = (warnings ?? []).find((w) => w.startsWith(REBUILD_FAILED_DETAIL_PREFIX));
  return {
    code: code.slice(REBUILD_FAILED_PREFIX.length).trim(),
    detail: detail ? detail.slice(REBUILD_FAILED_DETAIL_PREFIX.length).trim() : "",
  };
}
