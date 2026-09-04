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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RawInventoryItem } from "../types";
import {
  LINK_VERDICT_SCHEMA_VERSION,
  LinkVerdictSetSchema,
  summarizeLinkVerdicts,
  type LinkVerdict,
  type VerdictSummary,
  type VerdictThemeSummary,
} from "../contracts/link-verdict";
import { analyzeLinkPages, type LinkVerdictInput } from "./link-verdict-analyst";
import type { SubjectAnchors } from "./subject-anchors";
import { resolveThemeLabels, summarizeThemesWithLabels } from "./link-theme-clustering";
import { mapRegionBucket } from "../classic/composite-serp-overlay-merge";
import { isLinkReadingEnabled, readLinkPage, type LinkPageRead } from "../../services/link-page-reader";
import { readLinks, type LinkReadingReport } from "./link-reading-agent";
import {
  auditLinkVerdicts,
  subjectNameVariants,
  type VerdictAuditReport,
} from "./link-verdict-audit-agent";

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
   * Темы по контурам выдачи. Российская и международная страницы отчёта
   * показывают своё: свод по всему прогону отвечал на вопрос «о чём публикации
   * в ТОП-20 России» числами из выдачи ОАЭ.
   */
  themesByRegion: Record<string, VerdictThemeSummary[]>;
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
/**
 * Порядок чтения: подтверждённые страницы первыми, чужие не читаются вовсе.
 *
 * Отбор шёл по позиции в выдаче и о принадлежности не знал: на прогоне
 * DPA-2026-0049 из 120 купленных страниц десятки были карточками ИП и
 * врача-однофамильца — деньги за чужие страницы и вердикты, из которых потом
 * собраны «сюжеты» отчёта. Разметка к этому моменту уже готова (она идёт
 * раньше чтения), и спросить её ничего не стоит.
 */
const READ_PRIORITY: Record<string, number> = {
  SUBJECT_MATCH: 0,
  LIKELY_SUBJECT: 1,
};

export function linksToRead(
  items: RawInventoryItem[],
  limit = LINK_VERDICT_MAX_LINKS,
  opts?: { decisionByRef?: Map<string, string> }
): Array<{ item: RawInventoryItem; url: string; rank?: number; query?: string; region?: string }> {
  const seen = new Set<string>();
  const rows: Array<{
    item: RawInventoryItem;
    url: string;
    rank?: number;
    query?: string;
    region?: string;
  }> = [];
  const decisionByRef = opts?.decisionByRef;
  for (const item of items) {
    const url = String(item.sourceUrl ?? "").trim();
    if (!/^https?:\/\//iu.test(url)) continue;
    // Страница другого лица не покупается: её вердикт не нужен ни одной
    // странице отчёта, а прочитать её стоит денег.
    if (decisionByRef?.get(`inventory:${item.inventoryId}`) === "OTHER_SUBJECT") continue;
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
      region: item.region ? mapRegionBucket(item.region) : undefined,
    });
  }
  const priorityOf = (item: RawInventoryItem): number =>
    decisionByRef
      ? READ_PRIORITY[decisionByRef.get(`inventory:${item.inventoryId}`) ?? ""] ?? 2
      : 0;
  return rows
    .sort(
      (a, b) =>
        priorityOf(a.item) - priorityOf(b.item) ||
        (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER)
    )
    .slice(0, limit);
}

/** Почему купленный артефакт нельзя переиспользовать. */
type LinkVerdictReuseLossReason =
  | "unreadable"
  | "schema-mismatch"
  | "invalid"
  | "foreign-case";

export type LinkVerdictReuse =
  | { status: "reuse"; result: LinkVerdictRunResult; previousDatasetId: string | null }
  | { status: "lost"; reason: LinkVerdictReuseLossReason; previousVerdictCount: number }
  | { status: "none" };

/**
 * Купленное чтение прошлого прогона этой же джобы.
 *
 * У вердиктов нет базы: прочитанные страницы и решения модели живут только в
 * `link-verdicts.json`, и пересоздать их можно лишь заплатив ещё раз. Поэтому
 * пересборка отчёта их переиспользует — и по той же причине переиспользование
 * узкое: чужой кейс (скопированный каталог), чужая версия схемы и
 * неразобранное содержимое реюзом не считаются.
 *
 * `readOk` в условия не входит намеренно: прогон со сломанным чтением —
 * купленный и честно размеченный результат, заморозить его лучше, чем затереть
 * пустым. Лечится он новым сбором, а не молчаливой повторной тратой.
 */
