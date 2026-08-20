import { describe, expect, it } from "vitest";
import { validateSectionPack } from "@/modules/digital-profile/orion-golden/deck-sections/section-validation";
import { SECTION_PACK_SCHEMA_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { SectionPackV2 } from "@/modules/digital-profile/orion-golden/deck-sections/contracts";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { VerifiedFindingBundle } from "@/modules/digital-profile/orion-golden/contracts/verified-finding-bundle";
import { WIKIPEDIA_FRAGMENT_CATEGORY_LABELS } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

/**
 * Серверные ворота, а не только построитель.
 *
 * Фрагмент текста статьи — это негатив о ком-то. Пока не доказано, что статья о
 * проверяемом лице, он работал бы на чужой профиль. Построитель эту ветку уже
 * закрывает, но ворота повторяют проверку по данным пака: проверка, которая
 * читает вывод построителя, подтверждает сама себя.
 */

const CHECK_REF = "inventory:wiki-check-ru";
const FRAGMENT_BULLET =
  `${WIKIPEDIA_FRAGMENT_CATEGORY_LABELS.negative}: ` +
  "«В 2019 году в отношении компании начата налоговая проверка.» — налоговая проверка " +
  "(раздел «Деятельность»). Рекомендация: сверить формулировку с первоисточниками.";
const LEAD_BULLET = "Начало статьи (дословно): Андерс Хольмстрём — шведский предприниматель.";

const BUNDLE = {
  schemaVersion: "verified-finding-bundle-v1",
  caseId: "c1",
  datasetId: "d1",
  reportRunId: "r1",
  findings: [],
  excludedFindingIds: [],
} as unknown as VerifiedFindingBundle;

const OTHER_CHECK_REF = "inventory:wiki-check-en";

function evidenceIndex(subjectDecision: string): ScopedEvidenceIndex {
  return {
    [CHECK_REF]: {
      kind: "wikipedia_check",
      wikipediaExists: true,
      language: "ru",
      domain: "ru.wikipedia.org",
      url: "https://ru.wikipedia.org/wiki/Anders_Holmstrom",
      title: "Anders Holmström",
      subjectDecision,
    },
  };
}

/**
 * Слайд с двумя проверками: печатает построитель по найденной статье, а её
 * принадлежность не подтверждена. Соседняя запись «статьи нет» подтверждена —
 * ворота, спрашивающие «подтверждён ли хоть один», пропустили бы пак.
 */
const TWO_CHECKS: ScopedEvidenceIndex = {
  [CHECK_REF]: {
    kind: "wikipedia_check",
    wikipediaExists: true,
    language: "ru",
    domain: "ru.wikipedia.org",
    title: "Глинка (дворянский род)",
    subjectDecision: "AMBIGUOUS",
  },
  [OTHER_CHECK_REF]: {
    kind: "wikipedia_check",
    wikipediaExists: false,
    language: "en",
    domain: "en.wikipedia.org",
    subjectDecision: "SUBJECT_MATCH",
  },
};

function identityPack(
  bullets: string[],
  opts: { refs?: string[]; templateId?: string; fragmentKey?: string } = {}
): SectionPackV2 {
  const refs = opts.refs ?? [CHECK_REF];
  return {
    schemaVersion: SECTION_PACK_SCHEMA_VERSION,
    sectionId: "RU_PROFILE",
    sectionType: "RU_PROFILE",
    fragmentKey: opts.fragmentKey ?? "RU_IDENTITY_WIKIPEDIA",
    caseId: "c1",
    datasetId: "d1",
    reportRunId: "r1",
    sourceDatasetId: "d1",
    contentVersion: "deck-sections-v99",
    promptVersion: "ru-identity-analysis-deterministic-v1",
    contentHash: "sha256:x",
    inputHash: "h1",
    generatedAt: "2026-08-20T00:00:00.000Z",
    required: true,
    status: "READY",
    sourceFindingIds: [],
    evidenceRefs: refs,
    inputs: { findingIds: [], evidenceRefs: refs, metricSnapshotId: "m1" },
    slides: [
      {
        schemaVersion: "slide-content-v1",
        slideId: "p13_ru_wikipedia",
        baseSlotId: "p13_ru_wikipedia",
        sectionId: "RU_PROFILE",
        templateId: opts.templateId ?? "wikipedia-check",
        title: "Россия — Википедия",
        findingIds: [],
        evidenceRefs: refs,
        isContinuation: false,
        continuationOf: null,
        continuationIndex: null,
        visualAssetRefs: [],
        metrics: { wikipediaCheckExists: 1 },
        content: {
          narrative: "Результат проверки: статья найдена.",
          bullets,
        },
      },
    ],
    metrics: {
      datasetCount: 1,
      displayedCount: 1,
      adverseDatasetCount: 0,
      adverseDisplayedCount: 0,
    },
    provenance: { providers: [], reportRunIds: ["r1"], evidenceRefs: refs },
    validation: { passed: true, issues: [] },
  } as unknown as SectionPackV2;
}

function validateWith(
  bullets: string[],
  index: ScopedEvidenceIndex,
  opts: { refs?: string[]; templateId?: string; fragmentKey?: string } = {}
) {
  return validateSectionPack({
    pack: identityPack(bullets, opts),
    expectedCaseId: "c1",
    expectedReportRunId: "r1",
    expectedDatasetId: "d1",
    bundle: BUNDLE,
    knownEvidenceRefs: new Set(opts.refs ?? [CHECK_REF]),
    evidenceIndex: index,
  });
}

function validate(bullets: string[], subjectDecision: string) {
  return validateWith(bullets, evidenceIndex(subjectDecision));
}

describe("фрагменты статьи и подтверждённость принадлежности", () => {
  it("пак с фрагментами при неподтверждённой принадлежности не проходит", () => {
    const report = validate([LEAD_BULLET, FRAGMENT_BULLET], "AMBIGUOUS");
    expect(report.passed).toBe(false);
    expect(report.issues.join(" | ")).toMatch(/fragment/iu);
  });

  it("тот же пак при подтверждённой принадлежности проходит", () => {
    const report = validate([LEAD_BULLET, FRAGMENT_BULLET], "SUBJECT_MATCH");
    expect(report.issues).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("решение «статья о другом лице» фрагменты тоже запрещает", () => {
    expect(validate([LEAD_BULLET, FRAGMENT_BULLET], "OTHER_SUBJECT").passed).toBe(false);
  });

  it("лид без фрагментов при неподтверждённой принадлежности законен", () => {
    const report = validate([LEAD_BULLET], "AMBIGUOUS");
    expect(report.issues).toEqual([]);
    expect(report.passed).toBe(true);
  });
});

describe("признак фрагмента не ловит чужие страницы", () => {
  it("та же метка на странице другого шаблона секцию не роняет", () => {
    // «Требует проверки: …» — общеупотребительная фраза: статус ручного ревью,
    // уровень риска, подпись в комплаенсе. Признак фрагмента статьи обязан
    // держаться на шаблоне страницы, иначе любой такой буллет уронит
    // обязательную секцию — то есть деку целиком.
    const report = validateWith(
      ["Требует проверки: запись Dow Jones ожидает решения аналитика."],
      evidenceIndex("AMBIGUOUS"),
      { templateId: "serp-table", fragmentKey: "COMPLIANCE_MAIN" }
    );
    expect(report.issues).toEqual([]);
    expect(report.passed).toBe(true);
  });

  it("подтверждённая соседняя проверка не оправдывает фрагменты найденной статьи", () => {
    const report = validateWith([LEAD_BULLET, FRAGMENT_BULLET], TWO_CHECKS, {
      refs: [CHECK_REF, OTHER_CHECK_REF],
    });
    expect(report.passed).toBe(false);
    expect(report.issues.join(" | ")).toMatch(/fragment/iu);
  });
});

describe("дословный текст статьи ворота не роняет", () => {
  it("чужой домен внутри цитаты фрагмента проходит секционную валидацию", () => {
    // Ровно то, ради чего стоял гард построителя. Ворота буллеты в разбор не
    // берут (`wikipedia-check` — own scope), поэтому гард ничего не
    // предотвращал, а дословный текст удалял.
    const quoted =
      `${WIKIPEDIA_FRAGMENT_CATEGORY_LABELS.negative}: ` +
      "«Материал forbes.com называет сделку спорной» — спорная сделка " +
      "(раздел «Деятельность»). Рекомендация: сверить формулировку.";
    const report = validateWith([quoted], evidenceIndex("SUBJECT_MATCH"));
    expect(report.issues).toEqual([]);
    expect(report.passed).toBe(true);
  });
});
