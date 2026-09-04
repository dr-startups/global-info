/**
 * Материал, принадлежность которого не подтверждена, не попадает ни в темы, ни
 * в уровень риска — каким бы громким ни был его заголовок.
 *
 * `isMaterialClaim` пропускал AMBIGUOUS с уровнем CRITICAL или HIGH. Под
 * якорями «AMBIGUOUS» означает ровно «совпало только имя», и такой материал
 * громче всех: заголовок про уголовное дело у полного тёзки — обычная строка
 * выдачи. Прогон DPA-2026-0049 собрал из них тему «Арбитражные споры и
 * нарушения в деятельности ИП» про человека из Мончегорска.
 */

import { describe, expect, it } from "vitest";
import { isMaterialClaim } from "@/modules/digital-profile/orion-golden/analytics/representative-evidence-selector";
import type { CanonicalClaim } from "@/modules/digital-profile/orion-golden/contracts/canonical-claim";

function claim(over: Partial<CanonicalClaim>): CanonicalClaim {
  return {
    claimId: "c-1",
    caseId: "case-1",
    datasetId: "ds-1",
    sourceHashes: [],
    evidenceRefs: ["inventory:x"],
    fullClaimText: "Заголовок про уголовное дело",
    displayExcerpt: "Заголовок про уголовное дело",
    claimKind: "SOURCE_ALLEGATION",
    subjectMatch: "AMBIGUOUS",
    confidence: 0.5,
    themeIds: ["criminal_legal"],
    adverseType: "adverse_held_from_disposition",
    materialityLevel: "CRITICAL",
    materialityReasons: ["adverse_text", "disposition:KEEP_PRIMARY", "full_name_no_anchor"],
    namedEntities: [],
    dates: [],
    regions: ["RU"],
    contradictions: [],
    sourceDomains: ["rusprofile.ru"],
    provenance: { providers: ["topvisor-yandex"], reportRunIds: ["run-1"], findingIds: [] },
    ...over,
  } as unknown as CanonicalClaim;
}

describe("материальность заявления", () => {
  it("совпало только имя — заявление не материально даже при уровне CRITICAL", () => {
    expect(isMaterialClaim(claim({}))).toBe(false);
  });

  it("реестровая строка с непроверяемым ИНН — тоже", () => {
    expect(
      isMaterialClaim(
        claim({ claimId: "c-2", materialityReasons: ["adverse_text", "registry_inn_unverified"] })
      )
    ).toBe(false);
  });

  it("подтверждённое заявление остаётся материальным", () => {
    expect(
      isMaterialClaim(
        claim({
          claimId: "c-3",
          subjectMatch: "SUBJECT_MATCH",
          materialityReasons: ["adverse_text", "full_name_with_anchor:employer"],
        })
      )
    ).toBe(true);
  });

  it("прежняя ветка не тронута: неоднозначное заявление без якорей по-прежнему материально при CRITICAL", () => {
    // Без якорей код причины другой, и правило шага 0054 не действует —
    // старые кейсы и фикстуры судятся как раньше.
    expect(
      isMaterialClaim(
        claim({ claimId: "c-4", materialityReasons: ["adverse_text", "full_name_match"] })
      )
    ).toBe(true);
  });
});
