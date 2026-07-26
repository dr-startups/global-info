import { describe, expect, it } from "vitest";
import {
  runUnifiedComplianceScreening,
  screeningOutcome,
  screeningWarning,
} from "../../src/modules/digital-profile/services/unified-compliance-screening";

/**
 * Шаг 04.3: проверка по санкционным базам стала частью платного прогона.
 *
 * Главный инвариант — различать «проверен, записей нет» и «проверка не
 * выполнялась». Первое сообщает банку содержательный факт, второе — что вопрос
 * остался открытым. Смешать их значит сказать, что человек проверен, когда он
 * не проверен.
 */

describe("итог проверки", () => {
  it("ответ провайдера без совпадений — это результат, а не пустота", () => {
    expect(screeningOutcome({ status: "SUCCESS", provider: "OPEN_SANCTIONS", hits: [] })).toEqual({
      kind: "clean",
      provider: "OPEN_SANCTIONS",
    });
  });

  it("совпадения считаются", () => {
    expect(
      screeningOutcome({ status: "SUCCESS", provider: "OPEN_SANCTIONS", hits: [{}, {}] })
    ).toEqual({ kind: "hits", provider: "OPEN_SANCTIONS", count: 2 });
  });

  it("любой не-SUCCESS означает «не проверялся»", () => {
    for (const status of ["DISABLED", "NOT_CONFIGURED", "PROVIDER_ERROR", "FAILED"]) {
      const out = screeningOutcome({ status, provider: "OPEN_SANCTIONS", hits: [] });
      expect(out.kind, status).toBe("not_performed");
    }
  });

  it("причина берётся из ответа провайдера", () => {
    const out = screeningOutcome({
      status: "PROVIDER_ERROR",
      provider: "OPEN_SANCTIONS",
      hits: [],
      error: { code: "PROVIDER_RATE_LIMITED", message: "Provider rate limited (HTTP 429)." },
    });
    expect(out).toMatchObject({ kind: "not_performed", reason: "Provider rate limited (HTTP 429)." });
  });

  it("без сообщения причиной становится код, затем статус", () => {
    expect(
      screeningOutcome({
        status: "PROVIDER_ERROR",
        provider: "OPEN_SANCTIONS",
        hits: [],
        error: { code: "PROVIDER_NOT_CONFIGURED", message: "  " },
      })
    ).toMatchObject({ reason: "PROVIDER_NOT_CONFIGURED" });
    expect(
      screeningOutcome({ status: "DISABLED", provider: "OPEN_SANCTIONS", hits: [] })
    ).toMatchObject({ reason: "DISABLED" });
  });
});

describe("предупреждения прогона", () => {
  it("чистый результат прогон не засоряет", () => {
    expect(screeningWarning({ kind: "clean", provider: "OPEN_SANCTIONS" })).toBeNull();
  });

  it("невыполненная проверка называет причину", () => {
    expect(
      screeningWarning({ kind: "not_performed", provider: "OPEN_SANCTIONS", reason: "HTTP 429" })
    ).toBe("compliance-screening-skipped:OPEN_SANCTIONS:HTTP 429");
  });

  it("совпадения выводятся как задача на сверку", () => {
    expect(screeningWarning({ kind: "hits", provider: "OPEN_SANCTIONS", count: 3 })).toBe(
      "compliance-hits-pending-review:OPEN_SANCTIONS:3"
    );
  });
});

describe("сбой источника прогон не роняет", () => {
  it("исключение превращается в «не проверялся»", async () => {
    // Цена ошибки здесь — прерванный оплаченный сбор; ценность раздела ниже.
    const out = await runUnifiedComplianceScreening({
      caseId: "case-1",
      screen: async () => {
        throw new Error("getaddrinfo ENOTFOUND api.opensanctions.org");
      },
    });
    expect(out).toMatchObject({ kind: "not_performed", provider: "OPEN_SANCTIONS" });
    expect(out.kind === "not_performed" && out.reason).toMatch(/ENOTFOUND/);
  });

  it("успешная проверка доходит до итога", async () => {
    const out = await runUnifiedComplianceScreening({
      caseId: "case-1",
      screen: async () => ({ status: "SUCCESS", provider: "OPEN_SANCTIONS", hits: [{}] }),
    });
    expect(out).toEqual({ kind: "hits", provider: "OPEN_SANCTIONS", count: 1 });
  });
});
