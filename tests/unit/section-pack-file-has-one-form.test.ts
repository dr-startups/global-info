/**
 * Байты файла пакета — функция значения пакета, а не пути, которым пакет попал
 * в память.
 *
 * Форм было две: свежесобранный пакет писался в порядке ключей построителя,
 * а восстановленный из кэша (`loadPreviousPacks` → `SectionPackV2Schema`) — в
 * порядке объявления схемы. Прогон на тёплом кэше переписывал файл второй
 * формой, сохранив хэш, посчитанный над первой, — и файл переставал сходиться
 * сам с собой. Одна форма: `sectionPackJson`, рекурсивно отсортированные ключи.
 */

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  canonicalSectionPack,
  contentHashOf,
  sectionPackJson,
  FRAGMENT_ARTIFACT_PATHS,
  SECTION_PACK_SCHEMA_VERSION,
  SECTION_PACK_V2_SCHEMA_VERSION,
  SectionPackV2Schema,
  REPORT_SECTION_MANIFEST_VERSION,
  type SectionPackV2,
  type SlideContentContract,
} from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import {
  loadPreviousPacks,
  stripGptCopyFromSectionPacksOnDisk,
  writeSectionPackFile,
} from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import { migrateSectionPacksInDir } from "../../scripts/migrate-section-packs-v2-to-v3";

const SERP_REL = FRAGMENT_ARTIFACT_PATHS.RU_SERP;

/**
 * Пакет, написанный так, как его отдаёт построитель: ключи `content` — в
 * порядке автора фрагмента, ключи `metrics` — в порядке появления. Схемного
 * порядка здесь нет нигде, иначе проверка «форма одна» была бы тавтологией.
 */
function packFixture(over: Partial<SectionPackV2> = {}): SectionPackV2 {
  const slides: SlideContentContract[] = [
    {
      templateId: "search-table",
      title: "Поисковая выдача — Россия",
      schemaVersion: "slide-content-v1",
      slideId: "p12_ru_serp",
      baseSlotId: "p12_ru_serp",
      sectionId: "RU_PROFILE",
      isContinuation: false,
      continuationOf: null,
      continuationIndex: null,
      content: {
        table: { headers: ["№", "Заголовок"], rows: [["1", "Публикация"]] },
        whatWasFound: "Найдено 20 материалов.",
        narrative: "В выдаче преобладают деловые публикации.",
      },
      evidenceRefs: ["inventory:obs-01"],
      findingIds: ["finding-01"],
      metrics: { b: 1, A: 2, a: 3, B: 4 },
      visualAssetRefs: [],
    },
  ];
  return {
    slides,
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: "RU_PROFILE",
    sectionType: "RU_PROFILE",
    fragmentKey: "RU_SERP",
    caseId: "case-1",
    datasetId: "dataset-1",
    reportRunId: "run-1",
    sourceDatasetId: "dataset-1",
    contentVersion: "deck-sections-v114",
    promptVersion: "ru-serp-v1",
    contentHash: contentHashOf(slides),
    inputHash: "scoped-1:extras-1",
    generatedAt: "2026-08-25T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: ["finding-01"],
    evidenceRefs: ["inventory:obs-01"],
    inputs: {
      findingIds: ["finding-01"],
      evidenceRefs: ["inventory:obs-01"],
      metricSnapshotId: "snapshot-1",
    },
    metrics: {
      datasetCount: 20,
      displayedCount: 20,
      adverseDatasetCount: 2,
      adverseDisplayedCount: 2,
    },
    provenance: { providers: ["serper"], reportRunIds: ["run-1"], evidenceRefs: ["inventory:obs-01"] },
    validation: { passed: true, issues: [] },
    ...over,
  };
}

/** Тот же пакет в форме v2: миграция обязана вернуть из него ровно `packFixture()`. */
function legacyPackFixture(): Record<string, unknown> {
  const {
    caseId: _caseId,
    datasetId: _datasetId,
    sourceFindingIds: _findings,
    evidenceRefs: _refs,
    ...legacy
  } = packFixture();
  return { ...legacy, schemaVersion: SECTION_PACK_V2_SCHEMA_VERSION };
}

