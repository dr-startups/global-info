/**
 * Дата рождения и гражданство кейса доезжают до запроса в OpenSanctions.
 *
 * На живом прогоне 25.08 в теле `/match` уходило только имя со списком алиасов
 * и страна: `runComplianceScreening` подставлял `dateOfBirth: null` литералом, а
 * загрузчик субъекта эти поля даже не выбирал из базы. Оператор дату вводит,
 * схема её хранит, карточка её показывает — и до единственного места, где она
 * работает штрафом за расхождение и отсеяла бы чужого человека, она не
 * доезжала. По документации провайдера дата наказывает запись только при
 * расхождении и не трогает записи, где даты нет вовсе, — то есть настоящее
 * санкционное совпадение от неё не исчезает.
 */

import { describe, expect, it, vi } from "vitest";
import type { ComplianceScreeningRequest } from "@/modules/digital-profile/compliance-providers/types";

const db = vi.hoisted(() => {
  // Идентификатор объявлен внутри: `vi.hoisted` выполняется раньше модульных
  // констант, и ссылка на внешнюю падала бы до первой проверки.
  const caseId = "case-compliance-birthdate";

  /**
   * Заглушка исполняет `select` по-настоящему.
   *
   * Иначе тест не увидел бы главного дефекта: поле, которое загрузчик не
   * выбрал из базы, отсутствует в строке, а не приезжает само.
   */
  const applySelect = (row: Record<string, unknown>, select?: Record<string, unknown>): unknown => {
    if (!select) return row;
    const out: Record<string, unknown> = {};
    for (const [key, spec] of Object.entries(select)) {
      const value = row[key];
      if (spec === true) {
        out[key] = value;
        continue;
      }
      const nested = (spec as { select?: Record<string, unknown> })?.select;
      if (!nested) continue;
      out[key] = Array.isArray(value)
        ? value.map((v) => applySelect(v as Record<string, unknown>, nested))
        : applySelect(value as Record<string, unknown>, nested);
    }
    return out;
  };

  const caseRow: Record<string, unknown> = {
    id: caseId,
    targetRegions: ["RU"],
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
    subjects: [
      {
        fullName: "Умар Назарович Кремлев",
        aliases: ["Umar Kremlev"],
        country: "Россия",
        nationality: "Россия",
        dateOfBirth: new Date("1982-11-01T00:00:00.000Z"),
      },
    ],
  };

  return {
    caseId,
    client: {
      case: {
        findFirst: async (args: { select?: Record<string, unknown> }) =>
          applySelect(caseRow, args?.select),
      },
      complianceScreeningRun: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "run-1", ...data }),
      },
      auditLog: { create: async () => ({}) },
      databaseProfile: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: "hit-1", ...data }),
        update: async () => ({}),
        findFirst: async () => null,
      },
      riskFinding: {
        findFirst: async () => null,
        findUnique: async () => null,
        create: async () => ({ id: "finding-1" }),
        update: async () => ({}),
      },
    },
  };
});

vi.mock("@/server/prisma/client", () => ({ prisma: db.client }));

const CASE_ID = db.caseId;

const http = vi.hoisted(() => ({
  calls: [] as Array<{ url: string; body: unknown }>,
  payload: { responses: { subject: { results: [] } } } as unknown,
}));

vi.mock("@/modules/digital-profile/providers/http", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  postJson: async (url: string, body: unknown) => {
    http.calls.push({ url, body });
    return http.payload;
  },
}));

const { loadCaseSubject } = await import("@/modules/digital-profile/agents/mock/mock-utils");
const { runComplianceScreening } = await import(
  "@/modules/digital-profile/compliance-providers/service"
);
const { openSanctionsProvider } = await import(
  "@/modules/digital-profile/compliance-providers/open-sanctions-provider"
);

/** Свойства единственного запроса тела `/match` — то, что реально ушло в сеть. */
function sentProperties(): Record<string, string[]> {
  const body = http.calls.at(-1)?.body as {
    queries: Record<string, { properties: Record<string, string[]> }>;
  };
  return body.queries.subject!.properties;
}

