import { describe, expect, it } from "vitest";
import { anchorPhrasesFromCard } from "@/modules/digital-profile/services/persona-card-anchors";
import type { PersonaCard } from "@/modules/digital-profile/services/subject-persona-check";

/**
 * Признаки из карточки — имена собственные, а не пересказ прозы.
 *
 * Карточку выбрал человек глазами, и слова из неё — то, чем известный субъект
 * отличается от тёзки. Но брать из лида обороты вроде «основатель компании»
 * нельзя: они многословны, то есть по правилу сильны, а стоят в тексте о любом
 * основателе с той же фамилией. Берутся имена: в кавычках — сильными,
 * с заглавной буквы — слабыми.
 */

const NAMES = ["Дерипаска Олег Владимирович", "Дерипаска", "Олег", "Владимирович", "Deripaska"];

const wikipedia = (lead: string | null, snippet = ""): PersonaCard =>
  ({
    source: "wikipedia",
    cardId: "wiki-1",
    title: "Дерипаска, Олег Владимирович",
    lead,
    leadRequested: true,
    snippet,
    articles: [],
  }) as PersonaCard;

const LEAD =
  "Олег Владимирович Дерипаска (род. 2 января 1968, Дзержинск, Горьковская область) — " +
  "российский предприниматель, основатель компании «Русал» и владелец «Базового элемента».";

describe("признаки из карточки Википедии", () => {
  const phrases = anchorPhrasesFromCard(wikipedia(LEAD), NAMES);
  const byText = new Map(phrases.map((p) => [p.text, p]));

  it("имена в кавычках становятся сильными признаками", () => {
    expect(byText.get("Русал")?.strong).toBe(true);
    expect(byText.get("Базового элемента")?.strong).toBe(true);
  });

  it("обороты прозы признаками не становятся вовсе", () => {
    expect(phrases.map((p) => p.text)).not.toContain("основатель компании");
    expect(phrases.map((p) => p.text)).not.toContain("российский предприниматель");
  });

  it("скобки вырезаны: дата и место рождения разбираются своими правилами", () => {
    const texts = phrases.map((p) => p.text).join(" ");
    expect(texts).not.toContain("Дзержинск");
    expect(texts).not.toContain("Горьковская");
  });

  it("имя субъекта признаком не становится — иначе тёзка подтвердит сам себя", () => {
    for (const p of phrases) {
      expect(p.text.toLowerCase()).not.toContain("дерипаска");
      expect(p.text.toLowerCase()).not.toContain("олег");
    }
  });

  it("вид признака не угадывается по прозе", () => {
    for (const p of phrases) expect(p.kind).toBe("fact");
  });
});

describe("признаки из панели знаний", () => {
  const kg = {
    source: "knowledge_graph",
    cardId: "kg-1",
    title: "Олег Дерипаска",
    description: "Российский предприниматель, основатель РУСАЛа, выпускник РНИМУ",
    imageUrl: null,
    url: null,
    query: "q",
    region: "RU",
  } as unknown as PersonaCard;

  it("имена с заглавной буквы берутся слабыми: заглавная — признак ненадёжный", () => {
    const phrases = anchorPhrasesFromCard(kg, NAMES);
    const university = phrases.find((p) => p.text === "РНИМУ");
    expect(university).toBeDefined();
    expect(university?.strong).toBe(false);
  });

  it("слово в три буквы признаком не станет — по нему нечего искать", () => {
    // Предел движка якорей, а не карточки: `anchorPhraseStems` отбрасывает
    // короткие слова («ст.», «суд»), и «МГУ» уходит вместе с ними.
    const short = { ...(kg as unknown as Record<string, unknown>), description: "Выпускник МГУ" };
    expect(anchorPhrasesFromCard(short as never, NAMES)).toEqual([]);
  });

  it("первое слово предложения заглавной буквой признаком не делает", () => {
    const phrases = anchorPhrasesFromCard(kg, NAMES);
    expect(phrases.map((p) => p.text)).not.toContain("Российский");
  });
});

describe("что карточка не даёт", () => {
  it("санкционная запись не даёт признаков: её метки — категории, а не человек", () => {
    const sanctions = {
      source: "opensanctions",
      cardId: "os-1",
      profileId: "NK-1",
      profileUrl: null,
      matchedName: "Дерипаска Олег Владимирович",
      datesOfBirth: ["1968-01-02"],
      topicLabels: ["Санкционные списки", "Политически значимое лицо"],
      matchScore: 92,
      birthDateMatches: true,
    } as unknown as PersonaCard;
    expect(anchorPhrasesFromCard(sanctions, NAMES)).toEqual([]);
  });

  it("лида нет — берётся сниппет, и он тоже даёт только имена", () => {
    const phrases = anchorPhrasesFromCard(wikipedia(null, "Основатель «Русала»"), NAMES);
    expect(phrases.map((p) => p.text)).toEqual(["Русала"]);
  });

  it("описания нет вовсе — признаков нет, а не выдуманные", () => {
    expect(anchorPhrasesFromCard(wikipedia(null, ""), NAMES)).toEqual([]);
  });

  it("больше четырёх признаков карточка не даёт", () => {
    const many = wikipedia(
      "Имя — «Альфа», «Бета», «Гамма», «Дельта», «Эпсилон», «Дзета» и «Эта»."
    );
    expect(anchorPhrasesFromCard(many, NAMES)).toHaveLength(4);
  });
});
