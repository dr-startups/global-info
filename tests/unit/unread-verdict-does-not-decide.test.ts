/**
 * Вердикт по непрочитанной странице ничего не решает.
 *
 * Страницу не открыли — модель честно пишет «не знаем»: `subjectMatch:
 * "unclear"`, `tone: "neutral"`, заполненный `readFailure`, а темой становится
 * заголовок выдачи. Загрузчик применял такой вердикт наравне с настоящим: тон
 * «нейтрально» гасил словарную метку «Нежелательный», а `readVerdictTone`
 * получал значение, по которому потребители отличают прочитанную страницу от
 * непрочитанной. Контракт поля обещает обратное: «Есть только у страниц,
 * которые удалось прочитать».
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeckInputsFromAnalyticsDir } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";

const OBSERVATION = {
  observationKey: "obs-1",
  surface: "organic",
  region: "RU",
  engine: "YANDEX",
  url: "https://news.example/court",
  title: "Суд по иску о взыскании 72 млн рублей",
  domain: "news.example",
  rank: 3,
  evidenceRefs: ["inventory:obs-1"],
};

/**
 * Минимальный каталог артефактов аналитики: только то, что читает загрузчик.
 * `verdicts === null` — прогон без чтения ссылок: файла решений нет вовсе.
 */
function analyticsDirWith(verdicts: unknown[] | null): string {
  const dir = mkdtempSync(join(tmpdir(), "deck-inputs-"));
  const write = (name: string, value: unknown): void => {
    writeFileSync(join(dir, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  };
  write("verified-finding-bundle.json", { findings: [] });
  write("ambiguous-findings.json", []);
  write("surface-analysis.json", {});
  write("executive-summary.json", {});
  write("report-data-binding.json", {
    baseReportRunId: "run-1",
    datasetId: "ds-1",
    caseId: "case-1",
  });
  write("provider-delta.json", { baseCount: 1, arsenkinObservationCount: 0 });
  write("composite-serp-observations.json", {
    observations: [OBSERVATION],
    baseCount: 1,
    compositeCount: 1,
  });
  write("subject-resolution.json", { items: [] });
  if (verdicts) write("link-verdicts.json", { verdicts });
  return dir;
}

const UNREAD_VERDICT = {
  evidenceRef: "inventory:obs-1",
  region: "RU",
  subjectMatch: "unclear",
  tone: "neutral",
  theme: "Суд по иску о взыскании 72 млн рублей",
  readFailure: "blocked",
  quotes: [],
};

const READ_VERDICT = {
  evidenceRef: "inventory:obs-1",
  region: "RU",
  subjectMatch: "subject",
  tone: "neutral",
  theme: "Интервью о новом альбоме",
  quotes: [{ text: "Это интервью о новом альбоме и планах на тур." }],
};

describe("непрочитанный вердикт не переопределяет оценку наблюдения", () => {
  it("не пишет тон прочитанной страницы и не подменяет тему", () => {
    const inputs = loadDeckInputsFromAnalyticsDir(analyticsDirWith([UNREAD_VERDICT]));
    const entry = inputs.evidenceIndex["inventory:obs-1"]!;
    expect(entry.readVerdictTone).toBeUndefined();
    expect(entry.verdictTheme).toBeUndefined();
    // Словарная метка остаётся единственным, что есть о такой странице:
    // загрузчик её не трогает.
    expect(entry.adverse).toBeUndefined();
  });

  it("прочитанный вердикт по-прежнему решает", () => {
    const inputs = loadDeckInputsFromAnalyticsDir(analyticsDirWith([READ_VERDICT]));
    const entry = inputs.evidenceIndex["inventory:obs-1"]!;
    expect(entry.readVerdictTone).toBe("neutral");
    expect(entry.verdictTheme).toBe("Интервью о новом альбоме");
    expect(entry.adverse).toBe(false);
    expect(entry.pageQuote).toContain("новом альбоме");
  });
});

describe("снимок метрик несёт долю прочитанного по регионам", () => {
  it("считает корзину региона по вердиктам прогона", () => {
    const inputs = loadDeckInputsFromAnalyticsDir(
      analyticsDirWith([
        UNREAD_VERDICT,
        {
          evidenceRef: "inventory:obs-2",
          region: "RU",
          subjectMatch: "subject",
          tone: "adverse",
          theme: "Судебные споры",
          quotes: [{ text: "Суд удовлетворил иск о взыскании." }],
        },
      ])
    );
    expect(inputs.metricSnapshot.linkReadByRegion).toEqual({
      RU: { requested: 2, read: 1, readOther: 0, readUnconfirmed: 0, adverseRead: 1 },
    });
  });

  it("без артефакта вердиктов поля нет вовсе", () => {
    const inputs = loadDeckInputsFromAnalyticsDir(analyticsDirWith(null));
    expect(inputs.metricSnapshot.linkReadByRegion).toBeUndefined();
  });
});
