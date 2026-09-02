import { describe, expect, it } from "vitest";
import {
  YANDEX_GEN_SEARCH_ENDPOINT,
  YandexGenSearchParseError,
  buildYandexGenSearchBody,
  parseYandexGenSearchResponse,
} from "@/modules/digital-profile/providers/yandex-gen-search";

/**
 * Шаг AO. Контракт официального GenSearch снят с proto, а форма REST-стрима —
 * из документации, и живым ответом она не подтверждена. Проект уже обжигался на
 * выдуманных из документации фикстурах Arsenkin, поэтому разбор обязан быть
 * терпимым: единый объект, поток JSON Lines, обёртка `result`, snake_case
 * старого эндпойнта. Ошибка — типизированная, а не исключение сквозь стек.
 */

const FULL = {
  message: { role: "ROLE_ASSISTANT", content: "Алексей Мордашов — российский предприниматель." },
  sources: [
    { url: "https://ru.wikipedia.org/wiki/Мордашов", title: "Мордашов — Википедия", used: true },
    { url: "https://forbes.ru/profile/mordashov", title: "Профиль Forbes", used: false },
  ],
  searchQueries: ["мордашов алексей"],
  isAnswerRejected: false,
  isBulletAnswer: false,
};

describe("тело запроса GenSearch спрашивает ровно то, что задумано", () => {
  it("несёт один пользовательский message, folderId и searchType — и ничего сверх", () => {
    const body = buildYandexGenSearchBody({
      query: "Мордашов Алексей Александрович",
      folderId: "b1gtestfolder",
    });
    expect(Object.keys(body).sort()).toEqual(["folderId", "messages", "searchType"]);
    expect(body.messages).toEqual([
      { role: "ROLE_USER", content: "Мордашов Алексей Александрович" },
    ]);
    expect(body.folderId).toBe("b1gtestfolder");
    expect(body.searchType).toBe("SEARCH_TYPE_RU");
  });

  it("не включает исправление опечаток: исправленное ФИО — другой субъект", () => {
    const json = JSON.stringify(
      buildYandexGenSearchBody({ query: "Мордашов", folderId: "b1g" })
    );
    expect(json).not.toMatch(/fixMisspell|fix_misspell/i);
    expect(json).not.toMatch(/enableNrfmDocs|enableRichStructuredAnswer|getPartialResults/i);
    expect(json).not.toMatch(/"site"|"host"|"url"/);
  });

  it("адрес — тот же хост, что у органики", () => {
    expect(YANDEX_GEN_SEARCH_ENDPOINT).toBe(
      "https://searchapi.api.cloud.yandex.net/v2/gen/search"
    );
  });
});

