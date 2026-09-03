/**
 * Режим сбора выдачи — один переключатель и одно разрешение.
 *
 * Владелец решил 02.09.2026: выдача, AI-ответы, подсказки и частота собираются
 * через Topvisor, старый путь не вырезается, а выключается значением. Отсюда
 * два правила, которые здесь и закреплены.
 *
 * **Один вопрос — один ответ.** «Откуда берётся выдача» отвечает
 * `serpCollectionMode()`, и все ветвления спрашивают только его. Пока ответов
 * было два — флаг у провайдера и состав агентов, — источник переключался
 * наполовину, и половина прогона шла старым путём молча.
 *
 * **Разрешение — ключ, а не флаг.** Режим `topvisor` без `TOPVISOR_API_KEY` и
 * `TOPVISOR_USER_ID` обязан назвать недостающую переменную и **не откатываться**
 * на старый путь: тихий откат — это второй ответ на тот же вопрос, и увидеть
 * его в отчёте нельзя.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { serpCollectionMode, topvisorAvailability } from "@/modules/digital-profile/providers/config";
import { describeCapabilityReadiness } from "@/modules/digital-profile/config/env-validation";
import { resolveRuntimeStrategy } from "@/modules/digital-profile/agents/runtime-strategy";
import { arsenkinTools } from "@/modules/digital-profile/providers/arsenkin/flags";
import { collectYandexGenAnswer } from "@/modules/digital-profile/services/yandex-gen-answer-collection";
import { assessRealCollection } from "@/modules/digital-profile/services/base-collection-manifest";
import type { ActualProviderRecord } from "@/modules/digital-profile/services/unified-collection-types";

const KEYS = { TOPVISOR_API_KEY: "k", TOPVISOR_USER_ID: "1" };

afterEach(() => {
  vi.unstubAllEnvs();
});

function useMode(mode: "topvisor" | "legacy", extra: Record<string, string> = {}): void {
  vi.stubEnv("SERP_COLLECTION_PROVIDER", mode);
  for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
}

describe("режим сбора выдачи", () => {
  it("по умолчанию — прежний путь", () => {
    // Значение по умолчанию описывает работающий продукт: пока сбор через
    // Topvisor собран не целиком, умолчанием остаётся `legacy`.
    vi.stubEnv("SERP_COLLECTION_PROVIDER", "");
    expect(serpCollectionMode()).toBe("legacy");
  });

  it("читается одним значением", () => {
    useMode("topvisor");
    expect(serpCollectionMode()).toBe("topvisor");
  });

  it("непонятое значение не выключает источник молча", () => {
    // Опечатка в настройке не должна означать «собираем ничем».
    vi.stubEnv("SERP_COLLECTION_PROVIDER", "topvizor");
    expect(serpCollectionMode()).toBe("legacy");
  });
});

describe("разрешение Topvisor — ключ", () => {
  it("без ключа режим объявляет себя ненастроенным и называет переменные", () => {
    useMode("topvisor");
    vi.stubEnv("TOPVISOR_API_KEY", "");
    vi.stubEnv("TOPVISOR_USER_ID", "");

    const availability = topvisorAvailability();

    expect(availability.status).toBe("NOT_CONFIGURED");
    expect(availability.message).toContain("TOPVISOR_API_KEY");
    expect(availability.message).toContain("TOPVISOR_USER_ID");
    // Список недостающих — данные, а не формулировка: строка готовности
    // собирает свою деталь из него, а не разбирает сообщение.
    expect(availability.missing).toEqual(["TOPVISOR_API_KEY", "TOPVISOR_USER_ID"]);
  });

  it("одного ключа мало: нужен и идентификатор аккаунта", () => {
    useMode("topvisor", { TOPVISOR_API_KEY: "k" });
    vi.stubEnv("TOPVISOR_USER_ID", "");

    const availability = topvisorAvailability();

    expect(availability.status).toBe("NOT_CONFIGURED");
    expect(availability.message).toContain("TOPVISOR_USER_ID");
    expect(availability.message).not.toContain("TOPVISOR_API_KEY");
  });

  it("с обоими секретами источник готов", () => {
    useMode("topvisor", KEYS);
    expect(topvisorAvailability().status).toBe("ENABLED");
  });

  it("в прежнем режиме Topvisor выключен, а не «не настроен»", () => {
    // Разница видна оператору: «выключен» — так решили, «не настроен» — забыли ключ.
    useMode("legacy", KEYS);
    expect(topvisorAvailability().status).toBe("DISABLED");
  });

  it("на старте контейнер называет недостающую переменную", () => {
    const lines = describeCapabilityReadiness({
      SERP_COLLECTION_PROVIDER: "topvisor",
      TOPVISOR_API_KEY: "k",
    });
    const topvisor = lines.find((l) => /Topvisor/i.test(l.capability));

    expect(topvisor).toBeDefined();
    expect(topvisor!.ready).toBe(false);
    expect(topvisor!.detail).toContain("TOPVISOR_USER_ID");
  });
});

describe("состав сборщиков в режиме topvisor", () => {
  it("базовые агенты выдачи не выбираются, а причина названа", () => {
    /*
     * Судится решение стратегии, а не список выбранных шагов: попадёт ли
     * провайдер в `steps`, зависит ещё и от наличия его ключей, а здесь
     * проверяется ровно одно — что режим его не звал и сказал почему.
     */
    useMode("topvisor", KEYS);
    const strategy = resolveRuntimeStrategy({ mode: "real_only", requestedBy: "test" });

    expect(strategy.steps.map((s) => s.providerId)).not.toContain("yandex");
    expect(strategy.steps.map((s) => s.providerId)).not.toContain("google");

    for (const providerId of ["yandex", "google"]) {
      const decision = strategy.decisions.find((d) => d.providerId === providerId);
      expect(decision?.status).toBe("skipped_by_mode");
      expect(String(decision?.reason)).toMatch(/Topvisor/i);
    }
    // Профиль ORION и поверхности Topvisor не заменяет — их решения прежние.
    const orion = strategy.decisions.find((d) => d.providerId === "orion_profile");
    expect(String(orion?.reason ?? "")).not.toMatch(/Topvisor/i);
  });

  it("в прежнем режиме режим никого не выключает", () => {
    useMode("legacy", KEYS);
    const strategy = resolveRuntimeStrategy({ mode: "real_only", requestedBy: "test" });

    for (const providerId of ["yandex", "google"]) {
      const decision = strategy.decisions.find((d) => d.providerId === providerId);
      expect(String(decision?.reason ?? "")).not.toMatch(/Topvisor/i);
    }
  });

  it("выключенный режимом провайдер не считается упавшим", () => {
    /*
     * `assessRealCollection` судит честность сбора. Провайдер, которого не
     * звали по решению, — не отказ источника: иначе прогон в режиме Topvisor
     * объявлял бы себя неполным на ровном месте.
     */
    const providers: ActualProviderRecord[] = [
      { providerId: "yandex", runtime: "none", status: "skipped", reason: "collected by Topvisor" },
      { providerId: "google", runtime: "none", status: "skipped", reason: "collected by Topvisor" },
      { providerId: "orion_profile", runtime: "real", status: "completed" },
    ];

    const assessment = assessRealCollection(providers);

    expect(assessment.failedProviders).toEqual([]);
    expect(assessment.mockProviders).toEqual([]);
    expect(assessment.sufficient).toBe(true);
  });

  it("Arsenkin остаётся только ради «люди также спрашивают»", () => {
    // Позиции и подсказки собирает Topvisor; два источника одного и того же
    // означали бы два ответа на один вопрос — и двойную оплату.
    useMode("topvisor", KEYS);
    expect(arsenkinTools()).toEqual(["paa"]);
  });

  it("в прежнем режиме состав Arsenkin не меняется", () => {
    useMode("legacy", KEYS);
    expect(arsenkinTools()).toEqual(["check-top", "suggest", "paa"]);
  });
});

