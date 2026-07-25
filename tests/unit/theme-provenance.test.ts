import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "../../src/modules/digital-profile/orion-golden/types";
import {
  buildSubjectResolution,
  type SubjectIdentity,
} from "../../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import { synthesizeFindings } from "../../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { buildObservationDispositionLedger } from "../../src/modules/digital-profile/orion-golden/analytics/observation-disposition-ledger";
import { buildCanonicalClaimsBundle } from "../../src/modules/digital-profile/orion-golden/analytics/canonical-claim-builder";
import { selectRepresentativeEvidence } from "../../src/modules/digital-profile/orion-golden/analytics/representative-evidence-selector";
import { buildClientSummaryPack } from "../../src/modules/digital-profile/orion-golden/analytics/client-summary-pack-builder";

/**
 * Шаг 06.3 плана (docs/rework/06-theme-classification-false-positives.md).
 *
 * Тема могла возникнуть от срабатывания ключевого слова на мусорном материале.
 * Дальше в неё попадали любые факты, и отчёт печатал «Репутационные скандалы …
 * установлено: родился 10 октября 1984 года» — заголовок темы с посторонним
 * фактом под ним.
 */

const SUBJECT: SubjectIdentity = {
  displayName: "Тестов Сергей Михайлович",
  lastName: "Тестов",
  lastNameVariants: ["testov"],
  firstNames: ["Сергей"],
  patronymics: ["Михайлович"],
  aliases: ["Тестов Сергей Михайлович"],
  strongIdentifiers: [],
  contextIdentifiers: ["предприниматель"],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeNoise: [],
  namesakeProfiles: [],
};

let seq = 0;
function item(partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `tp-${seq}`,
    caseId: "case-tp",
    reportRunId: "run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-07-20T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: "",
    sourceUrl: `https://news.example/${seq}`,
    ...partial,
  } as RawInventoryItem;
}

const ITEMS = [
  item({
    title: "Тестов Сергей Михайлович задержан",
    snippet:
      "Тестов Сергей Михайлович задержан по подозрению в мошенничестве в особо крупном размере.",
  }),
  item({
    title: "Тестов Сергей Михайлович — предприниматель и инвестор",
    snippet: "Тестов Сергей Михайлович основал несколько компаний и является инвестором.",
  }),
];

function chain() {
  const resolution = buildSubjectResolution({
    caseId: "case-tp",
    datasetId: "ds-tp",
    items: ITEMS,
    subject: SUBJECT,
    sourceHashes: ["sha256:t"],
  });
  const byRef = new Map(resolution.items.map((i) => [i.evidenceRef, i]));
  const synthesis = synthesizeFindings({
    caseId: "case-tp",
    datasetId: "ds-tp",
    items: ITEMS,
    resolutionByRef: byRef,
    sourceHashes: ["sha256:t"],
  });
  const dispositionLedger = buildObservationDispositionLedger({
    caseId: "case-tp",
    datasetId: "ds-tp",
    inventoryReportRunId: "run-1",
    sourceHashes: ["sha256:t"],
    items: ITEMS,
    resolutionByRef: byRef,
    synthesis,
  });
  const claimsBundle = buildCanonicalClaimsBundle({
    caseId: "case-tp",
    datasetId: "ds-tp",
    subjectId: SUBJECT.displayName,
    sourceHashes: ["sha256:t"],
    items: ITEMS,
    synthesis,
    dispositionLedger,
  });
  const representative = selectRepresentativeEvidence({
    caseId: "case-tp",
    datasetId: "ds-tp",
    subjectId: SUBJECT.displayName,
    sourceHashes: ["sha256:t"],
    claimsBundle,
  });
  return { claimsBundle, representative: representative.selection };
}

function pack(over: Parameters<typeof buildClientSummaryPack>[0] extends infer T ? Partial<T> : never) {
  const { claimsBundle, representative } = chain();
  return buildClientSummaryPack({
    caseId: "case-tp",
    datasetId: "ds-tp",
    subjectId: SUBJECT.displayName,
    sourceHashes: ["sha256:t"],
    claimsBundle,
    representative,
    ...(over as object),
  } as never);
}

