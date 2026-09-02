import { describe, expect, it } from "vitest";
import {
  buildKnowledgeAiFragment,
  googleAnswerProbeHints,
  resolveEmptySurfaceCollection,
  type ScopedFragmentInput,
  type SurfaceCollectionHint,
} from "@/modules/digital-profile/orion-golden/deck-sections";
import type { SurfaceAnalysisUnit } from "@/modules/digital-profile/orion-golden/contracts/surface-analysis";

/**
 * Шаг AO. Страница «Россия — AI-ответы поисковых систем» печатает то, что
 * поисковик ответил о субъекте: полный текст, честную подпись и названные им
 * источники. Обещание methodologyNote («приводятся полностью, без сокращений»)
 * до этого шага данными не подкреплялось — в claim ехал заголовок, срезанный
 * до 300 знаков.
 */

const QUERY = "Мордашов Алексей Александрович";

const ANSWER = [
  "Алексей Александрович Мордашов — российский предприниматель и основной акционер «Северстали».",
  "Родился 26 февраля 1965 года в Череповце, окончил Ленинградский инженерно-экономический институт.",
  "С 1996 года возглавлял «Северсталь», позже сосредоточился на управлении активами группы «Севергрупп».",
  "Помимо металлургии, структуры предпринимателя владеют долями в туристическом и машиностроительном бизнесе.",
  "Открытые источники отмечают участие предпринимателя в благотворительных и образовательных программах.",
].join(" ");

/**
 * Длинный ответ из **различных** предложений.
 *
 * Повтор одного и того же абзаца делал проверку полноты вакуумной: у четырнадцати
 * копий словарь тот же, что у одной, и потеря целого блока сверкой «каждое слово
 * напечатано» не ловилась. Каждое предложение здесь уникально, а сверяется
 * дословная склейка, а не набор слов.
 */
const LONG_ANSWER = Array.from(
  { length: 60 },
  (_, i) =>
    `Абзац ${i + 1} ответа: поисковая система приводит сведение номер ${i + 1} о предпринимателе, ` +
    `со ссылкой на публикацию ${i + 1} и с оговоркой о неполноте открытых источников.`
).join(" ");

const METRIC_SNAPSHOT = {
  metricSnapshotId: "m-1",
  datasetId: "d-1",
  reportRunId: "r-1",
  baseCount: 100,
  enrichmentCount: 0,
  compositeCount: 100,
  subjectMatchCount: 30,
  likelySubjectCount: 0,
  ambiguousCount: 0,
  otherSubjectCount: 0,
  adverseFindingCount: 0,
  perRegionCounts: { RU: 100 },
};

function unit(refs: string[]): SurfaceAnalysisUnit {
  return {
    surface: "ai_answers",
    region: "RU",
    engine: "YANDEX",
    metrics: [
      { key: "totalCount", value: refs.length, sampleStatus: "MEASURED", denominator: refs.length },
      { key: "emptyMarkerCount", value: 0, sampleStatus: "MEASURED" },
    ],
    claims: [],
    evidenceRefs: refs,
  } as unknown as SurfaceAnalysisUnit;
}

function scoped(input: {
  units: SurfaceAnalysisUnit[];
  evidenceIndex: Record<string, Record<string, unknown>>;
  hints?: SurfaceCollectionHint[];
}): ScopedFragmentInput {
  return {
    subject: { displayName: "Мордашов Алексей Александрович", aliases: [] },
    findings: [],
    surfaceUnits: input.units,
    metricSnapshot: METRIC_SNAPSHOT,
    scope: { regions: ["RU"], surfaces: ["ai_answers"], subjectMatch: null, findingIds: null },
    evidenceIndex: input.evidenceIndex,
    surfaceCollectionHints: input.hints ?? [],
  } as unknown as ScopedFragmentInput;
}

function aiSlides(s: ScopedFragmentInput) {
  const out = buildKnowledgeAiFragment("RU_KNOWLEDGE_AI", "RU_PROFILE", "Россия", s, {} as never);
  const slides = out.slides.filter((x) => x.baseSlotId === "p19_ru_knowledge_2");
  if (slides.length === 0) throw new Error("страница AI-ответов не собралась");
  return slides;
}

