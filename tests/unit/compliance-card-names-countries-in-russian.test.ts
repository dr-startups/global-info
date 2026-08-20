/**
 * Страны в карточке комплаенс-записи называются по-русски.
 *
 * На живом прогоне 20.08 (джоба `unified-1787248325884-c84131ed`, страница 61)
 * банк читал в карточке PEP строку «Страны в записи: ru, ch». Провайдер отдаёт
 * страну кодом ISO 3166-1, и код доезжал до слайда дословно: детектор
 * внутренних кодов его не ловит — подчёркиваний в нём нет.
 *
 * Проверяется через сам построитель карточки, а не через функцию названий:
 * так же закрепляется и среда. Полный ICU в контейнере — часть контракта
 * клиентского текста, и урезанный ICU (названия молча станут английскими)
 * обязан ронять `npm run ci`, а не отчёт.
 */

import { describe, expect, it } from "vitest";
import { buildComplianceFragment } from "@/modules/digital-profile/orion-golden/deck-sections";
import type { SlideContentContract } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";

const METRIC_SNAPSHOT = {
  metricSnapshotId: "m-1",
  datasetId: "d-1",
  reportRunId: "r-1",
  baseCount: 10,
  enrichmentCount: 0,
  compositeCount: 10,
  subjectMatchCount: 3,
  likelySubjectCount: 0,
  ambiguousCount: 0,
  otherSubjectCount: 0,
  adverseFindingCount: 0,
  perRegionCounts: { RU: 6, UAE: 4 },
};

/** Строка «Страны в записи» карточки Dow Jones для заданного списка стран. */
function countriesRow(countries: string[]): string | undefined {
  const scoped = {
    subject: { displayName: "Йохан Хольмстрём", aliases: [] },
    findings: [],
    surfaceUnits: [
      {
        surface: "compliance",
        region: "GLOBAL",
        metrics: [{ key: "totalCount", value: 1 }],
        claims: [],
        evidenceRefs: ["hit-1"],
      },
    ],
    metricSnapshot: METRIC_SNAPSHOT,
    scope: { regions: null, surfaces: ["compliance"], subjectMatch: null, findingIds: null },
    evidenceIndex: {
      "hit-1": {
        kind: "compliance_hit",
        providerLabel: "DOW_JONES",
        matchCategory: "PEP",
        reviewStatus: "PENDING",
        title: "Йохан Хольмстрём",
        countries,
      },
    },
  };
  const slides: SlideContentContract[] = buildComplianceFragment(
    "COMPLIANCE" as never,
    scoped as never,
    {} as never
  ).slides;
  const card = slides.find((s) => s.slideId === "p34_dow_jones");
  if (!card) throw new Error("нет карточки p34_dow_jones");
  return card.content.table?.rows.find((r) => r[0] === "Страны в записи")?.[1];
}

