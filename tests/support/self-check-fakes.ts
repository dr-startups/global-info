/**
 * Офлайн-подмены для тестов сайта самопроверки: база в памяти и строки таблиц.
 *
 * База понимает ровно те формы запросов, которыми пользуется модуль: равенство
 * полей и условия `gte`, `lt`, `startsWith`, `in`, `not`. Транзакция откатывает
 * всё записанное внутри неё, если колбэк бросил, — без этого тест «файл профиля
 * не записался, база откатилась» проверял бы подмену, а не код.
 */

import type { SelfCheck } from "@prisma/client";
import type { PersonaCheckRow } from "@/modules/digital-profile/services/subject-persona-check";

type Row = Record<string, unknown>;

function matchesValue(value: unknown, cond: unknown): boolean {
  if (cond instanceof Date) {
    return value instanceof Date && value.getTime() === cond.getTime();
  }
  if (cond !== null && typeof cond === "object" && !Array.isArray(cond)) {
    const c = cond as Record<string, unknown>;
    const time = value instanceof Date ? value.getTime() : Number.NaN;
    if ("gte" in c && !(time >= (c.gte as Date).getTime())) return false;
    if ("lt" in c && !(time < (c.lt as Date).getTime())) return false;
    if ("startsWith" in c && !(typeof value === "string" && value.startsWith(String(c.startsWith)))) {
      return false;
    }
    if ("in" in c && !(c.in as unknown[]).includes(value)) return false;
    if ("not" in c && matchesValue(value, c.not)) return false;
    return true;
  }
  if (cond === null) return value === null || value === undefined;
  return value === cond;
}

export function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(
    ([key, cond]) => cond === undefined || matchesValue(row[key], cond)
  );
}

const clone = <T>(row: T): T => (row ? { ...row } : row);

export const TEST_NOW = new Date("2026-09-14T12:00:00Z");
export const DAY_MS = 24 * 60 * 60 * 1000;

