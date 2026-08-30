/**
 * Снимок выдачи не рисует один материал дважды.
 *
 * Красные рамки живут не в деке и не в рендерере: их впечатывает в PNG
 * генератор ассета, а строки для колонки отбирает
 * `selectVisibleObservationsForEngine`. Отбор дедуплицировался по
 * идентификатору наблюдения — а ключ наблюдения включает запрос, поэтому один
 * и тот же адрес, найденный двумя запросами, вставал в колонку двумя строками.
 * На прогоне Кремлёва снимок ОАЭ показал пять результатов при трёх материалах.
 *
 * Отбор сводит строки тем же ключом, что дека и таблица (`serpMaterialKey`), и
 * добирает следующую строку взамен схлопнутой: ёмкость колонки — свойство
 * картинки, терять её нельзя.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selectVisibleObservationsForEngine } from "@/modules/digital-profile/serp-observation/synthetic-asset";
import type { PersistedSerpObservation } from "@/modules/digital-profile/serp-observation/types";
import { serpMaterialKey } from "@/modules/digital-profile/serp-observation/material-key";
import { buildCanonicalVisualAssets } from "@/modules/digital-profile/services/canonical-visual-assets";
import { svgToPngBase64 } from "@/modules/digital-profile/orion-golden/assets/media-asset-svg";
import { adverseVisualSidebar } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { FragmentExtras } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

let seq = 0;

/** Наблюдение выдачи: идентификатор свой у каждого, материал — по адресу. */
function obs(over: Partial<PersistedSerpObservation>): PersistedSerpObservation {
  seq += 1;
  return {
    id: `obs-${seq}`,
    searchDocumentId: null,
    caseId: "case-1",
    auditRunId: "run-1",
    queryId: `q-${seq}`,
    queryText: "umar nazarovich kremlev",
    provider: "serper",
    engine: "GOOGLE",
    surface: "organic",
    region: "UAE",
    language: "en",
    rank: seq,
    url: `https://example-${seq}.ae/page`,
    title: `Материал ${seq}`,
    snippet: null,
    domain: `example-${seq}.ae`,
    providerStatus: "OK",
    capturedAt: new Date(0),
    ...over,
  } as PersistedSerpObservation;
}

/** Тот же материал, найденный другим запросом: адрес и заголовок совпадают. */
function sameMaterial(row: PersistedSerpObservation, queryText: string): PersistedSerpObservation {
  return obs({
    url: row.url,
    title: row.title,
    domain: row.domain,
    queryText,
  });
}

function materials(rows: PersistedSerpObservation[]): Set<string> {
  return new Set(rows.map((r) => serpMaterialKey(r)));
}

