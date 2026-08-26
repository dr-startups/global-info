/**
 * Присказка «почему это важно» переживает региональную пересборку темы.
 *
 * Региональный блок темы собирается из разобранных частей глобального
 * утверждения, и присказку в нём отбирали регулярным выражением по первому
 * слову строки. Два пояснения из восьми под этот перечень начал не подходят:
 * «Для KYC это типичный запрос…» (офшоры) и «Для международных проверок…»
 * (линия безопасности). Страница офшоров у банка оставалась без единственного
 * предложения, объясняющего, зачем ей эта тема.
 *
 * Присказка задана темой, а не текстом утверждения, поэтому берётся по
 * идентификатору темы — тем же справочником, которым её пишет синтезатор
 * находок.
 */

import { describe, expect, it } from "vitest";
import { localizedThemedClaim } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import type { ScopedFragmentInput } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { Finding } from "@/modules/digital-profile/orion-golden/contracts/finding";

const OFFSHORE_WHY =
  "Для KYC это типичный запрос на раскрытие бенефициаров и источников контроля.";
const SECURITY_WHY = "Для международных проверок это зона повышенного внимания.";

function uaeScoped(evidenceIndex: Record<string, unknown>): ScopedFragmentInput {
  return {
    findings: [],
    surfaceUnits: [],
    evidenceIndex,
    scope: { regions: ["UAE"] },
    metricSnapshot: {},
  } as unknown as ScopedFragmentInput;
}

/** Кросс-региональная находка: опора темы российская, страница — ОАЭ. */
function crossRegionalFinding(theme: string, why: string): Finding {
  return {
    findingId: `finding-${theme}-subject_match-why`,
    theme,
    claim:
      "Найдены публикации по теме:\n" +
      "«Офшорная структура владения раскрыта в реестре» — источник kulak.team\n" +
      "Всего по теме: 3 материала.\n" +
      why,
    riskLevel: "medium",
    regions: ["RU", "UAE"],
    evidenceRefs: ["ev-ru", "ev-uae"],
    sourceDomains: ["kulak.team", "gulfnews.com"],
  } as unknown as Finding;
}

describe("региональный блок темы называет, почему тема важна", () => {
  it.each([
    ["Офшоры / корпоративное владение", OFFSHORE_WHY],
    ["Внимание по линии безопасности / оборонный контур", SECURITY_WHY],
  ])("«%s» — присказка остаётся в пустой ветке", (theme, why) => {
    const claim = localizedThemedClaim(
      crossRegionalFinding(theme, why),
      uaeScoped({
        "ev-ru": {
          title: "Офшорная структура владения раскрыта в реестре",
          domain: "kulak.team",
          region: "RU",
        },
        // Страницу прочитали и признали нейтральной — цитировать её темой
        // нельзя, и ветка остаётся без цитат.
        "ev-uae": {
          title: "Gulf News profiles a Dubai holding company",
          domain: "gulfnews.com",
          region: "UAE",
          readVerdictTone: "neutral",
        },
      })
    );
    expect(claim).toContain("По теме в источниках gulfnews.com");
    expect(claim).toContain(why);
  });

  it.each([
    ["Офшоры / корпоративное владение", OFFSHORE_WHY],
    ["Внимание по линии безопасности / оборонный контур", SECURITY_WHY],
  ])("«%s» — присказка остаётся и под региональной цитатой", (theme, why) => {
    const claim = localizedThemedClaim(
      crossRegionalFinding(theme, why),
      uaeScoped({
        "ev-ru": {
          title: "Офшорная структура владения раскрыта в реестре",
          domain: "kulak.team",
          region: "RU",
        },
        "ev-uae": {
          title: "Dubai registry links the subject to an offshore holding chain",
          domain: "gulfnews.com",
          region: "UAE",
        },
      })
    );
    expect(claim).toContain("gulfnews.com");
    expect(claim).toContain(why);
  });

  it("присказка не берётся у соседней темы", () => {
    const claim = localizedThemedClaim(
      crossRegionalFinding("Офшоры / корпоративное владение", OFFSHORE_WHY),
      uaeScoped({
        "ev-ru": {
          title: "Офшорная структура владения раскрыта в реестре",
          domain: "kulak.team",
          region: "RU",
        },
        "ev-uae": {
          title: "Dubai registry links the subject to an offshore holding chain",
          domain: "gulfnews.com",
          region: "UAE",
        },
      })
    );
    expect(claim).toContain(OFFSHORE_WHY);
    expect(claim).not.toContain(SECURITY_WHY);
  });
});

describe("присказка находится и в утверждении, собранном иначе", () => {
  /*
   * Точное равенство строки нашло бы её только в утверждении сегодняшней
   * сборки и разложенном по строкам. Между сборкой отчёта и пересборкой деки
   * справочник присказок правится, а утверждение бывает одним абзацем — в
   * обоих случаях присказка молча исчезала бы с региональной страницы, оставаясь
   * на исполнительной.
   */
  const SCOPED = uaeScoped({
    "ev-ru": {
      title: "Офшорная структура владения раскрыта в реестре",
      domain: "kulak.team",
      region: "RU",
    },
    "ev-uae": {
      title: "Dubai registry links the subject to an offshore holding chain",
      domain: "gulfnews.com",
      region: "UAE",
    },
  });

  function claimOnUaePage(claim: string): string {
    const finding = {
      ...crossRegionalFinding("Офшоры / корпоративное владение", OFFSHORE_WHY),
      claim,
    } as unknown as Finding;
    return localizedThemedClaim(finding, SCOPED);
  }

  it("утверждение одним абзацем — присказка на месте", () => {
    const claim = claimOnUaePage(
      "Найдены публикации об офшорных и корпоративных структурах владения: " +
        "«Офшорная структура владения раскрыта в реестре» — источник kulak.team " +
        `Всего по теме: 3 материала. ${OFFSHORE_WHY}`
    );
    expect(claim).toContain(OFFSHORE_WHY);
  });

  it("прежняя редакция присказки — печатается нынешняя", () => {
    const claim = claimOnUaePage(
      "Найдены публикации об офшорных и корпоративных структурах владения:\n" +
        "«Офшорная структура владения раскрыта в реестре» — источник kulak.team\n" +
        "Всего по теме: 3 материала.\n" +
        "Для KYC это типовой запрос на раскрытие бенефициаров."
    );
    expect(claim).toContain(OFFSHORE_WHY);
    expect(claim).not.toContain("типовой запрос");
  });

  it("легаси-утверждение без счёта присказку не выдумывает", () => {
    // Утверждения фикстуры `report-72` — однострочники старого формата: ни
    // строки счёта, ни присказки. Дописывать им своё региональная пересборка
    // не вправе: она переписывает найденное.
    const claim = claimOnUaePage(
      "Офшоры / корпоративное владение: 4 свидетельства (1 негативное) в источниках " +
        "kulak.team, gulfnews.com. Примеры: Офшорная структура владения раскрыта в реестре · " +
        "Dubai registry links the subject to an offshore holding chain"
    );
    expect(claim).not.toContain(OFFSHORE_WHY);
  });
});