const GEN_INDEX = {
  "inventory:obs-body": {
    kind: "ai_answer",
    region: "RU",
    engine: "YANDEX",
    provider: "yandex",
    query: QUERY,
    title: `Нейро-ответ Яндекса (официальный API): ${QUERY}`,
    url: "yandex-gen://answer/abc123",
    snippet: ANSWER,
  },
  "inventory:obs-src-1": {
    kind: "ai_answer",
    region: "RU",
    engine: "YANDEX",
    query: QUERY,
    title: "Мордашов, Алексей Александрович — Википедия",
    url: "https://ru.wikipedia.org/wiki/Мордашов",
    domain: "ru.wikipedia.org",
  },
  "inventory:obs-src-2": {
    kind: "ai_answer",
    region: "RU",
    engine: "YANDEX",
    query: QUERY,
    title: "Профиль предпринимателя",
    url: "https://forbes.ru/profile/mordashov",
    domain: "forbes.ru",
  },
};

describe("страница печатает сам ответ, а не его заголовок", () => {
  const slides = () =>
    aiSlides(
      scoped({
        units: [unit(Object.keys(GEN_INDEX))],
        evidenceIndex: GEN_INDEX,
      })
    );

  it("текст ответа напечатан дословно и без обрезки", () => {
    const joined = slides()
      .flatMap((s) => s.content.bullets ?? [])
      .join(" ");
    // Сверяется дословная склейка, а не словарь: потеря любого блока — даже
    // одного из середины — делает эту подстроку недостижимой.
    expect(joined).toContain(ANSWER);
    // Заголовок вместо текста — ровно тот дефект, который шаг чинит.
    expect(joined).not.toContain("Нейро-ответ Яндекса (официальный API):");
    expect(ANSWER.length).toBeGreaterThan(300);
  });

  it("подпись называет способ получения и не выдаёт ответ за блок «Алисы»", () => {
    const text = slides()
      .flatMap((s) => s.content.bullets ?? [])
      .join(" ");
    expect(text).toContain("получен официальным Yandex Search API");
    expect(text).toContain(QUERY);
    expect(text).not.toMatch(/ИИ-ответ \(Алиса\)/);
  });

  it("источники перечислены словами, их ссылки — в evidenceRefs страницы", () => {
    const all = slides();
    const text = all.flatMap((s) => s.content.bullets ?? []).join(" ");
    expect(text).toContain("Мордашов, Алексей Александрович — Википедия");
    expect(text).toContain("ru.wikipedia.org");
    expect(text).toContain("forbes.ru");
    const refs = new Set(all.flatMap((s) => s.evidenceRefs ?? []));
    expect(refs.has("inventory:obs-src-1")).toBe(true);
    expect(refs.has("inventory:obs-src-2")).toBe(true);
  });

  it("синтетический адрес тела не выдаётся за источник", () => {
    const text = JSON.stringify(slides().map((s) => s.content));
    expect(text).not.toContain("yandex-gen://");
    expect(text).not.toContain("answer/abc123");
  });

  it("длинный ответ разъезжается продолжениями, не теряя ни одного блока", () => {
    const long = {
      ...GEN_INDEX,
      "inventory:obs-body": { ...GEN_INDEX["inventory:obs-body"], snippet: LONG_ANSWER },
    };
    const all = aiSlides(scoped({ units: [unit(Object.keys(long))], evidenceIndex: long }));
    expect(all.length).toBeGreaterThan(1);
    const printed = all.flatMap((s) => s.content.bullets ?? []).join(" ");
    // Дословно, целиком и подряд: обещание «приводятся полностью, без
    // сокращений» либо истинно, либо эта подстрока не найдётся.
    expect(printed).toContain(LONG_ANSWER);
  });
});

