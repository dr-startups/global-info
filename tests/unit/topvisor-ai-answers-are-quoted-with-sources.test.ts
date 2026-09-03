/**
 * AI-ответы Topvisor: текст поисковика и его ссылки.
 *
 * Пилот T0 установил: ответ приходит **не** снимком выдачи, а внутри
 * `serp_features` ответа `get/positions_2/history` — объектом
 * `aiOverview {snippetTitle, snippetBody, links[]}`, и туда же пишется Алиса.
 * Значит, за прогон нужны два чтения, и это второе.
 *
 * Что здесь закреплено:
 *
 * — **Ключ истории позиций — не ключ снимка.** У снимка это
 *   `дата:позиция:индексРегиона`, у позиций — `дата:идентификаторПроекта:
 *   индексРегиона`. Формы неотличимы на глаз, и перепутать их значит принять
 *   номер проекта за место в выдаче.
 * — **Берётся полный ответ, а не превью.** `aiOverviewPreview` — те же поля,
 *   обрезанные до пары предложений; заплатив за `with_ai_overview_full`, читать
 *   надо полный.
 * — **Тело ответа и его источники — разные строки.** Дека печатает тело как
 *   текст с подписью «чей это ответ», а ссылки — строками «Источник: …»;
 *   признак различения — публичный адрес у строки-источника и его отсутствие
 *   у тела (`isAnswerBody` в построителе).
 * — **Каждое утверждение прослеживается до URL:** ответ без единой ссылки в
 *   отчёт как факт не идёт.
 */

import { describe, expect, it } from "vitest";
import { aiAnswersFromPositions } from "@/modules/digital-profile/providers/topvisor/adapters/ai-answers";
import { parsePositionsKey } from "@/modules/digital-profile/providers/topvisor/adapters/positions";
import { TOPVISOR_AUDIT_REGIONS } from "@/modules/digital-profile/providers/topvisor/regions";
import { loadTopvisorFixture } from "@/modules/digital-profile/providers/topvisor/fixtures/fixture-call";

const region = (key: string) => TOPVISOR_AUDIT_REGIONS.find((r) => r.key === key)!;
const PROVENANCE = {
  caseId: "case-1",
  unifiedJobId: "job-1",
  enrichmentRunId: "topvisor-positions-job-1",
  providerTaskId: "pt-1",
  externalTaskId: "32742967:2026-09-03",
};
const RU = ["Умар Кремлёв IBA", "Кремлёв федерация бокса"];
const UAE = ["Umar Kremlev investigation", "Umar Kremlev boxing"];

function build(regionKey: string, regionIndex: number, queries: readonly string[]) {
  return aiAnswersFromPositions({
    body: loadTopvisorFixture("read-positions-correct"),
    region: region(regionKey),
    regionIndex,
    queries,
    provenance: PROVENANCE,
  });
}

describe("ключ истории позиций", () => {
  it("несёт дату, проект и регион — номера выдачи в нём нет", () => {
    expect(parsePositionsKey("2026-09-03:32742967:2520")).toEqual({
      date: "2026-09-03",
      projectId: 32742967,
      regionIndex: 2520,
    });
    expect(parsePositionsKey("мусор")).toBeNull();
  });
});

