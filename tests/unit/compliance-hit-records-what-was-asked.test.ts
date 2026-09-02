/**
 * По сохранённому совпадению видно, что мы спросили и что ответил провайдер.
 *
 * 25.08 в отчёт приехала запись OpenSanctions о постороннем человеке
 * (`ru-inn-504309044808`, «КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН») со счётом 1.0. В бандле
 * прогона нет ни тела запроса, ни объяснения провайдера: поиск по всем JSON по
 * `birthDate`, `features`, `threshold`, `algorithm` не дал ни одного файла.
 * То есть на вопрос «почему приехал посторонний» ответить нечем в принципе.
 *
 * Главная живая гипотеза проверяется здесь же: `matchedName` берётся из
 * `caption`, а сопоставить провайдер мог другое значение многозначного
 * свойства `name` той же записи. Пока значения `name` не сохранены, спор
 * «неверен запрос или неверна наша печать» решить нечем.
 *
 * И вторая находка того же прогона: у Кулебакина единственная тема
 * `sanction.linked` («связан с санкционным лицом»), а клиент читал «Категория:
 * Санкционные списки» — утверждение о человеке, которого ни в одном списке нет.
 */

import { describe, expect, it } from "vitest";
import {
  mapOpenSanctionsResponse,
  riskTypesFromTopics,
  summarizeEntity,
} from "@/modules/digital-profile/compliance-providers/open-sanctions-mapping";

/** Что мы послали: свойства единственного запроса тела `/match`. */
const SENT = {
  name: ["Умар Назарович Кремлев", "Umar Kremlev"],
  birthDate: ["1982-11-01"],
  country: ["россия"],
};

/**
 * Запись Кулебакина в том виде, в каком её описал бандл прогона: две темы
 * набора данных, единственная тема `sanction.linked`, ни алиасов, ни дат
 * рождения.
 */
const KULEBAKIN = {
  id: "ru-inn-504309044808",
  caption: "КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН",
  schema: "Person",
  score: 1,
  match: true,
  datasets: ["ext_ru_egrul", "ann_graph_topics"],
  features: { name_literal_match: 1, country_disjoint: 0 },
  properties: {
    name: ["КУЛЕБАКИН КИРИЛЛ СЕРГЕЕВИЧ", "Кулебакин Кирилл Сергеевич"],
    topics: ["sanction.linked"],
    country: ["ru"],
  },
};

function mapOne(entity: Record<string, unknown>, root: Record<string, unknown> = {}) {
  const hits = mapOpenSanctionsResponse({
    subjectName: "Умар Назарович Кремлев",
    payload: { ...root, responses: { subject: { results: [entity] } } },
    minScore: 0.7,
    webBaseUrl: "https://www.opensanctions.org",
    sentQuery: SENT,
  });
  const hit = hits[0];
  if (!hit) throw new Error("совпадение не разобрано");
  return hit;
}

describe("сохранённое совпадение отвечает, почему оно приехало", () => {
  it("посланные значения лежат рядом с ответом", () => {
    const raw = mapOne(KULEBAKIN).rawMetadataSafe;
    expect(raw.query).toEqual(SENT);
  });

  it("объяснение провайдера сохраняется как есть", () => {
    const raw = mapOne(KULEBAKIN, { algorithm: "logic-v1", threshold: 0.7 }).rawMetadataSafe;
    expect(raw.match).toBe(true);
    expect(raw.features).toEqual({ name_literal_match: 1, country_disjoint: 0 });
    expect(raw.algorithm).toBe("logic-v1");
    expect(raw.threshold).toBe(0.7);
  });

  it("поля, которых провайдер не прислал, отсутствуют, а не заполняются нулями", () => {
    const raw = mapOne({
      id: "ru-inn-1",
      caption: "Некто",
      score: 0.95,
      properties: { name: ["Некто"] },
    }).rawMetadataSafe;
    expect("match" in raw).toBe(false);
    expect("features" in raw).toBe(false);
    expect("algorithm" in raw).toBe(false);
    expect("threshold" in raw).toBe(false);
  });

  it("сохраняются все формы имени записи, а не только caption", () => {
    const hit = mapOne(KULEBAKIN);
    expect(hit.rawMetadataSafe.names).toEqual([
      "КУЛЕБАКИН КИРИЛЛ СЕРГЕЕВИЧ",
      "Кулебакин Кирилл Сергеевич",
    ]);
    // Печатаем по-прежнему `caption`: спор о том, верна ли эта печать, решается
    // сохранёнными формами имени, а не переписыванием печати вслепую.
    expect(hit.matchedName).toBe("КИРИЛЛ СЕРГЕЕВИЧ КУЛЕБАКИН");
  });

  it("совпадение никогда не подтверждается автоматически", () => {
    expect(mapOne(KULEBAKIN).reviewStatus).toBe("PENDING");
    expect(mapOne({ ...KULEBAKIN, score: 1 }).matchScore).toBe(100);
  });
});

describe("тема записи называется тем, что она есть", () => {
  it("«связан с санкционным лицом» — не санкционные списки", () => {
    expect(riskTypesFromTopics(["sanction.linked"])).toEqual(["SANCTION_LINKED"]);
    expect(mapOne(KULEBAKIN).riskTypes).toEqual(["SANCTION_LINKED"]);
  });

  it("тема sanction по-прежнему санкционные списки", () => {
    expect(riskTypesFromTopics(["sanction"])).toEqual(["SANCTIONS"]);
    expect(riskTypesFromTopics(["sanction.linked", "sanction"])).toEqual([
      "SANCTION_LINKED",
      "SANCTIONS",
    ]);
  });

  it("тема получает самый частный подходящий тип, а не все сразу", () => {
    // `role.pep` подходит и под `role.pep`, и (по префиксу) ни под что шире:
    // накопление всех подходящих типов и превращало одну тему в две категории.
    expect(riskTypesFromTopics(["role.pep"])).toEqual(["PEP"]);
    expect(riskTypesFromTopics(["sanction.counter"])).toEqual(["SANCTIONS"]);
  });

  it("сводка записи называет тему словами клиента", () => {
    const summary = summarizeEntity(KULEBAKIN);
    expect(summary).toMatch(/связь с санкционным лицом/u);
    expect(summary).not.toMatch(/санкционные списки/u);
    expect(summary).not.toMatch(/sanction/u);
  });
});
