/**
 * Решения аналитика по пунктам листа проверки: история, а не перезапись.
 *
 * Выпуск отчёта — юридически значимый документ, и на вопрос «почему в отчёте
 * нет X» надо отвечать данными: кто решил, когда и что решал до этого. Файл на
 * томе, которым живёт классический контур, не версионирует решения, не знает
 * автора и не переживает переезд тома.
 *
 * **Ключ пункта — ключ материала** (`serpMaterialKey`): тот же, которым лист
 * проверки считает пункты, таблица выдачи сводит строки, а загрузчик правок
 * раскладывает решения по наблюдениям. Он содержит `/`, `|` и `:`, поэтому
 * едет телом запроса, а не сегментом пути.
 *
 * **Вопрос назван колонкой.** «Чей это материал» и «негативен ли он» — разные
 * вопросы: материал однофамильца бывает и чужим, и негативным одновременно, и
 * одно поле статуса заставило бы аналитика выбирать между ответами.
 * Действующее решение — последняя активная строка на пару «пункт + вопрос».
 *
 * Модуль чистый в той части, которая считает; работа с базой отдана делегатам
 * параметром, поэтому офлайновый контур его тесты не нарушают.
 */

import { createHash } from "node:crypto";

/** Вопросы, на которые аналитик отвечает по пункту листа. */
export const REVIEW_DECISION_KINDS = ["belonging", "adverse", "presence"] as const;
export type ReviewDecisionKind = (typeof REVIEW_DECISION_KINDS)[number];

/**
 * Ответ «снимаю своё решение».
 *
 * Это именно ответ, а не отсутствие строки: удалять историю нельзя, а вернуться
 * к машинному ответу аналитику надо. Действующим решением `CLEARED` не
 * считается — его смысл в том, чтобы перестать перекрывать машину.
 */
export const REVIEW_DECISION_CLEARED = "CLEARED" as const;

const STATUSES: Readonly<Record<ReviewDecisionKind, readonly string[]>> = {
  belonging: ["CONFIRMED_SUBJECT", "OTHER_SUBJECT", REVIEW_DECISION_CLEARED],
  adverse: ["ADVERSE", "NEUTRAL", REVIEW_DECISION_CLEARED],
  /**
   * Печатается ли материал вовсе.
   *
   * Отдельный вопрос от негатива: «не негатив» оставляет строку в отчёте и
   * снимает с неё обвинение, «снять» убирает её из отчёта целиком. Одно поле
   * заставляло бы выбирать между двумя разными действиями.
   */
  presence: ["EXCLUDED", REVIEW_DECISION_CLEARED],
};

export type ReviewDecisionRow = {
  id: string;
  caseId: string;
  itemKind: string;
  itemKey: string;
  decisionKind: string;
  status: string;
  note?: string | null;
  isActive: boolean;
  previousDecisionId?: string | null;
  decidedBy?: string | null;
  /** ISO-строка либо `Date` — как отдаст база. */
  decidedAt: string | Date;
  source?: string | null;
};

/** Допустима ли пара «вопрос → ответ». Ответ не на свой вопрос молча не проходит. */
export function isValidReviewDecision(kind: string, status: string): boolean {
  const list = STATUSES[kind as ReviewDecisionKind];
  return Boolean(list) && list!.includes(status);
}

/** Допустимые ответы на вопрос — для проверки в API и для подписи в интерфейсе. */
export function reviewDecisionStatuses(kind: ReviewDecisionKind): readonly string[] {
  return STATUSES[kind];
}

/** Ключ действующего решения: пункт и вопрос, на который оно отвечает. */
export function reviewDecisionSlot(itemKey: string, decisionKind: string): string {
  return `${itemKey}|${decisionKind}`;
}

