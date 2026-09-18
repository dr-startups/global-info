/**
 * Региональный блок темы цитирует фразу с темой, а не первую цитату страницы
 * (шаг 0115).
 *
 * Стр. 15 отчёта Бондарчука: под «Политические связи / публичная экспозиция»
 * стояли лиды Википедии и Apple TV — первая цитата прочитанной страницы, та,
 * где рядом с именем стоит признак субъекта. Фраза с темой («Член Высшего
 * совета политической партии «Единая Россия» в 2009—2021 годах.») у обеих
 * страниц была второй цитатой, и загрузчик деки её выбрасывал.
 */

import { describe, expect, it } from "vitest";
import { localizedThemedClaim } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { applyLinkVerdictsToEvidence } from "@/modules/digital-profile/orion-golden/deck-sections/load-deck-inputs";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";

const WIKI_LEAD =
  "Фёдор Сергеевич Бондарчук (род. 9 мая 1967, Москва, СССР) — советский и российский актёр кино";
const WIKI_PARTY = "Член Высшего совета политической партии «Единая Россия» в 2009—2021 годах.";
const WIKI_SCHOOL =
  "Не отличался успешной учёбой и хорошим поведением, в школьные годы стал пить, курить и хулиганить";

const POLITICAL = {
  findingId: "finding-political_exposure-subject_match-test",
  theme: "Политические связи / публичная экспозиция",
  claim:
    "Найдены материалы о политической и публичной экспозиции субъекта:\n" +
    "«Председатель Правительства РФ.» — источник (2x2.su/biography/bondarchuk-fyedor-sergeevich)\n" +
    "Всего по теме: 2 материала.\n" +
    "Это усиливает вопросы к связям, влиянию и приемлемости контрагента для сделки.",
  riskLevel: "medium",
  regions: ["RU", "UAE"],
  evidenceRefs: ["inventory:wiki", "inventory:apple"],
  sourceDomains: ["ru.wikipedia.org", "tv.apple.com"],
} as unknown as Finding;

function scoped(evidenceIndex: Record<string, unknown>): ScopedFragmentInput {
  return {
    subject: { displayName: "Бондарчук Фёдор Сергеевич", aliases: [] },
    findings: [POLITICAL],
    surfaceUnits: [],
    evidenceIndex,
    scope: { regions: ["RU"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

describe("региональный блок темы печатает фразу с темой", () => {
  it("Р1: из цитат страницы берётся та, что несёт сигнал темы, а не первая", () => {
    const claim = localizedThemedClaim(
      POLITICAL,
      scoped({
        "inventory:wiki": {
          title: "Бондарчук, Фёдор Сергеевич — Википедия",
          domain: "ru.wikipedia.org",
          url: "https://ru.wikipedia.org/wiki/Бондарчук,_Фёдор_Сергеевич",
          region: "RU",
          readVerdictTone: "adverse",
          verdictSubjectMatch: "subject",
          pageQuote: WIKI_LEAD,
          pageQuotes: [WIKI_LEAD, WIKI_PARTY, WIKI_SCHOOL],
        },
        "inventory:apple": {
          title: "Фёдор Бондарчук — Фильмы и телешоу — Apple TV",
          domain: "tv.apple.com",
          url: "https://tv.apple.com/ru/person/федор-бондарчук",
          region: "RU",
          readVerdictTone: "supportive",
          verdictSubjectMatch: "subject",
          pageQuote:
            "Фёдор Сергеевич Бондарчук — советский и российский актёр кино, телевидения, озвучивания и дубляжа, режиссёр и продюсер кино и телевидения",
          pageQuotes: [
            "Фёдор Сергеевич Бондарчук — советский и российский актёр кино, телевидения, озвучивания и дубляжа, режиссёр и продюсер кино и телевидения",
          ],
        },
      })
    );
    expect(claim).toContain("Единая Россия");
    expect(claim).not.toContain("актёр кино");
    expect(claim).not.toContain("Председатель Правительства РФ");
  });

  it("Р2: страница без фразы с темой даёт честную строку, а не лид", () => {
    const claim = localizedThemedClaim(
      POLITICAL,
      scoped({
        "inventory:wiki": {
          title: "Бондарчук, Фёдор Сергеевич — Википедия",
          domain: "ru.wikipedia.org",
          url: "https://ru.wikipedia.org/wiki/Бондарчук,_Фёдор_Сергеевич",
          region: "RU",
          readVerdictTone: "adverse",
          verdictSubjectMatch: "subject",
          pageQuote: WIKI_LEAD,
          pageQuotes: [WIKI_LEAD, WIKI_SCHOOL],
        },
      })
    );
    expect(claim).not.toContain("актёр кино");
    expect(claim).toContain("По теме в источниках ru.wikipedia.org");
  });

  it("Р4: у описательной темы честная строка говорит о сути темы, а не риска", () => {
    const business = {
      ...POLITICAL,
      findingId: "finding-business_profile-subject_match-test",
      theme: "Деловой профиль",
      riskLevel: "low",
      claim:
        "Найдены материалы делового и биографического профиля:\n" +
        "«Paulina Andreeva - Biography» — источник imdb.com\n" +
        "Всего по теме: 2 материала.",
    } as unknown as Finding;
    const claim = localizedThemedClaim(
      business,
      scoped({
        "inventory:wiki": {
          title: "Paulina Andreeva - Biography - IMDb",
          domain: "imdb.com",
          url: "https://www.imdb.com/name/nm1234567/bio/",
          region: "RU",
        },
      })
    );
    expect(claim).not.toContain("Paulina Andreeva");
    expect(claim).toContain("с сутью темы");
    expect(claim).not.toContain("с сутью риска");
  });
});

describe("Р3: загрузчик деки оставляет все годные цитаты страницы", () => {
  it("вторая цитата не выбрасывается", () => {
    const index = {
      "inventory:wiki": {
        url: "https://ru.wikipedia.org/wiki/Бондарчук,_Фёдор_Сергеевич",
        domain: "ru.wikipedia.org",
        title: "Бондарчук, Фёдор Сергеевич — Википедия",
        region: "RU",
      },
    } as unknown as ScopedFragmentInput["evidenceIndex"];
    applyLinkVerdictsToEvidence(index, [
      {
        evidenceRef: "inventory:wiki",
        tone: "adverse",
        subjectMatch: "subject",
        quotes: [{ text: WIKI_LEAD }, { text: WIKI_PARTY }, { text: WIKI_SCHOOL }],
      },
    ]);
    expect(index["inventory:wiki"]!.pageQuote).toBe(WIKI_LEAD);
    expect(index["inventory:wiki"]!.pageQuotes).toEqual([WIKI_LEAD, WIKI_PARTY, WIKI_SCHOOL]);
  });
});
