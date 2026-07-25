import { describe, expect, it } from "vitest";
import {
  assessRealCollection,
  isRealCollectionSufficient,
} from "../../src/modules/digital-profile/services/base-collection-manifest";
import {
  fullAuditBlockReason,
  isJobWorking,
  paidRecollectionRequired,
} from "../../src/modules/digital-profile/services/unified-action-policy";
import {
  extractProviderReason,
  mapStatusToProviderError,
  providerHttpMessage,
} from "../../src/modules/digital-profile/providers/http";
import type { ActualProviderRecord } from "../../src/modules/digital-profile/services/unified-collection-types";

/**
 * Шаг 13, этап 1 (docs/rework/13-regression-run-findings.md).
 *
 * Три находки живого прогона: отказ одного провайдера обнулял весь платный
 * сбор; сообщение об отказе называло причину, которой не было; кнопка
 * повторного платного сбора предлагалась во время работы.
 */

function provider(over: Partial<ActualProviderRecord>): ActualProviderRecord {
  return {
    providerId: "yandex",
    agentName: "REAL_YANDEX_SEARCH",
    runtime: "real",
    status: "completed",
    reason: "ok",
    ...over,
  } as ActualProviderRecord;
}

describe("оценка базового сбора: честность отдельно от полноты", () => {
  it("живой сбор без подмен полон и достаточен", () => {
    const a = assessRealCollection([
      provider({ providerId: "yandex" }),
      provider({ providerId: "google", agentName: "REAL_GOOGLE_SEARCH" }),
    ]);
    expect(a).toMatchObject({ sufficient: true, complete: true, failedProviders: [] });
  });

  it("отказ одного провайдера делает сбор неполным, но не бесчестным", () => {
    // Ровно случай живого прогона: у Serper кончились кредиты, Яндекс отработал.
    // Раньше это давало FAILED_TERMINAL и выбрасывало 20 минут оплаченной работы.
    const a = assessRealCollection([
      provider({ providerId: "yandex" }),
      provider({ providerId: "google", agentName: "REAL_GOOGLE_SEARCH", status: "failed" }),
    ]);
    expect(a.sufficient).toBe(true);
    expect(a.complete).toBe(false);
    expect(a.failedProviders).toEqual(["google"]);
  });

  it("подмена демо-данными остаётся запретом", () => {
    const a = assessRealCollection([
      provider({ providerId: "yandex" }),
      provider({ providerId: "google", agentName: "MOCK_GOOGLE", runtime: "mock" }),
    ]);
    expect(a.sufficient).toBe(false);
    expect(a.mockProviders).toEqual(["google"]);
    expect(isRealCollectionSufficient([provider({ providerId: "google", runtime: "mock" })])).toBe(false);
  });

  it("без единого настоящего источника показывать нечего", () => {
    expect(
      assessRealCollection([provider({ providerId: "yandex", status: "failed" })]).sufficient
    ).toBe(false);
    expect(assessRealCollection([]).sufficient).toBe(false);
  });

  it("пропущенный и недоступный провайдер не считаются отказом", () => {
    const a = assessRealCollection([
      provider({ providerId: "yandex" }),
      provider({ providerId: "google", status: "skipped" }),
      provider({ providerId: "orion_profile", status: "unavailable" }),
    ]);
    expect(a).toMatchObject({ sufficient: true, complete: true, failedProviders: [] });
  });
});