describe("колонка снимка показывает каждый материал один раз", () => {
  it("один адрес под двумя наблюдениями встаёт в колонку одной строкой", () => {
    const first = obs({});
    const rows = [first, sameMaterial(first, "nazarovich umar"), obs({}), obs({})];
    const picked = selectVisibleObservationsForEngine(rows, "GOOGLE");
    expect(picked).toHaveLength(3);
    expect(materials(picked).size).toBe(3);
  });

  it("вместо схлопнутого повтора берётся следующая строка — колонка не укорачивается", () => {
    // Повтор заводится сразу за своим оригиналом: у него соседний ранг, и в
    // колонку он попадает раньше остальных. Отодвинутый в хвост повтор до
    // отбора не доезжает вовсе, и проверка становится пустой.
    const first = obs({});
    const duplicate = sameMaterial(first, "nazarovich umar");
    const rest = [obs({}), obs({}), obs({}), obs({}), obs({})];
    const rows = [first, duplicate, ...rest];
    const picked = selectVisibleObservationsForEngine(rows, "GOOGLE");
    expect(picked).toHaveLength(5);
    expect(materials(picked).size).toBe(5);
    // Добор идёт по рангу: пятой строкой встаёт четвёртая из «остальных».
    expect(picked.map((p) => p.url)).toEqual([
      first.url,
      rest[0]!.url,
      rest[1]!.url,
      rest[2]!.url,
      rest[3]!.url,
    ]);
  });

  it("живой набор ОАЭ: пять наблюдений трёх материалов не занимают всю колонку", () => {
    const sanctions = obs({
      url: "https://www.opensanctions.org/entities/Q55102113/",
      domain: "opensanctions.org",
      title: "Umar Nazarovich Kremlev",
    });
    const dossier = obs({
      url: "https://rucriminal.info/en/dosje/125",
      domain: "rucriminal.info",
      title: "Досье",
    });
    const pep = obs({
      url: "https://rupep.org/en/person/49596",
      domain: "rupep.org",
      title: "PEP",
    });
    const rows = [
      sanctions,
      sameMaterial(sanctions, "nazarovich umar"),
      dossier,
      sameMaterial(dossier, "nazarovich umar"),
      pep,
      obs({}),
      obs({}),
    ];
    const picked = selectVisibleObservationsForEngine(rows, "GOOGLE");
    expect(picked).toHaveLength(5);
    expect(materials(picked).size).toBe(5);
    expect(picked.filter((p) => /opensanctions|rucriminal|rupep/.test(p.url))).toHaveLength(3);
  });

  it("наблюдение без адреса, заголовка и домена своей строки не теряет", () => {
    const rows = [
      obs({ url: "", title: null, domain: null }),
      obs({ url: "", title: null, domain: null }),
    ];
    const picked = selectVisibleObservationsForEngine(rows, "GOOGLE");
    expect(picked).toHaveLength(2);
  });
});

describe("ключ читает адрес: общий заголовок две страницы не склеивает", () => {
  it("одинаковый заголовок при разных адресах даёт две строки колонки", () => {
    /*
     * Прежний ключ `домен|заголовок` сводил эти две страницы в одну, и вторая
     * пропадала с картинки; тест стоял здесь красной меткой той потери. Ключ
     * починен: материал опознаётся адресом, а по-разному обрезанный заголовок
     * одной страницы перестал плодить «материалы» — измерено на эталонном
     * отчёте, где один адрес лежал пятью ключами и таблица печатала шесть
     * страниц по два раза. Теперь тест держит обратную сторону того же
     * решения: две настоящие страницы с общим заголовком — два материала.
     */
    const first = obs({
      url: "https://www.forbes.ru/profile/sergei-glinka",
      domain: "forbes.ru",
      title: "Сергей Глинка",
    });
    const second = obs({
      url: "https://www.forbes.ru/profile/sergei-glinka-investitsii",
      domain: "forbes.ru",
      title: "Сергей Глинка",
    });
    const picked = selectVisibleObservationsForEngine([first, second], "GOOGLE");
    expect(picked).toHaveLength(2);
  });
});

/** Строка инвентаря, из которой генератор строит снимок. */
function inventoryRow(i: number, over?: Partial<RawInventoryItem>): RawInventoryItem {
  return {
    inventoryId: `inv-${i}`,
    caseId: "case-1",
    reportRunId: "run-1",
    source: "serper",
    provider: "serper",
    surface: "organic",
    region: "RU",
    sourceUrl: `https://rucriminal-${i}.info/dosje/${i}`,
    title: `Досье ${i}: компромат`,
    snippet: null,
    collectedAt: new Date(0).toISOString(),
    ...over,
  } as unknown as RawInventoryItem;
}

