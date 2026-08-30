/**
 * «Та же ли это страница» — одна линейка в слое деки, а не две.
 *
 * Их было две, и расходились они в обе стороны:
 *   `serp-observation/material-key.ts` — снимает схему, `www.` и хвостовой
 *   слэш, строку параметров **оставляет**;
 *   `deck-sections/load-deck-inputs.ts` — снимает `?…`/`#…` и слэш, схему и
 *   `www.` **оставляет**.
 *
 * Вторая решает, доедет ли дословная цитата до «брата» по материалу. Страница,
 * прочитанная как `https://www.x.ru/a`, отдавала свой вердикт записи
 * `http://x.ru/a/`, а цитату — нет: разные написания одного адреса линейка
 * считала разными страницами.
 *
 * Разница между линейками остаётся ровно одна и она объявлена: строка
 * параметров. Обратный ход — срезать `?…` в ключе материала — запрещён замером:
 * на эталоне-72 по строке параметров распадается группа
 * `youtube.com/watch?v=…`, и срез склеил бы одиннадцать разных видео в один
 * материал.
 */

import { describe, expect, it } from "vitest";
import { applyLinkVerdictsToEvidence } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";

const QUOTE = "Дословная цитата со страницы, длиной больше восьми слов, чтобы дожить до отчёта.";

function index(entries: Record<string, Record<string, unknown>>): ScopedEvidenceIndex {
  return entries as unknown as ScopedEvidenceIndex;
}

describe("цитата доезжает до того же адреса в другом написании", () => {
  it("вердикт со страницы https://www.x.ru/a доходит до записи http://x.ru/a/", () => {
    const idx = index({
      read: { url: "https://www.x.ru/a", domain: "x.ru", title: "Заголовок" },
      sibling: { url: "http://x.ru/a/", domain: "x.ru", title: "Заголовок" },
    });
    applyLinkVerdictsToEvidence(idx, [
      { evidenceRef: "read", tone: "adverse", quotes: [{ text: QUOTE }] },
    ]);
    expect((idx.sibling as { adverse?: boolean }).adverse).toBe(true);
    expect((idx.sibling as { pageQuote?: string }).pageQuote).toBeTruthy();
  });

  it("оценка и цитата едут вместе — вторая не отстаёт от первой", () => {
    const idx = index({
      read: { url: "https://X.RU/a/", domain: "x.ru", title: "Заголовок" },
      sibling: { url: "https://www.x.ru/a", domain: "x.ru", title: "Заголовок" },
    });
    applyLinkVerdictsToEvidence(idx, [
      { evidenceRef: "read", tone: "adverse", quotes: [{ text: QUOTE }] },
    ]);
    const sibling = idx.sibling as { adverse?: boolean; pageQuote?: string };
    expect(sibling.adverse).toBe(true);
    expect(sibling.pageQuote).toBeTruthy();
  });
});

describe("строка параметров по-прежнему различает страницы", () => {
  it("два видео YouTube остаются разными материалами и цитатами не меняются", () => {
    const idx = index({
      first: { url: "https://youtube.com/watch?v=9jmvjinqv3a", domain: "youtube.com", title: "Видео 1" },
      second: { url: "https://youtube.com/watch?v=buzncxusuxu", domain: "youtube.com", title: "Видео 2" },
    });
    applyLinkVerdictsToEvidence(idx, [
      { evidenceRef: "first", tone: "adverse", quotes: [{ text: QUOTE }] },
    ]);
    expect((idx.second as { pageQuote?: string }).pageQuote).toBeUndefined();
    expect((idx.second as { adverse?: boolean }).adverse).toBeUndefined();
  });

  it("псевдоадреса подсказок остаются каждый со своей цитатой", () => {
    // Группу без настоящего адреса держит пара «домен и заголовок», и в ней
    // законно лежат разные псевдоадреса: хеш запроса свой у каждой подсказки.
    const idx = index({
      a: { url: "arsenkin://suggest/768d0a43fcf7", domain: null, title: "глинка сергей михайлович" },
      b: { url: "arsenkin://suggest/63b0ee0dc49b", domain: null, title: "глинка сергей михайлович" },
    });
    applyLinkVerdictsToEvidence(idx, [
      { evidenceRef: "a", tone: "adverse", quotes: [{ text: QUOTE }] },
    ]);
    expect((idx.b as { adverse?: boolean }).adverse).toBe(true);
    expect((idx.b as { pageQuote?: string }).pageQuote).toBeUndefined();
  });
});