describe("причина отказа провайдера доходит до оператора", () => {
  it("достаёт сообщение из тела ответа", () => {
    // Serper на исчерпанном ключе: {"message":"Not enough credits"}.
    expect(extractProviderReason('{"message":"Not enough credits","statusCode":400}')).toBe(
      "Not enough credits"
    );
  });

  it("понимает вложенную форму error.message", () => {
    expect(extractProviderReason('{"error":{"message":"quota exceeded"}}')).toBe("quota exceeded");
  });

  it("принимает простой текст, но не страницу HTML", () => {
    expect(extractProviderReason("service unavailable")).toBe("service unavailable");
    expect(extractProviderReason("<html><body>502</body></html>")).toBeNull();
    expect(extractProviderReason("   ")).toBeNull();
  });

  it("обрезает длинную причину, не роняя сообщение", () => {
    const reason = extractProviderReason(JSON.stringify({ message: "x".repeat(500) }));
    expect(reason!.length).toBeLessThanOrEqual(160);
    expect(reason!.endsWith("…")).toBe(true);
  });

  it("сообщение называет причину, когда она есть", () => {
    expect(providerHttpMessage(400, '{"message":"Not enough credits"}')).toBe(
      "Provider returned HTTP 400: Not enough credits"
    );
    expect(providerHttpMessage(400, "")).toBe("Provider returned HTTP 400.");
  });

  it("причина попадает и в типизированную ошибку", () => {
    const err = mapStatusToProviderError(400, '{"message":"Not enough credits"}');
    expect(err!.message).toContain("Not enough credits");
    expect(err!.retryable).toBe(false);

    const unauthorized = mapStatusToProviderError(401, '{"message":"bad key"}');
    expect(unauthorized!.message).toContain("bad key");
  });

  it("успешный статус ошибкой не считается", () => {
    expect(mapStatusToProviderError(200, "{}")).toBeNull();
  });
});

describe("действия не предлагаются во время работы", () => {
  const base = {
    preserved: true,
    recoveryAllowed: false,
    recoveryBlockerReason: null as string | null,
    suggestionsMissingResult: false,
  };

  it("исполняющаяся стадия считается работой", () => {
    // Живой прогон: стадия ARSENKIN_ENRICHMENT в статусе RUNNING давала
    // блокер JOB_ALREADY_RUNNING, который прежний гейт работой не считал —
    // и предлагал выбросить оплаченный сбор.
    expect(isJobWorking("JOB_ALREADY_RUNNING")).toBe(true);
    expect(isJobWorking("JOB_PROGRESSING")).toBe(true);
    expect(isJobWorking("ACTIVE_LEASE")).toBe(true);
  });

  it("застой работой не считается", () => {
    expect(isJobWorking("JOB_ALREADY_COMPLETED")).toBe(false);
    expect(isJobWorking(null)).toBe(false);
    expect(isJobWorking("")).toBe(false);
  });

  it("во время работы платный пересбор не предлагается", () => {
    for (const reason of ["JOB_ALREADY_RUNNING", "JOB_PROGRESSING", "ACTIVE_LEASE"]) {
      expect(paidRecollectionRequired({ ...base, recoveryBlockerReason: reason })).toBe(false);
    }
  });

  it("на застрявшем прогоне с сохранёнными стадиями — предлагается", () => {
    expect(paidRecollectionRequired({ ...base, recoveryBlockerReason: null })).toBe(true);
  });

  it("пока можно продолжить, платить заново не предлагают", () => {
    expect(paidRecollectionRequired({ ...base, recoveryAllowed: true })).toBe(false);
  });

  it("без сохранённых стадий предлагать нечего", () => {
    expect(paidRecollectionRequired({ ...base, preserved: false })).toBe(false);
  });

  it("причина блокировки главного действия называет работу, а не оплату", () => {
    expect(fullAuditBlockReason({ ...base, recoveryBlockerReason: "JOB_ALREADY_RUNNING" })).toBe(
      "JOB_ACTIVE"
    );
    expect(fullAuditBlockReason({ ...base, recoveryBlockerReason: null })).toBe(
      "PRESERVED_STAGES_REQUIRE_PAID_RECOLLECTION"
    );
    expect(fullAuditBlockReason({ ...base, recoveryAllowed: true })).toBe("USE_RECOVERY");
    expect(fullAuditBlockReason({ ...base, suggestionsMissingResult: true })).toBe(
      "USE_SUGGESTIONS_TARGETED_RETRY"
    );
  });
});
