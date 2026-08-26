import { describe, expect, it } from "vitest";
import {
  collectYandexGenAnswer,
  yandexGenAnswerQuery,
} from "@/modules/digital-profile/services/yandex-gen-answer-collection";
import type { SearchSurfaceInput } from "@/modules/digital-profile/search-surfaces/types";
import type { YandexGenAnswerOutcome } from "@/modules/digital-profile/providers/yandex-search-provider";
import {
  buildOrionQueryPlanDetailed,
  queriesForRegionPurpose,
} from "@/modules/digital-profile/search-surfaces/orion-query-plan";
import { buildSubjectQuerySet } from "@/modules/digital-profile/search-surfaces/subject-query-set";
import { surfaceDedupHash } from "@/modules/digital-profile/services/search-surface-service";
import { parseSubjectName } from "@/modules/digital-profile/risk-classifier/entity-disambiguation";

/**
 * Шаг AO. Ответ и названные Яндексом источники ложатся строками наблюдений по
 * арсенкинскому образцу; не-данные (сбой, отсутствие ключа) наблюдениями не
 * становятся — их место в записи о попытке.
 */

const SUBJECT = {
  caseId: "case-gen",
  fullName: "Мордашов Алексей Александрович",
  aliases: [] as string[],
  targetRegions: ["RU"],
  location: null,
  dateOfBirth: null,
  nationality: null,
  lawfulBasis: null,
  consentStatus: null,
};

const ANSWER_TEXT =
  "Алексей Александрович Мордашов — российский предприниматель, основной акционер «Северстали». " +
  "Родился 26 февраля 1965 года в Череповце. Возглавлял компанию с 1996 года, ".repeat(3) +
  "по данным открытых источников входит в число крупнейших промышленников страны.";

function answer(over: Partial<{
  answerText: string;
  sources: Array<{ url: string; title: string | null; used: boolean }>;
  isAnswerRejected: boolean;
}>) {
  return {
    answerText: over.answerText ?? ANSWER_TEXT,
    sources: over.sources ?? [],
    isAnswerRejected: over.isAnswerRejected ?? false,
    isBulletAnswer: false,
    fixedMisspellQuery: null,
    searchQueries: [],
    raw: { message: { content: over.answerText ?? ANSWER_TEXT } },
  };
}

async function collect(outcome: YandexGenAnswerOutcome): Promise<{
  rows: SearchSurfaceInput[];
  probe: Awaited<ReturnType<typeof collectYandexGenAnswer>>;
}> {
  const rows: SearchSurfaceInput[] = [];
  const probe = await collectYandexGenAnswer({
    caseId: "case-gen",
    loadSubject: async () => SUBJECT,
    fetchAnswer: async () => outcome,
    saveRows: async (_caseId, items) => {
      rows.push(...items);
      return items.length;
    },
  });
  return { rows, probe };
}

describe("запрос пробы — тот же, что первым идёт в плане", () => {
  it("совпадает с первым субъектным запросом RU-плана", () => {
    const parsed = parseSubjectName(SUBJECT.fullName);
    const set = buildSubjectQuerySet({
      profile: {
        fullName: SUBJECT.fullName,
        firstName: parsed.givenName ?? undefined,
        lastName: parsed.surname ?? undefined,
        patronymic: parsed.patronymic ?? undefined,
        variants: SUBJECT.aliases,
      },
      // Допущение «автодополнение на первый запрос не влияет» проверяется, а не
      // повторяется: ожидание строится с подсказками, продакшн — без них.
      suggestions: [
        { text: "мордашов биография", engine: "GOOGLE", region: "RU", rank: 1 },
        { text: "мордашов северсталь", engine: "GOOGLE", region: "RU", rank: 2 },
      ],
      region: "RU",
      language: "ru",
      capturedAt: "2026-08-20T00:00:00.000Z",
    });
    expect(set.queries.length).toBeGreaterThan(1);
    const { plan } = buildOrionQueryPlanDetailed(
      {
        fullName: SUBJECT.fullName,
        aliases: SUBJECT.aliases,
        targetRegions: SUBJECT.targetRegions,
        location: SUBJECT.location,
      },
      { primaryQueriesByRegion: { RU: set.queries.map((q) => q.query) }, regions: ["RU"] }
    );
    const planned = queriesForRegionPurpose(plan, "RU", ["subject_lookup"])[0]!.query;
    expect(yandexGenAnswerQuery(SUBJECT)).toBe(planned);
  });
});

