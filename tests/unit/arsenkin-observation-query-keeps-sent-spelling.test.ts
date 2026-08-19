import { describe, expect, it } from "vitest";
import { adaptArsenkinToolResponse } from "@/modules/digital-profile/services/arsenkin-tool-adapters";

/**
 * Запрос записывается тем написанием, которым отправлялся.
 *
 * Arsenkin эхо-отдаёт запрос нормализованным в нижний регистр. Пока ингест
 * писал эхо, один и тот же запрос жил в корпусе двумя написаниями (в живом
 * прогоне 57 строк «тиньков олег юрьевич» против 24 «Тиньков Олег Юрьевич»),
 * а печатная форма выбирала частое — то есть нижний регистр.
 */

const SENT = "Рашников Виктор Филиппович";

const CTX = {
  caseAgent: "ARSENKIN_SEARCH_TOP_REAL",
  toolName: "check-top",
  externalTaskId: "task-1",
  enrichmentRunId: "run-1",
  unifiedJobId: "job-1",
  providerTaskId: "pt-1",
};

function ruRequest(queries: string[], depth: number) {
  return {
    tools_name: "check-top",
    data: { queries, se: [{ type: 2, region: 213 }], depth },
  };
}

function item(url: string, query: string) {
  return { url, title: `Заголовок ${url}`, query };
}

describe("написание запроса в наблюдении — отправленное, а не эхо провайдера", () => {
  it("эхо в нижнем регистре заменяется написанием заявки", () => {
    const adapted = adaptArsenkinToolResponse({
      toolName: "check-top",
      requestJson: ruRequest([SENT], 2),
      responseJson: {
        items: [
          item("https://example.com/a", "рашников виктор филиппович"),
          item("https://example.com/b", "рашников  виктор   филиппович "),
        ],
      },
      ctx: CTX,
    });

    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.observations.map((o) => o.query)).toEqual([SENT, SENT]);
  });

  it("эхо, которого в заявке не было, сохраняется как пришло", () => {
    const adapted = adaptArsenkinToolResponse({
      toolName: "check-top",
      requestJson: ruRequest([SENT], 2),
      responseJson: {
        items: [
          item("https://example.com/a", "рашников виктор филиппович"),
          item("https://example.com/b", "виктор рашников ммк"),
        ],
      },
      ctx: CTX,
    });

    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.observations.map((o) => o.query)).toEqual([SENT, "виктор рашников ммк"]);
  });

  it("замена написания не склеивает блоки запросов: позиции считаются по-прежнему", () => {
    const adapted = adaptArsenkinToolResponse({
      toolName: "check-top",
      requestJson: ruRequest([SENT, "Виктор Рашников"], 2),
      responseJson: {
        items: [
          item("https://example.com/a", "рашников виктор филиппович"),
          item("https://example.com/b", "рашников виктор филиппович"),
          item("https://example.com/c", "виктор рашников"),
          item("https://example.com/d", "виктор рашников"),
        ],
      },
      ctx: CTX,
    });

    expect(adapted.ok).toBe(true);
    if (!adapted.ok) return;
    expect(adapted.observations.map((o) => o.query)).toEqual([
      SENT,
      SENT,
      "Виктор Рашников",
      "Виктор Рашников",
    ]);
    expect(adapted.observations.map((o) => o.rank)).toEqual([1, 2, 1, 2]);
  });
});