describe("нейро-ответ Яндекса в режиме topvisor", () => {
  it("не спрашивается, и это записано исходом, а не молчанием", async () => {
    useMode("topvisor", KEYS);
    const fetchAnswer = vi.fn();

    const probe = await collectYandexGenAnswer({
      caseId: "case-1",
      loadSubject: async () => ({ caseId: "case-1", fullName: "Кремлёв Умар Назарович", aliases: [] }) as never,
      fetchAnswer: fetchAnswer as never,
      saveRows: async () => 0,
    });

    expect(probe.status).toBe("SKIPPED_DELEGATED");
    expect(probe.message).toMatch(/Topvisor/i);
    expect(fetchAnswer).not.toHaveBeenCalled();
  });

  it("в прежнем режиме спрашивается как раньше", async () => {
    useMode("legacy", KEYS);
    const fetchAnswer = vi.fn(async () => ({ status: "NO_RESULTS" }) as never);

    const probe = await collectYandexGenAnswer({
      caseId: "case-1",
      loadSubject: async () => ({ caseId: "case-1", fullName: "Кремлёв Умар Назарович", aliases: [] }) as never,
      fetchAnswer: fetchAnswer as never,
      saveRows: async () => 0,
    });

    expect(fetchAnswer).toHaveBeenCalledTimes(1);
    expect(probe.status).not.toBe("SKIPPED_DELEGATED");
  });
});

