import { describe, it, expect } from "vitest";
import {
  runFactExtraction,
  materialsForTheme,
  isFactExtractionEnabled,
  FACT_EXTRACTION_MAX_MATERIALS,
} from "../../src/modules/digital-profile/orion-golden/gpt/run-fact-extraction";
import type { RawInventoryItem } from "../../src/modules/digital-profile/orion-golden/types";

/**
 * Шаг 05.2(в2) плана (docs/rework/05-claim-synthesis-and-gpt-input.md).
 *
 * Раннер обязан быть fail-open: тема, на которой извлечение сорвалось, просто
 * сохраняет прежний детерминированный текст. Потерять обогащённый текст
 * допустимо, потерять отчёт — нет.
 */

const SNIPPET =
  "Павел Дуров был задержан в аэропорту Ле-Бурже 24 августа 2024 года по решению следствия.";

function item(id: string, over: Partial<RawInventoryItem> = {}): RawInventoryItem {
  return {
    inventoryId: id,
    caseId: "case-1",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-07-20T00:00:00.000Z",
    evidenceType: "search_result",
    title: `Заголовок ${id}`,
    snippet: SNIPPET,
    sourceUrl: `https://news.example/${id}`,
    ...over,
  } as RawInventoryItem;
}

const ITEMS = [item("a"), item("b")];
const ITEMS_BY_REF = new Map(ITEMS.map((i) => [`inventory:${i.inventoryId}`, i]));

const CLAIMS_BUNDLE = {
  claims: [
    {
      claimId: "c1",
      evidenceRefs: ["inventory:a", "inventory:b"],
      themeIds: ["criminal_judicial"],
    },
  ],
} as never;

const REPRESENTATIVE = {
  selectedByTheme: { criminal_judicial: [{ claimId: "c1" }] },
} as never;

const base = {
  caseId: "case-1",
  datasetId: "ds-1",
  subjectName: "Павел Дуров",
  claimsBundle: CLAIMS_BUNDLE,
  representative: REPRESENTATIVE,
  itemsByRef: ITEMS_BY_REF,
};

describe("materialsForTheme", () => {
  it("собирает материалы за claim'ами темы и нумерует их e1..eN", () => {
    const materials = materialsForTheme({
      themeId: "criminal_judicial" as never,
      claimsBundle: CLAIMS_BUNDLE,
      representative: REPRESENTATIVE,
      itemsByRef: ITEMS_BY_REF,
    });
    expect(materials.map((m) => m.ref)).toEqual(["e1", "e2"]);
    expect(materials[0].evidenceRef).toBe("inventory:a");
    expect(materials[0].domain).toBe("news.example");
  });

  it("ограничивает число материалов на вызов", () => {
    const many = Array.from({ length: 30 }, (_, i) => item(`m${i}`));
    const materials = materialsForTheme({
      themeId: "criminal_judicial" as never,
      claimsBundle: {
        claims: [
          {
            claimId: "c1",
            evidenceRefs: many.map((m) => `inventory:${m.inventoryId}`),
            themeIds: ["criminal_judicial"],
          },
        ],
      } as never,
      representative: REPRESENTATIVE,
      itemsByRef: new Map(many.map((i) => [`inventory:${i.inventoryId}`, i])),
    });
    expect(materials).toHaveLength(FACT_EXTRACTION_MAX_MATERIALS);
  });
});

describe("атрибуция источника материала", () => {
  it("не выдаёт внутренний псевдо-URL за источник", () => {
    // Arsenkin AI-ответы и PAA не имеют публичного источника и несут
    // синтетический handle. Разбор его как URL давал хост «other», который
    // уезжал клиенту как название источника (15 из 35 фактов на первом
    // живом прогоне).
    const materials = materialsForTheme({
      themeId: "criminal_judicial" as never,
      claimsBundle: {
        claims: [
          { claimId: "c1", evidenceRefs: ["inventory:ai"], themeIds: ["criminal_judicial"] },
        ],
      } as never,
      representative: REPRESENTATIVE,
      itemsByRef: new Map([
        [
          "inventory:ai",
          item("ai", { sourceUrl: "arsenkin://other/obs-71a1698ccd5591ae" }),
        ],
      ]),
    });
    expect(materials).toHaveLength(1);
    expect(materials[0]).not.toHaveProperty("domain");
    expect(materials[0]).not.toHaveProperty("url");
  });

  it("сохраняет домен обычного http(s)-источника", () => {
    const materials = materialsForTheme({
      themeId: "criminal_judicial" as never,
      claimsBundle: {
        claims: [
          { claimId: "c1", evidenceRefs: ["inventory:web"], themeIds: ["criminal_judicial"] },
        ],
      } as never,
      representative: REPRESENTATIVE,
      itemsByRef: new Map([
        ["inventory:web", item("web", { sourceUrl: "https://www.Reuters.com/article/x" })],
      ]),
    });
    expect(materials[0].domain).toBe("reuters.com");
    expect(materials[0].url).toBe("https://www.Reuters.com/article/x");
  });
});

