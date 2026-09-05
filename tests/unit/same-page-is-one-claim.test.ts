/**
 * Две страницы одного материала — одно утверждение.
 *
 * Отчёт 86: профиль судьи на `судьироссии.рф` вошёл в криминальную тему дважды
 * — по адресу самого профиля и по его же постраничной навигации (`/from/4`), —
 * и блок напечатал «Всего по теме: 2 материала, с негативным контекстом — 2».
 * Различал их заголовок, который поисковик обрезал по-разному.
 *
 * Утверждение опознаётся тем, что увидит клиент: домен плюс текст, из которого
 * берётся цитата.
 */

import { describe, expect, it } from "vitest";
import { claimFingerprint } from "@/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import type { RawInventoryItem } from "@/modules/digital-profile/orion-golden/types";

const SNIPPET =
  "Егоров Алексей Евгеньевич. Регион: Краснодарский край. Председатель Арбитражного суда " +
  "Краснодарского края Алексей Егоров при попустительстве губернатора завладел землей.";

function row(partial: Partial<RawInventoryItem>): RawInventoryItem {
  return {
    inventoryId: "obs",
    caseId: "c",
    reportRunId: "r",
    source: "serp_observation",
    provider: "topvisor-yandex",
    region: "RU",
    collectedAt: "2026-09-05T12:00:00.000Z",
    evidenceType: "search_result",
    title: "",
    snippet: "",
    ...partial,
  } as RawInventoryItem;
}

describe("одна страница — одно утверждение темы", () => {
  it("постраничная навигация того же профиля не удваивает материал", () => {
    const a = row({
      title: "Судьи России - Егоров Алексей Евгеньевич - Краснодарский край",
      snippet: SNIPPET,
      sourceUrl: "https://судьироссии.рф/sudii/egorov-aleksey-evgen-evich",
    });
    const b = row({
      title: "Судьи России - Егоров Алексей Евгеньевич - Краснодарский...",
      snippet: SNIPPET,
      sourceUrl: "https://судьироссии.рф/sudii/egorov-aleksey-evgen-evich/from/4",
    });
    expect(claimFingerprint("criminal_legal", a)).toBe(claimFingerprint("criminal_legal", b));
  });

  it("тот же текст на другом домене — другое утверждение", () => {
    const a = row({ snippet: SNIPPET, sourceUrl: "https://судьироссии.рф/sudii/egorov" });
    const b = row({ snippet: SNIPPET, sourceUrl: "https://other-site.ru/sudii/egorov" });
    expect(claimFingerprint("criminal_legal", a)).not.toBe(claimFingerprint("criminal_legal", b));
  });

  it("без сниппета утверждение опознаётся заголовком", () => {
    const a = row({ title: "Проверят председателя суда", sourceUrl: "https://zakrasnodar.ru/a" });
    const b = row({ title: "Проверят председателя суда", sourceUrl: "https://zakrasnodar.ru/b" });
    const c = row({ title: "Другая публикация о другом", sourceUrl: "https://zakrasnodar.ru/c" });
    expect(claimFingerprint("criminal_legal", a)).toBe(claimFingerprint("criminal_legal", b));
    expect(claimFingerprint("criminal_legal", a)).not.toBe(claimFingerprint("criminal_legal", c));
  });
});
