/**
 * Отказ **после** сбора: данные собраны и оплачены, упала сборка отчёта.
 *
 * Различие не косметическое. Сбор стоит денег у Arsenkin, Serper и Yandex;
 * сборка отчёта — только у GPT, и повторить её можно на уже собранных
 * наблюдениях. Пока эти два случая не различались, отказ на сборке приводил
 * оператора к единственной кнопке «Начать новый аудит с повторным сбором
 * данных» — то есть выбросить оплаченный сбор и заплатить за него заново
 * из-за ошибки в тексте.
 *
 * Правило проекта здесь прямое: отказ одного шага не обнуляет оплаченный сбор.
 *
 * Признак отказа перечислялся в трёх местах оркестратора по-своему; здесь он
 * один, и спрашивают его все.
 */

export type PostCollectionFailureView = {
  lastErrorCode?: string | null;
  lastError?: string | null;
};

/** Коды отказов, наступающих после того, как сбор уже завершён. */
const POST_COLLECTION_ERROR_CODES: ReadonlySet<string> = new Set([
  "ASSEMBLY_FAILED",
  "REQUIRED_SECTION_FAILED",
  "RENDER_FAILED",
  "PRE_RENDER_DATA_GATE_FAILED",
  "GPT_COPY_FAILED",
  // Ворота телеметрии рендерера: документ испорчен, сбор цел и оплачен.
  // Лечится ровно пересборкой — рендер бесплатен и детерминирован, а в окне
  // деплоя (новое приложение, старый рендерер без телеметрии) ре-рендер
  // проходит сам.
  "CONTENT_DROPPED_BY_RENDERER",
  "RENDER_TELEMETRY_MISSING",
]);

/** Формулировки, по которым отказ опознаётся, когда код не проставлен. */
const POST_COLLECTION_MESSAGE_RE =
  /required sections failed|deck assembly failed|render failed|pre-render data gate/i;

export function isPostCollectionFailure(job: PostCollectionFailureView): boolean {
  const code = String(job.lastErrorCode ?? "").trim();
  if (code && POST_COLLECTION_ERROR_CODES.has(code)) return true;
  return POST_COLLECTION_MESSAGE_RE.test(String(job.lastError ?? ""));
}
