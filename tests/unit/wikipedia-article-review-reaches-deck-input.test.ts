import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeckInputsFromAnalyticsDir } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import { WIKIPEDIA_ARTICLE_REVIEW_SCHEMA_VERSION } from "@/modules/digital-profile/orion-golden/contracts/wikipedia-article-review";

/**
 * Разбор статьи доезжает до построителя тем же путём, что и вердикты, и по тем
 * же правилам: прочтение сильнее заголовка, но **только вниз**.
 *
 * Полный тёзка проходит модельную проверку насквозь, поэтому подтверждённость
 * печати обязана опираться на детерминированный признак — ФИО в заголовке либо
 * наследование по межъязыковой ссылке. Мнение модели её не создаёт.
 */

const ANALYTICS_DIR = join(process.cwd(), "baselines/report-72/artifacts/analytics");
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function dirWith(input: {
  check?: Record<string, unknown>;
  review?: Record<string, unknown> | null;
}): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-review-input-"));
  tempDirs.push(dir);
  cpSync(ANALYTICS_DIR, dir, { recursive: true });
  writeFileSync(
    join(dir, "evidence-supplement.json"),
    JSON.stringify({
      version: "evidence-supplement-v1",
      caseId: "case-72",
      wikipediaChecks: [
        input.check ?? {
          id: "2",
          exists: true,
          url: "https://ru.wikipedia.org/wiki/Глинка_(дворянский_род)",
          language: "ru",
          pageTitle: "Глинка (дворянский род)",
          lastChecked: "2026-07-01T12:00:00.000Z",
        },
      ],
      serpScreenshots: [],
    }),
    "utf8"
  );
  if (input.review !== null) {
    writeFileSync(
      join(dir, "wikipedia-article-review.json"),
      JSON.stringify({
        schemaVersion: WIKIPEDIA_ARTICLE_REVIEW_SCHEMA_VERSION,
        caseId: "case-72",
        reviews: [
          {
            checkRef: "inventory:wiki-2",
            language: "ru",
            title: "Глинка (дворянский род)",
            url: "https://ru.wikipedia.org/wiki/Глинка_(дворянский_род)",
            lead: "Глинки — дворянский род.",
            sections: ["История"],
            articleTextChars: 300,
            reviewedChars: 300,
            truncated: false,
            subjectMatch: "unclear",
            fragments: [],
            audit: { dropped: 0, reasons: [] },
            status: "REVIEWED",
            ...(input.review ?? {}),
          },
        ],
      }),
      "utf8"
    );
  }
  return dir;
}

describe("разбор статьи на записи проверки", () => {
  it("лид, разделы и статус лежат рядом с проверкой", () => {
    const entry = loadDeckInputsFromAnalyticsDir(dirWith({})).evidenceIndex["inventory:wiki-2"];
    expect(entry!.kind).toBe("wikipedia_check");
    expect(entry!.articleReview!.status).toBe("REVIEWED");
    expect(entry!.articleReview!.lead).toBe("Глинки — дворянский род.");
    expect(entry!.articleReview!.sections).toEqual(["История"]);
  });

  it("без артефакта разбора запись остаётся прежней", () => {
    const entry = loadDeckInputsFromAnalyticsDir(dirWith({ review: null })).evidenceIndex[
      "inventory:wiki-2"
    ];
    expect(entry!.kind).toBe("wikipedia_check");
    expect(entry!.articleReview).toBeUndefined();
  });

  it("разбор «статья о другом лице» понижает решение о принадлежности", () => {
    const dir = dirWith({
      check: {
        id: "2",
        exists: true,
        url: "https://ru.wikipedia.org/wiki/Глинка,_Михаил_Иванович",
        language: "ru",
        pageTitle: "Глинка, Михаил Иванович",
        lastChecked: "2026-07-01T12:00:00.000Z",
      },
      review: { subjectMatch: "other" },
    });
    const entry = loadDeckInputsFromAnalyticsDir(dir).evidenceIndex["inventory:wiki-2"];
    expect(entry!.subjectDecision).toBe("OTHER_SUBJECT");
  });

  it("разбор «это он» решения не повышает", () => {
    // В замороженной аналитике прогона 72 у этой записи AMBIGUOUS: заголовок
    // несёт одну фамилию. Мнение модели ничего в эту сторону не двигает.
    const dir = dirWith({ review: { subjectMatch: "subject" } });
    const entry = loadDeckInputsFromAnalyticsDir(dir).evidenceIndex["inventory:wiki-2"];
    expect(entry!.subjectDecision).toBe("AMBIGUOUS");
  });

  it("способ находки статьи доезжает до индекса", () => {
    const dir = dirWith({
      check: {
        id: "2",
        exists: true,
        url: "https://en.wikipedia.org/wiki/Alexei_Mordashov",
        language: "en",
        pageTitle: "Alexei Mordashov",
        lastChecked: "2026-07-01T12:00:00.000Z",
        foundVia: "langlink",
        langlinkOf: { language: "ru", title: "Мордашов, Алексей Александрович" },
      },
      review: null,
    });
    const entry = loadDeckInputsFromAnalyticsDir(dir).evidenceIndex["inventory:wiki-2"];
    expect(entry!.foundVia).toBe("langlink");
    expect(entry!.langlinkOf).toEqual({
      language: "ru",
      title: "Мордашов, Алексей Александрович",
    });
  });
});