describe("страны в карточке комплаенс-записи", () => {
  it("коды провайдера называются по-русски", () => {
    // Ровно те коды, что стояли на странице 61 живого прогона.
    expect(countriesRow(["ru", "ch"])).toBe("Россия, Швейцария");
  });

  it("названия не зависят от состава ICU в среде", () => {
    // Урезанный ICU молча вернул бы английские названия — это подмена того,
    // что видит клиент, и она обязана падать здесь, а не в отчёте.
    expect(countriesRow(["gb"])).toBe("Великобритания");
    expect(countriesRow(["de", "fr"])).toBe("Германия, Франция");
  });

  it("неизвестный код не печатается машинным кодом", () => {
    // `Intl.DisplayNames` на неизвестном коде возвращает сам код: «XX» на
    // слайде — тот же мусор, что и «xx».
    const row = countriesRow(["xx"]);
    expect(row).toBe("страна не распознана");
    expect(row).not.toMatch(/xx/iu);
  });

  it("некорректный код не роняет сборку и сворачивается в одну формулировку", () => {
    // `Intl.DisplayNames` на таком коде бросает RangeError. Нераспознанные коды
    // не считаются: «ru» и «RUS» могут быть одной страной, и число назвало бы
    // две.
    expect(countriesRow(["q1", "RUS"])).toBe("страна не распознана");
  });

  it("названная страна и нераспознанный код печатаются вместе", () => {
    expect(countriesRow(["ru", "xx"])).toBe("Россия, страна не распознана");
  });

  it("страна, пришедшая словами, остаётся как есть", () => {
    // Ручной импорт и записи Dow Jones приходят названиями, а не кодами:
    // «Швеция» — уже клиентский текст, и подменять его общей формулировкой
    // значило бы потерять то, что провайдер сказал.
    expect(countriesRow(["Швеция", "Мальта"])).toBe("Швеция, Мальта");
  });

  it("одна и та же страна двумя кодами называется один раз", () => {
    expect(countriesRow(["ru", "RU"])).toBe("Россия");
  });

  it("дефисный код территории не печатается дословно", () => {
    // FollowTheMoney отдаёт территории собственными кодами: `gb-sct`,
    // `so-som`, `cy-trnc`, `ge-ab`, `az-nk`. `Intl.DisplayNames` на них
    // бросает, а детектор кодов их не ловил — дефиса в нём не было, и код
    // уходил на слайд как есть.
    expect(countriesRow(["gb-sct"])).toBe("Шотландия");
    expect(countriesRow(["so-som"])).toBe("Сомалиленд");
    expect(countriesRow(["cy-trnc"])).toBe("Северный Кипр");
    expect(countriesRow(["ge-ab", "az-nk"])).toBe("Абхазия, Нагорный Карабах");
  });

  it("исторический код называется страной, которой он принадлежал", () => {
    // ISO 3166-3: запись на человека советского времени несёт `suhh`.
    expect(countriesRow(["suhh"])).toBe("СССР");
  });

  it("дефисный код, которого мы не знаем, сворачивается, а не печатается", () => {
    const row = countriesRow(["xx-yyy"]);
    expect(row).toBe("страна не распознана");
    expect(row).not.toMatch(/yyy/iu);
  });

  it("страна, названная по-английски, называется по-русски", () => {
    // Название короче пяти знаков — не код. Правило «2–4 знака = код»
    // съедало «Iran», «Cuba», «Iraq», «Chad», то есть теряло сведение,
    // которое провайдер назвал, ровно на санкционно значимых странах.
    expect(countriesRow(["Iran", "Cuba"])).toBe("Иран, Куба");
    expect(countriesRow(["Iraq", "Chad"])).toBe("Ирак, Чад");
    expect(countriesRow(["Germany"])).toBe("Германия");
  });

  it("название в другом регистре не становится второй страной", () => {
    expect(countriesRow(["россия", "RU"])).toBe("Россия");
  });

  it("трёхбуквенный код сворачивается в общую формулировку", () => {
    // Alpha-3 не сводится к alpha-2 усечением: `CHN` → `CH` это Швейцария
    // вместо Китая, `ARE` → `AR` — Аргентина вместо ОАЭ. Напечатать не ту
    // страну хуже, чем сказать, что назвать её нечем.
    expect(countriesRow(["RUS", "CHE"])).toBe("страна не распознана");
  });

  it("строка стран ограничена по длине, как строка алиасов", () => {
    // Единственная многозначная строка карточки без клампа; после перевода
    // кодов в названия значения выросли втрое-вшестеро, и ячейка на записи с
    // десятком стран переполнялась.
    const many = ["ru", "de", "fr", "it", "es", "pt", "nl", "be", "at", "ch", "se", "no", "fi",
      "dk", "pl", "cz", "hu", "ro", "bg", "gr", "tr", "ua", "by", "kz", "uz", "az", "am", "ge"];
    const row = countriesRow(many);
    expect(row).toBeDefined();
    expect(row!.length).toBeLessThanOrEqual(200);
  });
});