export function selfCheckRow(overrides: Partial<SelfCheck> = {}): SelfCheck {
  const createdAt = overrides.createdAt ?? new Date("2026-09-14T10:00:00Z");
  return {
    id: "check-1",
    publicId: "pUbL1c-iD-0123456789abcdef",
    caseId: "case-1",
    status: "CREATED",
    inputJson: {
      fullName: "Иванов Иван Иванович",
      birthDate: "1985-03-12",
      aliases: [],
      city: "Москва",
      inn: "500301123458",
      employer: "ООО Ромашка",
      position: "Директор",
      website: "romashka.ru",
    },
    consentVersion: "draft-2026-09-14",
    consentAt: createdAt,
    ip: "203.0.113.7",
    userAgent: "Mozilla/5.0 test",
    ipHash: "iphash",
    subjectHash: "subjecthash",
    captchaVerifiedAt: null,
    honeypotTripped: false,
    blockedReason: null,
    jobId: null,
    runStartedAt: null,
    runFinishedAt: null,
    verdict: null,
    riskLevel: null,
    materialsFound: null,
    findingsTotal: null,
    themesJson: null,
    partial: false,
    verdictAt: null,
    verdictSource: null,
    leadName: null,
    leadPhone: null,
    leadEmail: null,
    leadTelegram: null,
    leadMessage: null,
    leadPreferredTime: null,
    leadAt: null,
    leadStatus: "NONE",
    expiresAt: new Date(createdAt.getTime() + 30 * DAY_MS),
    anonymizedAt: null,
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

export function personaCheckRow(overrides: Partial<PersonaCheckRow> = {}): PersonaCheckRow {
  return {
    id: "persona-1",
    caseId: "case-1",
    subjectInputHash: "hash",
    requestJson: null,
    personasJson: {
      subjectFullName: "Иванов Иван Иванович",
      subjectDateOfBirth: "1985-03-12",
      cards: [],
      serpRows: [],
      sources: [],
      fetchStatus: "SUCCESS",
      errorCode: null,
    },
    fetchStatus: "SUCCESS",
    errorCode: null,
    searchedBy: "self-check:check-1",
    searchedAt: new Date("2026-09-14T10:01:00Z"),
    decision: null,
    selectedPersonaJson: null,
    decidedBy: null,
    decidedAt: null,
    ...overrides,
  };
}

const SELF_CHECK_DEFAULTS = (now: Date): Row => ({
  caseId: null,
  captchaVerifiedAt: null,
  honeypotTripped: false,
  blockedReason: null,
  jobId: null,
  runStartedAt: null,
  runFinishedAt: null,
  verdict: null,
  riskLevel: null,
  materialsFound: null,
  findingsTotal: null,
  themesJson: null,
  partial: false,
  verdictAt: null,
  verdictSource: null,
  leadName: null,
  leadPhone: null,
  leadEmail: null,
  leadTelegram: null,
  leadMessage: null,
  leadPreferredTime: null,
  leadAt: null,
  leadStatus: "NONE",
  anonymizedAt: null,
  createdAt: now,
  updatedAt: now,
});

export interface FakeState {
  cases: Row[];
  selfChecks: Row[];
  personaChecks: Row[];
  audits: Row[];
}

export function fakeDb(
  seed: {
    now?: () => Date;
    selfChecks?: SelfCheck[];
    personaChecks?: PersonaCheckRow[];
  } = {}
) {
  const now = seed.now ?? (() => TEST_NOW);
  const state: FakeState = {
    cases: [],
    selfChecks: (seed.selfChecks ?? []).map((r) => ({ ...r })),
    personaChecks: (seed.personaChecks ?? []).map((r) => ({ ...r })),
    audits: [],
  };
  let seq = 0;

  const notFound = () => Object.assign(new Error("Record not found"), { code: "P2025" });

  const db = {
    selfCheck: {
      create: async ({ data }: { data: Row }) => {
        const row = { ...SELF_CHECK_DEFAULTS(now()), ...data };
        state.selfChecks.push(row);
        return clone(row);
      },
      findUnique: async ({ where }: { where: Row }) =>
        clone(state.selfChecks.find((r) => matches(r, where)) ?? null),
      findFirst: async ({ where }: { where: Row }) =>
        clone(state.selfChecks.find((r) => matches(r, where)) ?? null),
      count: async ({ where }: { where: Row }) =>
        state.selfChecks.filter((r) => matches(r, where)).length,
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = state.selfChecks.find((r) => matches(r, where));
        if (!row) throw notFound();
        Object.assign(row, data, { updatedAt: data.updatedAt ?? now() });
        return clone(row);
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const rows = state.selfChecks.filter((r) => matches(r, where));
        for (const row of rows) Object.assign(row, data, { updatedAt: data.updatedAt ?? now() });
        return { count: rows.length };
      },
    },
    case: {
      count: async ({ where }: { where: Row }) => state.cases.filter((r) => matches(r, where)).length,
      create: async ({ data }: { data: Row }) => {
        seq += 1;
        const { subjects, ...rest } = data as Row & { subjects: { create: Row } };
        const subject = {
          id: `subject-${seq}`,
          nationality: null,
          country: null,
          ...subjects.create,
        };
        const row: Row = {
          id: `case-${seq}`,
          reviewedBy: null,
          reviewedAt: null,
          deletedAt: null,
          isFixture: false,
          createdAt: now(),
          updatedAt: now(),
          ...rest,
          subject,
        };
        state.cases.push(row);
        return { ...row, subjects: [subject] };
      },
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        state.audits.push({ ...data });
        return data;
      },
    },
    subjectPersonaCheck: {
      create: async ({ data }: { data: Row }) => {
        seq += 1;
        const row: Row = {
          id: `persona-${seq}`,
          requestJson: null,
          errorCode: null,
          searchedBy: null,
          searchedAt: now(),
          decision: null,
          selectedPersonaJson: null,
          decidedBy: null,
          decidedAt: null,
          ...data,
        };
        state.personaChecks.push(row);
        return clone(row);
      },
      findFirst: async ({ where }: { where: Row; orderBy?: unknown }) => {
        // Последняя по времени сборки; при равном времени — записанная позже.
        const rows = state.personaChecks
          .filter((r) => matches(r, where))
          .reverse()
          .sort(
            (a, b) => (b.searchedAt as Date).getTime() - (a.searchedAt as Date).getTime()
          );
        return clone(rows[0] ?? null);
      },
      findMany: async ({ where }: { where: Row }) =>
        state.personaChecks
          .filter((r) => matches(r, where))
          .map((r) => ({ subjectInputHash: r.subjectInputHash as string })),
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = state.personaChecks.find((r) => matches(r, where));
        if (!row) throw notFound();
        Object.assign(row, data);
        return clone(row);
      },
    },
    $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
      const saved: FakeState = {
        cases: state.cases.map(clone),
        selfChecks: state.selfChecks.map(clone),
        personaChecks: state.personaChecks.map(clone),
        audits: state.audits.map(clone),
      };
      try {
        return await fn(db);
      } catch (err) {
        state.cases = saved.cases;
        state.selfChecks = saved.selfChecks;
        state.personaChecks = saved.personaChecks;
        state.audits = saved.audits;
        throw err;
      }
    },
  };

  return { db, state };
}

/** Отказ, которого ждёт тест, — со статусом и машинной причиной. */
export async function refusal(promise: Promise<unknown>): Promise<{
  status: number;
  code: string;
  details?: { reason?: string; fieldErrors?: Record<string, string[]> };
}> {
  try {
    await promise;
  } catch (err) {
    return err as never;
  }
  throw new Error("ожидался отказ, а вызов прошёл");
}