/** Манифест-владелец: без него миграция отказывается трогать пакет. */
function manifestFixture(): Record<string, unknown> {
  const pack = packFixture();
  return {
    schemaVersion: REPORT_SECTION_MANIFEST_VERSION,
    caseId: pack.caseId,
    reportRunId: pack.reportRunId,
    sourceDatasetId: pack.sourceDatasetId,
    generatedAt: pack.generatedAt,
    sectionOrder: ["RU_PROFILE"],
    entries: [
      {
        order: 1,
        sectionType: pack.sectionType,
        fragmentKey: pack.fragmentKey,
        artifactPath: SERP_REL,
        required: true,
        status: pack.status,
        contentHash: pack.contentHash,
        slideCount: pack.slides.length,
        validationPassed: true,
      },
    ],
    requiredSectionsFailed: [],
    buildBlocked: false,
  };
}

describe("файл пакета секции пишется одной формой", () => {
  it("ключи сортируются по кодовым единицам, а не по локали", () => {
    // `localeCompare` дал бы [a, A, b, B] и сделал бы байты файла — и хэш —
    // зависимыми от локали процесса, то есть от машины.
    const written = JSON.parse(sectionPackJson(packFixture())) as {
      slides: Array<{ metrics: Record<string, unknown> }>;
    };

    expect(Object.keys(written.slides[0].metrics)).toEqual(["A", "B", "a", "b"]);
  });

  it("повторная запись прочитанного пакета даёт те же байты", () => {
    const first = sectionPackJson(packFixture());
    const reparsed = SectionPackV2Schema.parse(JSON.parse(first));

    expect(sectionPackJson(reparsed)).toBe(first);
    // Порядок в файле не «какой получился», а канонический — на обоих кругах.
    expect(Object.keys((JSON.parse(first) as { slides: Array<{ content: object }> }).slides[0].content)).toEqual(
      ["narrative", "table", "whatWasFound"]
    );
  });

  it("пакет, поднятый из кэша, согласен со своим файлом и своим хэшем", () => {
    const root = mkdtempSync(join(tmpdir(), "section-pack-form-"));
    const path = join(root, SERP_REL);
    mkdirSync(dirname(path), { recursive: true });
    const bytes = sectionPackJson(packFixture());
    writeFileSync(path, bytes, "utf8");

    const previous = loadPreviousPacks(root).get("RU_SERP");
    expect(previous).toBeDefined();
    expect(contentHashOf(previous!.slides)).toBe(previous!.contentHash);
    expect(sectionPackJson(previous!)).toBe(bytes);
  });

  it("снятие gptCopy пишет тем же каноном и без завершающего перевода строки", () => {
    const root = mkdtempSync(join(tmpdir(), "section-pack-strip-"));
    const path = join(root, SERP_REL);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      sectionPackJson(
        packFixture({ gptCopy: { promptVersion: "slide-copy-v9", appliedSlides: 1 } })
      ),
      "utf8"
    );

    expect(stripGptCopyFromSectionPacksOnDisk(root)).toBe(1);

    const written = readFileSync(path, "utf8");
    expect(written).toBe(sectionPackJson(packFixture()));
    expect(written.endsWith("\n")).toBe(false);
  });

  it("все три записи пакета дают побайтово одинаковый файл", () => {
    /*
     * Три писателя: продуктовая запись пакета, снятие штампа GPT-копии и
     * офлайн-миграция v2→v3. Сверяются байты, а не исходники: грепом по
     * `sectionPackJson(` проходит и `${sectionPackJson(pack)}\n` — дословно
     * вторая из двух форм, ради которых шаг затевался.
     */
    const root = mkdtempSync(join(tmpdir(), "section-pack-writers-"));
    const expected = sectionPackJson(packFixture());

    const direct = join(root, "direct.json");
    writeSectionPackFile(direct, packFixture());

    const stripRoot = join(root, "strip");
    const stripped = join(stripRoot, SERP_REL);
    mkdirSync(dirname(stripped), { recursive: true });
    writeSectionPackFile(
      stripped,
      packFixture({ gptCopy: { promptVersion: "slide-copy-v9", appliedSlides: 1 } })
    );
    expect(stripGptCopyFromSectionPacksOnDisk(stripRoot)).toBe(1);

    const migrationRoot = join(root, "migration");
    const migrated = join(migrationRoot, SERP_REL);
    mkdirSync(dirname(migrated), { recursive: true });
    writeFileSync(migrated, JSON.stringify(legacyPackFixture(), null, 2), "utf8");
    writeFileSync(
      join(migrationRoot, "report-section-manifest.json"),
      JSON.stringify(manifestFixture(), null, 2),
      "utf8"
    );
    const outcomes = migrateSectionPacksInDir(migrationRoot);
    expect(outcomes.map((o) => o.result)).toEqual(["MIGRATED"]);

    expect(readFileSync(direct, "utf8"), "продуктовая запись").toBe(expected);
    expect(readFileSync(stripped, "utf8"), "снятие gptCopy").toBe(expected);
    expect(readFileSync(migrated, "utf8"), "миграция v2→v3").toBe(expected);
  });

  it("отдаёт в приложение обычный объект, а не беспрототипный", () => {
    /*
     * Сортирующий примитив строит `Object.create(null)` — иначе ключ
     * `__proto__` не стал бы собственным свойством и исчез бы из байтов. Но то,
     * что уходит **в приложение** (сборщик деки несёт это дальше в
     * `assembled-deck.json` и в полезную нагрузку рендерера), обязано быть
     * обычным значением: тип обещает `SectionPackV2`, и на нём когда-нибудь
     * позовут `hasOwnProperty`.
     */
    const canonical = canonicalSectionPack(packFixture());

    expect(Object.getPrototypeOf(canonical)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(canonical.slides[0])).toBe(Object.prototype);
    expect(Object.getPrototypeOf(canonical.slides[0].content.table)).toBe(Object.prototype);
    expect(() =>
      (canonical as unknown as { hasOwnProperty: (k: string) => boolean }).hasOwnProperty("slides")
    ).not.toThrow();
  });

  it("канонический пакет сохраняет ключ __proto__ собственным свойством", () => {
    // Обратная сторона той же монеты: обычный прототип не должен вернуться
    // ценой потерянного поля.
    const pack = packFixture();
    pack.slides[0].metrics = JSON.parse('{"__proto__": 7, "displayed": 20}') as Record<
      string,
      number
    >;

    const canonical = canonicalSectionPack(pack);

    expect(Object.keys(canonical.slides[0].metrics)).toContain("__proto__");
    expect(Object.getPrototypeOf(canonical.slides[0].metrics)).toBe(Object.prototype);
  });

  it("не теряет ключ __proto__", () => {
    /*
     * `JSON.parse` создаёт по такому имени собственное свойство, а присваивание
     * на литерале объекта — не создаёт: поле исчезло бы и из байтов, и из хэша,
     * хотя обычный `JSON.stringify` его печатает. Имена метрик сегодня зашиты в
     * построителях, но тихая потеря содержимого — не то, что здесь оставляют.
     */
    const metrics = JSON.parse('{"__proto__": 7, "displayed": 20}') as Record<string, number>;
    const pack = packFixture();
    pack.slides[0].metrics = metrics;

    const written = JSON.parse(sectionPackJson(pack)) as {
      slides: Array<{ metrics: Record<string, unknown> }>;
    };
    expect(Object.keys(written.slides[0].metrics)).toEqual(["__proto__", "displayed"]);

    const plain = packFixture();
    plain.slides[0].metrics = JSON.parse('{"displayed": 20}') as Record<string, number>;
    expect(contentHashOf(pack.slides)).not.toBe(contentHashOf(plain.slides));
  });
});