/**
 * Понижение идёт по ребру наследования.
 *
 * Наследование по межъязыковой ссылке заводилось ровно затем, чтобы две записи
 * об одной сущности Викиданных не разошлись. Понижение, применённое к одной из
 * них, обязано идти тем же ребром — иначе ru-статья становится «о другом лице»,
 * а её en-сестра остаётся подтверждённой.
 */
describe("разбор понижает обе записи одной сущности", () => {
  function dirWithPair(reviewLanguage: "ru" | "en"): string {
    const dir = mkdtempSync(join(tmpdir(), "wiki-review-pair-"));
    tempDirs.push(dir);
    cpSync(ANALYTICS_DIR, dir, { recursive: true });
    writeFileSync(
      join(dir, "evidence-supplement.json"),
      JSON.stringify({
        version: "evidence-supplement-v1",
        caseId: "case-72",
        wikipediaChecks: [
          {
            id: "2",
            exists: true,
            url: "https://ru.wikipedia.org/wiki/Глинка,_Михаил_Иванович",
            language: "ru",
            pageTitle: "Глинка, Михаил Иванович",
            lastChecked: "2026-07-01T12:00:00.000Z",
          },
          {
            id: "3",
            exists: true,
            url: "https://en.wikipedia.org/wiki/Mikhail_Glinka",
            language: "en",
            pageTitle: "Mikhail Glinka",
            lastChecked: "2026-07-01T12:00:00.000Z",
            foundVia: "langlink",
            langlinkOf: { language: "ru", title: "Глинка, Михаил Иванович" },
          },
        ],
        serpScreenshots: [],
      }),
      "utf8"
    );
    const base = {
      lead: "Лид статьи о лице.",
      sections: [],
      articleTextChars: 100,
      reviewedChars: 100,
      truncated: false,
      fragments: [],
      audit: { dropped: 0, reasons: [] },
      status: "REVIEWED",
    };
    writeFileSync(
      join(dir, "wikipedia-article-review.json"),
      JSON.stringify({
        schemaVersion: WIKIPEDIA_ARTICLE_REVIEW_SCHEMA_VERSION,
        caseId: "case-72",
        reviews: [
          {
            ...base,
            checkRef: reviewLanguage === "ru" ? "inventory:wiki-2" : "inventory:wiki-3",
            language: reviewLanguage,
            title: reviewLanguage === "ru" ? "Глинка, Михаил Иванович" : "Mikhail Glinka",
            subjectMatch: "other",
          },
        ],
      }),
      "utf8"
    );
    return dir;
  }

  it("понижение статьи-источника доезжает до её межъязыковой сестры", () => {
    const index = loadDeckInputsFromAnalyticsDir(dirWithPair("ru")).evidenceIndex;
    expect(index["inventory:wiki-2"]!.subjectDecision).toBe("OTHER_SUBJECT");
    expect(index["inventory:wiki-3"]!.subjectDecision).toBe("OTHER_SUBJECT");
  });

  it("понижение сестры доезжает до статьи-источника", () => {
    const index = loadDeckInputsFromAnalyticsDir(dirWithPair("en")).evidenceIndex;
    expect(index["inventory:wiki-3"]!.subjectDecision).toBe("OTHER_SUBJECT");
    expect(index["inventory:wiki-2"]!.subjectDecision).toBe("OTHER_SUBJECT");
  });
});
