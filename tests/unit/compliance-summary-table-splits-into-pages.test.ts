/**
 * Сводная таблица комплаенса разбивается на листы, как и карточки.
 *
 * Клип таблицы на странице комплаенс-раздела останавливает выдачу целиком
 * (`services/render-telemetry-gate.ts`), а сводная страница до этого шага
 * печатала столько строк, сколько записей: один импортированный PDF LexisNexis
 * кладёт в дело до сорока записей, сорок строк не влезают ни при каких именах,
 * и оплаченный прогон вставал бы в отказ, из которого не выходит ни
 * пересборкой, ни повтором рендера — рендер детерминирован, лист тот же, клип
 * тот же.
 *
 * Поэтому решение блокировать приходит вместе с ёмкостью для той страницы,
 * которую оно блокирует: у сводки свой потолок строк, а её продолжения и
 * карточки баз без своей страницы нумеруются одной цепочкой — это один и тот
 * же слот `p33_compliance_toc`.
 */

import { describe, expect, it } from "vitest";
import {
  complianceSlides,
  fullRecord,
  isSummaryPage,
  minimalRecord,
} from "../fixtures/compliance-fragment";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

/** Двенадцать записей без содержательных полей: своих карточек они не дают. */
const TWELVE_BARE = Array.from({ length: 12 }, (_, i) => minimalRecord("WORLD_CHECK", i + 1));

const summaryPages = (records: Array<Record<string, unknown>>): SlideContentContract[] =>
  complianceSlides(records).filter(isSummaryPage);

describe("сводная таблица комплаенса разбивается на листы", () => {
  it("двенадцать записей не печатаются одной таблицей", () => {
    const pages = summaryPages(TWELVE_BARE);
    expect(pages.map((p) => p.content.table?.rows.length ?? 0)).toEqual([5, 5, 2]);
    expect(pages[0]!.slideId).toBe("p33_compliance_toc");
    expect(pages.slice(1).map((p) => p.slideId)).toEqual([
      "p33_compliance_toc__cont1",
      "p33_compliance_toc__cont2",
    ]);
  });

  it("ни одна запись не теряется и не повторяется при разбивке", () => {
    const names = summaryPages(TWELVE_BARE).flatMap((p) =>
      (p.content.table?.rows ?? []).map((r) => r[2])
    );
    expect(names).toEqual(Array.from({ length: 12 }, (_, i) => `Кирилл Кулебакин ${i + 1}`));
  });

  it("продолжение сводки называет свой диапазон записей", () => {
    const pages = summaryPages(TWELVE_BARE);
    expect(pages[1]!.content.narrative).toContain("записи 6–10 из 12");
    expect(pages[2]!.content.narrative).toContain("записи 11–12 из 12");
  });

  it("лист с одной записью печатает её номер, а не диапазон из одного конца", () => {
    // Шесть записей дают последний лист на одну строку, и «записи 6–6 из 6» —
    // это то, что прочитал бы клиент банка. Граница достижима на любом корпусе
    // с остатком 1 при делении на потолок: 6, 11, 16, 21…
    const pages = summaryPages(
      Array.from({ length: 6 }, (_, i) => minimalRecord("WORLD_CHECK", i + 1))
    );
    expect(pages.map((p) => p.content.table?.rows.length ?? 0)).toEqual([5, 1]);
    expect(pages[1]!.content.narrative).toContain("запись 6 из 6");
    expect(pages[1]!.content.narrative).not.toContain("6–6");
  });

  it("продолжение говорит, где искать рекомендацию", () => {
    // Рекомендацию с продолжений снимает общий конструктор, и это правильно;
    // но читатель третьего листа обязан узнать, что она есть и относится к его
    // строкам тоже, — иначе лист выглядит как строки без вывода.
    const pages = summaryPages(TWELVE_BARE);
    expect(pages[1]!.content.narrative).toContain("рекомендаци");
  });

  it("рекомендация печатается один раз — на первой странице сводки", () => {
    // Иначе «верифицировать каждое совпадение вручную» повторяется на каждом
    // листе и съедает высоту, которой считается ёмкость.
    const pages = summaryPages(TWELVE_BARE);
    expect(pages[0]!.content.whatToCheck).toContain("Верифицировать");
    expect(pages.slice(1).map((p) => p.content.whatToCheck)).toEqual([undefined, undefined]);
  });

  it("продолжения сводки и карточки прочих баз нумеруются одной цепочкой", () => {
    // Слот один, значит и цепочка одна: индексы продолжений обязаны идти
    // подряд от единицы (`section-validation`), а подпись — называть длину
    // всей цепочки, а не одной её половины.
    const slides = complianceSlides(
      Array.from({ length: 7 }, (_, i) => fullRecord("OPEN_SANCTIONS", i + 1))
    );
    const chain = slides.filter((s) => s.continuationOf === "p33_compliance_toc");
    expect(chain.map((s) => s.continuationIndex)).toEqual(chain.map((_, i) => i + 1));
    expect(chain.map((s) => s.slideId)).toEqual(
      chain.map((_, i) => `p33_compliance_toc__cont${i + 1}`)
    );
    // Первое продолжение — хвост сводной таблицы, дальше идут карточки.
    expect(isSummaryPage(chain[0]!)).toBe(true);
    expect(chain.slice(1).every((s) => s.content.table?.headers?.[0] === "Параметр")).toBe(true);
    const total = chain.length + 1;
    expect(chain[chain.length - 1]!.title).toContain(`(продолжение ${total}/${total})`);
  });
});
