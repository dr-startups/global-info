/**
 * Сводка записи OpenSanctions называет число источников, а не их имена.
 *
 * Живой прогон 20.08 (кейс Прохоров), страница 61 отчёта, слайд
 * `p33_compliance_toc__cont1`:
 *
 *     «Сводка записи — темы: публичные должностные лица (PEP), политическая
 *      значимость, санкционные списки, списки наблюдения; должность: president
 *      (2008-2014); источники: ext_gb_coh_psc, wd_oligarchs,
 *      ru_billionaires_2021, ext_ru_egrul, wd_curated»
 *
 * Имена наборов данных провайдера — машинные идентификаторы, и читателю они не
 * сообщают ничего. Коды тем из этой же строки уже перевели в русские названия
 * рисков после отчёта о Тинькове, а список наборов остался как был; детектор
 * `internal-code-scan` про такие имена знает и на живом прогоне их нашёл, но
 * блокировка сборки наступает от трёх задетых страниц, а страница была одна.
 *
 * Прослеживаемость числом не теряется: строкой ниже в той же карточке стоит
 * ссылка на карточку записи OpenSanctions, по которой видны все наборы.
 */

import { describe, expect, it } from "vitest";
import { summarizeEntity } from "../../src/modules/digital-profile/compliance-providers/open-sanctions-mapping";
import { findInternalCodes } from "../../src/modules/digital-profile/orion-golden/deck-sections/internal-code-scan";

/** Наборы данных ровно в том виде, в каком они стояли на странице 61. */
const LIVE_DATASETS = [
  "ext_gb_coh_psc",
  "wd_oligarchs",
  "ru_billionaires_2021",
  "ext_ru_egrul",
  "wd_curated",
];

/** Запись живого прогона: темы, должность и наборы данных. */
function liveEntity(datasets: unknown[] = LIVE_DATASETS): Record<string, unknown> {
  return {
    datasets,
    properties: {
      topics: ["role.pep", "role.oligarch", "sanction", "poi"],
      position: ["president (2008-2014)"],
    },
  };
}

/** Запись только с наборами данных: остальные части сводки не мешают чтению. */
function entityWithDatasets(count: number): Record<string, unknown> {
  return { datasets: Array.from({ length: count }, (_, i) => `ds_source_${i + 1}`) };
}

describe("сводка записи OpenSanctions", () => {
  it("наблюдавшийся случай: имена наборов заменены их числом", () => {
    const summary = summarizeEntity(liveEntity());
    for (const name of LIVE_DATASETS) {
      expect(summary, `имя набора «${name}» осталось в клиентском тексте`).not.toContain(name);
    }
    expect(summary).toContain("источников в записи: 5");
    // Тот самый детектор, который нашёл дефект на живом прогоне.
    expect(findInternalCodes(summary)).toEqual([]);
  });

  it("остальные части сводки на месте", () => {
    const summary = summarizeEntity(liveEntity());
    expect(summary).toContain("публичные должностные лица (PEP)");
    expect(summary).toContain("president (2008-2014)");
  });

  it("число согласовано по-русски", () => {
    // Иначе на слайде появится «источников в записи: 1».
    const cases: Array<[number, string]> = [
      [1, "источник в записи: 1"],
      [2, "источника в записи: 2"],
      [4, "источника в записи: 4"],
      [5, "источников в записи: 5"],
      [11, "источников в записи: 11"],
      [12, "источников в записи: 12"],
      [21, "источник в записи: 21"],
      [22, "источника в записи: 22"],
      [25, "источников в записи: 25"],
    ];
    for (const [count, expected] of cases) {
      expect(summarizeEntity(entityWithDatasets(count)), `${count} наборов`).toContain(expected);
    }
  });

  it("наборов нет — строки о них нет вовсе", () => {
    // «источников в записи: 0» сообщало бы о том, чего провайдер не говорил, —
    // то же правило, по которому при пустых темах не пишется «темы: прочие
    // основания».
    const summary = summarizeEntity({
      datasets: [],
      properties: { position: ["president (2008-2014)"] },
    });
    expect(summary).not.toMatch(/источник/iu);
    expect(summary).toContain("president (2008-2014)");
  });

  it("поля `datasets` нет — строки о нём нет", () => {
    expect(summarizeEntity({ properties: { position: ["Сенатор"] } })).not.toMatch(/источник/iu);
  });

  it("считается весь список, а не первые пять", () => {
    // Прежде печатались пять первых имён; число обязано говорить о записи, а не
    // о том, сколько имён поместилось в строку.
    expect(summarizeEntity(entityWithDatasets(7))).toContain("источников в записи: 7");
  });

  it("пустые элементы списка не считаются", () => {
    const summary = summarizeEntity(liveEntity(["eu_fsf", "", "   ", null]));
    expect(summary).toContain("источник в записи: 1");
  });
});
