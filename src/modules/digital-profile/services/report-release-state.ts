/**
 * Состояние документа: черновик и выпуск.
 *
 * До этого шага у собранного отчёта состояние было одно — он есть, — и
 * «проверенный аналитиком документ» не отличался от «только что собранного»
 * ничем. Пока это так, ручной проверке не к чему прикладываться: непонятно,
 * что проверено и что ушло клиенту.
 *
 * Правило: **любая сборка даёт черновик, выпуск — отдельное действие**, которое
 * пересобирает отчёт и помечает результат. Пометить выпуском без пересборки
 * нельзя: тогда выпуском стал бы документ, собранный до последних решений
 * аналитика.
 *
 * Модуль чистый и офлайновый: ни базы, ни файлов. Переход считается здесь,
 * пишет его в джобу оркестратор — там же, где выставляет ссылки на отчёт.
 */

import type { DpRole } from "../auth/roles";

export type ReportReleaseState = {
  state: "draft" | "released";
  /**
   * Выпуск запрошен, пересборка идёт.
   *
   * Промежуточное состояние обязано быть данными, а не памятью процесса:
   * пересборка асинхронна, воркер может смениться, а вопрос «эта сборка —
   * выпуск или очередной черновик?» задаётся уже после неё.
   */
  requested?: { by: string; at: string } | null;
  releasedAt?: string | null;
  releasedBy?: string | null;
  /** sha256 выпущенного PDF: чем этот документ отличим от любого другого. */
  documentSha256?: string | null;
};

/**
 * Выпущен ли отчёт — один ответ на весь продукт.
 *
 * Блока нет вовсе (все прогоны до этого шага) — значит черновик: молчание
 * подтверждением не является.
 */
export function isReleasedReport(release: ReportReleaseState | null | undefined): boolean {
  return release?.state === "released";
}

/**
 * Состояние документа после успешной сборки.
 *
 * Запрос выпуска расходуется здесь: следующая пересборка, о выпуске не
 * просившая, вернёт документ в черновик. Иначе однажды выпущенный отчёт
 * оставался бы «выпуском» после любой правки — то есть слово перестало бы
 * значить «этот файл проверен».
 */
export function releaseStateAfterPrepare(input: {
  previous: ReportReleaseState | null | undefined;
  documentSha256: string | null;
  nowIso: string;
}): ReportReleaseState {
  const requested = input.previous?.requested ?? null;
  if (!requested) {
    return { state: "draft", requested: null, releasedAt: null, releasedBy: null, documentSha256: null };
  }
  return {
    state: "released",
    requested: null,
    releasedAt: input.nowIso,
    releasedBy: requested.by,
    documentSha256: input.documentSha256,
  };
}

/** Запрос выпуска: пишется до пересборки, расходуется на её успехе. */
export function withReleaseRequest(input: {
  previous: ReportReleaseState | null | undefined;
  by: string;
  nowIso: string;
}): ReportReleaseState {
  return {
    state: input.previous?.state ?? "draft",
    requested: { by: input.by, at: input.nowIso },
    releasedAt: input.previous?.releasedAt ?? null,
    releasedBy: input.previous?.releasedBy ?? null,
    documentSha256: input.previous?.documentSha256 ?? null,
  };
}

/** Причина отказа в скачивании или `null`. Коды клиенту не печатаются. */
export type DownloadDenialReason = "REPORT_NOT_RELEASED";

/**
 * Кому какой документ отдаётся.
 *
 * Черновик собран для проверки аналитиком: в нём стоят материалы, которые ещё
 * могут оказаться о другом человеке, и темы со статусом «Требует
 * подтверждения». Клиенту он не отдаётся — остальным отдаётся всегда, потому
 * что для них он и собран.
 */
export function downloadDenialForRole(input: {
  role: DpRole;
  released: boolean;
}): DownloadDenialReason | null {
  if (input.released) return null;
  return input.role === "CLIENT_VIEWER" ? "REPORT_NOT_RELEASED" : null;
}
