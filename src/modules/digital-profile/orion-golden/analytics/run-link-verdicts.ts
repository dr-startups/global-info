/**
 * Шаг прогона: прочитать ссылки предмета аудита и получить решение по каждой.
 *
 * Это самая дорогая часть отчёта — чужие страницы и вызовы модели, — поэтому
 * она подчинена трём правилам.
 *
 * **Выключено по умолчанию.** Без `DIGITAL_PROFILE_LINK_READING` шаг не ходит
 * ни в сеть, ни в модель и возвращает пустой результат с причиной. Решение о
 * трате принимает человек, а не значение по умолчанию.
 *
 * **Читается только предмет аудита.** ТОП-20 выдачи, по одному разу на
 * материал. Платить за чтение того, чего в выдаче не видно, незачем.
 *
 * **Отказ — это результат.** Страница не открылась, модель не ответила — в
 * решении стоит причина, и она дойдёт до отчёта. Эталон отрасли пишет об этом
 * прямо: «из 20 ссылок 2 нежелательные, 7 неактуальных и 2 — не открываются».
 */

import type { RawInventoryItem } from "../types";
import {
  LINK_VERDICT_SCHEMA_VERSION,
  summarizeLinkVerdicts,
  type LinkVerdict,
  type VerdictSummary,
} from "../contracts/link-verdict";
import { analyzeLinkPages, type LinkVerdictInput } from "./link-verdict-analyst";
import { clusterVerdictThemes } from "./link-theme-clustering";
import { isLinkReadingEnabled, readLinkPage, type LinkPageRead } from "../../services/link-page-reader";
import { readLinks, type LinkReadingReport } from "./link-reading-agent";
import { auditLinkVerdicts, type VerdictAuditReport } from "./link-verdict-audit-agent";
import { transliterateRuToEn } from "../../search-surfaces/orion-query-plan";

/** Сколько ссылок читаем за прогон. Предел, а не цель. */
export const LINK_VERDICT_MAX_LINKS = 120;

export type LinkVerdictRunResult = {
  schemaVersion: typeof LINK_VERDICT_SCHEMA_VERSION;
  caseId: string;
  /** Почему шаг ничего не сделал, если не сделал. */
  skippedReason?: "disabled" | "no-links";
  requested: number;
  /** Сколько страниц удалось прочитать. Ноль при непустом запросе — поломка. */
  readOk: number;
  /** Отчёт агента чтения: причины отказов, повторы, статус шага. */
  reading: LinkReadingReport;
  /** Отчёт агента проверки: что снято и почему. */
  audit: VerdictAuditReport;
  /**
   * Чтение не сработало вовсе: запрошены страницы, прочитано ноль.
   *
   * Отдельный признак, а не вывод из двух чисел: прогон с нулевым чтением
   * три раза подряд считался успешным, потому что «ни одна страница не
   * открылась» выглядело как свойство интернета, а не как поломка у нас. На
   * деле падал сам запрос — из-за кириллицы в заголовке.
   */
  readingBroken: boolean;
  verdicts: LinkVerdict[];
  summary: VerdictSummary;
};

