/**
 * Метка отслеживания не делает из одной статьи пятнадцать материалов.
 *
 * Прогон 91, стр. 41: две соседние строки таблицы выдачи — один и тот же
 * заголовок «Биография Умара Кремлева и его путь к успеху» и два адреса
 * `klerk.ru/materials/…?srsltid=AfmBOo…`, различающиеся стознаковым рекламным
 * токеном Google. Замер по бандлу: 19 наблюдений этой статьи дают **13** ключей
 * материала, 12 из них — метки `srsltid`.
 *
 * Список меток в дереве один, и читателей у него двое: `normalizeUrl` слоя
 * сбора (он кормит `dedupHash`) и `serpMaterialKey` слоя деки. Второй список
 * был бы вторым ответом на вопрос «одна ли это страница».
 *
 * Метка снимается не любая: `?v=` YouTube адресует ролик, и снятие склеило бы
 * два разных видео в один материал.
 */

import { describe, expect, it } from "vitest";
import { serpMaterialKey } from "@/modules/digital-profile/serp-observation/material-key";
import { normalizeUrl } from "@/modules/digital-profile/services/evidence-service";

const ARTICLE = "https://www.klerk.ru/materials/2026-05-22/biografiya-umara-kremleva-i-ego-put-k-uspehu/";
const MARKED = `${ARTICLE}?srsltid=AfmBOoodtMPtFzX6yPoKdR0yYG6cz_UmD-UOfkHKkPbRTjIOeRpgy_8d`;
const MARKED_2 = `${ARTICLE}?srsltid=AfmBOoouBUSl8b5xd6cnVb2nCnBbUyJdbasgkxL6YWci-bU9SA1RBqSl`;

describe("список меток отслеживания — один на дерево", () => {
  /*
   * Список проверяется через **обоих** его читателей сразу: слой сбора
   * (`normalizeUrl` → `dedupHash`) и слой деки (`serpMaterialKey`). Проверка
   * держит их **согласие**, а не единственность списка: второй список,
   * посимвольно совпадающий с первым, она пропустит — это замерено. Красной
   * она станет, как только два ответа на «одна ли это страница» разойдутся, а
   * расходятся они именно при двух списках.
   */
  it.each(["utm_source", "fbclid", "gclid", "yclid", "mc_cid", "srsltid", "shem"])(
    "метку %s снимают оба читателя",
    (key) => {
      const url = `https://a.ru/p?${key}=zzz`;
      expect(normalizeUrl(url)).toBe(normalizeUrl("https://a.ru/p"));
      expect(serpMaterialKey({ url, domain: "a.ru" })).toBe(
        serpMaterialKey({ url: "https://a.ru/p", domain: "a.ru" })
      );
    }
  );

  it.each(["v", "id", "page", "q", "text"])(
    "адресующий параметр %s не снимает ни один из них",
    (key) => {
      const url = `https://a.ru/p?${key}=zzz`;
      expect(normalizeUrl(url)).not.toBe(normalizeUrl("https://a.ru/p"));
      expect(serpMaterialKey({ url, domain: "a.ru" })).not.toBe(
        serpMaterialKey({ url: "https://a.ru/p", domain: "a.ru" })
      );
    }
  );
});

describe("ключ материала", () => {
  it("адрес с меткой и он же без метки — один материал", () => {
    const clean = serpMaterialKey({ url: ARTICLE, domain: "klerk.ru", title: "Биография" });
    expect(serpMaterialKey({ url: MARKED, domain: "klerk.ru", title: "Биография" })).toBe(clean);
    expect(serpMaterialKey({ url: MARKED_2, domain: "klerk.ru", title: "Биография" })).toBe(clean);
  });

  it("девятнадцать наблюдений статьи прогона 91 дают один ключ", () => {
    // Форма замера: одна чистая ссылка и восемнадцать с разными токенами.
    const rows = [
      ARTICLE,
      ...Array.from({ length: 18 }, (_, i) => `${ARTICLE}?srsltid=AfmBOo${i}${"x".repeat(40)}`),
    ];
    const keys = new Set(rows.map((url) => serpMaterialKey({ url, domain: "klerk.ru" })));
    expect(keys.size).toBe(1);
  });

  it("адрес без схемы метку теряет так же — его приносит ворот приёмки", () => {
    /*
     * `serpMaterialKey` рассчитан на адрес без схемы, и ворот
     * `serpTableAddressesPrintedOnce` зовёт его печатными ячейками таблицы, у
     * которых схемы нет. Пока метка снималась только со схемных адресов,
     * приёмка не увидела бы двух соседних рядов, различающихся токеном, —
     * ровно того, что владелец увидел на стр. 41.
     */
    const bare = serpMaterialKey({ url: "tadviser.ru/p?shem=abc", domain: "tadviser.ru" });
    expect(bare).toBe(serpMaterialKey({ url: "tadviser.ru/p", domain: "tadviser.ru" }));
    expect(serpMaterialKey({ url: "www.klerk.ru/materials/x/?srsltid=AfmBOo", domain: "klerk.ru" })).toBe(
      serpMaterialKey({ url: "www.klerk.ru/materials/x/", domain: "klerk.ru" })
    );
  });

  it("кириллица в адресе снятие метки переживает", () => {
    // Продукт русский: адрес с кириллицей в пути или в значении параметра
    // обязан давать один ключ с меткой и без. Перекодировка в процентные
    // последовательности делала их разными материалами.
    expect(serpMaterialKey({ url: "https://a.ru/путь?srsltid=x", domain: "a.ru" })).toBe(
      serpMaterialKey({ url: "https://a.ru/путь", domain: "a.ru" })
    );
    expect(serpMaterialKey({ url: "https://a.ru/p?a=б&srsltid=x", domain: "a.ru" })).toBe(
      serpMaterialKey({ url: "https://a.ru/p?a=б", domain: "a.ru" })
    );
  });

  it("два ролика YouTube остаются двумя материалами", () => {
    const a = serpMaterialKey({ url: "https://youtube.com/watch?v=aaa", domain: "youtube.com" });
    const b = serpMaterialKey({ url: "https://youtube.com/watch?v=bbb", domain: "youtube.com" });
    expect(a).not.toBe(b);
  });
});

describe("нормализация адреса слоя сбора", () => {
  it("снимает srsltid и shem", () => {
    expect(normalizeUrl(MARKED)).toBe(normalizeUrl(ARTICLE));
    expect(normalizeUrl("https://a.ru/p?shem=r1&b=2")).toBe("https://a.ru/p?b=2");
  });

  it("прочие параметры остаются и сортируются, как раньше", () => {
    expect(normalizeUrl("https://a.ru/p?z=1&a=2&srsltid=q")).toBe("https://a.ru/p?a=2&z=1");
    expect(normalizeUrl("https://a.ru/watch?v=xyz&utm_source=g")).toBe("https://a.ru/watch?v=xyz");
  });
});
