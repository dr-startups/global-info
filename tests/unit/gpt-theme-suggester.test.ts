/**
 * REMEDIATION §3.3 — offline GPT theme suggestion + deterministic verification.
 * NETWORK_CALLS=0 (vitest.config env); all callers are fakes.
 */

import { describe, expect, it } from "vitest";
import type { RawInventoryItem } from "../../src/modules/digital-profile/orion-golden/types";
import type { UncategorizedMaterialsBlock } from "../../src/modules/digital-profile/orion-golden/analytics/finding-synthesizer";
import { getFindingThemes } from "../../src/modules/digital-profile/config/finding-themes";
import {
  isGptThemesEnabled,
  runGptThemeSuggestion,
  verifyThemeSuggestion,
  LLM_THEME_CONFIDENCE_CAP,
} from "../../src/modules/digital-profile/orion-golden/gpt/gpt-theme-suggester";

const CASE_ID = "case-unit-gpt-themes";

function item(id: string, title: string, snippet = ""): RawInventoryItem {
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
    snippet,
    sourceUrl: `https://news.example/${id}`,
  };
}

function uncategorized(refs: string[]): UncategorizedMaterialsBlock {
  const examples = refs.map((evidenceRef) => ({
    evidenceRef,
    title: "пример",
    domain: "news.example",
    region: "RU",
    subjectMatch: "SUBJECT_MATCH" as const,
  }));
  return {
    version: "uncategorized-materials-v1",
    count: refs.length,
    subjectMatchCount: refs.length,
    likelySubjectCount: 0,
    topExamples: examples,
    allEvidenceRefs: refs,
    byRegion: { RU: { count: refs.length, examples } },
  };
}

describe("gpt-theme-suggester verify", () => {
  it("drops invalid keywords; accepts keyword with ≥2 material hits", () => {
    const a = item("a", "Выставка: современное искусство в Москве", "галерея и искусство");
    const b = item("b", "Искусство и благотворительный аукцион", "коллекционер");
    const c = item("c", "Нейтральная заметка без ключа", "погода");
    const byRef = new Map<string, RawInventoryItem>([
      ["inventory:a", a],
      ["inventory:b", b],
      ["inventory:c", c],
    ]);
    const allowed = new Set(["inventory:a", "inventory:b", "inventory:c"]);

    const bad = verifyThemeSuggestion({
      suggestion: {
        themeLabel: "Культурный контур",
        keywords: ["искусство", "марсиане"],
        evidenceRefs: ["inventory:a", "inventory:b"],
      },
      materialsByRef: byRef,
      allowedRefs: allowed,
    });
    expect(bad.accepted).toBe(true);
    expect(bad.keywordsAccepted).toContain("искусство");
    expect(bad.keywordsRejected).toContain("марсиане");

    const noHits = verifyThemeSuggestion({
      suggestion: {
        themeLabel: "Инопланетный контур",
        keywords: ["марсиане"],
        evidenceRefs: ["inventory:a", "inventory:b"],
      },
      materialsByRef: byRef,
      allowedRefs: allowed,
    });
    expect(noHits.accepted).toBe(false);

    const configured = getFindingThemes()[0]!;
    const dup = verifyThemeSuggestion({
      suggestion: {
        themeLabel: configured.label,
        keywords: ["искусство"],
        evidenceRefs: ["inventory:a", "inventory:b"],
      },
      materialsByRef: byRef,
      allowedRefs: allowed,
    });
    expect(dup.accepted).toBe(false);
    expect(dup.reason).toBe("duplicate-or-empty-theme");
  });
});

describe("gpt-theme-suggester flag off", () => {
  it("flag off → no caller invocations", async () => {
    expect(isGptThemesEnabled({})).toBe(false);
    let calls = 0;
    const items = [item("a", "x"), item("b", "y")];
    const { artifact, findings } = await runGptThemeSuggestion({
      caseId: CASE_ID,
      datasetId: "ds-1",
      items,
      uncategorized: uncategorized(["inventory:a", "inventory:b"]),
      sourceHashes: ["sha256:test"],
      enabled: false,
      caller: async () => {
        calls += 1;
        return { themes: [] };
      },
    });
    expect(calls).toBe(0);
    expect(artifact.enabled).toBe(false);
    expect(findings).toHaveLength(0);
  });
});

describe("gpt-theme-suggester with fake caller", () => {
  it("valid theme appears with llm-suggested mark; invalid keywords dropped", async () => {
    const items = [
      item("a", "Благотворительный аукцион коллекционера", "аукцион искусства"),
      item("b", "Аукцион редких картин в Дубае", "аукцион и галерея"),
      item("c", "Погода в Москве", "без темы"),
    ];
    let calls = 0;
    const { artifact, findings } = await runGptThemeSuggestion({
      caseId: CASE_ID,
      datasetId: "ds-1",
      items,
      uncategorized: uncategorized(["inventory:a", "inventory:b", "inventory:c"]),
      sourceHashes: ["sha256:test"],
      enabled: true,
      caller: async () => {
        calls += 1;
        return {
          themes: [
            {
              themeLabel: "Аукционный контур",
              keywords: ["аукцион", "несуществующеесловоxyz"],
              evidenceRefs: ["inventory:a", "inventory:b"],
            },
            {
              themeLabel: "Фейковая тема",
              keywords: ["марсиане"],
              evidenceRefs: ["inventory:a", "inventory:b"],
            },
          ],
        };
      },
    });

    expect(calls).toBe(1);
    expect(artifact.callCount).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.theme).toBe("Аукционный контур");
    expect(findings[0]!.origin).toBe("llm-suggested");
    expect(findings[0]!.subjectMatch).toBe("LIKELY_SUBJECT");
    expect(findings[0]!.confidence).toBeLessThanOrEqual(LLM_THEME_CONFIDENCE_CAP);
    expect(findings[0]!.promotionPriority).toBe("APPENDIX");
    const ok = artifact.verification.find((v) => v.themeLabel === "Аукционный контур");
    expect(ok?.accepted).toBe(true);
    expect(ok?.keywordsAccepted).toContain("аукцион");
    expect(ok?.keywordsRejected).toContain("несуществующеесловоxyz");
    expect(artifact.verification.find((v) => v.themeLabel === "Фейковая тема")?.accepted).toBe(
      false
    );
  });
});
