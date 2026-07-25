import { describe, expect, it } from "vitest";
import { selectRepresentativeEvidence } from "../../src/modules/digital-profile/orion-golden/analytics/representative-evidence-selector";
import type {
  CanonicalClaim,
  CanonicalClaimsBundle,
} from "../../src/modules/digital-profile/orion-golden/contracts/canonical-claim";

/**
 * Шаг 05.3-bis плана (docs/rework/05-claim-synthesis-and-gpt-input.md).
 *
 * Дедупликация представительных материалов была локальной для темы, поэтому
 * один и тот же материал занимал слоты сразу в нескольких темах. В отчёте это
 * дало слайд, где статья «Here's What You Need To Know About Pavel Durov»
 * одновременно обосновывала и деловые связи, и криминальные материалы, и
 * офшоры — пять тем одним источником.
 */

function claim(over: Partial<CanonicalClaim> & Pick<CanonicalClaim, "claimId">): CanonicalClaim {
  return {
    subjectId: "Субъект",
    fullClaimText: "Материал сообщает о существенных обстоятельствах, связанных с субъектом.",
    displayExcerpt: "Материал сообщает о существенных обстоятельствах.",
    claimKind: "SOURCE_ALLEGATION",
    subjectMatch: "SUBJECT_MATCH",
    confidence: 0.9,
    themeIds: [],
    adverseType: null,
    materialityLevel: "HIGH",
    materialityReasons: [],
    namedEntities: [],
    dates: [],
    regions: ["RU"],
    contradictions: [],
    evidenceRefs: [`inventory:${over.claimId}`],
    sourceDomains: ["example.com"],
    provenance: { providers: ["yandex"], reportRunIds: ["run-1"], findingIds: ["f-1"] },
    originalTitle: `Заголовок ${over.claimId}`,
    originalDomain: "example.com",
    originalUrl: `https://example.com/${over.claimId}`,
    originalFullTextRef: null,
    clientQualification: "Утверждение источника, требует проверки.",
    recommendedAction: "Сверить первоисточник.",
    dispositionRef: `inventory:${over.claimId}`,
    summaryOverrideRequired: false,
    ...over,
  } as CanonicalClaim;
}

function select(claims: CanonicalClaim[]) {
  const bundle = {
    schemaVersion: "canonical-claims-bundle-v1",
    caseId: "case-x",
    datasetId: "ds-x",
    sourceHashes: ["sha256:a"],
    evidenceRefs: claims.flatMap((c) => c.evidenceRefs),
    subjectId: "Субъект",
    claims,
    gates: {
      CANONICAL_CLAIM_TRACE_COMPLETE: true,
      MATERIAL_ADVERSE_WITHOUT_THEME: 0,
      UNQUALIFIED_MEDIA_ALLEGATIONS: 0,
      SUBJECT_UNIVERSALITY_PASS: true,
    },
  } as unknown as CanonicalClaimsBundle;

  return selectRepresentativeEvidence({
    caseId: "case-x",
    datasetId: "ds-x",
    subjectId: "Субъект",
    sourceHashes: ["sha256:a"],
    claimsBundle: bundle,
  }).selection;
}

describe("представительные материалы между темами", () => {
  it("даёт каждой теме собственный материал, когда альтернатива есть", () => {
    // Оба claim'а принадлежат обеим темам — выбор есть, дублировать незачем.
    const a = claim({
      claimId: "c-a",
      themeIds: ["criminal_judicial", "offshore_financial_transparency"],
      originalTitle: "Материал А",
      originalUrl: "https://a.example/1",
      originalDomain: "a.example",
      sourceDomains: ["a.example"],
    });
    const b = claim({
      claimId: "c-b",
      themeIds: ["criminal_judicial", "offshore_financial_transparency"],
      originalTitle: "Материал Б",
      originalUrl: "https://b.example/1",
      originalDomain: "b.example",
      sourceDomains: ["b.example"],
    });

    const sel = select([a, b]);
    const criminal = sel.selectedByTheme["criminal_judicial"] ?? [];
    const offshore = sel.selectedByTheme["offshore_financial_transparency"] ?? [];

    expect(criminal.length).toBeGreaterThan(0);
    expect(offshore.length).toBeGreaterThan(0);

    const criminalIds = new Set(criminal.map((s) => s.claimId));
    const offshoreIds = new Set(offshore.map((s) => s.claimId));
    const shared = [...criminalIds].filter((id) => offshoreIds.has(id));
    expect(shared).toEqual([]);
  });

  it("не оставляет тему пустой, если уникальных материалов не осталось", () => {
    // Единственный claim обслуживает обе темы — переиспользование допустимо,
    // иначе вторая тема исчезнет из отчёта вовсе.
    const only = claim({
      claimId: "c-only",
      themeIds: ["criminal_judicial", "offshore_financial_transparency"],
    });

    const sel = select([only]);
    const criminal = sel.selectedByTheme["criminal_judicial"] ?? [];
    const offshore = sel.selectedByTheme["offshore_financial_transparency"] ?? [];

    expect(criminal.length).toBe(1);
    expect(offshore.length).toBe(1);
    // Переиспользование помечается явно, чтобы это было видно в диагностике.
    const reused = [...criminal, ...offshore].some((s) =>
      s.selectionReasons.includes("reused_across_themes")
    );
    expect(reused).toBe(true);
  });

  it("не помечает переиспользованием материалы, выбранные впервые", () => {
    const a = claim({ claimId: "c-a", themeIds: ["criminal_judicial"] });
    const b = claim({
      claimId: "c-b",
      themeIds: ["offshore_financial_transparency"],
      originalDomain: "b.example",
      sourceDomains: ["b.example"],
    });

    const sel = select([a, b]);
    const all = Object.values(sel.selectedByTheme).flat();
    expect(all.length).toBeGreaterThan(0);
    for (const s of all) {
      expect(s.selectionReasons).not.toContain("reused_across_themes");
    }
  });
});
