/**
 * Платный сбор не начинается, пока не названо, чем субъект отличается от тёзок.
 *
 * Прогон DPA-2026-0049: панель показала пять чужих карточек, оператор ответил
 * «различимой персоны нет», и ворота открылись — решение о персоне для сбора
 * ничего не значило. Отчёт собрал четырёх разных людей, и клиент получил
 * материалы, которых не заказывал.
 *
 * Ворота теперь спрашивают не «нажата ли кнопка», а «есть ли признак, по
 * которому материал можно отличить от материала тёзки». Дата рождения кейса
 * этим признаком считается — её оператор вводит всегда.
 */

import { describe, expect, it } from "vitest";
import {
  personaGateState,
  recordPersonaDecision,
  type PersonaCheckPrisma,
  type PersonaCheckRow,
} from "@/modules/digital-profile/services/subject-persona-check";
import type { SubjectAnchors } from "@/modules/digital-profile/orion-golden/analytics/subject-anchors";

const ANCHORS: SubjectAnchors = {
  birthDate: "1977-11-30",
  phrases: [{ kind: "employer", text: "Арбитражный суд Краснодарского края", strong: true }],
  inn: [],
  domains: [],
};

function store(row: Partial<PersonaCheckRow> = {}): {
  prisma: PersonaCheckPrisma;
  updates: Array<Record<string, unknown>>;
} {
  const base: PersonaCheckRow = {
    id: "check-1",
    caseId: "case-1",
    subjectInputHash: "hash-1",
    requestJson: {},
    personasJson: { cards: [], serpRows: [] },
    fetchStatus: "SUCCESS",
    errorCode: null,
    searchedBy: null,
    searchedAt: "2026-09-04T00:00:00.000Z",
    decision: null,
    selectedPersonaJson: null,
    decidedBy: null,
    decidedAt: null,
    ...row,
  };
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    prisma: {
      subjectPersonaCheck: {
        create: async () => base,
        findFirst: async () => base,
        findMany: async () => [],
        update: async ({ data }) => {
          updates.push(data);
          return { ...base, ...(data as Partial<PersonaCheckRow>) };
        },
      },
    },
  };
}

describe("решение «признаки названы»", () => {
  it("без единого сильного якоря не записывается", async () => {
    const { prisma } = store();
    await expect(
      recordPersonaDecision({
        caseId: "case-1",
        checkId: "check-1",
        decision: "ANCHORS_CONFIRMED",
        anchors: { birthDate: null, phrases: [], inn: [], domains: [] },
        deps: { prisma },
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("слабого якоря одного недостаточно", async () => {
    const { prisma } = store();
    await expect(
      recordPersonaDecision({
        caseId: "case-1",
        checkId: "check-1",
        decision: "ANCHORS_CONFIRMED",
        anchors: {
          birthDate: null,
          phrases: [{ kind: "fact", text: "судья", strong: false }],
          inn: [],
          domains: [],
        },
        deps: { prisma },
      })
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("записывает якоря и итог пробы — их печатает лист «Кого проверяли»", async () => {
    const { prisma, updates } = store();
    await recordPersonaDecision({
      caseId: "case-1",
      checkId: "check-1",
      decision: "ANCHORS_CONFIRMED",
      anchors: ANCHORS,
      deps: { prisma },
    });
    const selected = updates[0]?.selectedPersonaJson as {
      source: string;
      anchors: SubjectAnchors;
      probe: { hits: unknown[]; conflicts: unknown[]; missing: string[] };
    };
    expect(updates[0]?.decision).toBe("ANCHORS_CONFIRMED");
    expect(selected.source).toBe("anchors");
    expect(selected.anchors.phrases[0]?.text).toBe("Арбитражный суд Краснодарского края");
    expect(selected.probe).toBeTruthy();
  });
});

describe("ворота", () => {
  const base = { isFixture: false, subjectInputHash: "hash-1", decidedHashes: ["hash-1"] };

  it("без признака закрыты, даже когда решение записано", () => {
    expect(personaGateState({ ...base, hasSubjectAnchor: false })).toEqual({
      mode: "PENDING",
      reason: "SUBJECT_ANCHORS_MISSING",
    });
  });

  it("с признаком и решением открыты", () => {
    expect(personaGateState({ ...base, hasSubjectAnchor: true }).mode).toBe("CONFIRMED");
  });

  it("фикстура проходит без признака — офлайн-контур не заводит субъектов", () => {
    expect(personaGateState({ ...base, isFixture: true, hasSubjectAnchor: false }).mode).toBe(
      "FIXTURE_BYPASS"
    );
  });

  it("признак есть, решения нет — прежняя причина", () => {
    expect(
      personaGateState({ ...base, decidedHashes: [], hasSubjectAnchor: true })
    ).toEqual({ mode: "PENDING", reason: "PERSONA_NOT_CONFIRMED" });
  });
});