function domainOf(url: string | null | undefined): string | undefined {
  const u = String(url ?? "").trim();
  if (!u) return undefined;
  return u
    .replace(/^https?:\/\//iu, "")
    .replace(/^www\./iu, "")
    .split("/")[0]
    ?.toLowerCase();
}

/**
 * Уникальные ссылки предмета аудита в порядке позиции в выдаче.
 *
 * Один и тот же адрес, найденный несколькими запросами, читается один раз:
 * содержание страницы от запроса не зависит.
 */
export function linksToRead(
  items: RawInventoryItem[],
  limit = LINK_VERDICT_MAX_LINKS
): Array<{ item: RawInventoryItem; url: string; rank?: number; query?: string }> {
  const seen = new Set<string>();
  const rows: Array<{ item: RawInventoryItem; url: string; rank?: number; query?: string }> = [];
  for (const item of items) {
    const url = String(item.sourceUrl ?? "").trim();
    if (!/^https?:\/\//iu.test(url)) continue;
    const key = url.replace(/[#?].*$/u, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const meta = (item.rawMetadata ?? {}) as Record<string, unknown>;
    const rank = Number(meta.rank);
    rows.push({
      item,
      url,
      rank: Number.isFinite(rank) && rank > 0 ? rank : undefined,
      query: typeof meta.queryText === "string" ? meta.queryText : undefined,
    });
  }
  return rows
    .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
    .slice(0, limit);
}

export async function runLinkVerdicts(input: {
  caseId: string;
  subject: { fullName: string; aliases?: string[] };
  /** Материалы предмета аудита (ТОП-20 выдачи). */
  items: RawInventoryItem[];
  deps?: {
    read?: (url: string) => Promise<LinkPageRead>;
    analyze?: typeof analyzeLinkPages;
    env?: NodeJS.ProcessEnv;
    limit?: number;
  };
}): Promise<LinkVerdictRunResult> {
  const empty: VerdictSummary = { total: 0, adverse: 0, unread: 0, themes: [] };
  const emptyReading: LinkReadingReport = {
    status: "NO_LINKS",
    requested: 0,
    read: 0,
    failed: 0,
    retried: 0,
    byReason: {},
  };
  const emptyAudit: VerdictAuditReport = {
    checked: 0,
    quotesDropped: 0,
    adverseDowngraded: 0,
    subjectDowngraded: 0,
    changes: [],
  };
  const base = {
    schemaVersion: LINK_VERDICT_SCHEMA_VERSION,
    caseId: input.caseId,
    verdicts: [] as LinkVerdict[],
    summary: empty,
    reading: emptyReading,
    audit: emptyAudit,
  };
  if (!isLinkReadingEnabled(input.deps?.env ?? process.env)) {
    return { ...base, skippedReason: "disabled", requested: 0, readOk: 0, readingBroken: false };
  }
  const links = linksToRead(input.items, input.deps?.limit ?? LINK_VERDICT_MAX_LINKS);
  if (links.length === 0) {
    return { ...base, skippedReason: "no-links", requested: 0, readOk: 0, readingBroken: false };
  }

  const read = input.deps?.read ?? ((url: string) => readLinkPage(url));
  const analyze = input.deps?.analyze ?? analyzeLinkPages;

  // Агент чтения: приносит текст, повторяет срывы связи, отвечает за статус.
  const reading = await readLinks(links.map((l) => l.url), { read });
  const analystInputs: LinkVerdictInput[] = links.map((link, i) => ({
    evidenceRef: `inventory:${link.item.inventoryId}`,
    url: link.url,
    domain: domainOf(link.url),
    rank: link.rank,
    query: link.query,
    serpTitle: link.item.title ?? undefined,
    serpSnippet: link.item.snippet ?? undefined,
    subject: input.subject,
    page: reading.outcomes[i]!.page,
  }));

  const rawVerdicts = await analyze(analystInputs);
  // Агент проверки: сверяет цитаты и принадлежность с текстом страницы.
  const audited = auditLinkVerdicts({
    verdicts: rawVerdicts,
    sources: analystInputs.map((i) => ({
      evidenceRef: i.evidenceRef,
      text: i.page.ok ? i.page.text : undefined,
    })),
    // Латинское написание нужно наравне с русским: половина прочитанного —
    // зарубежные страницы, где фамилия стоит транслитом.
    subjectNames: [
      input.subject.fullName,
      transliterateRuToEn(input.subject.fullName),
      ...(input.subject.aliases ?? []),
    ],
  });
  const verdicts = audited.verdicts;
  // Второй проход: формулировки страниц сводятся в темы отчёта. Без него на
  // живом прогоне вышло 73 темы на 75 публикаций — по теме на страницу.
  const summary = summarizeLinkVerdicts(verdicts);
  const themes = await clusterVerdictThemes(verdicts);
  return {
    schemaVersion: LINK_VERDICT_SCHEMA_VERSION,
    caseId: input.caseId,
    requested: links.length,
    readOk: reading.report.read,
    readingBroken: reading.report.status === "BROKEN",
    reading: reading.report,
    audit: audited.report,
    verdicts,
    summary: { ...summary, themes },
  };
}
