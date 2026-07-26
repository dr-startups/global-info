/**
 * REMEDIATION §2.4 — offline GPT identity disambiguation.
 * NETWORK_CALLS=0 (vitest.config env); all callers are fakes.
 */

import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "../../src/modules/digital-profile/orion-golden/types";
import {
  SUBJECT_RESOLUTION_SCHEMA_VERSION,
  type SubjectResolution,
  type SubjectResolutionItem,
} from "../../src/modules/digital-profile/orion-golden/contracts/subject-resolution";
import type { SubjectIdentity } from "../../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import {
  clampGptIdentityDecision,
  isGptIdentityEnabled,
  runGptIdentityResolution,
  IDENTITY_SYSTEM_PROMPT,
} from "../../src/modules/digital-profile/orion-golden/gpt/gpt-identity-resolver";

const CASE_ID = "case-unit-gpt-identity";

const SUBJECT: SubjectIdentity = {
  displayName: "Иванов Пётр",
  lastName: "Иванов",
  lastNameVariants: ["ivanov"],
  firstNames: ["Пётр", "petr"],
  patronymics: [],
  aliases: [],
  strongIdentifiers: [],
  contextIdentifiers: ["логистика"],
  wrongFirstNames: [],
  wrongPatronymics: [],
  unrelatedKnownPersons: [],
  namesakeProfiles: [{ label: "Иванов-актёр", noiseTerms: ["актёр", "кино"] }],
  namesakeNoise: ["актёр", "кино"],
};

function item(id: string, title: string): RawInventoryItem {
  return {
    inventoryId: id,
    caseId: CASE_ID,
    reportRunId: "base-1",
    source: "serp_observation",
    provider: "yandex",
    region: "RU",
    collectedAt: "2026-07-16T00:00:00.000Z",
    evidenceType: "search_result",
    title,
    snippet: "логистика и перевозки",
    sourceUrl: `https://news.example/${id}`,
  };
}

function ambiguousResolution(refs: string[]): {
  resolutionByRef: Map<string, SubjectResolutionItem>;
  subjectResolution: SubjectResolution;
} {
  const items: SubjectResolutionItem[] = refs.map((evidenceRef) => ({
    evidenceRef,
    decision: "AMBIGUOUS" as const,
    confidence: 0.4,
    matchedIdentifiers: ["Иванов"],
    conflictingIdentifiers: [],
    reasonCode: "surname_only",
  }));
  const subjectResolution: SubjectResolution = {
    schemaVersion: SUBJECT_RESOLUTION_SCHEMA_VERSION,
    caseId: CASE_ID,
    datasetId: "ds-1",
    sourceHashes: ["sha256:test"],
    evidenceRefs: refs,
    subjectDisplayName: SUBJECT.displayName,
    items,
  };
  return {
    resolutionByRef: new Map(items.map((i) => [i.evidenceRef, i])),
    subjectResolution,
  };
}

describe("gpt-identity-resolver clamp (§2.4)", () => {
  it("never raises above LIKELY_SUBJECT (SUBJECT_MATCH → LIKELY)", () => {
    expect(clampGptIdentityDecision("SUBJECT_MATCH").decision).toBe("LIKELY_SUBJECT");
    expect(clampGptIdentityDecision("SUBJECT_MATCH").clamped).toBe(true);
    expect(clampGptIdentityDecision("LIKELY").decision).toBe("LIKELY_SUBJECT");
    expect(clampGptIdentityDecision("OTHER").decision).toBe("OTHER_SUBJECT");
    expect(clampGptIdentityDecision("AMBIGUOUS").decision).toBe("AMBIGUOUS");
  });
});

describe("gpt-identity-resolver flag off", () => {
  it("flag default / off → no caller invocations", async () => {
    expect(isGptIdentityEnabled({})).toBe(false);
    expect(isGptIdentityEnabled({ ORION_GPT_IDENTITY: "0" })).toBe(false);

    let calls = 0;
    const items = [item("a1", "Иванов в новостях")];
    const { resolutionByRef, subjectResolution } = ambiguousResolution([
      "inventory:a1",
    ]);
    const artifact = await runGptIdentityResolution({
      caseId: CASE_ID,
      datasetId: "ds-1",
      subject: SUBJECT,
      items,
      resolutionByRef,
      subjectResolution,
      sourceHashes: ["sha256:test"],
      enabled: false,
      caller: async () => {
        calls += 1;
        return { decisions: [] };
      },
    });
    expect(calls).toBe(0);
    expect(artifact.enabled).toBe(false);
    expect(artifact.callCount).toBe(0);
    expect(resolutionByRef.get("inventory:a1")?.decision).toBe("AMBIGUOUS");
  });
});

