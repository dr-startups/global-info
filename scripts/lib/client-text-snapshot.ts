/**
 * Снимок клиентского текста собранной деки.
 *
 * Нужен шагам 0002–0004 (переработка текста отчёта): формулировки должны
 * меняться осознанно. Числовой эталон золотого кейса за этим не следит — он
 * сверяет счётчики и метрики качества, а не то, какими словами написан отчёт.
 * Снимок закрывает эту дыру: `git diff` по нему показывает каждое изменённое
 * предложение.
 *
 * В снимок попадает только то, что видит клиент. Служебные поля (метрики,
 * ссылки на находки, идентификаторы ассетов, номера страниц) исключены
 * намеренно: их изменения не являются изменением текста и создавали бы шум.
 * `slideKey` и `baseSlotId` оставлены как якоря — без них diff нечитаем.
 */

/** Поля слайда, содержащие клиентский текст. Порядок — как в снимке. */
const TEXT_FIELDS = [
  "title",
  "subtitle",
  "narrative",
  "whatWasFound",
  "whyItMatters",
  "whatToCheck",
  "statusNote",
  "sourceNote",
  "methodologyNote",
  "emptyStateReason",
] as const;

export type ClientTextSlide = {
  slideKey: string;
  baseSlotId?: string;
  template?: string;
  text: Record<string, string>;
  bullets?: string[];
  kpis?: string[];
  /**
   * Текст карточек «Что проверить» — рекомендация приходит в макет отдельным
   * полем, а не текстовым. Пока снимок его не читал, формулировки рекомендаций
   * пустых страниц и панелей не были закреплены эталоном вовсе.
   */
  actions?: string[];
  /**
   * Текст карточек матрицы рисков и исполнительного дашборда — то, что
   * нарисовано на карточке, а не строка таблицы-провода. Пока снимок его не
   * читал, формулировки карточек не были закреплены эталоном вовсе: у
   * риск-слайдов в снимок попадала одна таблица, и переписать карточку можно
   * было молча.
   */
  keyFindings?: Array<{ headline: string; status: string; detail: string }>;
  table?: { headers: string[]; rows: string[][] };
  highlights?: string[];
};

export type ClientTextSnapshot = {
  version: string;
  slideCount: number;
  /** Суммарная длина клиентского текста — грубая мера «многословности». */
  totalChars: number;
  slides: ClientTextSlide[];
};

export const CLIENT_TEXT_SNAPSHOT_VERSION = "client-text-snapshot-v2";

/**
 * Пробелы схлопываются, края обрезаются. Перенос строки внутри абзаца — это
 * решение вёрстки, а не текста, и сравнивать по нему нечего.
 */
function norm(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

type RawSlide = Record<string, unknown>;

export function extractClientText(deck: { slides?: unknown }): ClientTextSnapshot {
  const slides = Array.isArray(deck.slides) ? (deck.slides as RawSlide[]) : [];
  const out: ClientTextSlide[] = [];

  for (const raw of slides) {
    const text: Record<string, string> = {};
    for (const field of TEXT_FIELDS) {
      const v = norm(raw[field]);
      if (v) text[field] = v;
    }

    const slide: ClientTextSlide = {
      slideKey: String(raw.slideKey ?? ""),
      text,
    };
    if (raw.baseSlotId) slide.baseSlotId = String(raw.baseSlotId);
    if (raw.template) slide.template = String(raw.template);

    const bullets = Array.isArray(raw.bullets)
      ? raw.bullets.map(norm).filter(Boolean)
      : [];
    if (bullets.length) slide.bullets = bullets;

    if (Array.isArray(raw.actions)) {
      const actions = (raw.actions as Array<Record<string, unknown>>)
        .map((a) => norm(a?.label))
        .filter(Boolean);
      if (actions.length) slide.actions = actions;
    }

    if (Array.isArray(raw.keyFindings)) {
      const cards = (raw.keyFindings as Array<Record<string, unknown>>)
        .map((k) => ({
          headline: norm(k.headline),
          status: norm(k.status),
          detail: norm(k.detail),
        }))
        .filter((k) => k.headline || k.status || k.detail);
      if (cards.length) slide.keyFindings = cards;
    }

    if (Array.isArray(raw.kpis)) {
      const kpis = (raw.kpis as Array<Record<string, unknown>>)
        .map((k) => `${norm(k.label)}: ${norm(k.value)}`.trim())
        .filter((s) => s !== ":");
      if (kpis.length) slide.kpis = kpis;
    }

    const table = raw.table as { headers?: unknown; rows?: unknown } | undefined;
    if (table && (Array.isArray(table.headers) || Array.isArray(table.rows))) {
      slide.table = {
        headers: Array.isArray(table.headers) ? table.headers.map(norm) : [],
        rows: Array.isArray(table.rows)
          ? (table.rows as unknown[][]).map((r) => (Array.isArray(r) ? r.map(norm) : []))
          : [],
      };
    }

    if (Array.isArray(raw.highlightExplanations)) {
      const hl = (raw.highlightExplanations as Array<Record<string, unknown>>)
        .map((h) => norm(h.clientReason))
        .filter(Boolean);
      if (hl.length) slide.highlights = hl;
    }

    out.push(slide);
  }

  const totalChars = out.reduce((sum, s) => {
    const parts = [
      ...Object.values(s.text),
      ...(s.bullets ?? []),
      ...(s.kpis ?? []),
      ...(s.actions ?? []),
      ...(s.keyFindings ?? []).flatMap((k) => [k.headline, k.status, k.detail]),
      ...(s.highlights ?? []),
      ...(s.table ? [...s.table.headers, ...s.table.rows.flat()] : []),
    ];
    return sum + parts.reduce((a, p) => a + p.length, 0);
  }, 0);

  return {
    version: CLIENT_TEXT_SNAPSHOT_VERSION,
    slideCount: out.length,
    totalChars,
    slides: out,
  };
}
