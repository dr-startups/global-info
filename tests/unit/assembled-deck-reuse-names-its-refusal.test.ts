/**
 * Отказ от реюза собранной деки называет себя — и годной считается только та
 * дека, которую ворота сборки приняли и которая цела на диске.
 *
 * Загрузчик отвечал `null` на пять разных причин сразу: файлов нет, дека от
 * другого набора, дека без идентификатора (пустая строка обходила сверку),
 * дека объявлена устаревшей после дозагрузки наблюдений, файлы битые. Наверху
 * этот `null` означал «собери заново» — и полная пересборка с обоими проходами
 * GPT происходила молча, а оператор видел лишь то, что «повторный рендер»
 * почему-то занял столько же, сколько пересборка.
 *
 * Второе, чего он не спрашивал вовсе: годна ли дека. `runDeckBuild` пишет деку
 * на диск **до** того, как её судят ворота подготовки, поэтому забракованная
 * сборка остаётся лежать целой и внешне неотличимой от принятой; а урезанный
 * или разошедшийся с манифестом файл деки загрузчик принимал и рапортовал
 * полное покрытие по манифесту, которого в этой деке уже нет.
 *
 * Дека здесь не лепится литералами: она снимается с настоящей подготовки и
 * портится по одному признаку за раз — иначе тест закрепил бы формат
 * артефактов, а не поведение загрузчика.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReusableAssembledDeck } from "@/modules/digital-profile/services/canonical-report-prepare";
import {
  ASSEMBLED_DECK_ARTIFACT,
  staleMarkerFileName,
} from "@/modules/digital-profile/services/unified-downstream-invalidation";
import { seedAssembledDeckDir } from "../fixtures/tiny-canonical-prepare";

let CASE_ID = "";
let DATASET_ID = "";

/** Каталог прогона с годной собранной декой: ровно то, что читает загрузчик. */
async function seedDeck(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "reuse-refusal-"));
  await seedAssembledDeckDir({ artifactsDir: root });
  return root;
}

function deckFile(root: string, name: string): string {
  return join(root, "deck", name);
}

/** Имя маркера берётся у писателя: своя копия строки развела бы стороны молча. */
const staleMarker = (root: string) =>
  join(root, staleMarkerFileName(ASSEMBLED_DECK_ARTIFACT));

function patch(root: string, name: string, fields: Record<string, unknown>): void {
  const path = deckFile(root, name);
  const current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...current, ...fields }, null, 2), "utf8");
}

function load(root: string) {
  return loadReusableAssembledDeck({
    artifactsDir: root,
    caseId: CASE_ID,
    expectedDatasetId: DATASET_ID,
  });
}

beforeAll(async () => {
  const ids = await seedAssembledDeckDir({
    artifactsDir: mkdtempSync(join(tmpdir(), "reuse-refusal-ids-")),
  });
  CASE_ID = ids.caseId;
  DATASET_ID = ids.datasetId;
});