describe("настоящий скриншот перечисляет материалы, а не наблюдения", () => {
  it("один адрес, найденный двумя запросами, попадает в видимые строки один раз", async () => {
    const png = await svgToPngBase64(
      '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#345"/></svg>'
    );
    const rows = [
      inventoryRow(1),
      inventoryRow(2, {
        inventoryId: "inv-1-second-query",
        sourceUrl: "https://rucriminal-1.info/dosje/1",
        title: "Досье 1: компромат",
      }),
      inventoryRow(3),
    ];
    const visuals = await buildCanonicalVisualAssets({
      subjectName: "Умар Кремлёв",
      items: rows,
      allowImagePreviewNetwork: false,
      realSerpScreenshots: [
        {
          id: "real-ru-1",
          region: "RU",
          engine: "YANDEX",
          imageData: png,
          capturedAt: new Date().toISOString(),
        },
      ],
    });
    const meta = visuals.visualAssets.p10_ru_serp_visual?.[0];
    expect(meta?.kind).toBe("live_serp");
    const visibleItems = meta!.visibleItems ?? [];
    expect(new Set(visibleItems.map((v) => serpMaterialKey(v))).size).toBe(visibleItems.length);
    expect(visibleItems).toHaveLength(2);
  });
});

describe("подпись деки называет столько же, сколько нарисовано", () => {
  it("повтор материала в наборе не даёт ни лишней строки на снимке, ни лишнего объяснения", async () => {
    const rows = [
      inventoryRow(1),
      inventoryRow(2, {
        inventoryId: "inv-1-second-query",
        sourceUrl: "https://rucriminal-1.info/dosje/1",
        title: "Досье 1: компромат",
      }),
      inventoryRow(3),
      inventoryRow(4),
    ];
    const visuals = await buildCanonicalVisualAssets({
      subjectName: "Умар Кремлёв",
      items: rows,
      allowImagePreviewNetwork: false,
    });
    const meta = visuals.visualAssets.p10_ru_serp_visual?.[0];
    expect(meta).toBeTruthy();
    const visibleItems = meta!.visibleItems ?? [];
    // Нарисовано ровно столько строк, сколько материалов.
    expect(new Set(visibleItems.map((v) => serpMaterialKey(v))).size).toBe(visibleItems.length);

    const scoped = { evidenceIndex: {}, findings: [] } as unknown as ScopedFragmentInput;
    const extras = { visualAssets: visuals.visualAssets } as unknown as FragmentExtras;
    const sidebar = adverseVisualSidebar("p10_ru_serp_visual", extras, scoped);
    expect(sidebar.explanations).toHaveLength(visibleItems.filter((v) => v.adverse).length);
  });
});

/** Все `.ts` дерева исходников — сторожа читают их, а не список путей. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

describe("ответ «одна ли это строка» в проекте один", () => {
  const files = sourceFiles(join(process.cwd(), "src"));

  it("ключ материала определён ровно в одном файле", () => {
    /*
     * Ловится и объявление под своим именем, и вставленная формула ключа.
     * Одного имени мало: вторая реализация приходит стрелочной функцией и
     * зовётся по-своему. Одной формулы тоже мало: её можно переписать через
     * свои переменные. Поэтому два признака сразу — а «ключ материала» вообще
     * (`diffMaterialKeys` в свежести отчёта) под сторож не попадает: это другой
     * вопрос, там сравнивают составы наборов.
     */
    const declaresSerpKey = /(?:function|const|let|var)\s+\w*[Ss]erpMaterialKey\w*/u;
    const copiesFormula = /`\$\{domain\}\|\$\{title\}`/u;
    const defining = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return declaresSerpKey.test(src) || copiesFormula.test(src);
    });
    expect(defining.map((f) => f.replace(`${process.cwd()}/`, ""))).toEqual([
      "src/modules/digital-profile/serp-observation/material-key.ts",
    ]);
  });

  it("слой наблюдений не зависит от деки", () => {
    // Ключ переехал в `serp-observation/` именно затем, чтобы отбор строк для
    // картинки мог им пользоваться. Обратный импорт вернул бы цикл слоёв.
    const observationLayer = files.filter((f) => f.includes("/serp-observation/"));
    expect(observationLayer.length).toBeGreaterThan(0);
    const offenders = observationLayer.filter((f) => /from "[^"]*orion-golden/u.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
