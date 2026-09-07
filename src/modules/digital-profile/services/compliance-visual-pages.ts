/**
 * Снимок отчёта базы комплаенса и описание аналитика к нему — один ответ.
 *
 * Разбор `rawMetadataSafe.complianceVisual` жил в классическом контуре и знал
 * два источника: Dow Jones и World-Check. Канонический отчёт снимков не видел
 * вовсе, и страница LexisNexis печатала «визуальный экспорт недоступен» при
 * загруженном снимке. Второй разбор рядом с первым разошёлся бы с ним на первой
 * же правке, поэтому ответ живёт здесь, а классический построитель зовёт его.
 *
 * **Описание аналитика — те же три поля, которые сайдбар страницы печатает и
 * без снимка.** Новых мест для клиентского текста не заводится: у страницы уже
 * есть «что показывает экран», «почему это важно» и «что сделать», и описание
 * ложится в них.
 *
 * **Дата отчёта — не дата загрузки.** Под снимком печатается происхождение, и
 * это дата документа, а не нашего действия. Происхождение названо документом, а
 * не сотрудником: пометок о правках аналитика в отчёте нет (решение владельца
 * 6), но у напечатанного текста обязан быть источник.
 */

import {
  findInternalCodes,
  findLowercaseCodeLikeTokens,
} from "../orion-golden/deck-sections/internal-code-scan";

/** Виды снимков, у каждого свой слот в деке. */
export const COMPLIANCE_VISUAL_KINDS = [
  "dow_jones_report",
  "world_check_report",
  "lexisnexis_report",
] as const;
export type ComplianceVisualKind = (typeof COMPLIANCE_VISUAL_KINDS)[number];

/** Предел одного поля описания — тот же, что у примечания аналитика. */
export const ANALYST_DESCRIPTION_MAX_CHARS = 320;

export type AnalystVisualDescription = {
  /** «Что показывает экран». */
  whatItShows?: string;
  /** «Почему это важно». */
  whyItMatters?: string;
  /** «Что сделать». */
  whatToDo?: string;
};

export type ComplianceVisualPage = {
  pageNumber: number;
  storageKey?: string;
  imageBase64?: string;
  contentBase64?: string;
  caption?: string;
};

export type ComplianceVisualMeta = {
  /** `null` — вид записан, но нам незнаком: выдумывать его нельзя. */
  kind: ComplianceVisualKind | null;
  approved: boolean;
  approvedAt?: string;
  approvedBy?: string;
  /** Дата самого отчёта базы; печатается под снимком. */
  reportDate?: string;
  description?: AnalystVisualDescription;
  renderedPages: ComplianceVisualPage[];
};

