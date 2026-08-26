/**
 * Один лист — один ответ на «относится ли материал к этому региону».
 *
 * На региональной странице резюме подвал источников (`sourceLine`) и блок темы
 * (`localizedThemedClaim`) печатаются рядом, на одном слайде. Пока подвал
 * фильтровал мягко («регион не чужой»), а блок темы строго («регион свой»),
 * запись без региона попадала в перечень источников региона и не попадала ни в
 * счёт темы, ни в её цитаты: страница называла материал своим и тут же своим не
 * считала.
 *
 * Область при этом шире одного кода: у ОАЭ это «UAE / INTERNATIONAL / GLOBAL»,
 * и материал такой области — свой.
 */

import { describe, expect, it } from "vitest";
import {
  localizedThemedClaim,
  sourceLine,
} from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";

const FINDING = {
  findingId: "finding-criminal_legal-subject_match-source-line",
  theme: "Криминальные / судебные материалы",
  claim:
    "Найдены публикации по теме:\n" +
    "«Суд по иску о взыскании 72 млн рублей с предпринимателя» — источник dzen.ru\n" +
    "Всего по теме: 3 материала.",
  riskLevel: "high",
  regions: ["RU", "UAE"],
  evidenceRefs: ["ev-ru", "ev-uae", "ev-no-region"],
  sourceDomains: ["dzen.ru", "gulfnews.com"],
} as unknown as Finding;

const EVIDENCE = {
  "ev-ru": {
    title: "Суд по иску о взыскании 72 млн рублей с предпринимателя",
    domain: "dzen.ru",
    region: "RU",
  },
  "ev-uae": {
    title: "Court filings link the subject to a Dubai ownership dispute",
    domain: "gulfnews.com",
    region: "UAE",
  },
  "ev-global": {
    title: "OpenSanctions entity card",
    domain: "opensanctions.org",
    region: "GLOBAL",
  },
  // Проверка Википедии и карточка базы региона не имеют вовсе.
  "ev-no-region": {
    title: "Wikipedia (ru): статья не найдена",
    domain: "ru.wikipedia.org",
  },
};

const UAE_SCOPED = {
  findings: [FINDING],
  surfaceUnits: [],
  evidenceIndex: EVIDENCE,
  scope: { regions: ["UAE"] },
  metricSnapshot: {},
} as unknown as ScopedFragmentInput;

describe("подвал источников региональной страницы называет только её регион", () => {
  it("запись без региона источником региона не называется", () => {
    const line = sourceLine(UAE_SCOPED);
    expect(line).not.toContain("ru.wikipedia.org");
  });

  it("свой регион и его международная область остаются", () => {
    const line = sourceLine(UAE_SCOPED);
    expect(line).toContain("gulfnews.com");
    expect(line).toContain("opensanctions.org");
  });

  it("чужой регион не называется", () => {
    expect(sourceLine(UAE_SCOPED)).not.toContain("dzen.ru");
  });

  it("подвал и блок темы одного листа отвечают одинаково", () => {
    const line = sourceLine(UAE_SCOPED);
    const claim = localizedThemedClaim(FINDING, UAE_SCOPED);
    for (const domain of ["ru.wikipedia.org", "dzen.ru"]) {
      expect(line).not.toContain(domain);
      expect(claim).not.toContain(domain);
    }
  });
});
