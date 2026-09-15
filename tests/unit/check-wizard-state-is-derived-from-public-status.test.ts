import { describe, expect, it } from "vitest";
import {
  canLeaveLead,
  wizardScreen,
  wizardStep,
  type PublicStatusJson,
  type WizardInput,
  type WizardScreen,
} from "@/modules/site/check/wizard-state";

/**
 * Экран мастера выводится из проекции статуса, а не хранится в браузере.
 *
 * Посетитель закрывает вкладку посреди ожидания и возвращается по ссылке через
 * час: экран обязан быть тем, что говорит статус проверки, иначе после перезагрузки
 * он снова увидел бы «Кто из них вы?» при идущем прогоне. Локально живут только
 * шаги, которых в данных нет: открытая форма заявки и «спасибо».
 */

const BASE: PublicStatusJson = {
  publicId: "pUbL1c-iD-0123456789abcdef",
  status: "CREATED",
  createdAt: "2026-09-15T10:00:00.000Z",
  expiresAt: "2026-10-15T10:00:00.000Z",
  subject: { fullName: "Проверкин Тест Этапович", birthDate: "1985-03-12" },
  persona: { decided: false, cardsCount: 0 },
  run: null,
  result: null,
  lead: { submitted: false, at: null },
  blocked: null,
};

const RESULT = {
  verdict: "CLEAN",
  riskLevel: "low",
  materialsFound: 0,
  findingsTotal: 0,
  themes: [],
  partial: false,
  sourcesChecked: ["search", "surfaces", "open_sources", "sanctions"],
  checkedAt: "2026-09-15T10:05:00.000Z",
} as const;

const status = (over: Partial<PublicStatusJson>): PublicStatusJson => ({ ...BASE, ...over });
const input = (over: Partial<WizardInput>): WizardInput => ({
  status: null,
  refusal: null,
  panel: null,
  view: null,
  ...over,
});
const done = (verdict: string) =>
  status({ status: "DONE", result: { ...RESULT, sourcesChecked: [...RESULT.sourcesChecked], themes: [], verdict } });

describe("отказ ручки называет экран раньше статуса", () => {
  const cases: Array<[number, string | null, WizardScreen]> = [
    [503, "SELF_CHECK_DISABLED", "disabled"],
    [410, "SELF_CHECK_EXPIRED", "expired"],
    [403, "SELF_CHECK_FORBIDDEN", "no-cookie"],
    [404, null, "not-found"],
    [429, "RATE_LIMITED", "limit"],
    [0, "NETWORK_ERROR", "offline"],
    [500, null, "offline"],
  ];
  it.each(cases)("%i %s → %s", (code, reason, screen) => {
    expect(wizardScreen(input({ refusal: { status: code, reason } }))).toBe(screen);
  });

  it("устаревший статус не перебивает отказ: обезличенная запись — «срок истёк», а не ожидание", () => {
    expect(
      wizardScreen(input({ status: status({ status: "RUNNING" }), refusal: { status: 410, reason: "SELF_CHECK_EXPIRED" } }))
    ).toBe("expired");
  });

  it("503 без причины рубильника — не «временно недоступно»: рубильник включён, сломана настройка площадки", () => {
    expect(wizardScreen(input({ refusal: { status: 503, reason: "CAPTCHA_NOT_CONFIGURED" } }))).toBe("offline");
    expect(wizardScreen(input({ refusal: { status: 503, reason: "SELF_CHECK_SECRET_NOT_CONFIGURED" } }))).toBe(
      "offline"
    );
  });

  it("конфликт (второе нажатие) экрана не меняет — экран говорит статус", () => {
    expect(
      wizardScreen(input({ status: status({ status: "RUNNING" }), refusal: { status: 409, reason: "RUN_ALREADY_STARTED" } }))
    ).toBe("waiting");
  });
});

