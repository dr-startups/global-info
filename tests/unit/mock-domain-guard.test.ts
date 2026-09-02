/**
 * Phase A.1 (PDF_REVIEW_31_ANALYSIS) — mock/demo rows must never reach
 * client-facing output. Reproduces the `en.wikipedia-mock.example` leak
 * from rendered-client (31).pdf p37 and locks every path shut.
 */

import { describe, expect, it } from "vitest";
import {
  isMockBaseRow,
  isMockClientDomain,
  MOCK_URL_PATTERN,
} from "../../src/modules/digital-profile/services/composite-serp-merge";
import {
  isMockWikipediaCheck,
  resolveEvidenceSupplement,
} from "../../src/modules/digital-profile/services/evidence-supplement-adapter";
import {
  pageSourceLine,
  sourceLine,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "../../src/modules/digital-profile/orion-golden/deck-sections/scoped-input";

describe("MOCK_URL_PATTERN / isMockBaseRow (A.1)", () => {
  it("catches the reserved .example TLD that leaked into report 31", () => {
    expect(MOCK_URL_PATTERN.test("https://en.wikipedia-mock.example/wiki/subject")).toBe(true);
    expect(
      isMockBaseRow({ url: "https://en.wikipedia-mock.example/wiki/oleg_deripaska" })
    ).toBe(true);
  });

  it("keeps catching legacy example.<tld> and .invalid forms", () => {
    expect(isMockBaseRow({ url: "https://example.com/page" })).toBe(true);
    expect(isMockBaseRow({ url: "https://images.example/img.png" })).toBe(true);
    expect(isMockBaseRow({ url: "https://host.invalid/x" })).toBe(true);
    expect(isMockBaseRow({ provider: "mock-yandex", url: "https://real.ru" })).toBe(true);
    expect(isMockBaseRow({ title: "[demo] строка", url: "https://real.ru" })).toBe(true);
  });

  it("does not flag real domains", () => {
    for (const url of [
      "https://ru.wikipedia.org/wiki/X",
      "https://rbc.ru/article",
      "https://exampleshop.ru/item", // 'example' inside a word, not example.<tld>
      "https://dzen.ru/a/abc",
    ]) {
      expect(isMockBaseRow({ url })).toBe(false);
    }
  });
});

describe("isMockClientDomain (A.1)", () => {
  it("flags mock domains", () => {
    expect(isMockClientDomain("en.wikipedia-mock.example")).toBe(true);
    expect(isMockClientDomain("linkedin-mock.example")).toBe(true);
    expect(isMockClientDomain("example.com")).toBe(true);
    expect(isMockClientDomain("host.invalid")).toBe(true);
  });

  it("keeps real domains", () => {
    expect(isMockClientDomain("ru.wikipedia.org")).toBe(false);
    expect(isMockClientDomain("rbc.ru")).toBe(false);
    expect(isMockClientDomain("")).toBe(false);
    expect(isMockClientDomain(undefined)).toBe(false);
  });
});

describe("isMockWikipediaCheck + resolveEvidenceSupplement (A.1)", () => {
  it("flags mock-agent rows by checkedBy and by url", () => {
    expect(isMockWikipediaCheck({ checkedBy: "mock:WIKIPEDIA", url: null })).toBe(true);
    expect(
      isMockWikipediaCheck({ checkedBy: null, url: "https://en.wikipedia-mock.example/wiki/x" })
    ).toBe(true);
    expect(
      isMockWikipediaCheck({ checkedBy: "real:WIKIPEDIA", url: "https://en.wikipedia.org/wiki/X" })
    ).toBe(false);
    expect(isMockWikipediaCheck({ url: "https://ru.wikipedia.org/wiki/X" })).toBe(false);
  });

  it("drops mock checks from the supplement bundle (fixture path)", async () => {
    const res = await resolveEvidenceSupplement({
      caseId: "case-1",
      reportRunId: "run-1",
      fixture: {
        version: "evidence-supplement-v1",
        caseId: "case-1",
        wikipediaChecks: [
          {
            id: "wiki-real",
            exists: true,
            url: "https://en.wikipedia.org/wiki/Subject",
            language: "en",
            pageTitle: "Subject",
            checkedBy: "real:WIKIPEDIA",
          },
          {
            id: "wiki-mock",
            exists: true,
            url: "https://en.wikipedia-mock.example/wiki/subject",
            language: "en",
            pageTitle: "Subject",
            checkedBy: "mock:WIKIPEDIA",
          },
        ],
        serpScreenshots: [],
      },
    });
    expect(res.bundle.wikipediaChecks.map((w) => w.id)).toEqual(["wiki-real"]);
    expect(res.wikipediaItems).toHaveLength(1);
    expect(res.wikipediaItems[0]!.sourceUrl).toBe("https://en.wikipedia.org/wiki/Subject");
    expect(JSON.stringify(res)).not.toContain("wikipedia-mock");
  });
});

describe("source lines exclude mock domains (A.1 defense-in-depth)", () => {
  it("pageSourceLine drops .example domains", () => {
    const line = pageSourceLine({
      refs: [],
      domains: ["en.wikipedia.org", "en.wikipedia-mock.example", "rbc.ru"],
      findings: [],
      supportDomains: new Map(),
    } as never);
    // Проверка охраняет то, ради чего написана, — демо-домен не доходит до
    // клиента, а настоящие остаются. Точная строка здесь не при чём: она
    // ломала тест на каждой правке формулировки.
    expect(line).not.toMatch(/\.example\b/u);
    expect(line).not.toContain("wikipedia-mock");
    expect(line).toContain("en.wikipedia.org");
    expect(line).toContain("rbc.ru");
  });

  it("sourceLine drops .example domains from findings and evidence", () => {
    const scoped = {
      findings: [
        { sourceDomains: ["dzen.ru", "en.wikipedia-mock.example"] },
      ],
      evidenceIndex: {
        "inventory:1": { domain: "rbc.ru" },
        "inventory:2": { domain: "linkedin-mock.example" },
      },
    } as unknown as ScopedFragmentInput;
    const line = sourceLine(scoped);
    // Как и выше: охраняется отсутствие демо-доменов, а не формулировка.
    expect(line).not.toMatch(/\.example\b/u);
    expect(line).not.toContain("mock");
    expect(line).toContain("dzen.ru");
    expect(line).toContain("rbc.ru");
  });
});