describe("происхождение темы", () => {
  it("оставляет тему, у которой есть собственный проверенный факт", () => {
    const { representative } = chain();
    const themeIds = Object.keys(representative.selectedByTheme);
    expect(themeIds.length).toBeGreaterThan(0);
    const target = themeIds[0]!;

    const built = pack({
      factsByTheme: {
        [target]: [
          {
            statement: "Источник сообщает о задержании.",
            quote: "Тестов Сергей Михайлович задержан по подозрению",
            status: "source_allegation",
            evidenceRef: "inventory:tp-1",
            themeId: target,
          },
        ],
      },
      factsProcessedThemes: themeIds,
    });
    expect(built.materialThemes.some((t) => t.clientTitle.length > 0)).toBe(true);
  });

  it("убирает тему, которую оправдывает только унаследованный факт", () => {
    const { representative } = chain();
    const themeIds = Object.keys(representative.selectedByTheme);
    const target = themeIds[0]!;

    // themeId отсутствует: модель не отнесла факт к этой теме, он лишь
    // унаследовал запрошенную. Именно так «родился 10 октября 1984 года»
    // оказался под «Репутационными скандалами».
    const built = pack({
      factsByTheme: {
        [target]: [
          {
            statement: "Тестов Сергей Михайлович родился в Санкт-Петербурге.",
            quote: "Тестов Сергей Михайлович основал несколько компаний",
            status: "established_fact",
            evidenceRef: "inventory:tp-2",
          },
        ],
      },
      factsProcessedThemes: themeIds,
    });
    expect(built.materialThemes).toEqual([]);
  });

  it("убирает тему, обработанную извлечением и не давшую ни одного факта", () => {
    const { representative } = chain();
    const themeIds = Object.keys(representative.selectedByTheme);

    const built = pack({ factsByTheme: {}, factsProcessedThemes: themeIds });
    expect(built.materialThemes).toEqual([]);
  });

  it("не трогает темы, когда извлечение фактов не выполнялось", () => {
    const withoutExtraction = pack({});
    expect(withoutExtraction.materialThemes.length).toBeGreaterThan(0);
  });

  it("в текст темы не попадает унаследованный факт", () => {
    const { representative } = chain();
    const themeIds = Object.keys(representative.selectedByTheme);
    const target = themeIds[0]!;

    const built = pack({
      factsByTheme: {
        [target]: [
          {
            // Унаследованный: модель к этой теме его не относила.
            statement: "Посторонний биографический факт.",
            quote: "Тестов Сергей Михайлович основал несколько компаний",
            status: "established_fact",
            evidenceRef: "inventory:tp-2",
          },
          {
            statement: "Источник сообщает о задержании.",
            quote: "Тестов Сергей Михайлович задержан по подозрению",
            status: "source_allegation",
            evidenceRef: "inventory:tp-1",
            themeId: target,
          },
        ],
      },
      factsProcessedThemes: themeIds,
    });

    const theme = built.materialThemes.find((t) => t.themeId === target);
    expect(theme).toBeDefined();
    const text = [theme!.conclusion, ...theme!.concreteClaims].join(" ");
    expect(text).toContain("задержании");
    expect(text).not.toContain("Посторонний биографический факт");
  });

  it("отсев темы не роняет гейт валидности пака", () => {
    // Регрессия: гейт считал отсеянную CRITICAL/HIGH тему «пропавшей»,
    // CLIENT_SUMMARY_PACK_VALID становился false, и отчёт не собирался вовсе —
    // хуже исходного дефекта. Отсев осознан и должен учитываться как таковой.
    const { representative } = chain();
    const themeIds = Object.keys(representative.selectedByTheme);
    const built = pack({ factsByTheme: {}, factsProcessedThemes: themeIds });

    expect(built.materialThemes).toEqual([]);
    expect(built.gates.CLIENT_SUMMARY_PACK_VALID).toBe(true);
    expect(built.gates.MATERIAL_THEMES_MISSING).toBe(0);
  });

  it("не убирает тему, для которой извлечение не запускалось", () => {
    const { representative } = chain();
    const themeIds = Object.keys(representative.selectedByTheme);
    // Извлечение прошло по другой теме, эту не трогало.
    const built = pack({ factsByTheme: {}, factsProcessedThemes: ["identity_mismatch"] });
    expect(built.materialThemes.length).toBeGreaterThan(0);
    expect(themeIds.length).toBeGreaterThan(0);
  });
});

describe("единый вердикт (шаг 07.9)", () => {
  it("текст резюме использует переданный вердикт, а не пересчитывает свой", () => {
    // Плашка берёт вердикт executive summary (шкала без «критического»),
    // а текст считал по материальности тем, где «критический» есть. На одном
    // слайде стояло «Итоговая оценка: Высокий риск» и сразу под ним
    // «Итоговая оценка: критический риск».
    const { representative } = chain();
    const themeIds = Object.keys(representative.selectedByTheme);
    const target = themeIds[0]!;
    const built = pack({
      factsByTheme: {
        [target]: [
          {
            statement: "Источник сообщает о задержании.",
            quote: "Тестов Сергей Михайлович задержан по подозрению",
            status: "source_allegation",
            evidenceRef: "inventory:tp-1",
            themeId: target,
          },
        ],
      },
      overallVerdict: "HIGH",
    });
    expect(built.overallAssessment.conclusion).toContain("высокий");
    expect(built.overallAssessment.conclusion).not.toContain("критический");
  });

  it("без переданного вердикта поведение прежнее", () => {
    const { representative } = chain();
    const themeIds = Object.keys(representative.selectedByTheme);
    const target = themeIds[0]!;
    const built = pack({
      factsByTheme: {
        [target]: [
          {
            statement: "Источник сообщает о задержании.",
            quote: "Тестов Сергей Михайлович задержан по подозрению",
            status: "source_allegation",
            evidenceRef: "inventory:tp-1",
            themeId: target,
          },
        ],
      },
    });
    expect(built.overallAssessment.conclusion).toContain("Итоговая оценка");
  });
});