/**
 * Вето разметки над вердиктом прочитанной страницы.
 *
 * Стадия чтения знает о субъекте только ФИО и решает по тексту страницы: на
 * прогоне DPA-2026-0049 она назвала «страницами субъекта» тринадцать карточек
 * ИП и четыре страницы офтальмолога, и именно из этих вердиктов собраны
 * «Основные сюжеты в выдаче» на второй странице отчёта. Разметка знает больше —
 * она видела якоря, — и её ответ здесь сильнее.
 *
 * Применяется один раз, сразу после того как вердикты получены **или
 * переиспользованы**: артефакт прошлого прогона живёт по `schemaVersion`, и
 * фильтр только на свежих решениях не защищал бы пересборку отчёта.
 */
export function applySubjectDecisionVeto(input: {
  verdicts: LinkVerdict[];
  decisionByRef: Map<string, string>;
}): { verdicts: LinkVerdict[]; vetoed: number } {
  let vetoed = 0;
  const verdicts = input.verdicts.map((v) => {
    if (v.subjectMatch !== "subject") return v;
    const decision = input.decisionByRef.get(v.evidenceRef);
    if (!decision || decision === "SUBJECT_MATCH" || decision === "LIKELY_SUBJECT") return v;
    vetoed += 1;
    // «Другое лицо» так и называется; всё прочее — честное «непонятно»:
    // разметка не утверждает, что страница о постороннем, она лишь не
    // подтвердила принадлежность.
    return { ...v, subjectMatch: decision === "OTHER_SUBJECT" ? ("other" as const) : ("unclear" as const) };
  });
  return { verdicts, vetoed };
}

/**
 * Пересчитать темы после вето разметки.
 *
 * Стадия чтения сводит темы до того, как применено вето: реюз смотрит только
 * на `schemaVersion`, и вето поэтому стоит позже. Пока темы оставались
 * посчитанными по невето́ванным решениям, таблица тем страницы 25 показывала
 * страницы однофамильцев, которых в доле негатива и в резюме уже не было, —
 * числа одного отчёта не сходились между собой.
 *
 * Считается по тем же правилам, что и сам свод: в тему идут только материалы о
 * субъекте. Тема, у которой не осталось ни одной страницы, исчезает: пустая
 * строка в таблице тем — это утверждение о теме без единого материала.
 */
export function applyVetoToThemeSummaries(input: {
  themes: readonly VerdictThemeSummary[];
  verdicts: readonly LinkVerdict[];
}): VerdictThemeSummary[] {
  const byRef = new Map(input.verdicts.map((v) => [v.evidenceRef, v] as const));
  const out: VerdictThemeSummary[] = [];
  for (const theme of input.themes) {
    const kept = theme.evidenceRefs.filter((ref) => byRef.get(ref)?.subjectMatch === "subject");
    if (kept.length === 0) continue;
    if (kept.length === theme.evidenceRefs.length) {
      out.push(theme);
      continue;
    }
    const keptUrls = new Set(kept.map((ref) => byRef.get(ref)!.url));
    out.push({
      ...theme,
      count: kept.length,
      adverseCount: kept.filter((ref) => byRef.get(ref)!.tone === "adverse").length,
      evidenceRefs: kept,
      examples: theme.examples.filter((e) => keptUrls.has(e.url)),
    });
  }
  return out;
}

