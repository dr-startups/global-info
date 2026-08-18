import { afterEach, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeckInputsFromAnalyticsDir } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import { loadWikipediaChecksFromPrisma } from "@/modules/digital-profile/services/evidence-supplement-adapter";

/**
 * Дата проверки и принадлежность найденной статьи доезжают до строителя.
 *
 * Страница Википедии печатает и то, и другое, а приходят они разными путями:
 * дата — из `evidence-supplement.json` живого пути, принадлежность — из
 * subject-resolution через наблюдения. Стык — идентификатор записи:
 * supplement пишет `wiki-${row.id}`, а решение лежит на `inventory:wiki-<id>`.
 * Разъехавшись, они не сломают ни один тип: страница просто замолчит о дате и
 * назовёт тёзку субъектом.
 *
 * Вход — замороженные артефакты прогона 72 (офлайн, без базы), к ним
 * дописывается supplement во временном каталоге: сам эталон не трогается.
 */
const ANALYTICS_DIR = join(process.cwd(), "baselines/report-72/artifacts/analytics");

/**
 * Копии каталога аналитики удаляются и после упавшего теста: каждая — полный
 * слепок артефактов прогона 72, и оставленные в `/tmp` они копятся с каждым
 * `npm test`.
 */
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function analyticsDirWithSupplement(check: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "wiki-check-input-"));
  tempDirs.push(dir);
  cpSync(ANALYTICS_DIR, dir, { recursive: true });
  writeFileSync(
    join(dir, "evidence-supplement.json"),
    JSON.stringify({
      version: "evidence-supplement-v1",
      caseId: "case-72",
      wikipediaChecks: [check],
      serpScreenshots: [],
    }),
    "utf8"
  );
  return dir;
}

describe("проверка Википедии доезжает до входа сборки", () => {
  it("дата проверки и решение о принадлежности стоят на записи проверки", () => {
    const dir = analyticsDirWithSupplement({
      // Прогон 72: статья «Глинка (дворянский род)» — это `inventory:wiki-2`,
      // и subject-resolution оценил её AMBIGUOUS.
      id: "2",
      exists: true,
      url: "https://ru.wikipedia.org/wiki/Глинка_(дворянский_род)",
      language: "ru",
      pageTitle: "Глинка (дворянский род)",
      lastChecked: "2026-07-01T12:00:00.000Z",
    });
    const entry = loadDeckInputsFromAnalyticsDir(dir).evidenceIndex["inventory:wiki-2"];
    expect(entry).toBeDefined();
    expect(entry!.kind).toBe("wikipedia_check");
    expect(entry!.wikipediaExists).toBe(true);
    expect(entry!.checkedAt).toBe("2026-07-01T12:00:00.000Z");
    expect(entry!.subjectDecision).toBe("AMBIGUOUS");
  });

  it("запрос проверки доезжает до индекса доказательств", () => {
    const dir = analyticsDirWithSupplement({
      id: "2",
      exists: false,
      language: "en",
      lastChecked: "2026-08-17T12:00:00.000Z",
      // Живой прогон: en-раздел спрашивали кириллицей, и страница обязана
      // напечатать этот запрос дословно, а не обобщать «по имени субъекта».
      query: "Рашников Виктор Филиппович",
    });
    const entry = loadDeckInputsFromAnalyticsDir(dir).evidenceIndex["inventory:wiki-2"];
    expect(entry!.kind).toBe("wikipedia_check");
    expect(entry!.query).toBe("Рашников Виктор Филиппович");
  });

  it("проверка без даты поля не заводит", () => {
    const dir = analyticsDirWithSupplement({
      id: "2",
      exists: false,
      language: "ru",
    });
    const entry = loadDeckInputsFromAnalyticsDir(dir).evidenceIndex["inventory:wiki-2"];
    expect(entry!.kind).toBe("wikipedia_check");
    expect(entry!.checkedAt).toBeUndefined();
  });

  it("старый артефакт без запроса поля не заводит", () => {
    const dir = analyticsDirWithSupplement({ id: "2", exists: false, language: "ru" });
    const entry = loadDeckInputsFromAnalyticsDir(dir).evidenceIndex["inventory:wiki-2"];
    expect(entry!.query).toBeUndefined();
  });
});

/**
 * Запрос лежит в снимке ответа провайдера (`snapshot.raw.query`), а страница
 * читает поле записи. Где именно он лежит, знает только писатель supplement —
 * иначе это знание пришлось бы держать в двух местах.
 */
describe("писатель supplement поднимает запрос из снимка проверки", () => {
  const prismaWithRow = (row: Record<string, unknown>) => ({
    wikipediaCheck: { findMany: async () => [row] },
  });

  it("запрос снимка становится полем записи", async () => {
    const rows = await loadWikipediaChecksFromPrisma({
      prisma: prismaWithRow({
        id: "w1",
        exists: false,
        language: "en",
        checkedBy: "real:WIKIPEDIA",
        snapshot: {
          source: "REAL_WIKIPEDIA",
          raw: { provider: "WIKIPEDIA", language: "en", query: "Рашников Виктор Филиппович" },
        },
      }) as never,
      caseId: "case-1",
    });
    expect(rows[0]!.query).toBe("Рашников Виктор Филиппович");
  });

  it("снимок без запроса поля не выдумывает", async () => {
    const rows = await loadWikipediaChecksFromPrisma({
      prisma: prismaWithRow({ id: "w1", exists: false, language: "ru", snapshot: null }) as never,
      caseId: "case-1",
    });
    expect(rows[0]!.query ?? null).toBeNull();
  });
});
