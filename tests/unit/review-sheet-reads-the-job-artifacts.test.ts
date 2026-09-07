/**
 * Лист собирается из тех артефактов, которые джоба действительно пишет.
 *
 * Построитель чист и проверен на своих входах, но между ним и прогоном лежит
 * чтение файлов: имена полей у наблюдений, у записей комплаенса и у списка
 * приложения разные, и разойтись они могут молча — лист выйдет пустым при
 * полном документе. Тест читает каталог той же формы, что бандл прогона.
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildReviewSheetFromJobDir,
  reviewSheetPath,
  writeReviewSheet,
} from "@/modules/digital-profile/services/review-sheet-artifact";

const jobDir = mkdtempSync(join(tmpdir(), "review-sheet-job-"));
afterAll(() => rmSync(jobDir, { recursive: true, force: true }));

const analyticsDir = join(jobDir, "analytics");
const deckDir = join(jobDir, "deck");
mkdirSync(analyticsDir, { recursive: true });
mkdirSync(deckDir, { recursive: true });

const write = (path: string, value: unknown): void =>
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");

write(join(deckDir, "assembled-deck.json"), {
  version: "assembled-deck-v1",
  slides: [
    {
      slideKey: "p09_ru_serp_table",
      baseSlotId: "p09_ru_serp_table",
      templateId: "serp-table",
      pageNumber: 15,
      title: "Россия — результаты поисковой выдачи",
      evidenceRefs: ["inventory:obs-1"],
      findingIds: [],
      visualAssetRefs: [],
    },
    {
      slideKey: "p04_risk_dashboard",
      baseSlotId: "p04_risk_dashboard",
      templateId: "risk-matrix",
      pageNumber: 9,
      title: "Матрица комплаенс-рисков",
      evidenceRefs: [],
      findingIds: ["finding-1"],
      visualAssetRefs: [],
    },
    {
      slideKey: "appendix_main_base",
      baseSlotId: "appendix_main_base",
      templateId: "finding-cards",
      pageNumber: 62,
      title: "Приложение",
      evidenceRefs: [],
      findingIds: ["finding-amb"],
      visualAssetRefs: [],
    },
    {
      slideKey: "p35_lexis_visual",
      baseSlotId: "p35_lexis_visual",
      templateId: "serp-screenshot-analysis",
      pageNumber: 61,
      title: "LexisNexis — страница профиля",
      evidenceRefs: [],
      findingIds: [],
      visualAssetRefs: [],
    },
  ],
});

write(join(analyticsDir, "composite-serp-observations.json"), {
  schemaVersion: "composite-dataset-v1",
  observations: [
    {
      observationKey: "запрос|GOOGLE|RU|organic|pravo.ru/judge/1465",
      url: "https://pravo.ru/arbitr_practice/judge/1465",
      title: "Судья Егоров Алексей Евгеньевич на портале Право.ру",
      domain: "pravo.ru",
      evidenceRefs: ["inventory:obs-1"],
    },
  ],
});

write(join(analyticsDir, "subject-resolution.json"), {
  schemaVersion: "subject-resolution-v2",
  subjectDisplayName: "Егоров Алексей Евгеньевич",
  items: [
    {
      evidenceRef: "inventory:obs-1",
      decision: "AMBIGUOUS",
      confidence: 0.45,
      matchedIdentifiers: [],
      conflictingIdentifiers: [],
      reasonCode: "surname_query_no_anchor",
    },
  ],
});

write(join(analyticsDir, "verified-finding-bundle.json"), {
  schemaVersion: "verified-finding-bundle-v1",
  findings: [
    {
      findingId: "finding-1",
      theme: "Криминальные / судебные материалы",
      subjectMatch: "LIKELY_SUBJECT",
      riskLevel: "critical",
    },
  ],
  excludedFindingIds: [],
  exclusionReasons: {},
});

// Список приложения лежит голым массивом, а не объектом с полем.
write(join(analyticsDir, "ambiguous-findings.json"), [
  {
    findingId: "finding-amb",
    theme: "Корпоративное владение",
    subjectMatch: "AMBIGUOUS",
    riskLevel: "low",
  },
]);

write(join(analyticsDir, "compliance-inventory.json"), {
  version: "compliance-inventory-v1",
  count: 1,
  items: [
    {
      inventoryId: "db-42",
      provider: "OPEN_SANCTIONS",
      title: "Egorov Aleksey Evgenevich",
      classification: "PENDING",
    },
  ],
  screenings: [],
});

write(join(jobDir, "visual-assets-by-slot.json"), {
  counts: {},
  visualAssets: {},
  failed: [],
});

describe("лист проверки читает артефакты джобы", () => {
  it("собирает материалы, темы и комплаенс из каталога прогона", () => {
    const sheet = buildReviewSheetFromJobDir({ caseId: "case-1", artifactsDir: jobDir });

    const material = sheet.items.find((i) => i.kind === "evidence");
    expect(material?.url).toBe("https://pravo.ru/arbitr_practice/judge/1465");
    expect(material?.pages).toEqual([15]);
    expect(material?.reason?.label).toContain("фамилия");

    const themes = sheet.items.filter((i) => i.kind === "finding");
    expect(themes.map((x) => x.key).sort()).toEqual(["finding-1", "finding-amb"]);
    expect(themes.find((x) => x.key === "finding-1")?.open).toBe(true);

    const compliance = sheet.items.filter((i) => i.kind === "compliance");
    // Запись базы и слот снимка LexisNexis, у которого снимка нет.
    expect(compliance.map((x) => x.key).sort()).toEqual(["db-42", "p35_lexis_visual"]);
    expect(compliance.every((x) => x.open)).toBe(true);
  });

  it("лист кладётся рядом с декой и читается обратно", () => {
    const path = writeReviewSheet({ caseId: "case-1", artifactsDir: jobDir });
    expect(path).toBe(reviewSheetPath(jobDir));
    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { version: string };
    expect(parsed.version).toBe("review-sheet-v1");
  });

  it("каталог без аналитики лист не роняет", () => {
    const empty = mkdtempSync(join(tmpdir(), "review-sheet-empty-"));
    try {
      const sheet = buildReviewSheetFromJobDir({ caseId: "case-1", artifactsDir: empty });
      expect(sheet.items).toEqual([]);
      expect(sheet.summary.evidence.total).toBe(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
