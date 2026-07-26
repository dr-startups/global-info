/**
 * Stage 1 — ObservationDisposition ledger.
 * NETWORK_CALLS=0 (vitest.config env).
 */

import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "../../src/modules/digital-profile/orion-golden/types";
import {
  buildSubjectResolution,
  type SubjectIdentity,
} from "../../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import { synthesizeFindings } from "../../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import {
  assertDispositionGatesPass,
  buildDispositionSummary,
  buildObservationDispositionLedger,
  ledgerContentFingerprint,
} from "../../src/modules/digital-profile/orion-golden/analytics/observation-disposition-ledger";
import { validateStage1Contract } from "../../src/modules/digital-profile/orion-golden/contracts";
import { sampleObservationDispositionLedger } from "../../src/modules/digital-profile/orion-golden/contracts/sample-contracts";

const CASE_A = "case-disp-a";
const CASE_B = "case-disp-b";

let seq = 0;
function item(
  caseId: string,
  partial: Partial<RawInventoryItem> & Pick<RawInventoryItem, "title">
): RawInventoryItem {
  seq += 1;
  return {
    inventoryId: `it-${seq}`,
    caseId,
    reportRunId: "base-run-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-07-16T00:00:00.000Z",
    evidenceType: "search_result",
    snippet: partial.snippet ?? "полный сниппет без обрезки",
    sourceUrl: partial.sourceUrl ?? `https://news.example/${seq}`,
    ...partial,
  };
}

const SUBJECT_A: SubjectIdentity = {
  displayName: "Глинка Сергей Михайлович",
  lastName: "Глинка",
  lastNameVariants: ["glinka"],
  firstNames: ["Сергей", "sergey", "sergei"],
  patronymics: ["Михайлович"],
  aliases: ["Глинка Сергей Михайлович"],
  strongIdentifiers: ["773800015809"],
  contextIdentifiers: ["бизнесмен", "транспорт"],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: ["композитор", "опера"],
};

const SUBJECT_B: SubjectIdentity = {
  displayName: "Иванов Пётр Николаевич",
  lastName: "Иванов",
  lastNameVariants: ["ivanov"],
  firstNames: ["Пётр", "petr", "pyotr"],
  patronymics: ["Николаевич"],
  aliases: ["Иванов Пётр Николаевич"],
  strongIdentifiers: ["770000000000"],
  contextIdentifiers: ["инвестор"],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [],
  namesakeNoise: [],
};

function buildLedgerFor(
  caseId: string,
  subject: SubjectIdentity,
  items: RawInventoryItem[],
  force?: Map<string, "SUBJECT_MATCH" | "LIKELY_SUBJECT" | "AMBIGUOUS" | "OTHER_SUBJECT">
) {
  const resolution = buildSubjectResolution({
    caseId,
    datasetId: `ds-${caseId}`,
    subject,
    items,
    sourceHashes: ["sha256:test"],
  });
  const byRef = new Map(resolution.items.map((i) => [i.evidenceRef, i]));
  if (force) {
    for (const [ref, decision] of force) {
      const cur = byRef.get(ref);
      if (cur) byRef.set(ref, { ...cur, decision, reasonCode: `forced:${decision}` });
    }
  }
  const synthesis = synthesizeFindings({
    caseId,
    datasetId: `ds-${caseId}`,
    items,
    resolutionByRef: byRef,
    sourceHashes: ["sha256:test"],
  });
  const ledger = buildObservationDispositionLedger({
    caseId,
    datasetId: `ds-${caseId}`,
    inventoryReportRunId: "base-run-1",
    sourceHashes: ["sha256:test"],
    items,
    resolutionByRef: byRef,
    synthesis,
  });
  return { ledger, synthesis, byRef };
}

