import { describe, expect, it } from "vitest";
import {
  cardSourceLabel,
  personaCardMatchNote,
  personaCardText,
  personaLedger,
  type PersonaCardJson,
  type PersonaSourceJson,
} from "@/modules/site/check/persona-view";

/**
 * «Где искали совпадения» — словами, без кодов: пустая панель без объяснения
 * читается как сбой сайта, а не как честное «таких упоминаний нет». Порядок
 * источников постоянный, как в макете, а не порядок ответа ручки.
 */

const card = (over: Partial<PersonaCardJson>): PersonaCardJson => ({
  cardId: "card-1",
  source: "wikipedia",
  title: "Проверкин, Тест Этапович",
  description: null,
  imageUrl: null,
  url: null,
  birthDates: [],
  birthDateMatches: false,
  ...over,
});

const sources = (...list: Array<[PersonaSourceJson["source"], PersonaSourceJson["status"]]>): PersonaSourceJson[] =>
  list.map(([source, status]) => ({ source, status }));

describe("ответы источников", () => {
  it("ответил и дал карточку — «ответ получен»; не подключён — так и сказано", () => {
    const ledger = personaLedger(
      sources(["opensanctions", "ok"], ["knowledge_graph", "not_configured"], ["wikipedia", "ok"]),
      [card({ source: "wikipedia" }), card({ cardId: "card-2", source: "opensanctions" })]
    );
    expect(ledger).toEqual([
      { name: "Открытые источники", value: "ответ получен", tone: "ok" },
      { name: "Панель знаний Google", value: "не подключена в этой проверке", tone: "off" },
      { name: "Санкционные списки", value: "ответ получен", tone: "ok" },
    ]);
  });

  it("ответил без карточек — «совпадений нет»", () => {
    expect(personaLedger(sources(["opensanctions", "ok"]), [])).toEqual([
      { name: "Санкционные списки", value: "совпадений нет", tone: "ok" },
    ]);
  });

  it("не ответил вовремя или не ответил — проверка всё равно продолжится", () => {
    expect(personaLedger(sources(["wikipedia", "timeout"], ["opensanctions", "unavailable"]), [])).toEqual([
      { name: "Открытые источники", value: "ответ не пришёл вовремя — проверка всё равно продолжится", tone: "warn" },
      { name: "Санкционные списки", value: "ответа нет — проверка всё равно продолжится", tone: "warn" },
    ]);
  });
});

describe("карточка совпадения", () => {
  it("подпись источника", () => {
    expect(cardSourceLabel("wikipedia")).toBe("Энциклопедия");
    expect(cardSourceLabel("knowledge_graph")).toBe("Панель знаний Google");
    expect(cardSourceLabel("opensanctions")).toBe("Санкционные списки");
  });

  it("санкционная карточка называет базу и дату рождения в карточке", () => {
    expect(personaCardText(card({ source: "opensanctions", birthDates: ["1985-03-12"] }))).toBe(
      "Карточка в открытой базе OpenSanctions. Дата рождения в карточке: 12.03.1985."
    );
    expect(
      personaCardText(card({ source: "opensanctions", description: "Sanctioned entity", birthDates: ["1985-03-12", "1986-01-01"] }))
    ).toBe("Карточка в открытой базе OpenSanctions: Sanctioned entity. Дата рождения в карточке: 12.03.1985, 01.01.1986.");
  });

  it("у энциклопедии и панели знаний — описание как есть", () => {
    expect(personaCardText(card({ description: "Российский предприниматель." }))).toBe("Российский предприниматель.");
    expect(personaCardText(card({ source: "knowledge_graph", description: null }))).toBe("");
  });

  it("«Дата рождения совпадает» — только у санкционной карточки", () => {
    expect(personaCardMatchNote(card({ source: "opensanctions", birthDateMatches: true }))).toBe(
      "Дата рождения совпадает с вашей"
    );
    expect(personaCardMatchNote(card({ source: "opensanctions", birthDateMatches: false }))).toBeNull();
    expect(personaCardMatchNote(card({ source: "wikipedia", birthDateMatches: true }))).toBeNull();
  });
});