describe("покрытие нейро-ответа в режиме topvisor", () => {
  it("«не спрашивали» не записывается как «спросили — пусто»", async () => {
    /*
     * `NO_RESULTS` в ячейке покрытия значит «вопрос задан, ответ получен».
     * Делегированный ответ вопросом не был — ячейка обязана назвать источник,
     * а не измеренную пустоту.
     */
    const { genAnswerCoverageCells } = await import(
      "@/modules/digital-profile/services/base-collection-manifest"
    );

    const cells = genAnswerCoverageCells({
      yandexGenAnswerProbe: {
        status: "SKIPPED_DELEGATED",
        query: null,
        errorCode: null,
        message: "Генеративный ответ собирает Topvisor.",
        attemptedAt: "2026-09-03T00:00:00.000Z",
      },
    });

    expect(cells).toHaveLength(1);
    expect(cells[0]!.status).toBe("NOT_COLLECTED");
    expect(cells[0]!.errorCode).toBe("DELEGATED_TO_TOPVISOR");
  });
});

describe("базовый сбор в режиме topvisor", () => {
  it("органику не собирает и говорит об этом словом, а не «не настроено»", async () => {
    /*
     * Статус региона читает страница покрытия. «NOT_CONFIGURED» о делегированном
     * сборе — неправда: ключи на месте, просто выдачу собирает другой источник.
     */
    useMode("topvisor", KEYS);
    const { runRegionOrganic } = await import(
      "@/modules/digital-profile/services/orion-search-profile-service"
    );

    const summary = await runRegionOrganic(
      "case-1",
      { caseId: "case-1", fullName: "Кремлёв Умар Назарович", aliases: [] } as never,
      [
        {
          query: "кремлёв умар назарович",
          queryId: "q1",
          queryPlanId: "p1",
          purpose: "subject_lookup",
          providerPreference: ["yandex", "google"],
          language: "ru",
        } as never,
      ],
      "RU"
    );

    expect(summary.organic).toBe(0);
    expect(summary.yandexStatus).toBe("DELEGATED");
    expect(summary.googleStatus).toBe("DELEGATED");
  });

  it("статус региона — DELEGATED, а не «собрано» и не «не запрашивался»", async () => {
    /*
     * Слово «делегировано» обязано дойти до статуса региона, который читает
     * страница покрытия. Поверхности Serper в режиме `topvisor` собираются
     * по-прежнему и перетирают `googleStatus` в COLLECTED — статус региона
     * при нуле строк выдачи от этого «собранным» не становится.
     */
    const { deriveCollectionStatus } = await import(
      "@/modules/digital-profile/services/orion-search-profile-service"
    );

    const withSurfaces = deriveCollectionStatus(0, 5, "COLLECTED", "DELEGATED", "RU");
    expect(withSurfaces.status).toBe("DELEGATED");

    const withoutSurfaces = deriveCollectionStatus(0, 0, "DELEGATED", "DELEGATED", "RU");
    expect(withoutSurfaces.status).toBe("DELEGATED");

    // Регион без Яндекса делегирован ровно так же.
    const uae = deriveCollectionStatus(0, 3, "COLLECTED", "DELEGATED", "UAE");
    expect(uae.status).toBe("DELEGATED");
  });

  it("подсказки Serper в отчёт не идут: источник подсказок один", async () => {
    // Решение владельца 03.09.2026: двух параллельных источников подсказок быть
    // не может. Остальные поверхности Serper Topvisor не заменяет.
    const { surfaceItemAllowedInMode } = await import(
      "@/modules/digital-profile/services/orion-search-profile-service"
    );
    const item = (kind: string) => ({ kind }) as never;

    expect(surfaceItemAllowedInMode(item("autocomplete"), "topvisor")).toBe(false);
    expect(surfaceItemAllowedInMode(item("images"), "topvisor")).toBe(true);
    expect(surfaceItemAllowedInMode(item("knowledgePanel"), "topvisor")).toBe(true);
    expect(surfaceItemAllowedInMode(item("autocomplete"), "legacy")).toBe(true);
  });
});
