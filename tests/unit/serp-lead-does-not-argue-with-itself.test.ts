/**
 * Лид страницы выдачи говорит о том, что на ней показано, и не объявляет
 * потерю, которой не было.
 *
 * Прогон 91, страницы 22, 28 и 67. Две беды на одном абзаце:
 *
 * 1. Под фразой «Показана выдача Яндекса **по запросу** «Кремлев Умар
 *    Назарович»» стояла справка «Выдача проверена по 5 запросам: …» — ответ на
 *    вопрос, которого страница одного запроса не задавала. Справка осталась от
 *    смешанной таблицы, разделённой партией 0041.
 * 2. «Позиции 17–20 в собранных данных отсутствуют: эти строки потеряны при
 *    сборе» — при том, что 18, 19 и 20 лежат в бандле, а собственный API
 *    Яндекса вернул ровно шестнадцать строк. Клиенту сообщено о потере
 *    двадцати шести позиций, которые собраны и оплачены.
 *
 * Новая формула отвечает на вопрос **что в данных**: сколько позиций вернул
 * источник. Потерю, которую допускает дека, объявляет не отчёт, а ворот
 * приёмки — отчёт о ней говорить не вправе.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSerpFragment,
  serpTablePageProse,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/serp";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const QUERY = "Кремлев Умар Назарович";
const EXTRA_QUERY = "умар кремлев рольф";

/** Корпус двух запросов: у набора есть знаменатель, и справка о нём строится. */
function scopedTwoQueries(): ScopedFragmentInput {
  const evidenceIndex: Record<string, unknown> = {};
  const refs: string[] = [];
  const add = (i: number, query: string, rank: number | undefined, host: string): void => {
    const ref = `i${i}`;
    evidenceIndex[ref] = {
      title: `Материал ${host}`,
      url: `https://${host}/umar`,
      domain: host,
      region: "RU",
      engine: "YANDEX",
      ...(rank ? { rank, rankSource: "yandex" } : {}),
      query,
      queryPurpose: "subject_lookup",
      subjectNameQuery: query === QUERY,
      subjectDecision: "SUBJECT_MATCH",
    };
    refs.push(ref);
  };
  for (let i = 1; i <= 16; i += 1) add(i, QUERY, i, `main-${i}.ru`);
  add(17, EXTRA_QUERY, 3, "extra-1.ru");
  add(18, EXTRA_QUERY, 4, "extra-2.ru");
  return {
    findings: [],
    surfaceUnits: [{ surface: "organic", region: "RU", claims: [], metrics: [], evidenceRefs: refs }],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

function serpSlides(): SlideContentContract[] {
  return buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scopedTwoQueries()).slides;
}

/** Весь клиентский текст листа: абзац плюс справка под ним. */
function pageText(slide: SlideContentContract): string {
  return [slide.content.narrative, slide.content.statusNote, slide.content.whatWasFound]
    .filter(Boolean)
    .join(" ");
}
const RANKS_16 = Array.from({ length: 16 }, (_, i) => i + 1);
const RANKS_20 = Array.from({ length: 20 }, (_, i) => i + 1);

describe("лид не спорит сам с собой", () => {
  it("страница одного запроса справки о наборе запросов не несёт", () => {
    const tableA = serpSlides().filter(
      (s) => s.metrics?.serpPositional === 1 && s.metrics?.serpExtraQueries !== 1
    );
    expect(tableA.length).toBeGreaterThan(0);
    for (const slide of tableA) {
      expect(pageText(slide)).toContain("Показана выдача Яндекса по запросу");
      expect(JSON.stringify(slide.content)).not.toContain("Выдача проверена по");
    }
  });

  it("знаменатель остаётся в отчёте и когда таблица Б пуста", () => {
    /*
     * Дополнительные запросы могут не найти ничего нового — тогда у таблицы Б
     * пустое состояние. Пока справка печаталась только рядом со строками,
     * прогон тремя запросами оставлял отчёт без единого места, где сказано,
     * сколько их было.
     */
    const scoped = scopedTwoQueries();
    const index = scoped.evidenceIndex as Record<string, Record<string, unknown>>;
    // Оба наблюдения второго запроса указывают на материалы таблицы А:
    // нового они не приносят, и таблица Б вырождается в пустое состояние.
    index.i17!.url = "https://main-1.ru/umar";
    index.i17!.domain = "main-1.ru";
    index.i18!.url = "https://main-2.ru/umar";
    index.i18!.domain = "main-2.ru";
    const slides = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped).slides;
    const extra = slides.find((s) => s.metrics?.serpExtraQueries === 1);
    expect(extra?.content.table).toBeUndefined();
    expect(String(extra?.content.narrative ?? "")).toContain("Выдача проверена по 2 запросам");
  });

  it("справка о наборе запросов печатается там, где объясняет колонку", () => {
    // У таблицы Б есть колонка «Найдено по запросу»: знаменатель «сколько
    // всего запросов было» объясняет именно её.
    const extra = serpSlides().filter((s) => s.metrics?.serpExtraQueries === 1);
    expect(extra.length).toBeGreaterThan(0);
    expect(JSON.stringify(extra[0]!.content)).toContain("Выдача проверена по 2 запросам");
  });
});