describe("observation-disposition-ledger Stage 1", () => {
  it("validates sample contract", () => {
    const parsed = validateStage1Contract(
      "ObservationDispositionLedger",
      sampleObservationDispositionLedger()
    );
    expect(parsed.success).toBe(true);
  });

  it("accounts 100% raw observations with reasoned dispositions", () => {
    const criminal = item(CASE_A, {
      title: "Уголовное дело бизнесмена Сергея Глинки: суд и следствие",
      sourceUrl: "https://news.example/criminal",
    });
    const neutral = item(CASE_A, {
      title: "Сергей Глинка посетил выставку в Москве",
      sourceUrl: "https://news.example/exhibit",
    });
    const other = item(CASE_A, {
      title: "Композитор Михаил Глинка — биография",
      sourceUrl: "https://wiki.example/composer",
    });
    const amb = item(CASE_A, {
      title: "Глинка выступил с комментарием",
      snippet: "без идентификаторов",
      sourceUrl: "https://news.example/amb",
    });

    const force = new Map([
      [`inventory:${criminal.inventoryId}`, "SUBJECT_MATCH" as const],
      [`inventory:${neutral.inventoryId}`, "SUBJECT_MATCH" as const],
      [`inventory:${other.inventoryId}`, "OTHER_SUBJECT" as const],
      [`inventory:${amb.inventoryId}`, "AMBIGUOUS" as const],
    ]);
    const items = [criminal, neutral, other, amb];
    const { ledger, synthesis } = buildLedgerFor(CASE_A, SUBJECT_A, items, force);

    expect(ledger.entries).toHaveLength(items.length);
    expect(ledger.gates.RAW_OBSERVATION_ACCOUNTING).toBe(100);
    expect(ledger.gates.UNREASONED_DROPS).toBe(0);
    expect(ledger.gates.P1_P2_SILENT_DROPS).toBe(0);
    assertDispositionGatesPass(ledger);

    const byId = new Map(ledger.entries.map((e) => [e.rawObservationId, e]));
    expect(byId.get(`inventory:${other.inventoryId}`)?.disposition).toBe(
      "EXCLUDE_OTHER_SUBJECT"
    );
    expect(byId.get(`inventory:${amb.inventoryId}`)?.disposition).toBe("APPENDIX_AMBIGUOUS");
    expect(byId.get(`inventory:${neutral.inventoryId}`)?.disposition).toBe("KEEP_SUPPORTING");
    expect(byId.get(`inventory:${criminal.inventoryId}`)?.disposition).toMatch(
      /^KEEP_/
    );

    // Original text preserved (no truncation in ledger).
    expect(byId.get(`inventory:${criminal.inventoryId}`)?.originalTitle).toBe(criminal.title);
    expect(byId.get(`inventory:${criminal.inventoryId}`)?.originalSnippet).toBe(
      criminal.snippet
    );

    // OTHER_SUBJECT not in KPI findings evidence.
    const kpiRefs = new Set(
      synthesis.bundle.findings
        .filter(
          (f) =>
            f.subjectMatch === "SUBJECT_MATCH" &&
            (f.promotionPriority === "P1" || f.promotionPriority === "P2")
        )
        .flatMap((f) => f.evidenceRefs)
    );
    expect(kpiRefs.has(`inventory:${other.inventoryId}`)).toBe(false);
    expect(ledger.gates.OTHER_SUBJECT_IN_SUBJECT_KPI).toBe(0);

    // AMBIGUOUS stays in appendix/review path (disposition + ambiguous findings list).
    expect(
      synthesis.ambiguousFindings.length +
        (byId.get(`inventory:${amb.inventoryId}`)?.disposition === "APPENDIX_AMBIGUOUS" ? 1 : 0)
    ).toBeGreaterThan(0);
  });

  it("keeps all source IDs in a duplicate group", () => {
    const a = item(CASE_A, {
      title: "Одинаковый заголовок про Глинку и санкции PEP",
      sourceUrl: "https://dup.example/same",
      provider: "yandex",
      query: "глинка",
      rawMetadata: { engine: "yandex", surface: "organic", queryText: "глинка" },
    });
    const b = item(CASE_A, {
      title: "Одинаковый заголовок про Глинку и санкции PEP",
      sourceUrl: "https://dup.example/same",
      provider: "serper",
      query: "глинка",
      rawMetadata: {
        engine: "google",
        surface: "organic",
        queryText: "глинка",
        sourceEvidenceRefs: ["searchResult:enrich-9"],
      },
    });
    // Force same composite key region/engine via metadata alignment
    b.rawMetadata = {
      ...b.rawMetadata,
      engine: "yandex",
      surface: "organic",
      queryText: "глинка",
    };

    const force = new Map([
      [`inventory:${a.inventoryId}`, "SUBJECT_MATCH" as const],
      [`inventory:${b.inventoryId}`, "SUBJECT_MATCH" as const],
    ]);
    const { ledger } = buildLedgerFor(CASE_A, SUBJECT_A, [a, b], force);
    const entries = ledger.entries.filter((e) =>
      [`inventory:${a.inventoryId}`, `inventory:${b.inventoryId}`].includes(e.rawObservationId)
    );
    expect(entries).toHaveLength(2);
    const secondary = entries.find((e) => e.disposition === "EXCLUDE_DUPLICATE");
    const primary = entries.find((e) => e.disposition !== "EXCLUDE_DUPLICATE");
    expect(secondary).toBeTruthy();
    expect(primary).toBeTruthy();
    expect(secondary!.duplicateOf).toBe(primary!.rawObservationId);
    expect(secondary!.duplicateGroupId).toBeTruthy();
    expect(secondary!.provenance.sourceEvidenceRefs.length).toBeGreaterThan(0);
    expect(primary!.evidenceRefs.length).toBeGreaterThan(0);
  });

  it("does not silently drop P1/P2-class adverse via top-N/source-quality/date reasons", () => {
    const adverse = item(CASE_A, {
      title: "Коррупционное расследование и уголовный суд по Сергею Глинке",
      snippet: "расследование ФБК и санкции",
      sourceUrl: "https://currenttime.tv/a/1",
    });
    const force = new Map([[`inventory:${adverse.inventoryId}`, "SUBJECT_MATCH" as const]]);
    const { ledger } = buildLedgerFor(CASE_A, SUBJECT_A, [adverse], force);
    const row = ledger.entries[0]!;
    expect(row.disposition).not.toBe("EXCLUDE_INVALID");
    expect(row.reasonCode).not.toMatch(/top[_-]?n|source[_-]?quality|date|low[_-]?confidence/i);
    expect(ledger.gates.P1_P2_SILENT_DROPS).toBe(0);
  });

  it("shuffle of input yields the same ledger fingerprint", () => {
    const items = [
      item(CASE_A, { title: "Уголовное дело Сергея Глинки в суде" }),
      item(CASE_A, { title: "Сергей Глинка бизнесмен транспорт" }),
      item(CASE_A, { title: "Глинка PEP watchlist сигнал" }),
    ];
    const force = new Map(
      items.map((it) => [`inventory:${it.inventoryId}`, "SUBJECT_MATCH" as const])
    );
    const a = buildLedgerFor(CASE_A, SUBJECT_A, items, force).ledger;
    const b = buildLedgerFor(CASE_A, SUBJECT_A, [...items].reverse(), force).ledger;
    expect(ledgerContentFingerprint(a)).toBe(ledgerContentFingerprint(b));
    expect(a.gates).toEqual(b.gates);
  });

  it("second synthetic subject does not receive first subject's observations", () => {
    const aItem = item(CASE_A, {
      title: "Уголовное дело бизнесмена Сергея Глинки",
      sourceUrl: "https://a.example/glinka",
    });
    const bItem = item(CASE_B, {
      title: "Инвестор Пётр Иванов — профиль",
      sourceUrl: "https://b.example/ivanov",
    });
    const forceA = new Map([[`inventory:${aItem.inventoryId}`, "SUBJECT_MATCH" as const]]);
    const forceB = new Map([[`inventory:${bItem.inventoryId}`, "SUBJECT_MATCH" as const]]);
    const ledgerA = buildLedgerFor(CASE_A, SUBJECT_A, [aItem], forceA).ledger;
    const ledgerB = buildLedgerFor(CASE_B, SUBJECT_B, [bItem], forceB).ledger;

    expect(ledgerA.entries.every((e) => e.rawObservationId.includes(aItem.inventoryId))).toBe(
      true
    );
    expect(ledgerB.entries.every((e) => e.rawObservationId.includes(bItem.inventoryId))).toBe(
      true
    );
    expect(ledgerA.evidenceRefs).not.toContain(`inventory:${bItem.inventoryId}`);
    expect(ledgerB.evidenceRefs).not.toContain(`inventory:${aItem.inventoryId}`);
    expect(ledgerA.entries[0]!.originalTitle).toContain("Глинки");
    expect(ledgerB.entries[0]!.originalTitle).toContain("Иванов");
  });

  it("builds disposition-summary with matching counts", () => {
    const items = [
      item(CASE_A, { title: "Суд по делу Сергея Глинки" }),
      item(CASE_A, { title: "Глинка биография" }),
    ];
    const force = new Map(
      items.map((it) => [`inventory:${it.inventoryId}`, "SUBJECT_MATCH" as const])
    );
    const { ledger } = buildLedgerFor(CASE_A, SUBJECT_A, items, force);
    const summary = buildDispositionSummary(ledger);
    expect(summary.rawObservationCount).toBe(2);
    const sum = Object.values(summary.byDisposition).reduce((a, b) => a + b, 0);
    expect(sum).toBe(2);
    expect(summary.gates.RAW_OBSERVATION_ACCOUNTING).toBe(100);
  });
});
