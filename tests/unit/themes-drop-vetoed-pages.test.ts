import { describe, expect, it } from "vitest";
import { applyVetoToThemeSummaries } from "@/modules/digital-profile/orion-golden/analytics/run-link-verdicts";
import {
  LINK_VERDICT_SCHEMA_VERSION,
  LinkVerdictSchema,
  type LinkVerdict,
  type VerdictThemeSummary,
} from "@/modules/digital-profile/orion-golden/contracts/link-verdict";

/**
 * Темы отчёта считаются по тем же решениям, что и всё остальное.
 *
 * Вето разметки применяется после того, как стадия чтения свела свои темы, — и
 * таблица тем страницы 25 оставалась посчитанной по невето́ванным решениям:
 * страницы однофамильцев в ней были, а в доле негатива и в резюме их уже не
 * было. Числа одного отчёта обязаны сходиться между собой.
 */

const verdict = (ref: string, subjectMatch: string, tone = "neutral"): LinkVerdict =>
  LinkVerdictSchema.parse({
    schemaVersion: LINK_VERDICT_SCHEMA_VERSION,
    evidenceRef: ref,
    url: `https://example.org/${ref}`,
    subjectMatch,
    tone,
    theme: "Судебные споры",
    sourceType: "news",
    quotes: tone === "adverse" ? [{ text: "дословная цитата со страницы" }] : [],
    readAt: "2026-01-01T00:00:00.000Z",
  });

const themes: VerdictThemeSummary[] = [
  {
    theme: "Судебные споры",
    count: 3,
    adverseCount: 2,
    evidenceRefs: ["e1", "e2", "e3"],
    examples: [
      { url: "https://example.org/e1", domain: "example.org", rank: 1 },
      { url: "https://example.org/e2", domain: "example.org", rank: 2 },
    ],
  },
  {
    theme: "Тема целиком о тёзке",
    count: 1,
    adverseCount: 1,
    evidenceRefs: ["e4"],
    examples: [{ url: "https://example.org/e4", domain: "example.org", rank: 4 }],
  },
];

describe("темы после вето разметки", () => {
  const out = applyVetoToThemeSummaries({
    themes,
    verdicts: [
      verdict("e1", "subject", "adverse"),
      verdict("e2", "unclear", "adverse"),
      verdict("e3", "subject"),
      verdict("e4", "other", "adverse"),
    ],
  });

  it("страницы, снятые вето, из темы уходят вместе со своим негативом", () => {
    expect(out[0]).toMatchObject({
      theme: "Судебные споры",
      count: 2,
      adverseCount: 1,
      evidenceRefs: ["e1", "e3"],
    });
  });

  it("адреса примеров тоже чистятся", () => {
    expect(out[0]?.examples.map((e) => e.url)).toEqual(["https://example.org/e1"]);
  });

  it("тема, у которой не осталось ни одной страницы, исчезает", () => {
    expect(out.map((t) => t.theme)).toEqual(["Судебные споры"]);
  });

  it("вето ничего не сняло — темы те же до буквы", () => {
    const untouched = applyVetoToThemeSummaries({
      themes,
      verdicts: [
        verdict("e1", "subject", "adverse"),
        verdict("e2", "subject", "adverse"),
        verdict("e3", "subject"),
        verdict("e4", "subject", "adverse"),
      ],
    });
    expect(untouched).toEqual(themes);
  });
});