function isoOf(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/**
 * Действующие решения: последняя активная строка на пару «пункт + вопрос».
 *
 * `CLEARED` из результата выпадает — им аналитик и возвращает машинный ответ.
 * Порядок строк из базы не гарантирован, поэтому свежесть решается временем, а
 * не позицией.
 */
export function activeReviewDecisions(
  rows: readonly ReviewDecisionRow[]
): Map<string, ReviewDecisionRow> {
  const out = new Map<string, ReviewDecisionRow>();
  for (const row of rows) {
    if (!row.isActive) continue;
    const slot = reviewDecisionSlot(row.itemKey, row.decisionKind);
    const prev = out.get(slot);
    if (!prev || isoOf(row.decidedAt) > isoOf(prev.decidedAt)) out.set(slot, row);
  }
  for (const [slot, row] of [...out]) {
    if (row.status === REVIEW_DECISION_CLEARED) out.delete(slot);
  }
  return out;
}

/**
 * Отпечаток набора решений.
 *
 * По нему видно, что документ собран **раньше** решений: лист проверки несёт
 * отпечаток того набора, который вошёл в сборку, а вкладка сравнивает его с
 * нынешним. Без этого аналитик видит своё решение в списке и не понимает,
 * почему его нет в PDF.
 */
export function reviewDecisionsDigest(rows: readonly ReviewDecisionRow[]): string {
  const active = [...activeReviewDecisions(rows).values()]
    .map((r) => `${r.itemKind}|${r.itemKey}|${r.decisionKind}|${r.status}|${isoOf(r.decidedAt)}`)
    .sort();
  return createHash("sha256").update(active.join("\n"), "utf8").digest("hex").slice(0, 16);
}

// --------------------------------------------------------------------------
// База
// --------------------------------------------------------------------------

export type ReviewDecisionPrisma = {
  reviewDecision: {
    // `any` args: делегаты PrismaClient не присваиваются без трения по фильтрам.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (args: any) => Promise<ReviewDecisionRow[]>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateMany: (args: any) => Promise<unknown>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: (args: any) => Promise<ReviewDecisionRow>;
  };
};

/** Все решения кейса, включая погашенные: история читается целиком. */
export async function listReviewDecisions(
  caseId: string,
  prisma: Partial<ReviewDecisionPrisma> | null | undefined
): Promise<ReviewDecisionRow[]> {
  if (!prisma?.reviewDecision) return [];
  return prisma.reviewDecision.findMany({
    where: { caseId },
    orderBy: { decidedAt: "asc" },
  });
}

/**
 * Записать решение: прежнее по этой паре гасится и остаётся в истории.
 *
 * Гашение идёт первым намеренно: два активных решения на одну пару — это
 * состояние, в котором «действующее» приходится угадывать, и никакой порядок
 * чтения его не спасёт.
 */
export async function recordReviewDecision(
  input: {
    caseId: string;
    itemKind: string;
    itemKey: string;
    decisionKind: string;
    status: string;
    note?: string | null;
    decidedBy?: string | null;
    source?: string;
  },
  prisma: ReviewDecisionPrisma
): Promise<ReviewDecisionRow> {
  const previous = (
    await prisma.reviewDecision.findMany({
      where: {
        caseId: input.caseId,
        itemKind: input.itemKind,
        itemKey: input.itemKey,
        decisionKind: input.decisionKind,
        isActive: true,
      },
      orderBy: { decidedAt: "desc" },
    })
  )[0];

  await prisma.reviewDecision.updateMany({
    where: {
      caseId: input.caseId,
      itemKind: input.itemKind,
      itemKey: input.itemKey,
      decisionKind: input.decisionKind,
      isActive: true,
    },
    data: { isActive: false },
  });

  return prisma.reviewDecision.create({
    data: {
      caseId: input.caseId,
      itemKind: input.itemKind,
      itemKey: input.itemKey,
      decisionKind: input.decisionKind,
      status: input.status,
      note: input.note ?? null,
      isActive: true,
      previousDecisionId: previous?.id ?? null,
      decidedBy: input.decidedBy ?? null,
      source: input.source ?? "ui",
    },
  });
}
