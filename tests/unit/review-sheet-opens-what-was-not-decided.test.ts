/**
 * Открытый пункт листа — тот, о котором машина решить не смогла.
 *
 * «Открыт» — это не «плохо» и не «негатив»: материал, отнесённый к субъекту, и
 * материал, названный чужим, уже названы честно, и решать по ним нечего — но
 * на листе они стоят, потому что снять можно и их. Открытых пунктов ровно
 * столько, сколько раз отчёт напечатал утверждение, которого сам не проверил;
 * на бандле отчёта 86 их 111 из 160.
 */

import { describe, expect, it } from "vitest";
import { buildReviewSheet } from "@/modules/digital-profile/services/review-sheet";

const CASE_ID = "case-1";

function table(refs: string[]) {
  return [
    {
      slideKey: "p09_ru_serp_table",
      baseSlotId: "p09_ru_serp_table",
      templateId: "serp-table",
      pageNumber: 15,
      title: "Россия — результаты поисковой выдачи",
      evidenceRefs: refs,
    },
  ];
}

const DECISIONS = [
  ["match", "SUBJECT_MATCH", "full_name_with_anchor:employer"],
  ["likely", "LIKELY_SUBJECT", "surname_with_anchor"],
  ["ambiguous", "AMBIGUOUS", "surname_query_no_anchor"],
  ["thin", "INSUFFICIENT_IDENTIFIERS", "no_subject_tokens"],
  ["other", "OTHER_SUBJECT", "foreign_inn"],
] as const;