describe("runFactExtraction", () => {
  it("возвращает пустой артефакт, когда извлечение выключено", async () => {
    const artifact = await runFactExtraction({
      ...base,
      enabled: false,
      caller: async () => {
        throw new Error("не должен вызываться");
      },
    });
    expect(artifact.enabled).toBe(false);
    expect(artifact.factsByTheme).toEqual({});
    expect(artifact.diagnostics.themesProcessed).toBe(0);
  });

  it("принимает подтверждённые факты и считает диагностику", async () => {
    const artifact = await runFactExtraction({
      ...base,
      enabled: true,
      caller: async () => ({
        facts: [
          {
            statement: "Источник сообщает о задержании.",
            quote: "задержан в аэропорту Ле-Бурже 24 августа 2024 года",
            ref: "e1",
            status: "source_allegation",
          },
        ],
      }),
    });
    expect(artifact.factsByTheme["criminal_judicial"]).toHaveLength(1);
    expect(artifact.diagnostics.accepted).toBe(1);
    expect(artifact.diagnostics.rejected).toBe(0);
    expect(artifact.factsByTheme["criminal_judicial"][0].evidenceRef).toBe("inventory:a");
  });

  it("отбрасывает непроверяемые факты и фиксирует причину", async () => {
    const artifact = await runFactExtraction({
      ...base,
      enabled: true,
      caller: async () => ({
        facts: [
          {
            statement: "Выдумка.",
            quote: "этой фразы нет ни в одном материале дела",
            ref: "e1",
            status: "source_allegation",
          },
        ],
      }),
    });
    expect(artifact.factsByTheme).toEqual({});
    expect(artifact.diagnostics.rejected).toBe(1);
    expect(artifact.diagnostics.rejectedByReason["quote-not-in-material"]).toBe(1);
  });

  it("fail-open: падение вызова не роняет прогон, тема помечается", async () => {
    const artifact = await runFactExtraction({
      ...base,
      enabled: true,
      caller: async () => {
        throw new Error("openai-timeout");
      },
    });
    expect(artifact.factsByTheme).toEqual({});
    expect(artifact.diagnostics.failedThemes).toEqual(["criminal_judicial"]);
  });

  it("fail-open: ответ, не прошедший схему, тоже не роняет прогон", async () => {
    const artifact = await runFactExtraction({
      ...base,
      enabled: true,
      caller: async () => ({ нет: "такого поля" }),
    });
    expect(artifact.diagnostics.failedThemes).toEqual(["criminal_judicial"]);
  });
});

describe("перегруппировка фактов по их теме (шаг 06.2)", () => {
  it("кладёт факт в тему, которую выбрала модель, а не в запрошенную", async () => {
    const artifact = await runFactExtraction({
      ...base,
      enabled: true,
      caller: async () => ({
        facts: [
          {
            statement: "Факт о деловом профиле.",
            quote: "задержан в аэропорту Ле-Бурже 24 августа 2024 года",
            ref: "e1",
            status: "established_fact",
            theme: "business_ownership_associates",
          },
        ],
      }),
    });
    // Вызов был по теме criminal_judicial — факт ушёл в деловую.
    expect(artifact.factsByTheme["criminal_judicial"]).toBeUndefined();
    expect(artifact.factsByTheme["business_ownership_associates"]).toHaveLength(1);
    expect(artifact.diagnostics.reassignedByModel).toBe(1);
  });

  it("оставляет факт в запрошенной теме, когда модель тему не указала", async () => {
    const artifact = await runFactExtraction({
      ...base,
      enabled: true,
      caller: async () => ({
        facts: [
          {
            statement: "Факт без темы.",
            quote: "задержан в аэропорту Ле-Бурже 24 августа 2024 года",
            ref: "e1",
            status: "source_allegation",
          },
        ],
      }),
    });
    expect(artifact.factsByTheme["criminal_judicial"]).toHaveLength(1);
    expect(artifact.diagnostics.reassignedByModel).toBe(0);
  });

  it("игнорирует тему вне таксономии и оставляет факт в запрошенной", async () => {
    const artifact = await runFactExtraction({
      ...base,
      enabled: true,
      caller: async () => ({
        facts: [
          {
            statement: "Факт с выдуманной темой.",
            quote: "задержан в аэропорту Ле-Бурже 24 августа 2024 года",
            ref: "e1",
            status: "source_allegation",
            theme: "нет_такой_темы",
          },
        ],
      }),
    });
    expect(artifact.factsByTheme["criminal_judicial"]).toHaveLength(1);
    expect(artifact.diagnostics.reassignedByModel).toBe(0);
  });

  it("передаёт модели список допустимых тем", async () => {
    let seen: unknown = null;
    await runFactExtraction({
      ...base,
      enabled: true,
      caller: async ({ userPayload }) => {
        seen = (userPayload as { allowedThemes?: unknown }).allowedThemes;
        return { facts: [] };
      },
    });
    const themes = seen as Array<{ id: string; label: string }>;
    expect(Array.isArray(themes)).toBe(true);
    expect(themes.some((t) => t.id === "criminal_judicial" && t.label.length > 0)).toBe(true);
  });
});

describe("isFactExtractionEnabled", () => {
  it("выключается явным нулём", () => {
    expect(isFactExtractionEnabled({ ORION_GPT_FACTS: "0" } as never)).toBe(false);
  });

  it("включается явной единицей", () => {
    expect(isFactExtractionEnabled({ ORION_GPT_FACTS: "1" } as never)).toBe(true);
  });

  it("выключается в офлайн-режиме без явного флага", () => {
    expect(isFactExtractionEnabled({ NETWORK_CALLS: "0" } as never)).toBe(false);
  });
});
