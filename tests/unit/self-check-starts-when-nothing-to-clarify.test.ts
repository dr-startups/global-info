import { describe, expect, it, vi } from "vitest";
import type { SelfCheck } from "@prisma/client";
import { buildSelfCheckPersona } from "@/modules/self-check/service";
import type { PersonaCheckRow } from "@/modules/digital-profile/services/subject-persona-check";
import type { CaseSubjectInfo } from "@/modules/digital-profile/agents/mock/mock-utils";
import { wizardScreen } from "@/modules/site/check/wizard-state";
import { TEST_NOW, fakeDb, selfCheckRow, type FakeState } from "../support/self-check-fakes";

/**
 * Уточнять нечего — проверка запускается сама.
 *
 * Панель без карточек показывала экран «Уточнять нечего» с одной кнопкой: выбирать
 * на нём нечего, а нажатие — лишний шаг между формой и проверкой (предложение
 * владельца 24.09.2026). Решает сервер, который знает, что карточек нет: закрытая
 * вкладка проверку не останавливает, и второго ответа на «запускать ли» нет.
 * «Выбирать было не из чего» — данные: то же решение и ноль карточек панели.
 */

const subject: CaseSubjectInfo = {
  caseId: "case-1",
  fullName: "Иванов Иван Иванович",
  aliases: [],
  targetRegions: ["RU"],
  location: null,
  dateOfBirth: "1985-03-12",
  nationality: null,
  lawfulBasis: "LEGITIMATE_INTEREST",
  consentStatus: "OBTAINED",
  isFixture: false,
};

function panelWith(cards: unknown[]) {
  return {
    request: { terms: ["Иванов Иван Иванович"], languages: ["ru"], serperQueries: [], budgetMs: 20_000 },
    snapshot: {
      subjectFullName: "Иванов Иван Иванович",
      subjectDateOfBirth: "1985-03-12",
      cards,
      serpRows: [],
      sources: [
        { source: "wikipedia" as const, status: "TIMEOUT" as const, code: "PERSONA_PANEL_BUDGET_EXCEEDED" as const, detail: null, waitedMs: 20_000 },
      ],
      fetchStatus: "SUCCESS" as const,
      errorCode: null,
    },
  };
}

const CARD = {
  source: "wikipedia" as const,
  cardId: "wikipedia:ru:Иванов, Иван Иванович",
  title: "Иванов, Иван Иванович",
  lead: "российский предприниматель",
  leadRequested: true,
  snippet: "",
  articles: [{ language: "ru", title: "Иванов, Иван Иванович", url: "https://ru.wikipedia.org/wiki/Иванов", lead: null, snippet: "" }],
};

const ctx = { ip: "203.0.113.7" };

function deps(db: unknown, cards: unknown[], startRun: (...args: unknown[]) => Promise<{ unifiedJobId: string }>) {
  return {
    db: db as never,
    now: () => TEST_NOW,
    env: {} as NodeJS.ProcessEnv,
    loadSubject: async () => subject,
    buildPanel: (async () => panelWith(cards)) as never,
    startRun: startRun as never,
  };
}

const fresh = (state: FakeState): SelfCheck => ({ ...state.selfChecks[0] }) as unknown as SelfCheck;

describe("уточнять нечего — проверка запускается сама", () => {
  it("пустая панель: решение записано, прогон запущен один раз, аудит говорит, кто решил", async () => {
    const { db, state } = fakeDb({ selfChecks: [selfCheckRow()] });
    const startRun = vi.fn(async () => ({ unifiedJobId: "job-1" }));
    const out = await buildSelfCheckPersona(fresh(state), ctx, deps(db, [], startRun));
    expect(out.cards).toEqual([]);
    expect(state.personaChecks[0]).toMatchObject({ decision: "APPROVED_WITHOUT_PERSONA" });
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(state.selfChecks[0]).toMatchObject({ status: "RUNNING", jobId: "job-1" });
    expect(state.audits.find((a) => a.action === "SELF_CHECK_PERSONA_DECIDED")?.metadata).toMatchObject({
      decision: "APPROVED_WITHOUT_PERSONA",
      automatic: "NO_CANDIDATES",
    });
  });

  it("панель с карточкой: выбирает посетитель — решения и прогона нет", async () => {
    const { db, state } = fakeDb({ selfChecks: [selfCheckRow()] });
    const startRun = vi.fn(async () => ({ unifiedJobId: "job-1" }));
    await buildSelfCheckPersona(fresh(state), ctx, deps(db, [CARD], startRun));
    expect(state.personaChecks[0]?.decision ?? null).toBeNull();
    expect(startRun).not.toHaveBeenCalled();
    expect(state.selfChecks[0]!.status).toBe("PERSONA_PENDING");
  });

  it("запуск упал — панель отдана, запись ждёт запуска с кнопкой", async () => {
    const { db, state } = fakeDb({ selfChecks: [selfCheckRow()] });
    const startRun = vi.fn(async () => {
      throw new Error("orchestrator is down");
    });
    const out = await buildSelfCheckPersona(fresh(state), ctx, deps(db, [], startRun));
    expect(out.cards).toEqual([]);
    expect(state.personaChecks[0]).toMatchObject({ decision: "APPROVED_WITHOUT_PERSONA" });
    expect(state.selfChecks[0]!.status).toBe("PERSONA_DECIDED");
  });

  it("пустая панель, собранная раньше и без решения, — следующее обращение запускает проверку", async () => {
    const built = panelWith([]);
    const legacy: PersonaCheckRow = {
      id: "persona-legacy",
      caseId: "case-1",
      subjectInputHash: "hash",
      requestJson: built.request,
      personasJson: built.snapshot,
      fetchStatus: "SUCCESS",
      errorCode: null,
      searchedBy: "self-check:check-1",
      searchedAt: new Date("2026-09-14T11:00:00Z"),
      decision: null,
      selectedPersonaJson: null,
      decidedBy: null,
      decidedAt: null,
    };
    const { db, state } = fakeDb({
      selfChecks: [selfCheckRow({ status: "PERSONA_PENDING" })],
      personaChecks: [legacy],
    });
    const startRun = vi.fn(async () => ({ unifiedJobId: "job-2" }));
    const buildPanel = vi.fn();
    await buildSelfCheckPersona(fresh(state), ctx, { ...deps(db, [], startRun), buildPanel: buildPanel as never });
    expect(buildPanel).not.toHaveBeenCalled();
    expect(state.personaChecks[0]).toMatchObject({ decision: "APPROVED_WITHOUT_PERSONA" });
    expect(startRun).toHaveBeenCalledTimes(1);
    expect(state.selfChecks[0]!.status).toBe("RUNNING");
  });
});

describe("мастер не показывает «Уточнять нечего»", () => {
  it("PERSONA_PENDING с пустой панелью — ещё поиск, пока статус не скажет «идёт проверка»", () => {
    const screen = wizardScreen({
      status: { status: "PERSONA_PENDING" } as never,
      refusal: null,
      panel: { cards: [] },
      view: null,
    });
    expect(screen).toBe("persona-loading");
  });
});
