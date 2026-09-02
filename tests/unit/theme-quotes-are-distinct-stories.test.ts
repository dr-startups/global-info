/**
 * В блоке темы не цитируется один сюжет дважды.
 *
 * На эталонной деке так вышло трижды, и все три пары — одна публикация:
 *
 *   p24_uae_summary        sledst.org  и  m.sledst.org
 *     «…Automecanica SA • Следствие»
 *     «…Automecanica SA • Следствие • Версия для печати • Следствие»
 *
 *   p07_ru_summary__cont1  repost.news  и  rumafia.io
 *     «…оборонного завода Popeci в Молдове • Портал РЕПОСТ»
 *     «…оборонного завода Popeci в Молдове • Портал РуМафия»
 *
 * Отбор брал просто два лучших по счёту, а мобильное зеркало и перепечатка
 * несут тот же заголовок и тот же счёт. Для отчёта, который показывают банку,
 * это не мелочь: одна публикация выглядит как два свидетельства. Читатель же
 * видит одно предложение подряд — самый заметный признак выгрузки.
 *
 * Свойство: два выбранных заголовка — про разные сюжеты. Охват при этом не
 * теряется: домены обоих источников называет строка «Где видно».
 */

import { describe, expect, it } from "vitest";
import {
  pickDistinctTitles,
  titleFingerprint,
} from "../../src/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

const HEADLINE =
  "Russian businessman Sergei Glinka is attempting to gain control of the Popeci defense plant in Moldova through the Romanian company Automecanica SA";

const RU_HEADLINE =
  "Российский бизнесмен Сергей Глинка пытается с помощью румынской Automecanica SA овладеть контрольным пакетом оборонного завода Popeci в Молдове";

describe("цитаты в блоке темы — про разные сюжеты", () => {
  it("хвост площадки в отпечаток не входит", () => {
    expect(titleFingerprint(`${HEADLINE} • Следствие`)).toBe(
      titleFingerprint(`${HEADLINE} • Следствие • Версия для печати • Следствие`)
    );
  });

  it("наблюдавшийся случай: зеркало и версия для печати дают одну цитату", () => {
    const picked = pickDistinctTitles(
      [
        { title: `${HEADLINE} • Следствие`, domain: "sledst.org" },
        { title: `${HEADLINE} • Следствие • Версия для печати • Следствие`, domain: "m.sledst.org" },
      ],
      2
    );
    expect(picked).toHaveLength(1);
    expect(picked[0]!.domain).toBe("sledst.org");
  });

  it("наблюдавшийся случай: перепечатка на другом сайте тоже одна цитата", () => {
    const picked = pickDistinctTitles(
      [
        { title: `${RU_HEADLINE} • Портал РЕПОСТ`, domain: "repost.news" },
        { title: `${RU_HEADLINE} • Портал РуМафия`, domain: "rumafia.io" },
      ],
      2
    );
    expect(picked).toHaveLength(1);
  });

  it("разные сюжеты остаются оба", () => {
    const picked = pickDistinctTitles(
      [
        { title: `${HEADLINE} • Следствие`, domain: "sledst.org" },
        { title: "Бизнесмен Глинка: биография, семья и взгляд на будущее • BM", domain: "bmmagazine.co.uk" },
      ],
      2
    );
    expect(picked).toHaveLength(2);
  });

  it("порядок и предел сохраняются", () => {
    const picked = pickDistinctTitles(
      [
        { title: "Первый сюжет про завод в Молдове и контрольный пакет" },
        { title: "Второй сюжет про санкционных партнёров и переводы" },
        { title: "Третий сюжет про транспортную отрасль и планы" },
      ],
      2
    );
    expect(picked.map((p) => p.title[0])).toEqual(["П", "В"]);
  });

  it("пустые заголовки не занимают место", () => {
    const picked = pickDistinctTitles([{ title: "   " }, { title: "Настоящий сюжет" }], 2);
    expect(picked).toHaveLength(1);
    expect(picked[0]!.title).toBe("Настоящий сюжет");
  });
});