describe("gpt-identity-resolver with fake caller", () => {
  it("raises AMBIGUOUS→LIKELY, lowers→OTHER, clamps SUBJECT_MATCH, fail-safe on error", async () => {
    const items = [
      item("lik", "Иванов логистика контракт"),
      item("oth", "Иванов снялся в кино"),
      item("bad", "Иванов без контекста"),
      item("err", "Иванов тайм-аут батч"),
    ];
    // Put err in its own batch by using batch size — we'll fail the whole call once
    // for a dedicated run; here one caller handles all.
    const { resolutionByRef, subjectResolution } = ambiguousResolution(
      items.map((i) => `inventory:${i.inventoryId}`)
    );

    let calls = 0;
    const artifact = await runGptIdentityResolution({
      caseId: CASE_ID,
      datasetId: "ds-1",
      subject: SUBJECT,
      items,
      resolutionByRef,
      subjectResolution,
      sourceHashes: ["sha256:test"],
      enabled: true,
      caller: async ({ systemPrompt, userPayload }) => {
        calls += 1;
        expect(systemPrompt).toContain("LIKELY|AMBIGUOUS|OTHER");
        expect(IDENTITY_SYSTEM_PROMPT.length).toBeGreaterThan(40);
        const materials = (userPayload as { materials: Array<{ ref: string }> }).materials;
        return {
          decisions: materials.map((m) => {
            if (m.ref.endsWith(":lik")) {
              return { ref: m.ref, decision: "LIKELY", reason: "контекст логистики" };
            }
            if (m.ref.endsWith(":oth")) {
              return { ref: m.ref, decision: "OTHER", reason: "тёзка актёр" };
            }
            if (m.ref.endsWith(":bad")) {
              // Illegal upgrade — must clamp to LIKELY
              return { ref: m.ref, decision: "SUBJECT_MATCH", reason: "модель ошиблась" };
            }
            return { ref: m.ref, decision: "AMBIGUOUS", reason: "мало данных" };
          }),
        };
      },
    });

    expect(calls).toBe(1);
    expect(artifact.callCount).toBe(1);
    expect(resolutionByRef.get("inventory:lik")?.decision).toBe("LIKELY_SUBJECT");
    expect(resolutionByRef.get("inventory:lik")?.reasonCode).toBe("gpt_identity_likely");
    expect(resolutionByRef.get("inventory:oth")?.decision).toBe("OTHER_SUBJECT");
    expect(resolutionByRef.get("inventory:bad")?.decision).toBe("LIKELY_SUBJECT");
    expect(resolutionByRef.get("inventory:err")?.decision).toBe("AMBIGUOUS");
    expect(artifact.applied.some((a) => a.clamped && a.evidenceRef === "inventory:bad")).toBe(
      true
    );
    // Invariant: no applied row / resolution is SUBJECT_MATCH
    expect(artifact.applied.every((a) => a.to !== ("SUBJECT_MATCH" as string))).toBe(true);
    expect(
      [...resolutionByRef.values()].every((i) => i.decision !== "SUBJECT_MATCH")
    ).toBe(true);
  });

  it("transport failure → materials stay AMBIGUOUS", async () => {
    const items = [item("x1", "Иванов новость")];
    const { resolutionByRef, subjectResolution } = ambiguousResolution(["inventory:x1"]);
    const artifact = await runGptIdentityResolution({
      caseId: CASE_ID,
      datasetId: "ds-1",
      subject: SUBJECT,
      items,
      resolutionByRef,
      subjectResolution,
      sourceHashes: ["sha256:test"],
      enabled: true,
      caller: async () => {
        throw new Error("openai-timeout");
      },
      queueOptions: { maxAttempts: 1, concurrency: 1, deadlineMs: 60_000, sleep: async () => undefined },
    });
    expect(resolutionByRef.get("inventory:x1")?.decision).toBe("AMBIGUOUS");
    expect(artifact.failures.length).toBeGreaterThanOrEqual(1);
  });
});
