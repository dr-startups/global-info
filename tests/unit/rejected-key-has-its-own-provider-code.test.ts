/**
 * «Ключ не принят» и «источник ответил мусором» — разные исходы.
 *
 * Живой прогон 91: OpenSanctions ответил `401 Invalid API key`, отображение
 * статуса давало `PROVIDER_BAD_RESPONSE`, и клиенту на странице комплаенса
 * печаталось «источник не ответил в этом прогоне». Источник ответил, и ответил
 * понятно. До клиента доезжает **код**, а не сообщение, поэтому различить два
 * исхода можно только кодом.
 *
 * Повтор ни на одном из них не назначается: ключ повтором не чинится.
 */

import { describe, expect, it, vi } from "vitest";
import { mapStatusToProviderError } from "@/modules/digital-profile/providers/http";

/**
 * Отказ строится **классом того самого экземпляра модуля**, который видит
 * проверяемый код: после `vi.resetModules` в памяти живут два экземпляра
 * `providers/http`, и `err instanceof ProviderHttpError` из другого экземпляра
 * тихо ложен — исход тогда становится общим `PROVIDER_REQUEST_FAILED`, и
 * проверка краснела бы на устройстве теста, а не на поведении.
 */
type HttpModule = typeof import("@/modules/digital-profile/providers/http");

describe("код отказа называет причину отказа", () => {
  it("401 — отвергнутый ключ, и причина провайдера сохранена", () => {
    const err = mapStatusToProviderError(401, '{"message":"Invalid API key"}');
    expect(err?.code).toBe("PROVIDER_UNAUTHORIZED");
    expect(err?.retryable).toBe(false);
    expect(err?.message).toContain("Invalid API key");
  });

  it("403 — тот же исход: доступ не разрешён", () => {
    const err = mapStatusToProviderError(403, null);
    expect(err?.code).toBe("PROVIDER_UNAUTHORIZED");
    expect(err?.retryable).toBe(false);
  });

  it("частота и отказ сервера остаются собой", () => {
    // Соседние ветки не двигались: 429 повторяем, 5xx повторяем, прочий 4xx нет.
    expect(mapStatusToProviderError(429, null)?.code).toBe("PROVIDER_RATE_LIMITED");
    expect(mapStatusToProviderError(429, null)?.retryable).toBe(true);
    expect(mapStatusToProviderError(500, null)?.code).toBe("PROVIDER_BAD_RESPONSE");
    expect(mapStatusToProviderError(500, null)?.retryable).toBe(true);
    expect(mapStatusToProviderError(400, null)?.code).toBe("PROVIDER_BAD_RESPONSE");
    expect(mapStatusToProviderError(400, null)?.retryable).toBe(false);
    expect(mapStatusToProviderError(200, null)).toBeNull();
  });
});

describe("код доезжает до исхода проверки комплаенса", () => {
  it("401 облака становится PROVIDER_UNAUTHORIZED в результате скрининга", async () => {
    vi.resetModules();
    vi.doMock("@/modules/digital-profile/providers/http", async (importOriginal) => {
      const original = await importOriginal<HttpModule>();
      return {
        ...original,
        postJson: async () => {
          throw original.mapStatusToProviderError(401, '{"message":"Invalid API key"}');
        },
      };
    });
    process.env.OPEN_SANCTIONS_API_KEY = "os-key-rejected";
    try {
      const { openSanctionsProvider } = await import(
        "@/modules/digital-profile/compliance-providers/open-sanctions-provider"
      );
      const result = await openSanctionsProvider.screenPerson({
        caseId: "case-unauthorized",
        subjectFullName: "Умар Назарович Кремлев",
      });
      expect(result.status).toBe("PROVIDER_ERROR");
      expect(result.error?.code).toBe("PROVIDER_UNAUTHORIZED");
      expect(result.error?.retryable).toBe(false);
    } finally {
      delete process.env.OPEN_SANCTIONS_API_KEY;
      vi.doUnmock("@/modules/digital-profile/providers/http");
      vi.resetModules();
    }
  });
});

describe("читатели кода отвергнутого ключа перечислены", () => {
  it("Serper по-прежнему называет свою переменную, а не общий отказ", async () => {
    // Новый код в общем перечислении молча уводит в другую ветку всякого, кто
    // сверялся со старым: здесь этим читателем был `serperFailure`, и вместе с
    // веткой пропадало единственное место, где названа переменная ключа.
    vi.resetModules();
    vi.doMock("@/modules/digital-profile/providers/http", async (importOriginal) => {
      const original = await importOriginal<HttpModule>();
      return {
        ...original,
        postJson: async () => {
          throw original.mapStatusToProviderError(401, '{"message":"Invalid API key"}');
        },
      };
    });
    try {
      const { serperSearch } = await import(
        "@/modules/digital-profile/providers/serper-search-provider"
      );
      const run = await serperSearch({
        caseId: "case-serper-key",
        query: "Сергей Глинка",
        region: "RU",
        limit: 10,
      } as unknown as Parameters<typeof serperSearch>[0]);
      expect(run.status).toBe("FAILED");
      expect(run.error?.code).toBe("PROVIDER_UNAUTHORIZED");
      expect(run.error?.message).toContain("GOOGLE_EXTERNAL_SERP_API_KEY");
    } finally {
      vi.doUnmock("@/modules/digital-profile/providers/http");
      vi.resetModules();
    }
  });
});