describe("каждый напечатанный ответ подписан тем, чей он", () => {
  it("ответ, собранный обогатителем, не выдаётся за утверждение отчёта", () => {
    // У арсенкинских ответов нет ни схемы `yandex-gen://`, ни адреса вовсе;
    // без подписи текст читается как утверждение отчёта о человеке.
    const index = {
      "inventory:obs-arsenkin": {
        kind: "ai_answer",
        region: "RU",
        engine: "YANDEX",
        provider: "arsenkin",
        query: QUERY,
        title: `ИИ-ответ (Алиса): ${QUERY}`,
        snippet: ANSWER,
      },
    };
    const joined = aiSlides(scoped({ units: [unit(Object.keys(index))], evidenceIndex: index }))
      .flatMap((s) => s.content.bullets ?? [])
      .join(" ");
    expect(joined).toContain(ANSWER);
    expect(joined).toMatch(/Ответ поискового ИИ Яндекса/);
    // Официальным API он не получен — так утверждать нельзя.
    expect(joined).not.toContain("официальным Yandex Search API");
  });

  it("подпись про официальный API выводится из провайдера наблюдения", () => {
    // Схема адреса — деталь хранения; подпись обязана следовать данным.
    const index = {
      "inventory:obs-body": {
        ...GEN_INDEX["inventory:obs-body"],
        url: "gen-answer://stored-differently/1",
      },
    };
    const joined = aiSlides(scoped({ units: [unit(Object.keys(index))], evidenceIndex: index }))
      .flatMap((s) => s.content.bullets ?? [])
      .join(" ");
    expect(joined).toContain("получен официальным Yandex Search API");
  });

  it("неназванному движку ответ не приписывается ни Яндексу, ни Google", () => {
    // `mapEngineBucket` отдаёт «UNKNOWN» при пустом движке, то есть вход
    // достижим данными; приписать такой ответ Яндексу — ложное утверждение о
    // происхождении в клиентском тексте.
    for (const engine of ["UNKNOWN", "", "BING", undefined]) {
      const index = {
        "inventory:obs-body": {
          kind: "ai_answer",
          region: "RU",
          provider: "arsenkin",
          query: QUERY,
          title: "ИИ-ответ: сводка",
          snippet: ANSWER,
          ...(engine === undefined ? {} : { engine }),
        },
      };
      const joined = aiSlides(scoped({ units: [unit(Object.keys(index))], evidenceIndex: index }))
        .flatMap((s) => s.content.bullets ?? [])
        .join(" ");
      expect(joined, String(engine)).toContain(ANSWER);
      expect(joined, String(engine)).toMatch(/Ответ поискового ИИ/);
      expect(joined, String(engine)).not.toMatch(/Яндекс/);
      expect(joined, String(engine)).not.toMatch(/Google/);
    }
  });

  it("метка «относится к другому лицу» стоит на каждом листе ответа", () => {
    const index = {
      "inventory:obs-body": {
        ...GEN_INDEX["inventory:obs-body"],
        snippet: LONG_ANSWER,
        subjectDecision: "OTHER_SUBJECT",
      },
    };
    const all = aiSlides(scoped({ units: [unit(Object.keys(index))], evidenceIndex: index }));
    const blocks = all.flatMap((s) => s.content.bullets ?? []);
    expect(blocks.length).toBeGreaterThan(1);
    // Пометка на первом блоке и её отсутствие на продолжениях — это и есть
    // «чужой материал работает на профиль субъекта» со второй страницы.
    for (const b of blocks) expect(b).toMatch(/^Относится к другому лицу: /);
  });
});