export function loadReusableLinkVerdicts(
  artifactsDir: string,
  input: { caseId: string }
): LinkVerdictReuse {
  const path = join(artifactsDir, "link-verdicts.json");
  if (!existsSync(path)) return { status: "none" };

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    // Сколько решений было в нечитаемом файле — неизвестно, и выдумывать
    // число нельзя; что файл был и пропал — сказать обязаны.
    return { status: "lost", reason: "unreadable", previousVerdictCount: 0 };
  }

  const previousVerdictCount = Array.isArray(raw.verdicts) ? raw.verdicts.length : 0;
  // Схема проверяется раньше пустоты: артефакт чужой версии мог хранить
  // решения под другим ключом, и «пустой» он только на наш взгляд — считать
  // его пустотой значило бы затереть купленное молча.
  if (raw.schemaVersion !== LINK_VERDICT_SCHEMA_VERSION) {
    return { status: "lost", reason: "schema-mismatch", previousVerdictCount };
  }
  // Пустой артефакт своей схемы (шаг был выключен или ссылок не нашлось)
  // покупкой не был: следующую попытку по-прежнему решает флаг.
  if (previousVerdictCount === 0) return { status: "none" };
  if (raw.caseId !== input.caseId) {
    return { status: "lost", reason: "foreign-case", previousVerdictCount };
  }

  const parsed = LinkVerdictSetSchema.safeParse(raw);
  const summary = raw.summary as VerdictSummary | undefined;
  const reading = raw.reading as LinkReadingReport | undefined;
  const audit = raw.audit as VerdictAuditReport | undefined;
  if (!parsed.success || !summary || !Array.isArray(summary.themes) || !reading || !audit) {
    return { status: "lost", reason: "invalid", previousVerdictCount };
  }

  return {
    status: "reuse",
    previousDatasetId: typeof raw.datasetId === "string" ? raw.datasetId : null,
    result: {
      schemaVersion: LINK_VERDICT_SCHEMA_VERSION,
      caseId: input.caseId,
      requested: Number(raw.requested ?? parsed.data.verdicts.length),
      readOk: Number(raw.readOk ?? 0),
      reading,
      audit,
      themesByRegion: (raw.themesByRegion ?? {}) as Record<string, VerdictThemeSummary[]>,
      readingBroken: Boolean(raw.readingBroken),
      verdicts: parsed.data.verdicts,
      summary,
      // `skippedReason` не переносится сознательно: одно поле не может значить
      // и «шаг пропущен», и «результат куплен раньше».
    },
  };
}

export async function runLinkVerdicts(input: {
  caseId: string;
  /** Признаки субъекта едут и в промпт чтения, и в дословную проверку вывода. */
  subject: { fullName: string; aliases?: string[]; anchors?: SubjectAnchors | null };
  /** Материалы предмета аудита (ТОП-20 выдачи). */
  items: RawInventoryItem[];
  /** Решение разметки по наблюдению: чужие страницы не читаются. */
  decisionByRef?: Map<string, string>;
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
    themesByRegion: {} as Record<string, VerdictThemeSummary[]>,
  };
  if (!isLinkReadingEnabled(input.deps?.env ?? process.env)) {
    return { ...base, skippedReason: "disabled", requested: 0, readOk: 0, readingBroken: false };
  }
  const links = linksToRead(input.items, input.deps?.limit ?? LINK_VERDICT_MAX_LINKS, {
    decisionByRef: input.decisionByRef,
  });
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
    region: link.region,
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
    subjectNames: subjectNameVariants(input.subject),
    anchors: input.subject.anchors ?? null,
  });
  const verdicts = audited.verdicts;
  // Второй проход: формулировки страниц сводятся в темы отчёта. Без него на
  // живом прогоне вышло 73 темы на 75 публикаций — по теме на страницу.
  const summary = summarizeLinkVerdicts(verdicts);
  // Словарь тем общий на прогон, числа — свои у каждого контура.
  const labels = await resolveThemeLabels(verdicts);
  const themes = summarizeThemesWithLabels(verdicts, labels);
  const regions = [...new Set(verdicts.map((v) => v.region).filter((r): r is string => Boolean(r)))];
  const themesByRegion = Object.fromEntries(
    regions.map((region) => [
      region,
      summarizeThemesWithLabels(verdicts.filter((v) => v.region === region), labels),
    ])
  );
  return {
    schemaVersion: LINK_VERDICT_SCHEMA_VERSION,
    caseId: input.caseId,
    requested: links.length,
    readOk: reading.report.read,
    readingBroken: reading.report.status === "BROKEN",
    reading: reading.report,
    audit: audited.report,
    themesByRegion,
    verdicts,
    summary: { ...summary, themes },
  };
}
