/**
 * Ответ поискового ИИ печатается текстом, а не разметкой.
 *
 * Нейро-ответ Яндекса приходит размеченным Markdown, и на живом прогоне 20.08
 * (кейс Прохоров, страница «Россия — AI-ответы») это доехало до бумаги: буллет
 * со звёздочками `**Михаил Дмитриевич Прохоров**`, соседний буллет, начинающийся
 * со сноски «[2]», и строки со звёздочкой-маркером списка. Владелец прочитал
 * страницу как «в целом каша».
 *
 * Разметка снимается на печати; сырое наблюдение остаётся дословным —
 * прослеживаемость до первоисточника важнее.
 */

import { describe, expect, it } from "vitest";
import { plainAiAnswerText } from "@/modules/digital-profile/orion-golden/client/ai-answer-text";
import { buildKnowledgeAiFragment } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/knowledge-ai";
import { buildKnowledgePanelSvg } from "@/modules/digital-profile/orion-golden/assets/media-asset-svg";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

/** Начало ответа ровно в том виде, в каком его отдал API на прогоне 20.08. */
const LIVE_ANSWER = [
  "**Михаил Дмитриевич Прохоров** (род. 3 мая 1965, Москва) — **российский и израильский предприниматель, миллиардер и политик**. [1][4] ",
  "",
  "**Некоторые факты из биографии:**",
  "",
  "* В 1989 году окончил факультет международных экономических отношений Московского финансового института. [2]",
  "* На старших курсах института в 1987 году открыл кооператив «Регина», занимавшийся изготовлением джинсов. [2][3]",
  "* В 1993 году вместе с Владимиром Потаниным основал Объединённый экспортно-импортный банк (Онэксим-банк). [2]",
].join("\n");

describe("разметка ответа поискового ИИ", () => {
  it("снимается со всего ответа, а слова остаются", () => {
    const text = plainAiAnswerText(LIVE_ANSWER);
    expect(text).not.toMatch(/\*/u);
    expect(text).not.toMatch(/\[\d+\]/u);
    expect(text).toContain("Михаил Дмитриевич Прохоров");
    expect(text).toContain("миллиардер и политик");
    expect(text).toContain("Онэксим-банк");
    expect(text).toContain("кооператив «Регина»");
  });

  it("пункт списка становится законченным предложением", () => {
    // Без точки следующий пункт приклеивается к предыдущему, и разбивка по
    // предложениям снова разъезжается — ровно то, из-за чего буллет начинался
    // со сноски.
    const text = plainAiAnswerText("* Первый пункт без точки\n* Второй пункт без точки");
    expect(text).toBe("Первый пункт без точки. Второй пункт без точки.");
  });

  it("заголовок с двоеточием точку не получает", () => {
    expect(plainAiAnswerText("**Некоторые факты:**\n* Пункт.")).toBe(
      "Некоторые факты: Пункт."
    );
  });

  it("обычный текст без разметки не меняется", () => {
    const plain = "Прохоров Михаил Дмитриевич — предприниматель. Основал Онэксим-банк.";
    expect(plainAiAnswerText(plain)).toBe(plain);
  });

  it("пустое не роняет", () => {
    expect(plainAiAnswerText("")).toBe("");
    expect(plainAiAnswerText(undefined)).toBe("");
  });
});

describe("страница AI-ответов", () => {
  /** Фрагмент страницы «Россия — AI-ответы» на одном наблюдении-ответе. */
  function aiBullets(snippet: string): string[] {
    const scoped = {
      subject: { displayName: "Прохоров Михаил Дмитриевич", aliases: [] },
      findings: [],
      surfaceUnits: [
        {
          surface: "ai_answers",
          region: "RU",
          metrics: [],
          claims: [],
          evidenceRefs: ["ai-1"],
        },
      ],
      metricSnapshot: {
        metricSnapshotId: "m",
        datasetId: "d",
        reportRunId: "r",
        baseCount: 1,
        enrichmentCount: 0,
        compositeCount: 1,
        subjectMatchCount: 1,
        likelySubjectCount: 0,
        ambiguousCount: 0,
        otherSubjectCount: 0,
        adverseFindingCount: 0,
        perRegionCounts: { RU: 1 },
      },
      scope: { regions: ["RU"], surfaces: ["ai_answers"], subjectMatch: null, findingIds: null },
      evidenceIndex: {
        "ai-1": {
          kind: "ai_answer",
          url: "yandex-gen://answer/2d4ba31c9d1a",
          title: "Нейро-ответ Яндекса (официальный API): Прохоров Михали Дмитриевич",
          snippet,
          engine: "YANDEX",
          provider: "yandex",
          query: "Прохоров Михали Дмитриевич",
          subjectDecision: "SUBJECT_MATCH",
        },
      },
    } as unknown as ScopedFragmentInput;
    const out = buildKnowledgeAiFragment(
      "RU_KNOWLEDGE_AI" as never,
      "RU_REGION" as never,
      "Россия",
      scoped,
      {} as never
    );
    return out.slides.flatMap((s) => s.content.bullets ?? []);
  }

  it("буллет не начинается со сноски и не несёт звёздочек", () => {
    const bullets = aiBullets(LIVE_ANSWER);
    expect(bullets.length).toBeGreaterThan(0);
    for (const b of bullets) {
      expect(b).not.toMatch(/^\s*\[\d+\]/u);
      expect(b).not.toMatch(/\*/u);
    }
    expect(bullets.join(" ")).toContain("миллиардер и политик");
  });
});

describe("панель ответа на картинке", () => {
  it("рисует абзац, а не одну обрезанную строку", () => {
    const svg = buildKnowledgePanelSvg({
      title: "Россия — ответ поискового ИИ",
      summary: plainAiAnswerText(LIVE_ANSWER),
      facts: ["Источник: Рувики", "Источник: ТАСС"],
    });
    const lines = [...svg.matchAll(/font-size="14"/gu)].length;
    expect(lines).toBeGreaterThan(1);
    // Обрыв многоточием на первой же строке — ровно то, что видел владелец.
    expect(svg).toContain("миллиардер и политик");
  });

  it("без фактов сводке достаётся больше строк", () => {
    // Ответ прогона укладывается в четыре строки и до потолка не доходит —
    // свойство видно только на тексте, который упирается в оба потолка.
    const summary = plainAiAnswerText(
      Array.from({ length: 24 }, (_, i) => `* Пункт номер ${i + 1} с достаточно длинным текстом, чтобы занять целую строку панели`).join("\n")
    );
    const withFacts = buildKnowledgePanelSvg({ title: "T", summary, facts: ["a", "b"] });
    const without = buildKnowledgePanelSvg({ title: "T", summary, facts: [] });
    const count = (svg: string) => [...svg.matchAll(/font-size="14"/gu)].length;
    expect(count(without)).toBeGreaterThan(count(withFacts));
  });
});