describe("разбор ответа GenSearch терпим к форме", () => {
  it("читает единый JSON-объект", () => {
    const a = parseYandexGenSearchResponse(JSON.stringify(FULL));
    expect(a.answerText).toBe("Алексей Мордашов — российский предприниматель.");
    expect(a.sources.map((s) => s.url)).toEqual([
      "https://ru.wikipedia.org/wiki/Мордашов",
      "https://forbes.ru/profile/mordashov",
    ]);
    expect(a.sources[0]!.title).toBe("Мордашов — Википедия");
    expect(a.sources[0]!.used).toBe(true);
    expect(a.isAnswerRejected).toBe(false);
    expect(a.searchQueries).toEqual(["мордашов алексей"]);
  });

  it("берёт последний объект потока JSON Lines, а не первый обрезанный", () => {
    const chunks = [
      { message: { content: "Алексей" }, sources: [] },
      { message: { content: "Алексей Мордашов —" }, sources: [] },
      FULL,
    ]
      .map((c) => JSON.stringify(c))
      .join("\n");
    const a = parseYandexGenSearchResponse(chunks);
    expect(a.answerText).toBe("Алексей Мордашов — российский предприниматель.");
    expect(a.sources).toHaveLength(2);
  });

  it("снимает обёртку {result: …}", () => {
    const a = parseYandexGenSearchResponse(JSON.stringify({ result: FULL }));
    expect(a.answerText).toBe("Алексей Мордашов — российский предприниматель.");
    expect(a.sources).toHaveLength(2);
  });

  it("читает snake_case и links/titles старой формы без потери URL", () => {
    const old = {
      message: { content: "Ответ старого эндпойнта." },
      links: ["https://kommersant.ru/doc/1", "https://rbc.ru/doc/2"],
      titles: ["Коммерсантъ", "РБК"],
      is_answer_rejected: false,
      is_bullet_answer: true,
      fixed_misspell_query: "мордашов",
      search_queries: ["мордашов"],
    };
    const a = parseYandexGenSearchResponse(JSON.stringify(old));
    expect(a.answerText).toBe("Ответ старого эндпойнта.");
    expect(a.sources.map((s) => s.url)).toEqual([
      "https://kommersant.ru/doc/1",
      "https://rbc.ru/doc/2",
    ]);
    expect(a.sources.map((s) => s.title)).toEqual(["Коммерсантъ", "РБК"]);
    expect(a.isBulletAnswer).toBe(true);
    expect(a.fixedMisspellQuery).toBe("мордашов");
    expect(a.searchQueries).toEqual(["мордашов"]);
  });

  it("отказ модели читается как отказ, а не как пустой ответ", () => {
    const a = parseYandexGenSearchResponse(
      JSON.stringify({ message: { content: "" }, is_answer_rejected: true })
    );
    expect(a.isAnswerRejected).toBe(true);
    expect(a.answerText).toBe("");
  });

  it("сохраняет разобранный объект целиком — по нему форма пере-закрепляется", () => {
    const a = parseYandexGenSearchResponse(JSON.stringify({ result: FULL }));
    expect(a.raw).toEqual(FULL);
  });

  it("трейлер потока не выдаётся за пустой ответ", () => {
    // grpc-gateway закрывает поток служебной строкой. Если брать последний
    // объект безусловно, полный ответ выбрасывается, а исход читается как
    // «спросили — ответа нет»: отчёт получает измеренную пустоту вместо
    // собранного ответа, и следа не остаётся.
    const stream = [
      JSON.stringify(FULL),
      JSON.stringify({ trailer: { "grpc-status": "0" } }),
    ].join("\n");
    const a = parseYandexGenSearchResponse(stream);
    expect(a.answerText).toBe("Алексей Мордашов — российский предприниматель.");
    expect(a.sources).toHaveLength(2);
    expect(a.raw).toEqual(FULL);
  });

  it("ошибка в хвосте потока — сбой разбора, а не пустота", () => {
    const stream = [
      JSON.stringify(FULL),
      JSON.stringify({ error: { code: 13, message: "internal" } }),
    ].join("\n");
    expect(() => parseYandexGenSearchResponse(stream)).toThrow(YandexGenSearchParseError);
  });

  it("ошибка вместо ответа — сбой разбора", () => {
    expect(() =>
      parseYandexGenSearchResponse(JSON.stringify({ error: { code: 7, message: "denied" } }))
    ).toThrow(YandexGenSearchParseError);
  });

  it("отказ модели трейлером не затирается", () => {
    const stream = [
      JSON.stringify({ message: { content: "" }, is_answer_rejected: true }),
      JSON.stringify({ trailer: { "grpc-status": "0" } }),
    ].join("\n");
    expect(parseYandexGenSearchResponse(stream).isAnswerRejected).toBe(true);
  });

  it("непригодный ответ даёт типизированную ошибку, а не исключение сквозь стек", () => {
    expect(() => parseYandexGenSearchResponse("")).toThrow(YandexGenSearchParseError);
    expect(() => parseYandexGenSearchResponse("<html>captcha</html>")).toThrow(
      YandexGenSearchParseError
    );
    expect(() => parseYandexGenSearchResponse("data: {\"message\":{}}")).toThrow(
      YandexGenSearchParseError
    );
    // Потолок разбора — тот же, что у транспорта (8 МБ): двух пределов на один
    // вопрос «сколько мы готовы прочитать» в проекте нет.
    const huge = JSON.stringify({ message: { content: "я".repeat(9 * 1024 * 1024) } });
    expect(() => parseYandexGenSearchResponse(huge)).toThrow(YandexGenSearchParseError);
  });
});