describe("страница называет причину пропуска, а не общую оговорку", () => {
  it("номер, которого нет ни у одного чтения, назван своими словами", () => {
    const prose = serpTablePageProse({
      engineLabel: "Яндекса",
      query: QUERY,
      collectedRanks: RANKS_16,
      printedRanks: RANKS_16,
      occupiedRanks: [],
      datasetKnowsSecondReading: true,
      positional: true,
    });
    expect(prose.head).toContain("Позиции 17–20 не вернул ни один источник выдачи в этом прогоне");
    expect(prose.head).not.toContain("потеряны при сборе");
  });

  it("общей оговорки о пропуске нет: на трёх пропусках из семи она была бы ложью", () => {
    /*
     * Правило «пропуск номера не означает пустоту в выдаче» отменено замером
     * прогона 91: на таблице GOOGLE/UAE «Umar Kremlev» оно встало бы над
     * пропусками 1, 4 и 9, где именно это и означает — источники их не вернули.
     */
    const prose = serpTablePageProse({
      engineLabel: "Яндекса",
      query: QUERY,
      collectedRanks: RANKS_16,
      printedRanks: RANKS_16,
      occupiedRanks: [],
      datasetKnowsSecondReading: true,
      positional: true,
    });
    expect(prose.head).not.toContain("пропуск номера не означает");
    expect(prose.head).not.toContain("в выдаче на дату сбора не было");
  });

  it("полная двадцатка объяснений не требует", () => {
    const prose = serpTablePageProse({
      engineLabel: "Яндекса",
      query: QUERY,
      collectedRanks: RANKS_20,
      positional: true,
    });
    expect(prose.head).not.toContain("вернул по этому запросу");
    expect(prose.head).not.toContain("отсутству");
  });

  it("занятый номер назван занятым, а не невернувшимся", () => {
    // Форма прогона 91: 17-й номер второе чтение намерило на материале,
    // показанном выше пятнадцатым.
    const prose = serpTablePageProse({
      engineLabel: "Яндекса",
      query: QUERY,
      collectedRanks: [...RANKS_16, 18, 19, 20],
      printedRanks: [...RANKS_16, 18, 19, 20],
      occupiedRanks: [17],
      datasetKnowsSecondReading: true,
      positional: true,
    });
    expect(prose.head).toContain("Позиция 17 занята материалом, показанным выше под другим номером");
    expect(prose.head).not.toContain("не вернул ни один источник");
  });

  it("набор без второго чтения называет только измеренную глубину", () => {
    const prose = serpTablePageProse({
      engineLabel: "Яндекса",
      query: QUERY,
      collectedRanks: RANKS_16,
      printedRanks: RANKS_16,
      occupiedRanks: [],
      datasetKnowsSecondReading: false,
      positional: true,
    });
    expect(prose.head).toContain("Поисковик вернул по этому запросу 16 позиций из 20");
    expect(prose.head).not.toContain("занята материалом");
  });

  it("непозиционная таблица о глубине источника не рассуждает", () => {
    const prose = serpTablePageProse({
      engineLabel: "Яндекса",
      query: QUERY,
      collectedRanks: [1, 2, 3],
      printedRanks: [1, 2, 3],
      occupiedRanks: [],
      datasetKnowsSecondReading: true,
      positional: false,
    });
    expect(prose.head).not.toContain("вернул по этому запросу");
    expect(prose.head).not.toContain("не вернул ни один источник");
  });
});