describe("лист проверки: что открыто", () => {
  it("открыт тот, чья принадлежность не решена", () => {
    const sheet = buildReviewSheet({
      caseId: CASE_ID,
      slides: table(DECISIONS.map(([id]) => `inventory:obs-${id}`)),
      observations: DECISIONS.map(([id]) => ({
        url: `https://${id}.example/1`,
        title: `Материал ${id}`,
        domain: `${id}.example`,
        evidenceRefs: [`inventory:obs-${id}`],
      })),
      subjectResolution: DECISIONS.map(([id, decision, reasonCode]) => ({
        evidenceRef: `inventory:obs-${id}`,
        decision,
        reasonCode,
      })),
    });

    const openKeys = sheet.items.filter((i) => i.open).map((i) => i.domain);
    expect(openKeys.sort()).toEqual(["ambiguous.example", "likely.example", "thin.example"]);
    expect(sheet.items).toHaveLength(5);
    expect(sheet.summary.evidence.open).toBe(3);
  });

  it("код причины расшифрован словами, а незнакомый — назван как есть", () => {
    const sheet = buildReviewSheet({
      caseId: CASE_ID,
      slides: table(["inventory:obs-1", "inventory:obs-2"]),
      observations: [
        { url: "https://a.ru/1", title: "А", domain: "a.ru", evidenceRefs: ["inventory:obs-1"] },
        { url: "https://b.ru/2", title: "Б", domain: "b.ru", evidenceRefs: ["inventory:obs-2"] },
      ],
      subjectResolution: [
        { evidenceRef: "inventory:obs-1", decision: "AMBIGUOUS", reasonCode: "surname_query_no_anchor" },
        { evidenceRef: "inventory:obs-2", decision: "AMBIGUOUS", reasonCode: "какой_то_новый_код" },
      ],
    });
    const a = sheet.items.find((i) => i.domain === "a.ru");
    expect(a?.reason?.code).toBe("surname_query_no_anchor");
    expect(a?.reason?.label).toContain("фамилия");
    expect(a?.reason?.label).not.toBe("surname_query_no_anchor");
    const b = sheet.items.find((i) => i.domain === "b.ru");
    expect(b?.reason?.label).toBe("какой_то_новый_код");
  });

  it("тема получает страницы от слайдов, а «Требует подтверждения» открыта", () => {
    const sheet = buildReviewSheet({
      caseId: CASE_ID,
      slides: [
        {
          slideKey: "p04_risk_dashboard",
          baseSlotId: "p04_risk_dashboard",
          templateId: "risk-matrix",
          pageNumber: 9,
          title: "Матрица комплаенс-рисков",
          findingIds: ["finding-criminal", "finding-likely"],
        },
        {
          slideKey: "appendix_main_base",
          baseSlotId: "appendix_main_base",
          templateId: "finding-cards",
          pageNumber: 62,
          title: "Приложение",
          findingIds: ["finding-appendix"],
        },
      ],
      observations: [],
      subjectResolution: [],
      findings: [
        { findingId: "finding-criminal", theme: "Криминальные / судебные материалы", subjectMatch: "SUBJECT_MATCH", riskLevel: "critical" },
        { findingId: "finding-likely", theme: "Финансовые претензии / долговые споры", subjectMatch: "LIKELY_SUBJECT", riskLevel: "low" },
        // Находка есть в наборе, но её не называет ни одна страница.
        { findingId: "finding-gone", theme: "Деловой профиль", subjectMatch: "OTHER_SUBJECT", riskLevel: "none" },
      ],
      ambiguousFindings: [
        { findingId: "finding-appendix", theme: "Корпоративное владение", subjectMatch: "AMBIGUOUS", riskLevel: "low" },
      ],
    });

    const themes = sheet.items.filter((i) => i.kind === "finding");
    // Тема, которую не печатает ни одна страница, на листе не стоит.
    expect(themes.map((t) => t.key).sort()).toEqual([
      "finding-appendix",
      "finding-criminal",
      "finding-likely",
    ]);
    expect(themes.find((t) => t.key === "finding-criminal")?.pages).toEqual([9]);
    expect(themes.find((t) => t.key === "finding-appendix")?.pages).toEqual([62]);
    expect(themes.filter((t) => t.open).map((t) => t.key)).toEqual(["finding-likely"]);
    expect(sheet.summary.finding).toEqual({ total: 3, open: 1 });
  });

  it("комплаенс: запись без решения открыта, слот без снимка тоже", () => {
    const sheet = buildReviewSheet({
      caseId: CASE_ID,
      slides: [
        { slideKey: "p34_dow_jones", baseSlotId: "p34_dow_jones", templateId: "coverage-empty-state", pageNumber: 60, title: "Dow Jones — профиль" },
        { slideKey: "p35_lexis_visual", baseSlotId: "p35_lexis_visual", templateId: "serp-screenshot-analysis", pageNumber: 61, title: "LexisNexis — страница профиля" },
      ],
      observations: [],
      subjectResolution: [],
      compliance: {
        items: [
          { inventoryId: "db-1", provider: "OPEN_SANCTIONS", title: "Egorov Aleksey", classification: "PENDING" },
          { inventoryId: "db-2", provider: "OPEN_SANCTIONS", title: "Egorov A. E.", classification: "FALSE_POSITIVE" },
        ],
      },
      visualAssets: {
        p35_lexis_visual: [{ kind: "compliance_visual", visibleItems: [] }],
      },
    });

    const compliance = sheet.items.filter((i) => i.kind === "compliance");
    const keys = compliance.map((c) => c.key).sort();
    expect(keys).toEqual(["db-1", "db-2", "p34_dow_jones", "p35_lexis_visual"]);
    // Снимка Dow Jones нет — пункт открыт; у LexisNexis актив есть — закрыт.
    expect(compliance.find((c) => c.key === "p34_dow_jones")?.open).toBe(true);
    expect(compliance.find((c) => c.key === "p35_lexis_visual")?.open).toBe(false);
    expect(compliance.find((c) => c.key === "db-1")?.open).toBe(true);
    expect(compliance.find((c) => c.key === "db-2")?.open).toBe(false);
    expect(compliance.find((c) => c.key === "p34_dow_jones")?.pages).toEqual([60]);
  });
});
