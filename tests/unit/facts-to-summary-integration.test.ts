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
import { runFactExtraction } from "../../src/modules/digital-profile/orion-golden/gpt/run-fact-extraction";

/**
 * Шаг 05.2(в2) — сквозная проверка связки.
 *
 * Материалы → findings → claims → представители → извлечение фактов → текст
 * резюме. Тест существует прежде всего ради одного: evidenceRef, по которым
 * раннер ищет материалы, должны совпадать с теми, что проставил построитель
 * claim'ов. Ручная обвязка на артефактах этого не проверяет — там refs
 * восстановить неоткуда.
 */

const SUBJECT: SubjectIdentity = {
  displayName: "Тестов Сергей Михайлович",
  lastName: "Тестов",
  lastNameVariants: ["testov"],
  firstNames: ["Сергей", "sergey"],
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

const QUOTE =
  "Тестов Сергей Михайлович задержан по подозрению в мошенничестве в особо крупном размере";

let seq = 0;
function item(partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `it-${seq}`,
    caseId: "case-facts",
    reportRunId: "base-run-1",
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

function buildChain(items: RawInventoryItem[]) {
  const resolution = buildSubjectResolution({
    caseId: "case-facts",
    datasetId: "ds-facts",
    items,
    subject: SUBJECT,
    sourceHashes: ["sha256:test"],
  });
  const byRef = new Map(resolution.items.map((i) => [i.evidenceRef, i]));

  const synthesis = synthesizeFindings({
    caseId: "case-facts",
    datasetId: "ds-facts",
    items,
    resolutionByRef: byRef,
    sourceHashes: ["sha256:test"],
  });
  const dispositionLedger = buildObservationDispositionLedger({
    caseId: "case-facts",
    datasetId: "ds-facts",
    inventoryReportRunId: "base-run-1",
    sourceHashes: ["sha256:test"],
    items,
    resolutionByRef: byRef,
    synthesis,
  });
  const claimsBundle = buildCanonicalClaimsBundle({
    caseId: "case-facts",
    datasetId: "ds-facts",
    subjectId: SUBJECT.displayName,
    sourceHashes: ["sha256:test"],
    items,
    synthesis,
    dispositionLedger,
  });
  const representative = selectRepresentativeEvidence({
    caseId: "case-facts",
    datasetId: "ds-facts",
    subjectId: SUBJECT.displayName,
    sourceHashes: ["sha256:test"],
    claimsBundle,
  });
  return { claimsBundle, representative: representative.selection };
}

const ITEMS = [
  item({
    title: "Задержан предприниматель Тестов",
    snippet: `${QUOTE}. Следствие продолжается.`,
    sourceUrl: "https://news.example/arrest",
    publishedAt: "2024-08-25T00:00:00.000Z",
  }),
  item({
    title: "Тестов Сергей Михайлович — биография предпринимателя",
    snippet: "Тестов Сергей Михайлович основал несколько компаний в Санкт-Петербурге.",
    sourceUrl: "https://bio.example/testov",
  }),
];

describe("проверенные факты доходят до текста резюме", () => {
  it("раннер находит материалы по тем же evidenceRef, что проставил построитель claim'ов", async () => {
    const { claimsBundle, representative } = buildChain(ITEMS);
    expect(claimsBundle.claims.length).toBeGreaterThan(0);

    const itemsByRef = new Map(ITEMS.map((i) => [`inventory:${i.inventoryId}`, i]));
    const seenRefs: string[] = [];

    const artifact = await runFactExtraction({
      caseId: "case-facts",
      datasetId: "ds-facts",
      subjectName: SUBJECT.displayName,
      claimsBundle,
      representative,
      itemsByRef,
      enabled: true,
      caller: async ({ userPayload }) => {
        const materials = (userPayload as { materials: Array<{ ref: string }> }).materials;
        seenRefs.push(...materials.map((m) => m.ref));
        return {
          facts: [
            {
              statement: "Источник сообщает о задержании проверяемого лица.",
              quote: QUOTE,
              ref: materials[0]?.ref ?? "e1",
              status: "source_allegation",
            },
          ],
        };
      },
    });

    // Материалы вообще нашлись — refs совпали по всей цепочке.
    expect(seenRefs.length).toBeGreaterThan(0);
    expect(artifact.diagnostics.themesProcessed).toBeGreaterThan(0);
  });

  it("принятый факт с цитатой попадает в текст темы вместо перечня заголовков", async () => {
    const { claimsBundle, representative } = buildChain(ITEMS);
    const itemsByRef = new Map(ITEMS.map((i) => [`inventory:${i.inventoryId}`, i]));

    const artifact = await runFactExtraction({
      caseId: "case-facts",
      datasetId: "ds-facts",
      subjectName: SUBJECT.displayName,
      claimsBundle,
      representative,
      itemsByRef,
      enabled: true,
      caller: async ({ userPayload }) => {
        const payload = userPayload as {
          themeId: string;
          materials: Array<{ ref: string; snippet?: string }>;
        };
        const carrier = payload.materials.find((m) => (m.snippet ?? "").includes(QUOTE));
        if (!carrier) return { facts: [] };
        return {
          facts: [
            {
              statement: "Источник сообщает о задержании проверяемого лица.",
              quote: QUOTE,
              ref: carrier.ref,
              status: "source_allegation",
              // Тема указана явно: факт без темы модель к разделу не относила,
              // и с шага 06.3 такие в текст темы не попадают.
              theme: payload.themeId,
            },
          ],
        };
      },
    });

    const withFacts = buildClientSummaryPack({
      caseId: "case-facts",
      datasetId: "ds-facts",
      subjectId: SUBJECT.displayName,
      sourceHashes: ["sha256:test"],
      claimsBundle,
      representative,
      factsByTheme: artifact.factsByTheme,
    });

    const themesWithFacts = withFacts.materialThemes.filter((t) =>
      t.concreteClaims.some((c) => c.includes(QUOTE))
    );
    expect(themesWithFacts.length).toBeGreaterThan(0);

    const theme = themesWithFacts[0]!;
    // Регистр не важен: тема больше не называется в начале вывода,
    // поэтому фраза стала первой в предложении и пишется с заглавной.
    expect(theme.conclusion.toLowerCase()).toContain("установлено");
    expect(theme.concreteClaims.join(" ")).toContain("Цитата:");
    // Перечень заголовков «В выборке: «...»» вытеснен фактами.
    expect(theme.concreteClaims.some((c) => c.startsWith("В выборке:"))).toBe(false);
  });

  it("без фактов текст темы остаётся прежним, детерминированным", () => {
    const { claimsBundle, representative } = buildChain(ITEMS);
    const pack = buildClientSummaryPack({
      caseId: "case-facts",
      datasetId: "ds-facts",
      subjectId: SUBJECT.displayName,
      sourceHashes: ["sha256:test"],
      claimsBundle,
      representative,
      factsByTheme: {},
    });
    expect(pack.materialThemes.length).toBeGreaterThan(0);
    for (const theme of pack.materialThemes) {
      expect(theme.concreteClaims.length).toBeGreaterThan(0);
      expect(theme.conclusion.toLowerCase()).toContain("найдены конкретные материалы");
    }
  });
});
