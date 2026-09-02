/**
 * Вторичная ингестия дополняет индекс доказательств, а не переписывает его.
 *
 * Примеры «прочих материалов» записывались в `evidenceIndex` записью целиком:
 * `{title, domain, kind, region}` — без позиции, запроса и движка. На прогоне
 * 76 в восемь примеров ОАЭ попали ровно серперные строки 3 (opensanctions.org),
 * 4 (bloomberg.com) и 10 (wikidata.org): после перезаписи у них не осталось
 * запроса таблицы, они выпали из ТОП-20, а освободившиеся места заняла
 * нумерация обогатителя. Соседний цикл `topExamples` тот же ref пишет только
 * при его отсутствии — задуманная семантика была видна, охраны не было.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDeckInputsFromAnalyticsDir } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import {
  UAE_UNCATEGORIZED_REFS,
  run76UaeObservations,
  writeSerpAnalyticsDir,
} from "../fixtures/run76-serp-slice";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function loadWithUncategorized() {
  const dir = mkdtempSync(join(tmpdir(), "uncategorized-ingest-"));
  tempDirs.push(dir);
  writeSerpAnalyticsDir(dir, {
    observations: run76UaeObservations(),
    uncategorizedRefs: UAE_UNCATEGORIZED_REFS,
  });
  return loadDeckInputsFromAnalyticsDir(dir).evidenceIndex;
}

describe("примеры прочих материалов не стирают строку выдачи", () => {
  it("позиция, запрос и движок остаются у наблюдения из примеров", () => {
    const entry = loadWithUncategorized()[UAE_UNCATEGORIZED_REFS[0]!];
    expect(entry?.domain).toBe("opensanctions.org");
    expect(entry?.rank).toBe(3);
    expect(entry?.query).toBe("viktor rashnikov");
    expect(entry?.engine).toBe("GOOGLE");
    expect(entry?.rankSource).toBe("serper");
  });

  it("все три перезаписанные строки прогона 76 сохраняют свою позицию", () => {
    const index = loadWithUncategorized();
    expect(UAE_UNCATEGORIZED_REFS.map((ref) => index[ref]?.rank)).toEqual([3, 4, 10]);
  });

  it("ref, которого в наблюдениях нет, ингестия по-прежнему добавляет", () => {
    // Материал без наблюдения виден отчёту только через примеры: охрана
    // запрещает перезапись, а не запись.
    const dir = mkdtempSync(join(tmpdir(), "uncategorized-ingest-new-"));
    tempDirs.push(dir);
    writeSerpAnalyticsDir(dir, {
      observations: run76UaeObservations(),
      uncategorizedRefs: ["inventory:obs-not-an-observation"],
    });
    const entry =
      loadDeckInputsFromAnalyticsDir(dir).evidenceIndex["inventory:obs-not-an-observation"];
    expect(entry?.kind).toBe("uncategorized");
  });
});