describe("AI-ответ Яндекса (Алиса)", () => {
  it("тело ответа — отдельная строка без публичного адреса, с разметкой, снятой из текста", () => {
    const out = build("yandex-moscow", 1, RU);
    const bodies = out.observations.filter((o) => !o.url);

    expect(bodies.length).toBeGreaterThan(0);
    const body = bodies.find((o) => o.query === "Умар Кремлёв IBA")!;
    expect(body).toBeDefined();
    expect(body.surface).toBe("ai_answer");
    expect(body.kind).toBe("other");
    expect(body.provider).toBe("topvisor-yandex");
    expect(body.engine).toBe("YANDEX");
    expect(body.region).toBe("RU");
    expect(String(body.snippet)).toContain("Умар Назарович Кремлёв");
    expect(String(body.snippet)).not.toMatch(/<b>|<u>|<br>/);
    // Заголовка у ответа обычно нет — тогда его не выдумываем, а называем видом.
    expect(String(body.title ?? "")).not.toBe("");
  });

  it("берётся полный ответ, а не превью", () => {
    const out = build("yandex-moscow", 1, RU);
    const body = out.observations.find((o) => !o.url && o.query === "Умар Кремлёв IBA")!;

    // Превью в этой же записи обрезано до пары сотен знаков; полный — длиннее.
    expect(String(body.snippet).length).toBeGreaterThan(300);
  });

  it("каждая ссылка ответа — своя строка-источник с публичным адресом", () => {
    const out = build("yandex-moscow", 1, RU);
    const sources = out.observations.filter((o) => o.url && o.query === "Умар Кремлёв IBA");

    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      expect(String(s.url)).toMatch(/^https?:\/\//);
      expect(s.surface).toBe("ai_answer");
      expect(s.provider).toBe("topvisor-yandex");
      // У строки-источника своего текста нет: её печатают строкой «Источник: …».
      expect(s.snippet ?? "").toBe("");
    }
    expect(sources.map((s) => s.url)).toContain(
      "https://tass.ru/encyclopedia/person/kremlev-umar-nazarovich"
    );
  });
});

describe("регион ответа", () => {
  it("ответ берётся только из своего региона, хотя фраза отвечена во всех трёх", () => {
    /*
     * «Кремлёв федерация бокса» имеет AI-блок и у Яндекса Москвы, и у Google
     * Москвы, и в Дубае. Без сверки индекса региона все три легли бы в одну
     * таблицу: клиент прочитал бы дубайский ответ как ответ Яндекса.
     */
    const out = aiAnswersFromPositions({
      body: loadTopvisorFixture("read-positions-correct"),
      region: region("yandex-moscow"),
      regionIndex: 1,
      queries: ["Кремлёв федерация бокса"],
      provenance: PROVENANCE,
    });
    const bodies = out.observations.filter((o) => !o.url);

    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.engine).toBe("YANDEX");
    expect(new Set(out.observations.map((o) => o.engine))).toEqual(new Set(["YANDEX"]));
  });
});

describe("AI Overview Google", () => {
  it("Дубай: свои фразы, движок GOOGLE, регион UAE", () => {
    const out = build("google-dubai", 2520, UAE);
    const body = out.observations.find((o) => !o.url)!;

    expect(body.query).toBe("Umar Kremlev investigation");
    expect(body.engine).toBe("GOOGLE");
    expect(body.region).toBe("UAE");
    expect(body.provider).toBe("topvisor-google");
  });

  it("чужая по региону фраза в ответ не идёт", () => {
    // Проект проверяет все фразы во всех регионах: русская фраза с ответом в
    // дубайской выдаче — издержка одного проекта на кейс, а не строка отчёта.
    const out = build("google-dubai", 2520, UAE);

    expect(out.observations.map((o) => o.query)).not.toContain("Кремлёв федерация бокса");
    expect(out.unmatchedKeywords).toContain("кремлёв федерация бокса");
  });
});

describe("ответа нет", () => {
  it("фраза без AI-блока строк не даёт, и это названо, а не молчание", () => {
    const out = build("google-dubai", 2520, ["Umar Kremlev boxing"]);

    expect(out.observations).toEqual([]);
    expect(out.absentQueries).toEqual(["Umar Kremlev boxing"]);
  });

  it("ответ без единой ссылки в отчёт как факт не идёт", () => {
    const out = aiAnswersFromPositions({
      body: {
        result: {
          keywords: [
            {
              name: "умар кремлёв iba",
              positionsData: {
                "2026-09-03:32742967:1": {
                  serp_features: JSON.stringify({
                    aiOverview: { snippetTitle: "", snippetBody: "Текст без источников.", links: [] },
                  }),
                },
              },
            },
          ],
        },
      },
      region: region("yandex-moscow"),
      regionIndex: 1,
      queries: ["Умар Кремлёв IBA"],
      provenance: PROVENANCE,
    });

    expect(out.observations).toEqual([]);
    expect(out.warnings.join(" ")).toMatch(/ai-answer-without-sources/);
  });
});