describe("страница без ответа говорит словами, что именно случилось", () => {
  const markerIndex = (title: string) => ({
    "inventory:obs-marker": {
      kind: "ai_answer",
      region: "RU",
      engine: "YANDEX",
      query: QUERY,
      title,
      url: "yandex-gen://answer/abc123",
      snippet: "",
    },
  });

  it("отказ модели напечатан словами и не назван «не найдено»", () => {
    const title =
      "Нейро-ответ Яндекса: ответ не предоставлен — модель Яндекса отказалась отвечать на запрос (этические ограничения)";
    const all = aiSlides(
      scoped({ units: [unit(["inventory:obs-marker"])], evidenceIndex: markerIndex(title) })
    );
    const text = all.flatMap((s) => s.content.bullets ?? []).join(" ");
    expect(text).toContain("ответ не предоставлен");
    expect(text).toMatch(/отказал/);
    // Страница остаётся страницей с данными: слова отказа нельзя терять в
    // пустом состоянии покрытия.
    expect(all[0]!.emptyStateReason).not.toBe("no-ai-answers");
  });

  it("отказ считается измеренной пустотой, а не находкой", async () => {
    const { NOT_FOUND_PATTERNS } = await import(
      "@/modules/digital-profile/orion-golden/analytics/surface-analyzers"
    );
    expect(
      NOT_FOUND_PATTERNS.test(
        "Нейро-ответ Яндекса: ответ не предоставлен — модель Яндекса отказалась отвечать"
      )
    ).toBe(true);
    expect(NOT_FOUND_PATTERNS.test("Нейро-ответ Яндекса: не найден")).toBe(true);
  });

  it("измеренный Яндекс сильнее арсенкинского «не спрашивали» внутри того же движка", () => {
    const status = resolveEmptySurfaceCollection(
      scoped({
        units: [],
        evidenceIndex: {},
        hints: [
          {
            surface: "ai_answers",
            region: "RU",
            engine: "YANDEX",
            status: "NOT_COLLECTED",
            provider: "arsenkin",
            errorCode: "DISABLED_BY_TOOLS",
          },
          {
            surface: "ai_answers",
            region: "RU",
            engine: "YANDEX",
            status: "NO_RESULTS",
            provider: "yandex",
            errorCode: null,
          },
        ],
      }),
      "ai_answers"
    );
    expect(status.kind).toBe("MEASURED_EMPTY");
  });

  it("сорванный сбор нейро-ответа не выдаётся за «не спрашивали»", () => {
    const status = resolveEmptySurfaceCollection(
      scoped({
        units: [],
        evidenceIndex: {},
        hints: [
          {
            surface: "ai_answers",
            region: "RU",
            engine: "YANDEX",
            status: "ERROR",
            provider: "yandex",
            errorCode: "PROVIDER_TIMEOUT",
          },
        ],
      }),
      "ai_answers"
    );
    expect(status.kind).toBe("COLLECTION_FAILED");
    expect(status.reasonLabel).toMatch(/ошибк|не удалось/i);
  });

  it("ненастроенный провайдер называется причиной, а не «инструментом вне состава»", () => {
    const status = resolveEmptySurfaceCollection(
      scoped({
        units: [],
        evidenceIndex: {},
        hints: [
          {
            surface: "ai_answers",
            region: "RU",
            engine: "YANDEX",
            status: "NOT_COLLECTED",
            provider: "yandex",
            errorCode: "PROVIDER_NOT_CONFIGURED",
          },
        ],
      }),
      "ai_answers"
    );
    expect(status.kind).toBe("NOT_COLLECTED");
    expect(status.reasonLabel).toMatch(/не настроен/);
    expect(status.reasonLabel).not.toMatch(/не входил в состав/);
  });
});

describe("факт про Google не гаснет от ответа Яндекса", () => {
  it("наблюдения Яндекса не отменяют «Google спрошен, готового ответа нет»", () => {
    const hints = googleAnswerProbeHints(
      [
        { surface: "organic", region: "RU", engine: "GOOGLE" },
        { surface: "ai_answer", region: "RU", engine: "YANDEX" },
      ],
      []
    );
    expect(hints.map((h) => h.engine)).toEqual(["GOOGLE"]);
  });

  it("собственный ответ Google подсказку по-прежнему гасит", () => {
    const hints = googleAnswerProbeHints(
      [
        { surface: "organic", region: "RU", engine: "GOOGLE" },
        { surface: "ai_answer", region: "RU", engine: "GOOGLE" },
      ],
      []
    );
    expect(hints).toEqual([]);
  });

  it("измеренная ячейка Яндекса не глушит выведенный факт про Google", () => {
    const hints = googleAnswerProbeHints(
      [{ surface: "organic", region: "RU", engine: "GOOGLE" }],
      [
        {
          surface: "ai_answers",
          region: "RU",
          engine: "YANDEX",
          status: "NO_RESULTS",
          provider: "yandex",
          errorCode: null,
        },
      ]
    );
    expect(hints).toHaveLength(1);
  });
});
