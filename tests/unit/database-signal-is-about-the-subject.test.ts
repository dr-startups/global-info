/**
 * Сигнал комплаенс-базы называет запись о субъекте, а не о другом человеке
 * (шаг 0141).
 *
 * Стр. 8 отчёта Фридмана 20.09.2026: «opensanctions.org. По
 * открытым/импортированным данным есть сигнал, связанный с записью
 * „ООО УК «РОСВОДОКАНАЛ» — Москва — Гендиректор Михальков…“». В записи стоит
 * Михальков, а лист подаёт её как сигнал по Фридману. Это утверждение о
 * человеке, которое до него не прослеживается, — то, чего продукт делать не
 * должен никогда.
 *
 * Предикат тот же, что у цитат: голое имя в сегменте заголовка, не содержащее
 * основы имени субъекта. Запись без имени вовсе остаётся: она не называет
 * чужого.
 */

import { describe, expect, it } from "vitest";
import { buildInternationalDatabases } from "@/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";
import type { CanonicalClaim } from "@/modules/digital-profile/orion-golden/contracts/canonical-claim";

const SUBJECT = "Фридман Михаил Маратович";

function claim(title: string): CanonicalClaim {
  return {
    claimId: `claim-${title.length}`,
    subjectId: SUBJECT,
    fullClaimText: `Санкции, PEP, RCA и compliance-сигналы\n«${title}»`,
    displayExcerpt: title,
    claimKind: "DATABASE_STATUS",
    subjectMatch: "SUBJECT_MATCH",
    confidence: 0.9,
    themeIds: ["sanctions_pep_rca_compliance"],
    materialityLevel: "HIGH",
    materialityReasons: [],
    namedEntities: [],
    dates: [],
    regions: ["RU"],
    contradictions: [],
    evidenceRefs: ["inventory:db-1"],
    sourceDomains: ["opensanctions.org"],
    provenance: { providers: [], reportRunIds: [], evidenceRefs: [] },
    evidenceTypes: ["database_record"],
    originalTitle: title,
    originalDomain: "opensanctions.org",
    originalUrl: "https://www.opensanctions.org/entities/x",
    originalFullTextRef: null,
    clientQualification: "Сигнал базы требует сверки идентификаторов.",
    recommendedAction: "Сверить карточку.",
    dispositionRef: "inventory:db-1",
    summaryOverrideRequired: false,
  } as unknown as CanonicalClaim;
}

const summaryFor = (title: string): string =>
  buildInternationalDatabases([claim(title)], [SUBJECT])
    .map((d) => d.statusSummary)
    .join(" ");

describe("сигнал международной базы", () => {
  it("Д1: запись про другого человека заголовком не печатается", () => {
    const summary = summaryFor('ООО УК "РОСВОДОКАНАЛ" - Москва - Гендиректор Михальков Сергей Петрович');
    expect(summary).not.toContain("Михальков");
    expect(summary).toMatch(/требует сверки по идентификаторам/u);
  });

  it("Д2: запись, называющая субъекта, печатается как прежде", () => {
    const summary = summaryFor("Mikhail Fridman - Sanctions record");
    expect(summary).toContain("Mikhail Fridman - Sanctions record");
  });

  it("Д3: запись без имени вовсе печатается — чужого она не называет", () => {
    const summary = summaryFor("Designation - UK Sanctions List");
    expect(summary).toContain("Designation - UK Sanctions List");
  });
});
