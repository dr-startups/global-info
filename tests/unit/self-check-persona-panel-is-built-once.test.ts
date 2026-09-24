import { describe, expect, it, vi } from "vitest";
import type { SelfCheck } from "@prisma/client";
import { buildSelfCheckPersona, decideSelfCheckPersona } from "@/modules/self-check/service";
import {
  loadPersonaGateInput,
  personaGateState,
  subjectInputHash,
} from "@/modules/digital-profile/services/subject-persona-check";
import type { CaseSubjectInfo } from "@/modules/digital-profile/agents/mock/mock-utils";
import { TEST_NOW, fakeDb, refusal, selfCheckRow, type FakeState } from "../support/self-check-fakes";

/**
 * Панель персоны посетителя собирается один раз и решается один раз.
 *
 * Панель стоит денег (Serper и OpenSanctions при ключах), а ручку дёргает
 * браузер посетителя — двойной клик или скрипт, повторяющий запрос, не должны
 * оплачивать её дважды. Поэтому сборку захватывает статус записи одним
 * условным обновлением, а не проверка «панели ещё нет», между которой и
 * сборкой успевает прийти второй запрос.
 *
 * Решение посетителя пишется тем же сервисом, что решение оператора, и
 * открывает те же ворота оркестратора: второго ответа на вопрос «можно ли
 * собирать» нет.
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

const CARD_ID = "wikipedia:ru:Иванов, Иван Иванович";

const panel = {
  request: { terms: ["Иванов Иван Иванович"], languages: ["ru"], serperQueries: [], budgetMs: 20_000 },
  snapshot: {
    subjectFullName: "Иванов Иван Иванович",
    subjectDateOfBirth: "1985-03-12",
    cards: [
      {
        source: "wikipedia" as const,
        cardId: CARD_ID,
        title: "Иванов, Иван Иванович",
        lead: "российский предприниматель",
        leadRequested: true,
        snippet: "",
        articles: [
          { language: "ru", title: "Иванов, Иван Иванович", url: "https://ru.wikipedia.org/wiki/Иванов", lead: null, snippet: "" },
        ],
      },
    ],
    serpRows: [],
    sources: [{ source: "wikipedia" as const, status: "SUCCESS" as const, code: null, detail: null, waitedMs: null }],
    fetchStatus: "SUCCESS" as const,
    errorCode: null,
  },
};

const ctx = { ip: "203.0.113.7" };

function deps(db: unknown, buildPanel: (...args: unknown[]) => unknown) {
  return {
    db: db as never,
    now: () => TEST_NOW,
    env: {} as NodeJS.ProcessEnv,
    loadSubject: async () => subject,
    buildPanel: buildPanel as never,
  };
}

const fresh = (state: FakeState): SelfCheck => ({ ...state.selfChecks[0] }) as unknown as SelfCheck;

describe("сборка панели", () => {
  it("собирает панель по субъекту кейса, пишет её от имени проверки и переводит статус", async () => {
    const { db, state } = fakeDb({ selfChecks: [selfCheckRow()] });
    const buildPanel = vi.fn(async (_input: unknown) => panel);
    const out = await buildSelfCheckPersona(fresh(state), ctx, deps(db, buildPanel));
    expect(buildPanel).toHaveBeenCalledTimes(1);
    expect(buildPanel.mock.calls[0]![0]).toMatchObject({
      subject: { caseId: "case-1", fullName: "Иванов Иван Иванович", aliases: [], dateOfBirth: "1985-03-12" },
    });
    expect(state.personaChecks).toHaveLength(1);
    expect(state.personaChecks[0]).toMatchObject({
      caseId: "case-1",
      searchedBy: "self-check:check-1",
      subjectInputHash: subjectInputHash(subject),
    });
    expect(state.selfChecks[0]!.status).toBe("PERSONA_PENDING");
    expect(state.audits.find((a) => a.action === "SELF_CHECK_PERSONA_BUILT")).toMatchObject({
      caseId: "case-1",
      actorId: "self-check:check-1",
      ipAddress: "203.0.113.7",
    });
    expect(out.cards).toHaveLength(1);
    expect(out.cards[0]!.cardId).toBe(CARD_ID);
  });

  it("повторный вызов отдаёт ту же панель и заново не платит", async () => {
    const { db, state } = fakeDb({ selfChecks: [selfCheckRow()] });
    const buildPanel = vi.fn(async () => panel);
    const initial = fresh(state);
    const first = await buildSelfCheckPersona(initial, ctx, deps(db, buildPanel));
    const second = await buildSelfCheckPersona(initial, ctx, deps(db, buildPanel));
    const third = await buildSelfCheckPersona(fresh(state), ctx, deps(db, buildPanel));
    expect(buildPanel).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(state.personaChecks).toHaveLength(1);
  });

  it("вызов во время сборки — 409 PERSONA_BUILD_IN_PROGRESS, второй сборки нет", async () => {
    const { db, state } = fakeDb({ selfChecks: [selfCheckRow()] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const buildPanel = vi.fn(async () => {
      await gate;
      return panel;
    });
    const initial = fresh(state);
    const running = buildSelfCheckPersona(initial, ctx, deps(db, buildPanel));
    await vi.waitFor(() => expect(buildPanel).toHaveBeenCalledTimes(1));
    const err = await refusal(buildSelfCheckPersona(initial, ctx, deps(db, buildPanel)));
    expect(err).toMatchObject({ status: 409, code: "CONFLICT", details: { reason: "PERSONA_BUILD_IN_PROGRESS" } });
    release();
    await running;
    expect(buildPanel).toHaveBeenCalledTimes(1);
  });

  it("захват, брошенный умершим процессом, перехватывается через минуту", async () => {
    const stale = selfCheckRow({ status: "PERSONA_PENDING", updatedAt: new Date(TEST_NOW.getTime() - 2 * 60_000) });
    const { db, state } = fakeDb({ selfChecks: [stale] });
    const buildPanel = vi.fn(async () => panel);
    await buildSelfCheckPersona(fresh(state), ctx, deps(db, buildPanel));
    expect(buildPanel).toHaveBeenCalledTimes(1);
    expect(state.personaChecks).toHaveLength(1);
  });

  it("свежий захват без панели — 409, сборка не начинается", async () => {
    const busy = selfCheckRow({ status: "PERSONA_PENDING", updatedAt: new Date(TEST_NOW.getTime() - 10_000) });
    const { db, state } = fakeDb({ selfChecks: [busy] });
    const buildPanel = vi.fn(async () => panel);
    const err = await refusal(buildSelfCheckPersona(fresh(state), ctx, deps(db, buildPanel)));
    expect(err).toMatchObject({ status: 409, details: { reason: "PERSONA_BUILD_IN_PROGRESS" } });
    expect(buildPanel).not.toHaveBeenCalled();
  });

  it("сборка упала — статус возвращается к CREATED, и повтор собирает", async () => {
    const { db, state } = fakeDb({ selfChecks: [selfCheckRow()] });
    const buildPanel = vi
      .fn()
      .mockRejectedValueOnce(new Error("database is down"))
      .mockResolvedValueOnce(panel);
    await expect(buildSelfCheckPersona(fresh(state), ctx, deps(db, buildPanel))).rejects.toThrow(/database/u);
    expect(state.selfChecks[0]!.status).toBe("CREATED");
    await buildSelfCheckPersona(fresh(state), ctx, deps(db, buildPanel));
    expect(state.personaChecks).toHaveLength(1);
  });

  it.each(["PERSONA_DECIDED", "RUNNING", "DONE"])(
    "в статусе %s панель не пересобирается — 409 PERSONA_ALREADY_DECIDED",
    async (status) => {
      const { db, state } = fakeDb({ selfChecks: [selfCheckRow({ status })] });
      const buildPanel = vi.fn(async () => panel);
      const err = await refusal(buildSelfCheckPersona(fresh(state), ctx, deps(db, buildPanel)));
      expect(err).toMatchObject({ status: 409, details: { reason: "PERSONA_ALREADY_DECIDED" } });
      expect(buildPanel).not.toHaveBeenCalled();
    }
  );
});

describe("решение посетителя", () => {
  async function built() {
    const { db, state } = fakeDb({ selfChecks: [selfCheckRow()] });
    const d = deps(db, vi.fn(async () => panel));
    await buildSelfCheckPersona(fresh(state), ctx, d);
    return { db, state, d };
  }

  it("«Это я» пишет решение от имени проверки и переводит статус", async () => {
    const { state, d } = await built();
    const out = await decideSelfCheckPersona(
      fresh(state),
      { decision: "PERSONA_SELECTED", selectedCardId: CARD_ID },
      ctx,
      d
    );
    expect(out).toEqual({ decision: "PERSONA_SELECTED", decidedAt: TEST_NOW });
    expect(state.personaChecks[0]).toMatchObject({ decision: "PERSONA_SELECTED", decidedBy: "self-check:check-1" });
    expect(state.selfChecks[0]!.status).toBe("PERSONA_DECIDED");
    expect(state.audits.find((a) => a.action === "SELF_CHECK_PERSONA_DECIDED")).toMatchObject({
      caseId: "case-1",
      actorId: "self-check:check-1",
      ipAddress: "203.0.113.7",
      metadata: { decision: "PERSONA_SELECTED", selectedCardIds: [CARD_ID] },
    });
  });

  it("«Среди них меня нет» — решение без карточки", async () => {
    const { state, d } = await built();
    await decideSelfCheckPersona(fresh(state), { decision: "APPROVED_WITHOUT_PERSONA" }, ctx, d);
    expect(state.personaChecks[0]).toMatchObject({ decision: "APPROVED_WITHOUT_PERSONA", selectedPersonaJson: null });
  });

  it("решение сайта открывает те же ворота, что проверяет оркестратор", async () => {
    const { db, state, d } = await built();
    await decideSelfCheckPersona(fresh(state), { decision: "APPROVED_WITHOUT_PERSONA" }, ctx, d);
    const gate = personaGateState(
      await loadPersonaGateInput("case-1", { prisma: db as never, loadSubject: async () => subject })
    );
    expect(gate.mode).toBe("CONFIRMED");
  });

  it("до сборки панели решать не о чем — 409 PERSONA_PANEL_NOT_BUILT", async () => {
    const { db, state } = fakeDb({ selfChecks: [selfCheckRow()] });
    const err = await refusal(
      decideSelfCheckPersona(fresh(state), { decision: "APPROVED_WITHOUT_PERSONA" }, ctx, deps(db, vi.fn()))
    );
    expect(err).toMatchObject({ status: 409, details: { reason: "PERSONA_PANEL_NOT_BUILT" } });
  });

  it("то же решение повторно — без ошибки; другое — 409 PERSONA_DECISION_ALREADY_RECORDED", async () => {
    const { state, d } = await built();
    await decideSelfCheckPersona(fresh(state), { decision: "APPROVED_WITHOUT_PERSONA" }, ctx, d);
    await expect(
      decideSelfCheckPersona(fresh(state), { decision: "APPROVED_WITHOUT_PERSONA" }, ctx, d)
    ).resolves.toMatchObject({ decision: "APPROVED_WITHOUT_PERSONA" });
    const err = await refusal(
      decideSelfCheckPersona(fresh(state), { decision: "PERSONA_SELECTED", selectedCardId: CARD_ID }, ctx, d)
    );
    expect(err).toMatchObject({ status: 409, details: { reason: "PERSONA_DECISION_ALREADY_RECORDED" } });
  });

  it("карточка не из этой панели — 400", async () => {
    const { state, d } = await built();
    const err = await refusal(
      decideSelfCheckPersona(fresh(state), { decision: "PERSONA_SELECTED", selectedCardId: "wikipedia:ru:Чужой" }, ctx, d)
    );
    expect(err).toMatchObject({ status: 400 });
    expect(state.selfChecks[0]!.status).toBe("PERSONA_PENDING");
  });

  it.each([
    ["нет решения", {}],
    ["неизвестное решение", { decision: "ANCHORS_CONFIRMED" }],
    ["«Это я» без карточки", { decision: "PERSONA_SELECTED" }],
  ])("%s — 400 VALIDATION_ERROR", async (_l, body) => {
    const { state, d } = await built();
    const err = await refusal(decideSelfCheckPersona(fresh(state), body, ctx, d));
    expect(err).toMatchObject({ status: 400, code: "VALIDATION_ERROR" });
  });
});