describe("загрузчик собранной деки", () => {
  it("годную сборку отдаёт с хэшем и без причины отказа", async () => {
    const res = load(await seedDeck());
    expect(res.refusedReason).toBeNull();
    expect(res.reused?.datasetId).toBe(DATASET_ID);
    expect(res.reused?.assemblyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(res.reused?.rendererSlides.length).toBeGreaterThan(1);
  });

  it("отсутствие файлов называется отсутствием файлов", () => {
    const res = load(mkdtempSync(join(tmpdir(), "reuse-empty-")));
    expect(res.reused).toBeNull();
    expect(res.refusedReason).toBe("missing-files");
  });

  it("дека другого набора называет оба идентификатора", async () => {
    const foreign = "composite-cmreamy2t0002o30f29urzcog-59139ee6683b";
    const root = await seedDeck();
    patch(root, "assembled-deck.json", { datasetId: foreign, sourceDatasetId: foreign });
    const res = load(root);
    expect(res.reused).toBeNull();
    expect(res.refusedReason).toContain("dataset-mismatch");
    expect(res.refusedReason).toContain(foreign);
    expect(res.refusedReason).toContain(DATASET_ID);
  });

  it("дека без идентификатора мимо сверки не проскальзывает", async () => {
    // Раньше пустой идентификатор обходил сверку: `datasetId && datasetId !==
    // expected`. Дека, о происхождении которой ничего не известно, — не повод
    // считать её своей.
    const root = await seedDeck();
    patch(root, "assembled-deck.json", { datasetId: undefined, sourceDatasetId: undefined });
    const res = load(root);
    expect(res.reused).toBeNull();
    expect(res.refusedReason).toBe("dataset-missing");
  });

  it("дека чужого дела не реюзится и говорит об этом", async () => {
    const root = await seedDeck();
    patch(root, "assembled-deck.json", { caseId: "case-somebody-else" });
    const res = load(root);
    expect(res.reused).toBeNull();
    expect(res.refusedReason).toContain("case-mismatch");
  });

  it("стоп-маркер инвалидации отбивает реюз годной деки", async () => {
    const root = await seedDeck();
    writeFileSync(
      staleMarker(root),
      JSON.stringify({
        version: "downstream-stale-marker-v1",
        artifact: "assembled-deck.json",
        reason: "arsenkin-ingest-recovery",
        doNotReuse: true,
      }),
      "utf8"
    );
    const res = load(root);
    expect(res.reused).toBeNull();
    expect(res.refusedReason).toBe("stale-marker");
  });

  it("нечитаемый маркер закрывает реюз, а не открывает его", async () => {
    // Сказать «маркер битый, значит реюзим» — это молча переиспользовать деку,
    // о которой заявлено, что верить ей нельзя.
    const root = await seedDeck();
    writeFileSync(staleMarker(root), "{ обрыв", "utf8");
    expect(load(root).refusedReason).toBe("stale-marker");
  });

  it("маркер без запрета реюза реюз не отбивает", async () => {
    // Контроль: отбивает именно объявленный запрет, а не сам факт файла рядом.
    const root = await seedDeck();
    writeFileSync(
      staleMarker(root),
      JSON.stringify({ version: "downstream-stale-marker-v1", doNotReuse: false }),
      "utf8"
    );
    expect(load(root).refusedReason).toBeNull();
  });

  it("битые файлы называются битыми", async () => {
    const broken = await seedDeck();
    writeFileSync(deckFile(broken, "assembled-deck.json"), "{ не json", "utf8");
    expect(load(broken).refusedReason).toBe("corrupt:unreadable");

    const empty = await seedDeck();
    patch(empty, "assembled-deck.json", { slides: [] });
    expect(load(empty).refusedReason).toBe("corrupt:no-slides");

    const pageless = await seedDeck();
    patch(pageless, "report-deck-manifest.json", { pageCount: 0 });
    expect(load(pageless).refusedReason).toBe("corrupt:no-page-count");
  });

  it("значение null вместо деки — причина отказа, а не исключение", async () => {
    /*
     * `null` разбирается успешно и роняет читателя на первом же поле. Загрузчик
     * зовут из ветки резюме и из восстановления, и исключение оттуда — это
     * упавший прогон вместо пересборки и вылетевшая ручка восстановления.
     */
    const root = await seedDeck();
    writeFileSync(deckFile(root, "assembled-deck.json"), "null", "utf8");
    expect(load(root).refusedReason).toBe("corrupt:unreadable");

    const manifestless = await seedDeck();
    writeFileSync(deckFile(manifestless, "report-deck-manifest.json"), "null", "utf8");
    expect(load(manifestless).refusedReason).toBe("corrupt:unreadable");
  });
});

describe("годность деки загрузчик измеряет, а не принимает на слово", () => {
  it("неполное покрытие слотов реюз не проходит", async () => {
    // Ворота подготовки требуют 36 канонических слотов. Дека, не набравшая их,
    // уехала бы клиентом как полный отчёт: покрытие в ответе подготовки при
    // реюзе просто утверждалось константой.
    const root = await seedDeck();
    patch(root, "report-deck-manifest.json", { baseSlotCoverage: 30 });
    const res = load(root);
    expect(res.reused).toBeNull();
    expect(res.refusedReason).toBe("coverage-incomplete");
  });

  it("дека, разошедшаяся с манифестом, не выдаётся за целую", async () => {
    /*
     * Манифест и дека пишутся двумя записями: между ними прогон может умереть,
     * а файл — быть урезан. Отпечаток укладки в манифесте отвечает на вопрос,
     * та ли это дека, — иначе одна страница проезжает как отчёт на 36 слотов.
     */
    const root = await seedDeck();
    const deck = JSON.parse(readFileSync(deckFile(root, "assembled-deck.json"), "utf8")) as {
      slides: unknown[];
    };
    expect(deck.slides.length).toBeGreaterThan(1);
    patch(root, "assembled-deck.json", { slides: deck.slides.slice(0, 1) });
    const res = load(root);
    expect(res.reused).toBeNull();
    expect(res.refusedReason).toBe("deck-manifest-mismatch");
  });

  it("сборка без штампа приёмки не реюзится", async () => {
    /*
     * Забракованная воротами дека остаётся на диске целой: `runDeckBuild` пишет
     * её раньше, чем подготовка судит. Структурно она неотличима от принятой —
     * ворота качества текста говорят о словах на безупречных страницах, — и
     * единственный, кто знает вердикт, это сами ворота. Поэтому реюз требует
     * штампа приёмки, а не отсутствия жалобы.
     */
    const root = await seedDeck();
    rmSync(deckFile(root, "assembly-accepted.json"), { force: true });
    const res = load(root);
    expect(res.reused).toBeNull();
    expect(res.refusedReason).toBe("not-accepted");
  });

  it("штамп от другой сборки приёмкой не считается", async () => {
    // Приняты были другие байты — значит эту деку никто не судил.
    const root = await seedDeck();
    writeFileSync(
      deckFile(root, "assembly-accepted.json"),
      JSON.stringify({
        version: "deck-assembly-accepted-v1",
        assemblyHash: "0".repeat(64),
      }),
      "utf8"
    );
    expect(load(root).refusedReason).toBe("not-accepted");
  });

  it("текст сменился, раскладка нет — приёмка не переносится", async () => {
    /*
     * Отпечаток укладки видит только `slideKey:pageNumber`. Ключить им штамп
     * значило бы объявить принятой любую пересборку с тем же набором страниц —
     * в том числе ту, которую ворота качества текста забраковали за слова.
     */
    const root = await seedDeck();
    const deck = JSON.parse(readFileSync(deckFile(root, "assembled-deck.json"), "utf8")) as {
      slides: Array<Record<string, unknown>>;
    };
    patch(root, "assembled-deck.json", {
      slides: deck.slides.map((slide) => ({ ...slide, narrative: "другие слова" })),
    });
    expect(load(root).refusedReason).toBe("not-accepted");
  });
});
