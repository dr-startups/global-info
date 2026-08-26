import { describe, expect, it } from "vitest";
import { captureBaseCollectionManifest } from "@/modules/digital-profile/services/base-collection-manifest";
import { collectYandexGenAnswer } from "@/modules/digital-profile/services/yandex-gen-answer-collection";

/**
 * Шаг AO. Отказ одного источника не обнуляет оплаченную работу: проба
 * нейро-ответа не роняет базовый сбор — её исход остаётся записью в манифесте.
 */

const prisma = {
  searchResult: { findMany: async () => [{ id: "sr-1" }] },
  searchSurfaceItem: { findMany: async () => [{ id: "ss-1" }] },
} as never;

async function manifest(probe?: unknown) {
  return captureBaseCollectionManifest({
    prisma,
    caseId: "case-gen",
    unifiedJobId: "unified-gen-1",
    beforeSearchResultIds: new Set<string>(),
    beforeSearchSurfaceItemIds: new Set<string>(),
    actualProviders: [],
    baseReportRunId: "run-1",
    ...(probe === undefined ? {} : { yandexGenAnswerProbe: probe as never }),
  });
}

describe("исход пробы нейро-ответа живёт в манифесте базового сбора", () => {
  it("записывается вместе с кодом причины", async () => {
    const m = await manifest({
      status: "FAILED",
      query: "Мордашов Алексей Александрович",
      errorCode: "PROVIDER_TIMEOUT",
      message: "Provider request timed out.",
      attemptedAt: "2026-08-20T00:00:00.000Z",
    });
    expect(m.yandexGenAnswerProbe).toMatchObject({
      status: "FAILED",
      errorCode: "PROVIDER_TIMEOUT",
    });
  });

  it("прогон без пробы поля не заводит — история не переписывается", async () => {
    const m = await manifest();
    expect(JSON.parse(JSON.stringify(m))).not.toHaveProperty("yandexGenAnswerProbe");
  });
});

describe("падение провайдера сбор не роняет", () => {
  it("исключение внутри вызова становится исходом FAILED, а неброском наружу", async () => {
    const probe = await collectYandexGenAnswer({
      caseId: "case-gen",
      loadSubject: async () => ({
        caseId: "case-gen",
        fullName: "Мордашов Алексей Александрович",
        aliases: [],
        targetRegions: ["RU"],
        location: null,
        dateOfBirth: null,
        nationality: null,
        lawfulBasis: null,
        consentStatus: null,
      }),
      fetchAnswer: async () => {
        throw new Error("соединение оборвано");
      },
      saveRows: async () => 0,
    });
    expect(probe.status).toBe("FAILED");
    expect(probe.errorCode).toBe("PROVIDER_REQUEST_FAILED");
  });
});