function asObj(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

function nonEmpty(v: unknown): string | undefined {
  const text = String(v ?? "").trim();
  return text || undefined;
}

function kindOf(raw: string): ComplianceVisualKind | null {
  const value = raw.trim().toLowerCase();
  if ((COMPLIANCE_VISUAL_KINDS as readonly string[]).includes(value)) {
    return value as ComplianceVisualKind;
  }
  // Прежние написания источника — их писал классический импорт.
  if (/world.?check/u.test(value)) return "world_check_report";
  if (/dow.?jones/u.test(value)) return "dow_jones_report";
  if (/lexis/u.test(value)) return "lexisnexis_report";
  return null;
}

/** Разобрать метаданные снимка; `null` — снимка нет вовсе. */
export function parseComplianceVisualMeta(raw: unknown): ComplianceVisualMeta | null {
  const visual = asObj(asObj(raw).complianceVisual);
  if (Object.keys(visual).length === 0) return null;
  const pages = Array.isArray(visual.renderedPages)
    ? (visual.renderedPages as Array<Record<string, unknown>>)
    : [];
  const description = asObj(visual.description);
  const parsed: AnalystVisualDescription = {
    ...(nonEmpty(description.whatItShows) ? { whatItShows: nonEmpty(description.whatItShows)! } : {}),
    ...(nonEmpty(description.whyItMatters) ? { whyItMatters: nonEmpty(description.whyItMatters)! } : {}),
    ...(nonEmpty(description.whatToDo) ? { whatToDo: nonEmpty(description.whatToDo)! } : {}),
  };
  return {
    kind: kindOf(String(visual.kind ?? "")),
    approved: visual.approved === true || String(visual.approved).toLowerCase() === "true",
    ...(nonEmpty(visual.approvedAt) ? { approvedAt: nonEmpty(visual.approvedAt)! } : {}),
    ...(nonEmpty(visual.approvedBy) ? { approvedBy: nonEmpty(visual.approvedBy)! } : {}),
    ...(nonEmpty(visual.reportDate) ? { reportDate: nonEmpty(visual.reportDate)! } : {}),
    ...(Object.keys(parsed).length > 0 ? { description: parsed } : {}),
    renderedPages: pages.map((p, idx) => ({
      pageNumber: Number(p.pageNumber ?? idx + 1) || idx + 1,
      ...(nonEmpty(p.storageKey) ? { storageKey: nonEmpty(p.storageKey)! } : {}),
      ...(nonEmpty(p.imageBase64) ? { imageBase64: String(p.imageBase64) } : {}),
      ...(nonEmpty(p.contentBase64) ? { contentBase64: String(p.contentBase64) } : {}),
      ...(nonEmpty(p.caption) ? { caption: nonEmpty(p.caption)! } : {}),
    })),
  };
}

/**
 * Слот деки для страницы снимка — или `null`, если печатать её негде.
 *
 * У Dow Jones слот один, у LexisNexis два: так устроен канонический набор
 * страниц. Третьей страницы нет, и притворяться, что есть, нельзя — снимок
 * молча не поместился бы.
 */
export function complianceVisualSlotOf(
  kind: ComplianceVisualKind | null,
  pageIndex: number
): string | null {
  if (pageIndex === 1) {
    if (kind === "dow_jones_report" || kind === "world_check_report") return "p34_dow_jones";
    if (kind === "lexisnexis_report") return "p35_lexis_visual";
    return null;
  }
  if (pageIndex === 2 && kind === "lexisnexis_report") return "p36_lexis_visual_2";
  return null;
}

export type DescriptionCheck =
  | { ok: true; value: AnalystVisualDescription | undefined }
  | { ok: false; reason: string };

/**
 * Проверить описание при сохранении, а не в рендере.
 *
 * Текст уезжает на клиентскую страницу и проходит те же ворота, что весь
 * клиентский текст. Проверять его в сборке значило бы показать отказ через пять
 * минут после того, как аналитик ушёл, — и не показать вовсе, если сборку
 * запустит кто-то другой.
 */
export function validateAnalystVisualDescription(
  input: AnalystVisualDescription | null | undefined
): DescriptionCheck {
  if (!input) return { ok: true, value: undefined };
  const out: AnalystVisualDescription = {};
  for (const field of ["whatItShows", "whyItMatters", "whatToDo"] as const) {
    const text = nonEmpty(input[field]);
    if (!text) continue;
    if (text.length > ANALYST_DESCRIPTION_MAX_CHARS) {
      return {
        ok: false,
        reason: `поле длиннее ${ANALYST_DESCRIPTION_MAX_CHARS} знаков`,
      };
    }
    // Оба сторожа: заглавный код («MATCH_CONFIRMED») и машинное имя нижнего
    // регистра («criminal_legal»). Читателю не говорит ничего ни то, ни другое,
    // и регистр этого не меняет.
    const codes = [...findInternalCodes(text), ...findLowercaseCodeLikeTokens(text)];
    if (codes.length > 0) {
      return { ok: false, reason: `в тексте служебный код: ${codes[0]}` };
    }
    out[field] = text;
  }
  // Пустое описание — это отсутствие описания, а не ошибка: снимок без слов
  // честнее выдуманных слов.
  return { ok: true, value: Object.keys(out).length > 0 ? out : undefined };
}

// --------------------------------------------------------------------------
// Снимок → страница деки
// --------------------------------------------------------------------------

/** Как называется база под снимком. */
const PROVIDER_LABEL: Readonly<Record<ComplianceVisualKind, string>> = {
  dow_jones_report: "Dow Jones",
  world_check_report: "World-Check",
  lexisnexis_report: "LexisNexis",
};

/**
 * Происхождение под снимком — датой **отчёта**, а не датой загрузки.
 *
 * Даты отчёта нет — фраза о ней не выдумывается: «Снимок отчёта LexisNexis»
 * без даты честнее приписанной. Имени сотрудника здесь нет по решению
 * владельца 6.
 */
export function complianceVisualSourceLine(meta: ComplianceVisualMeta): string {
  const label = meta.kind ? PROVIDER_LABEL[meta.kind] : "базы данных";
  const date = (meta.reportDate ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}/u.test(date)) return `Снимок отчёта ${label}.`;
  const [y, m, d] = date.slice(0, 10).split("-");
  return `Отчёт ${label} от ${d}.${m}.${y}`;
}

export type ComplianceVisualBinding = {
  slotId: string;
  assetRef: string;
  title: string;
  pageNumber: number;
  imageData: string;
  storageKey?: string;
  evidenceRefs: string[];
  description?: AnalystVisualDescription;
  sourceLine: string;
};

/**
 * Одобренные снимки → привязки к слотам деки.
 *
 * Байты страницы читает вызывающий (`loadPage`): модуль остаётся офлайновым и
 * проверяемым, а хранилище живёт там, где ему положено. Страница, для которой
 * слота нет, не привязывается вовсе — молча ужать её в чужой слот значило бы
 * потерять снимок.
 */
export async function buildComplianceVisualBindings(
  rows: ReadonlyArray<{ id: string; provider?: string | null; rawMetadataSafe?: unknown }>,
  loadPage: (page: ComplianceVisualPage) => Promise<string | null>
): Promise<ComplianceVisualBinding[]> {
  const out: ComplianceVisualBinding[] = [];
  const taken = new Set<string>();
  for (const row of rows) {
    const meta = parseComplianceVisualMeta(row.rawMetadataSafe);
    if (!meta || !meta.approved || !meta.kind || meta.renderedPages.length === 0) continue;
    const sourceLine = complianceVisualSourceLine(meta);
    let index = 0;
    for (const page of meta.renderedPages) {
      index += 1;
      const slotId = complianceVisualSlotOf(meta.kind, index);
      if (!slotId || taken.has(slotId)) continue;
      const imageData = await loadPage(page);
      if (!imageData) continue;
      taken.add(slotId);
      out.push({
        slotId,
        assetRef: `${meta.kind}_${index}`,
        title: `${PROVIDER_LABEL[meta.kind]} — страница профиля${index > 1 ? ` (${index})` : ""}`,
        pageNumber: page.pageNumber || index,
        imageData,
        ...(page.storageKey ? { storageKey: page.storageKey } : {}),
        evidenceRefs: [`database_profile:${row.id}`],
        ...(meta.description ? { description: meta.description } : {}),
        sourceLine,
      });
    }
  }
  return out;
}
