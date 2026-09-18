/**
 * Двойники цитат сверяются по напечатанному тексту (шаг 0111).
 *
 * Отчёт Дерипаски на v201, стр. 21: блок «Корпоративное владение» печатал одну
 * и ту же цитату дважды — с otvet.mail.ru и dic.academic.ru. Страницы
 * зеркальные: на одной ударения и пробел перед скобкой, на другой нет. Отпечаток
 * сюжета (`titleFingerprint`, им сводят двойники и синтезатор находок, и
 * региональный блок) считался по сырому тексту, а печать шла после чистки
 * `quoteBody` (шаг 0109): два ключа, один напечатанный текст.
 */

import { describe, expect, it } from "vitest";
import {
  pickDistinctTitles,
  titleFingerprint,
} from "@/modules/digital-profile/orion-golden/analytics/distinct-stories";

const LEAD =
  "Олег Владимирович Дерипаска (род. 2 января 1968, Дзержинск Горьковской области) — " +
  "российский предприниматель, владелец компании „Базовый элемент“.";
const RAW =
  "Оле́г Влади́мирович Дерипа́ска ( род. 2 января 1968 , Дзержинск Горьковской области ) — " +
  "российский предприниматель, владелец компании „Базовый элемент“.";

describe("двойники цитат сверяются по напечатанному тексту", () => {
  it("Д1: отпечаток сюжета не видит ударений и пробелов перед знаками", () => {
    expect(titleFingerprint(RAW)).toBe(titleFingerprint(LEAD));
  });

  it("Д2: две зеркальные страницы, различные лишь ударением и пробелом, — один сюжет", () => {
    const picked = pickDistinctTitles(
      [
        { title: RAW, domain: "otvet.mail.ru" },
        { title: LEAD, domain: "dic.academic.ru" },
      ],
      2
    );
    expect(picked.map((p) => p.domain)).toEqual(["otvet.mail.ru"]);
  });

  it("Д3: разные тексты — два сюжета, как прежде", () => {
    const picked = pickDistinctTitles(
      [
        { title: LEAD, domain: "dic.academic.ru" },
        { title: "Олег Дерипаска родился 2 января 1968 года в Дзержинске.", domain: "brobank.ru" },
      ],
      2
    );
    expect(picked).toHaveLength(2);
  });
});