async function screenWithCapturedRequest(): Promise<ComplianceScreeningRequest> {
  const captured: ComplianceScreeningRequest[] = [];
  const spy = vi
    .spyOn(openSanctionsProvider, "screenPerson")
    .mockImplementation(async (request: ComplianceScreeningRequest) => {
      captured.push(request);
      return { status: "SUCCESS" as const, provider: "OPEN_SANCTIONS" as const, hits: [] };
    });
  try {
    await runComplianceScreening(CASE_ID, "OPEN_SANCTIONS");
  } finally {
    spy.mockRestore();
  }
  const request = captured[0];
  if (!request) throw new Error("провайдер не был вызван");
  return request;
}

describe("субъект кейса доезжает до провайдера целиком", () => {
  it("загрузчик субъекта выбирает дату рождения и гражданство", async () => {
    const subject = await loadCaseSubject(CASE_ID);
    expect(subject.dateOfBirth).toBe("1982-11-01");
    expect(subject.nationality).toBe("Россия");
  });

  it("проверка по санкционным базам получает дату рождения, а не литеральный null", async () => {
    const request = await screenWithCapturedRequest();
    expect(request.dateOfBirth).toBe("1982-11-01");
    expect(request.nationality).toBe("Россия");
    expect(request.country).toBe("Россия");
  });
});

describe("тело запроса /match", () => {
  it("несёт дату рождения, когда она в кейсе есть", async () => {
    http.calls.length = 0;
    const result = await openSanctionsProvider.screenPerson({
      caseId: CASE_ID,
      subjectFullName: "Умар Назарович Кремлев",
      aliases: ["Umar Kremlev"],
      dateOfBirth: "1982-11-01",
      country: "Россия",
      nationality: "Россия",
    });
    expect(result.status).toBe("SUCCESS");
    expect(sentProperties().birthDate).toEqual(["1982-11-01"]);
  });

  it("без даты поля нет вовсе, но проверка состоится", async () => {
    http.calls.length = 0;
    const result = await openSanctionsProvider.screenPerson({
      caseId: CASE_ID,
      subjectFullName: "Умар Назарович Кремлев",
      dateOfBirth: null,
      country: "Россия",
    });
    expect(result.status).toBe("SUCCESS");
    expect(http.calls).toHaveLength(1);
    expect("birthDate" in sentProperties()).toBe(false);
  });

  it("посланное тело доезжает до сохранённого совпадения", async () => {
    // Цепочка целиком: то, что ушло в сеть, лежит рядом с ответом. Разбор
    // отдельно от запроса проверить нельзя — вопрос «что мы спросили» имеет
    // смысл только рядом с тем, что провайдер на это ответил.
    http.calls.length = 0;
    http.payload = {
      responses: {
        subject: {
          results: [
            {
              id: "ru-inn-504309044808",
              caption: "КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН",
              score: 1,
              properties: { name: ["КУЛЕБАКИН КИРИЛЛ СЕРГЕЕВИЧ"] },
            },
          ],
        },
      },
    };
    const result = await openSanctionsProvider.screenPerson({
      caseId: CASE_ID,
      subjectFullName: "Умар Назарович Кремлев",
      dateOfBirth: "1982-11-01",
      country: "Россия",
    });
    http.payload = { responses: { subject: { results: [] } } };
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.rawMetadataSafe.query).toEqual(sentProperties());
    expect(result.hits[0]!.rawMetadataSafe.query).toEqual({
      name: ["Умар Назарович Кремлев"],
      birthDate: ["1982-11-01"],
      country: ["россия"],
    });
  });

  it("страна и гражданство складываются в country без дублей и в нижнем регистре", async () => {
    http.calls.length = 0;
    await openSanctionsProvider.screenPerson({
      caseId: CASE_ID,
      subjectFullName: "Умар Назарович Кремлев",
      country: "Россия",
      nationality: "Россия",
    });
    expect(sentProperties().country).toEqual(["россия"]);

    http.calls.length = 0;
    await openSanctionsProvider.screenPerson({
      caseId: CASE_ID,
      subjectFullName: "Умар Назарович Кремлев",
      country: "Россия",
      nationality: "ОАЭ",
    });
    expect(sentProperties().country).toEqual(["россия", "оаэ"]);
  });
});