describe("глубина считается по данным, а не по напечатанному", () => {
  /** Корпус двадцати позиций, где две строки — одна статья с меткой и без. */
  function scopedWithMergedDuplicate(): ScopedFragmentInput {
    const evidenceIndex: Record<string, unknown> = {};
    const refs: string[] = [];
    const add = (i: number, rank: number, url: string, host: string): void => {
      const ref = `i${i}`;
      evidenceIndex[ref] = {
        title: `Материал ${host}`,
        url,
        domain: host,
        region: "RU",
        engine: "YANDEX",
        rank,
        rankSource: "yandex",
        query: QUERY,
        queryPurpose: "subject_lookup",
        subjectNameQuery: true,
        subjectDecision: "SUBJECT_MATCH",
      };
      refs.push(ref);
    };
    for (let i = 1; i <= 20; i += 1) {
      // Позиции 4 и 5 — одна и та же статья, различаются только меткой: ровно
      // тот случай, ради которого работа 5 и делается.
      if (i === 4) add(i, 4, "https://klerk.ru/materials/biografiya/", "klerk.ru");
      else if (i === 5) add(i, 5, "https://klerk.ru/materials/biografiya/?srsltid=AfmBOo1", "klerk.ru");
      else add(i, i, `https://main-${i}.ru/umar`, `main-${i}.ru`);
    }
    return {
      findings: [],
      surfaceUnits: [{ surface: "organic", region: "RU", claims: [], metrics: [], evidenceRefs: refs }],
      evidenceIndex,
      scope: { regions: ["RU"] },
      metricSnapshot: {},
    } as unknown as ScopedFragmentInput;
  }

  it("сведённый дубль не отнимает позицию у глубины", () => {
    /*
     * Заголовок считает по напечатанным номерам, лид — по собранным данным.
     * Пока лид считал по материалам, каждая склейка работы 5 отнимала номер:
     * «позиции 1–20 из ТОП-20» в заголовке и «19 позиций из 20» в лиде на
     * одной странице. Чем лучше работала одна работа партии, тем чаще врала
     * другая.
     */
    const slides = buildSerpFragment(
      "RU_SERP",
      "RU_PROFILE",
      "Россия",
      scopedWithMergedDuplicate()
    ).slides;
    const tableA = slides.filter(
      (s) => s.metrics?.serpPositional === 1 && s.metrics?.serpExtraQueries !== 1
    );
    const text = tableA.map((s) => String(s.content.narrative ?? "")).join(" ");
    // Двадцать собранных позиций — фразы о глубине нет вовсе. Пока лид считал
    // по материалам, сведённый дубль отнимал номер, и лист говорил «19 из 20»
    // под заголовком «позиции 1–20 из ТОП-20».
    expect(text).not.toContain("Поисковик вернул по этому запросу");
    expect(text).not.toContain("не вернул ни один источник");
    expect(text).not.toContain("занята материалом");
    // И строк действительно девятнадцать: дубль сведён, а сама статья
    // напечатана один раз — это и есть то, что владелец увидел на стр. 41.
    const rows = tableA.flatMap((s) => s.content.table?.rows ?? []);
    expect(rows).toHaveLength(19);
    expect(rows.filter((r) => r.join(" ").includes("klerk.ru"))).toHaveLength(1);
  });

  it("позиции второго чтения считаются позициями той же выдачи", () => {
    // Форма прогона 91: шестнадцать позиций своего чтения плюс 18, 19, 20 от
    // обогатителя. Собранных позиций девятнадцать, и лид называет девятнадцать.
    const scoped = scopedTwoQueries();
    const index = scoped.evidenceIndex as Record<string, Record<string, unknown>>;
    for (const [i, rank] of [18, 19, 20].entries()) {
      index[`tail${i}`] = {
        title: `Материал tail-${rank}.ru`,
        url: `https://tail-${rank}.ru/umar`,
        domain: `tail-${rank}.ru`,
        region: "RU",
        engine: "YANDEX",
        rank,
        rankSource: "arsenkin",
        /*
         * Поля второго чтения у этого корпуса **нет намеренно**: он сторожит
         * третью ветку — счёт измеренной глубины. С полем лид уходит в ветки
         * «занято»/«не вернул», глубина не считается вовсе, и обе ошибки её
         * счёта (сведённый дубль отнимает номер; фильтр источника прячет
         * позиции второго чтения) снова становятся неловимыми.
         */
        query: QUERY,
        queryPurpose: "subject_lookup",
        subjectNameQuery: true,
        subjectDecision: "SUBJECT_MATCH",
      };
      (scoped.surfaceUnits[0]!.evidenceRefs as string[]).push(`tail${i}`);
    }
    const slides = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped).slides;
    const text = slides
      .filter((s) => s.metrics?.serpPositional === 1 && s.metrics?.serpExtraQueries !== 1)
      .map((s) => String(s.content.narrative ?? ""))
      .join(" ");
    // Хвост печатается строками, а пропуск номера объясняется причиной.
    const rows = slides
      .filter((s) => s.metrics?.serpPositional === 1 && s.metrics?.serpExtraQueries !== 1)
      .flatMap((s) => s.content.table?.rows ?? []);
    expect(rows.map((r) => Number(r[0]))).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20,
    ]);
    // Набор о втором чтении не знает — работает третья ветка, и она считает
    // **девятнадцать** собранных позиций, а не шестнадцать позвоночника.
    expect(text).toContain("Поисковик вернул по этому запросу 19 позиций из 20");
  });
});

describe("слов о потере при сборе в дереве не осталось", () => {
  it("ни один построитель их не печатает", () => {
    // Греп-тест по построителям — как у прочих запретов лексики: фраза
    // возвращается правкой в одну строку, и заметить это должен тест.
    const dir = join(
      process.cwd(),
      "src/modules/digital-profile/orion-golden/deck-sections/fragment-builders"
    );
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => readFileSync(join(dir, f), "utf8").includes("потеряны при сборе"));
    expect(offenders).toEqual([]);
  });
});