describe("экран по статусу проверки", () => {
  it("пока статуса нет — загрузка", () => {
    expect(wizardScreen(input({}))).toBe("loading");
  });

  it("панель ещё не собрана — сборка «Это вы?»", () => {
    expect(wizardScreen(input({ status: status({ status: "CREATED" }) }))).toBe("persona-loading");
    expect(wizardScreen(input({ status: status({ status: "PERSONA_PENDING" }) }))).toBe("persona-loading");
  });

  it("панель с карточками — «Кто из них вы?», без карточек — «Уточнять нечего»", () => {
    const pending = status({ status: "PERSONA_PENDING" });
    expect(wizardScreen(input({ status: pending, panel: { cards: [{}, {}] } }))).toBe("persona");
    expect(wizardScreen(input({ status: pending, panel: { cards: [] } }))).toBe("persona-empty");
  });

  it("решение записано, прогон не запущен — запуск", () => {
    expect(wizardScreen(input({ status: status({ status: "PERSONA_DECIDED" }) }))).toBe("start");
  });

  it("идёт прогон — ожидание", () => {
    expect(wizardScreen(input({ status: status({ status: "RUNNING" }) }))).toBe("waiting");
  });

  it("результат — по вердикту", () => {
    expect(wizardScreen(input({ status: done("NEGATIVE_FOUND") }))).toBe("result-negative");
    expect(wizardScreen(input({ status: done("CLEAN") }))).toBe("result-clean");
    expect(wizardScreen(input({ status: done("INSUFFICIENT_DATA") }))).toBe("result-insufficient");
  });

  it("DONE без результата — «данных недостаточно», а не «чисто»", () => {
    expect(wizardScreen(input({ status: status({ status: "DONE", result: null }) }))).toBe("result-insufficient");
  });

  it("упавший прогон, ловушка и обезличенная запись — свои экраны", () => {
    expect(wizardScreen(input({ status: status({ status: "FAILED" }) }))).toBe("failed");
    expect(wizardScreen(input({ status: status({ status: "BLOCKED" }) }))).toBe("blocked");
    expect(wizardScreen(input({ status: status({ status: "EXPIRED" }) }))).toBe("expired");
  });

  it("заявка и «спасибо» — там, где ручка заявку примет", () => {
    expect(wizardScreen(input({ status: done("NEGATIVE_FOUND"), view: "lead" }))).toBe("lead");
    expect(wizardScreen(input({ status: done("CLEAN"), view: "lead" }))).toBe("lead");
    expect(wizardScreen(input({ status: status({ status: "FAILED" }), view: "lead" }))).toBe("lead");
    expect(wizardScreen(input({ status: done("INSUFFICIENT_DATA"), view: "thanks" }))).toBe("thanks");
  });

  it("у идущего прогона и у записи ловушки формы заявки нет", () => {
    expect(wizardScreen(input({ status: status({ status: "RUNNING" }), view: "lead" }))).toBe("waiting");
    expect(wizardScreen(input({ status: status({ status: "BLOCKED" }), view: "lead" }))).toBe("blocked");
    expect(canLeaveLead(status({ status: "RUNNING" }))).toBe(false);
    expect(canLeaveLead(status({ status: "BLOCKED" }))).toBe(false);
    expect(canLeaveLead(done("CLEAN"))).toBe(true);
    expect(canLeaveLead(status({ status: "FAILED" }))).toBe(true);
  });
});

describe("шаг степпера", () => {
  it.each<[WizardScreen, number]>([
    ["persona-loading", 2],
    ["persona", 2],
    ["persona-empty", 2],
    ["start", 2],
    ["waiting", 3],
    ["failed", 3],
    ["result-negative", 4],
    ["result-clean", 4],
    ["result-insufficient", 4],
    ["lead", 4],
    ["thanks", 4],
    ["loading", 0],
    ["disabled", 0],
    ["limit", 0],
    ["expired", 0],
    ["no-cookie", 0],
    ["not-found", 0],
    ["offline", 0],
    ["blocked", 0],
  ])("%s → %i", (screen, step) => {
    expect(wizardStep(screen)).toBe(step);
  });
});