describe("строки наблюдений по исходу вызова", () => {
  it("каждая строка объявляет свой вид — им аналитика отличает ответ от пометки", async () => {
    // Первое звено цепочки `contentKind`: сборщик единственный знает наверняка,
    // ответ это, его источник или пометка о пустоте. Опечатка или
    // переименование здесь тихо отменяют правило — `isEmptyMarker` откатится на
    // гадание по словам, и короткий ответ-отрицание снова станет «пустотой».
    const kindsOf = (rows: SearchSurfaceInput[]): unknown[] =>
      rows.map((r) => (r.rawMetadata as { contentKind?: unknown } | undefined)?.contentKind);

    const success = await collect({
      status: "SUCCESS",
      answer: answer({
        sources: [{ url: "https://forbes.ru/a", title: "Forbes", used: true }],
      }),
    });
    expect(kindsOf(success.rows)).toEqual(["answer_text", "answer_source"]);

    const empty = await collect({ status: "NO_RESULTS", answer: answer({ answerText: "" }) });
    expect(kindsOf(empty.rows)).toEqual(["absent"]);

    const rejected = await collect({
      status: "REJECTED",
      answer: answer({ answerText: "", isAnswerRejected: true }),
    });
    expect(kindsOf(rejected.rows)).toEqual(["answer_rejected"]);
  });

  it("успех: тело ответа плюс по строке на каждый названный источник", async () => {
    const { rows, probe } = await collect({
      status: "SUCCESS",
      answer: answer({
        sources: [
          { url: "https://ru.wikipedia.org/wiki/Мордашов", title: "Мордашов — Википедия", used: true },
          { url: "https://forbes.ru/profile/mordashov", title: "Профиль Forbes", used: false },
        ],
      }),
    });
    expect(probe.status).toBe("SUCCESS");
    expect(probe.query).toBe(yandexGenAnswerQuery(SUBJECT));
    expect(rows).toHaveLength(3);

    const body = rows[0]!;
    expect(body.type).toBe("AI_ANSWER");
    expect(body.source).toBe("REAL_YANDEX");
    expect(body.provider).toBe("YANDEX");
    expect(body.region).toBe("RU");
    expect(String(body.url)).toMatch(/^yandex-gen:\/\/answer\//);
    // Синтетический адрес клиенту источником не показывается.
    expect(String(body.url)).not.toMatch(/^https?:/);
    // Полный текст, без среза: обрезка claims до 300 знаков — ровно тот дефект,
    // из-за которого methodologyNote обещала полноту, а данные её не несли.
    expect(body.snippet).toBe(ANSWER_TEXT);
    expect(String(body.snippet).length).toBeGreaterThan(300);
    expect(body.title).toBe(`Нейро-ответ Яндекса (официальный API): ${probe.query}`);
    expect(body.query).toBe(probe.query);

    expect(rows.slice(1).map((r) => r.url)).toEqual([
      "https://ru.wikipedia.org/wiki/Мордашов",
      "https://forbes.ru/profile/mordashov",
    ]);
    expect(rows.slice(1).map((r) => r.title)).toEqual([
      "Мордашов — Википедия",
      "Профиль Forbes",
    ]);
    for (const src of rows.slice(1)) expect(src.type).toBe("AI_ANSWER");
  });

  it("отказ модели — один маркер словами «ответ не предоставлен», источников нет", async () => {
    const { rows, probe } = await collect({
      status: "REJECTED",
      answer: answer({
        answerText: "",
        isAnswerRejected: true,
        sources: [{ url: "https://forbes.ru/a", title: "Forbes", used: true }],
      }),
    });
    expect(probe.status).toBe("REJECTED");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toMatch(/ответ не предоставлен/);
    expect(rows[0]!.title).toMatch(/отказал/);
    // Отказ — это не «не нашлось»: слова обязаны различаться.
    expect(rows[0]!.title).not.toMatch(/не найден/);
  });

  it("пустой ответ без отказа — маркер «не найден»", async () => {
    const { rows, probe } = await collect({
      status: "NO_RESULTS",
      answer: answer({ answerText: "" }),
    });
    expect(probe.status).toBe("NO_RESULTS");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toMatch(/Нейро-ответ Яндекса: не найден/);
  });

  it("сбой наблюдением не становится: ноль строк, у пробы — код", async () => {
    const { rows, probe } = await collect({
      status: "FAILED",
      errorCode: "PROVIDER_TIMEOUT",
      message: "Provider request timed out.",
    });
    expect(rows).toEqual([]);
    expect(probe.status).toBe("FAILED");
    expect(probe.errorCode).toBe("PROVIDER_TIMEOUT");
  });

  it("непригодный ключ наблюдением не становится", async () => {
    const { rows, probe } = await collect({
      status: "NOT_CONFIGURED",
      errorCode: "PROVIDER_NOT_CONFIGURED",
      message: "YANDEX: переменная YANDEX_SEARCH_API_KEY не задана.",
    });
    expect(rows).toEqual([]);
    expect(probe.status).toBe("NOT_CONFIGURED");
    expect(probe.errorCode).toBe("PROVIDER_NOT_CONFIGURED");
  });

  it("тело и маркеры не делят один ключ дедупликации", async () => {
    // Ключ строки — `тип|источник|url`; титул в него не входит, пока адрес
    // непустой. Общий адрес у тела и маркера означал бы, что `createMany`
    // со `skipDuplicates` молча теряет ответ, пришедший после пустоты.
    const body = (await collect({ status: "SUCCESS", answer: answer({}) })).rows[0]!;
    const empty = (await collect({ status: "NO_RESULTS", answer: answer({ answerText: "" }) }))
      .rows[0]!;
    const rejected = (
      await collect({
        status: "REJECTED",
        answer: answer({ answerText: "", isAnswerRejected: true }),
      })
    ).rows[0]!;
    const hashes = [body, empty, rejected].map((r) =>
      surfaceDedupHash({
        type: String(r.type),
        source: String(r.source),
        url: r.url,
        query: r.query,
        title: r.title,
      })
    );
    expect(new Set(hashes).size).toBe(3);
  });

  it("повторный сбор того же ответа второй строки не рождает", async () => {
    const first = await collect({ status: "SUCCESS", answer: answer({}) });
    const second = await collect({ status: "SUCCESS", answer: answer({}) });
    expect(second.rows[0]!.url).toBe(first.rows[0]!.url);
    expect(second.rows[0]!.title).toBe(first.rows[0]!.title);
  });

  it("изменившийся ответ не теряется дедупликацией", async () => {
    const first = await collect({ status: "SUCCESS", answer: answer({}) });
    const second = await collect({
      status: "SUCCESS",
      answer: answer({ answerText: "Поисковик ответил иначе." }),
    });
    expect(second.rows[0]!.url).not.toBe(first.rows[0]!.url);
    // Титул при этом стабилен: он и есть то, чем страница называет ответ.
    expect(second.rows[0]!.title).toBe(first.rows[0]!.title);
  });

  it("все названные источники доезжают до наблюдений", async () => {
    const sources = Array.from({ length: 12 }, (_, i) => ({
      url: `https://source-${i}.ru/page`,
      title: `Источник ${i}`,
      used: i % 2 === 0,
    }));
    const { rows } = await collect({ status: "SUCCESS", answer: answer({ sources }) });
    expect(rows).toHaveLength(1 + sources.length);
    expect(rows.slice(1).map((r) => r.url)).toEqual(sources.map((s) => s.url));
  });
});
