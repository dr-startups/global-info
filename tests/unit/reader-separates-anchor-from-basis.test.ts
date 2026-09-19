/**
 * Чтение ссылок отделяет фрагмент принадлежности от оснований вывода (шаг 0118).
 *
 * Промпт v3 правилом 1a просил процитировать фрагмент с признаком субъекта
 * рядом с именем — и он вставал первой из трёх цитат, вытесняя основания
 * тональности и темы (лид Википедии впереди фразы о партии и о скандалах).
 * Теперь фрагмент принадлежности идёт отдельным полем `anchorQuote`, а
 * `quotes` — только основания; аудит сверяет и его с текстом страницы.
 */

import { describe, expect, it } from "vitest";
import {
  analyzeLinkPage,
  LINK_VERDICT_PROMPT_VERSION,
} from "@/modules/digital-profile/orion-golden/analytics/link-verdict-analyst";
import { auditLinkVerdicts } from "@/modules/digital-profile/orion-golden/analytics/link-verdict-audit-agent";
import type { LinkPageRead } from "@/modules/digital-profile/services/link-page-reader";
import type { LinkVerdict } from "@/modules/digital-profile/orion-golden/contracts/link-verdict";

const READ_AT = "2026-09-19T10:00:00.000Z";
const PAGE_TEXT =
  "Фёдор Сергеевич Бондарчук (род. 9 мая 1967, Москва) — советский и российский актёр кино, режиссёр. " +
  "Член Высшего совета политической партии «Единая Россия» в 2009—2021 годах. " +
  "Не отличался успешной учёбой и хорошим поведением, в школьные годы стал пить, курить и хулиганить.";

const page: LinkPageRead = {
  ok: true,
  url: "https://ru.wikipedia.org/wiki/Бондарчук,_Фёдор_Сергеевич",
  text: PAGE_TEXT,
  title: "Бондарчук, Фёдор Сергеевич — Википедия",
  readAt: READ_AT,
};

function input() {
  return {
    evidenceRef: "inventory:wiki",
    url: page.url,
    domain: "ru.wikipedia.org",
    subject: { fullName: "Бондарчук Фёдор Сергеевич", aliases: [] },
    page,
  };
}

const ANCHOR = "Фёдор Сергеевич Бондарчук (род. 9 мая 1967, Москва) — советский и российский актёр кино, режиссёр.";
const PARTY = "Член Высшего совета политической партии «Единая Россия» в 2009—2021 годах.";
const SCHOOL =
  "Не отличался успешной учёбой и хорошим поведением, в школьные годы стал пить, курить и хулиганить.";

describe("промпт чтения ссылок", () => {
  it("Ч1: просит фрагмент принадлежности отдельным полем, а в quotes — основания; версия не ниже v4", async () => {
    let systemPrompt = "";
    await analyzeLinkPage(input(), {
      call: async (args) => {
        systemPrompt = String((args as { systemPrompt: string }).systemPrompt);
        return { subjectMatch: "subject", tone: "adverse", theme: "Биография со скандалами", quotes: [{ text: PARTY }] };
      },
    });
    expect(systemPrompt).toContain("anchorQuote");
    expect(systemPrompt).toMatch(/основани/u);
    const m = LINK_VERDICT_PROMPT_VERSION.match(/^link-verdict-prompt-v(\d+)$/u);
    expect(m, LINK_VERDICT_PROMPT_VERSION).toBeTruthy();
    expect(Number(m![1])).toBeGreaterThanOrEqual(4);
  });

  it("Ч2: ответ модели с anchorQuote даёт решение с этим полем, quotes без него", async () => {
    const verdict = await analyzeLinkPage(input(), {
      call: async () => ({
        subjectMatch: "subject",
        tone: "adverse",
        theme: "Биография со скандалами",
        anchorQuote: { text: ANCHOR },
        quotes: [{ text: PARTY }, { text: SCHOOL }],
      }),
    });
    expect(verdict.anchorQuote?.text).toBe(ANCHOR);
    expect(verdict.quotes.map((q) => q.text)).toEqual([PARTY, SCHOOL]);
  });
});

describe("аудит сверяет фрагмент принадлежности с текстом", () => {
  function verdict(over: Partial<LinkVerdict>): LinkVerdict {
    return {
      schemaVersion: "link-verdict-v1",
      evidenceRef: "inventory:wiki",
      url: page.url,
      domain: "ru.wikipedia.org",
      subjectMatch: "subject",
      tone: "adverse",
      theme: "Биография со скандалами",
      quotes: [{ text: PARTY }],
      readAt: READ_AT,
      ...over,
    } as LinkVerdict;
  }

  it("Ч3: ненайденный anchorQuote снимается, найденный остаётся", () => {
    const { verdicts } = auditLinkVerdicts({
      verdicts: [
        verdict({ anchorQuote: { text: ANCHOR } }),
        verdict({
          evidenceRef: "inventory:other",
          anchorQuote: { text: "Совершенно выдуманный фрагмент о рождении в Ленинграде." },
        }),
      ],
      sources: [
        { evidenceRef: "inventory:wiki", text: PAGE_TEXT },
        { evidenceRef: "inventory:other", text: PAGE_TEXT },
      ],
      subjectNames: ["Бондарчук Фёдор Сергеевич"],
    });
    expect(verdicts[0]!.anchorQuote?.text).toBe(ANCHOR);
    expect(verdicts[1]!.anchorQuote).toBeUndefined();
    // Основания при этом на месте: они найдены в тексте.
    expect(verdicts[1]!.quotes.map((q) => q.text)).toEqual([PARTY]);
  });
});
