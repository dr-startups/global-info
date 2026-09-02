/**
 * Утверждение предъявляется вместе со своим источником — и без трафарета.
 *
 * Боевой отчёт 28.07 (Тиньков), страница 3, тема «Криминальные и судебные
 * материалы»:
 *
 *     Установлено: Forbes сообщает, что весной 2020 года в Лондоне был выдан
 *     ордер на арест Олега Тинькова из-за претензий налоговой службы США.
 *     «Олег Тиньков — биография, личная жизнь и карьера» — источник ria.ru.
 *
 * Утверждение приписано Forbes, а единственная приведённая рядом ссылка — на
 * ria.ru, и это биографическая статья, а не источник новости об ордере.
 *
 * Сам факт прослеживается верно, в нём всё есть:
 *
 *     sourceDomain: "forbes.ru"
 *     sourceUrl:    "https://www.forbes.ru/profile/237245-tinkov"
 *
 * Но в деку уходил только `statement`, без своего источника, а следом
 * подставлялись статьи, отобранные **отдельным** участником. На вопрос «чем
 * подтверждается это утверждение» отвечали двое, и клиенту показывался не тот
 * ответ. Правило проекта — «любое утверждение прослеживается до наблюдения с
 * URL» — с точки зрения читателя нарушалось.
 *
 * Слово «Установлено:» при этом обещало больше, чем у нас есть: публикация
 * сообщает, а не устанавливает, и эталон отрасли такого трафарета не знает.
 * Источник, названный рядом, говорит то же самое без обещания.
 *
 * Свойство: если у факта есть источник, он назван рядом с утверждением, и
 * никакого трафарета перед утверждением нет.
 */

import { describe, expect, it } from "vitest";
import { factConclusionSentence } from "../../src/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import type { VerifiedFact } from "../../src/modules/digital-profile/orion-golden/gpt/fact-extraction";

const STATEMENT =
  "Forbes сообщает, что весной 2020 года в Лондоне был выдан ордер на арест Олега Тинькова из-за претензий налоговой службы США.";

function fact(over: Partial<VerifiedFact> = {}): VerifiedFact {
  return {
    statement: STATEMENT,
    quote:
      "Весной 2020 года в Лондоне был выдан ордер на арест Олега Тинькова из-за претензий налоговой службы США",
    status: "source_allegation",
    themeId: "criminal_judicial",
    evidenceRef: "inventory:obs-037c1f7dd14974c6",
    sourceDomain: "forbes.ru",
    sourceUrl: "https://www.forbes.ru/profile/237245-tinkov",
    ...over,
  } as VerifiedFact;
}

describe("утверждение и его источник", () => {
  it("наблюдавшийся случай: рядом с утверждением назван forbes.ru", () => {
    expect(factConclusionSentence(fact())).toBe(
      "Forbes сообщает, что весной 2020 года в Лондоне был выдан ордер на арест Олега Тинькова из-за претензий налоговой службы США (forbes.ru)."
    );
  });

  it("источник не выдумывается, когда его нет", () => {
    expect(factConclusionSentence(fact({ sourceDomain: "" }))).toBe(STATEMENT);
  });

  it("демо-домен клиенту не называется", () => {
    // То же правило, что и в остальном клиентском тексте.
    const s = factConclusionSentence(fact({ sourceDomain: "demo.example" }));
    expect(s).not.toContain("demo.example");
  });

  it("трафарета перед утверждением нет ни на одном пути", () => {
    for (const d of ["forbes.ru", "", "demo.example"]) {
      const s = factConclusionSentence(fact({ sourceDomain: d }));
      expect(s).not.toContain("Установлено:");
      expect(s).toMatch(/\.$/u);
    }
  });
});
