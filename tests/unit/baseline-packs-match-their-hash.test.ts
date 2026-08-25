/**
 * Закоммиченные пакеты эталона написаны каноном и согласны со своим хэшем.
 *
 * У файла пакета одна форма — `sectionPackJson` (рекурсивно отсортированные
 * ключи), и над ней же считается `contentHash`. Поэтому байты файла зависят
 * только от значения пакета: собран он заново или взят из кэша, файл выходит
 * один и тот же. Пока форм было две, прогон на тёплом кэше переписывал эталон
 * второй формой, сохранив хэш от первой, — и эталон переставал соответствовать
 * сам себе.
 *
 * Проверка независима не инструментом, а входом: закоммиченные байты в момент
 * теста не производит никто, тест их только читает. Если он однажды начнёт
 * пакет **строить** и сверять с собой, он перестанет что-либо проверять.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  contentHashOf,
  sectionPackJson,
  FRAGMENT_ARTIFACT_PATHS,
  SectionPackV2Schema,
} from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const PACKS_ROOT = join(process.cwd(), "baselines", "report-72", "artifacts", "deck-sections");

const COMMITTED = Object.values(FRAGMENT_ARTIFACT_PATHS).map((rel) => {
  const bytes = readFileSync(join(PACKS_ROOT, rel), "utf8");
  return { rel, bytes, parsed: SectionPackV2Schema.safeParse(JSON.parse(bytes)) };
});

const WHAT_IT_MEANS = [
  "Файл писали не каноном (`sectionPackJson`) или правили руками.",
  "Пакет эталона — это то, чем принимают изменения деки: его байты обязаны быть",
  "функцией значения пакета, а не пути, которым пакет попал в память.",
  "",
  "Пересобрать эталон: npx tsx scripts/run-orion-deck-sections-report72.ts",
].join("\n");

describe("эталонные пакеты секций", () => {
  it("разбираются схемой пакета", () => {
    // Иначе следующие две проверки молчали бы о настоящей причине.
    const broken = COMMITTED.filter((c) => !c.parsed.success).map((c) => c.rel);
    expect(broken).toEqual([]);
  });

  it("записаны канонической формой", () => {
    const notCanonical = COMMITTED.filter(
      (c) => c.parsed.success && sectionPackJson(c.parsed.data) !== c.bytes
    ).map((c) => c.rel);

    expect(notCanonical, WHAT_IT_MEANS).toEqual([]);
  });

  it("совпадают со своим contentHash", () => {
    const mismatched = COMMITTED.filter(
      (c) => c.parsed.success && contentHashOf(c.parsed.data.slides) !== c.parsed.data.contentHash
    ).map((c) => c.rel);

    expect(mismatched, WHAT_IT_MEANS).toEqual([]);
  });
});
