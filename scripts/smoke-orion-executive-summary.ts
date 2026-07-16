/**
 * EXECUTIVE_SUMMARY stage — offline tests, NETWORK_CALLS=0.
 * Covers the 7 mandatory scenarios: rich evidence, insufficient data,
 * wrong-subject noise, conflicting sources, AI security-scrutiny inclusion,
 * no claim without findingId, and idempotent stage result by input hash.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import {
  ExecutiveSummaryStageOutputSchema,
  ExecutiveSummaryEvidenceMapSchema,
  type ExecutiveSummaryStageOutput,
} from "../src/modules/digital-profile/orion-golden/executive-summary/stage-contracts";
import {
  EXECUTIVE_SUMMARY_PROMPT_VERSION,
  EXECUTIVE_SUMMARY_SYSTEM_PROMPT,
} from "../src/modules/digital-profile/orion-golden/executive-summary/prompt-version";
import {
  computeStageInputHash,
  runExecutiveSummaryStage,
  sha256Hex,
} from "../src/modules/digital-profile/orion-golden/executive-summary/run-stage";
import { composeExecutiveSummaryDeterministic } from "../src/modules/digital-profile/orion-golden/executive-summary/deterministic-composer";
import { runExecutiveSummaryGuards } from "../src/modules/digital-profile/orion-golden/executive-summary/guards";
import {
  conflictingSourceFixture,
  insufficientDataFixture,
  richEvidenceFixture,
  wrongSubjectNoiseFixture,
} from "../src/modules/digital-profile/orion-golden/executive-summary/fixtures";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

function freshDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `orion-es-${label}-`));
}

describe("executive-summary NETWORK_CALLS", () => {
  it("forces NETWORK_CALLS=0", () => {
    assert.equal(process.env.NETWORK_CALLS, "0");
  });
});

describe("1. rich evidence fixture", () => {
  it("produces a valid non-INSUFFICIENT summary with all artifacts", async () => {
    const dir = freshDir("rich");
    const result = await runExecutiveSummaryStage({ input: richEvidenceFixture(), artifactsDir: dir });
    assert.equal(result.status, "OK");
    const out = result.output!;
    ExecutiveSummaryStageOutputSchema.parse(out);
    assert.notEqual(out.verdict, "INSUFFICIENT_DATA");
    assert.ok(out.keyFindings.length >= 4 && out.keyFindings.length <= 7);
    assert.ok(out.executiveConclusion.length >= 300 && out.executiveConclusion.length <= 600);
    for (const kf of out.keyFindings) {
      assert.ok(kf.factualBasis.length <= 320);
      assert.ok(kf.clientImpact.length <= 220);
      assert.ok(kf.recommendedAction.length <= 180);
    }
    // adverse + neutral + identity-pollution shown simultaneously
    assert.ok(out.keyFindings.some((f) => f.basisKind !== undefined && ["f-ai-security", "f-politics-md", "f-offshore"].includes(f.findingId)));
    assert.ok(out.keyFindings.some((f) => f.findingId === "f-business-neutral"), "neutral finding must be present");
    assert.ok(out.identityCaveats.length > 0, "identity pollution caveats must be present");
    // no forbidden opening / internal terms
    assert.ok(!/^мы провели поиск/iu.test(out.executiveConclusion));
    assert.ok(!/pipeline|reportRunId|\bAPI\b|arsenkin/iu.test(out.executiveConclusion));
    // artifacts on disk
    for (const p of Object.values(result.artifactPaths!)) assert.ok(existsSync(p), `missing artifact ${p}`);
    const evidenceMap = ExecutiveSummaryEvidenceMapSchema.parse(
      JSON.parse(readFileSync(result.artifactPaths!.evidenceMap, "utf8"))
    );
    assert.equal(evidenceMap.entries.length, out.keyFindings.length);
    const promptArtifact = JSON.parse(readFileSync(result.artifactPaths!.promptVersion, "utf8"));
    assert.equal(promptArtifact.promptVersion, EXECUTIVE_SUMMARY_PROMPT_VERSION);
    assert.equal(promptArtifact.systemPromptSha256, sha256Hex(EXECUTIVE_SUMMARY_SYSTEM_PROMPT));
  });
});

describe("2. insufficient-data fixture", () => {
  it("returns INSUFFICIENT_DATA instead of generic filler", async () => {
    const dir = freshDir("insufficient");
    const result = await runExecutiveSummaryStage({ input: insufficientDataFixture(), artifactsDir: dir });
    assert.equal(result.status, "OK");
    const out = result.output!;
    assert.equal(out.verdict, "INSUFFICIENT_DATA");
    assert.equal(out.keyFindings.length, 0);
    assert.ok(out.executiveConclusion.includes("недостаточно"));
    assert.ok(out.priorityActions.length >= 1);
  });
});

describe("3. wrong-subject noise fixture", () => {
  it("never lets composer (OTHER_SUBJECT) material shape subject conclusions", async () => {
    const dir = freshDir("wrong-subject");
    const input = wrongSubjectNoiseFixture();
    const result = await runExecutiveSummaryStage({ input, artifactsDir: dir });
    assert.equal(result.status, "OK");
    const out = result.output!;
    // Only 1 weak subject-match finding → summary must degrade to INSUFFICIENT_DATA.
    assert.equal(out.verdict, "INSUFFICIENT_DATA");
    const text = JSON.stringify(out.keyFindings);
    assert.ok(!text.includes("f-composer-"), "composer findings must not appear as key findings");
    assert.ok(!/опер|композитор/iu.test(text), "opera/composer claims must not describe the subject");
    // Identity pollution disclosed even in insufficient mode via conclusion
    assert.ok(/другому лицу/u.test(out.executiveConclusion));
  });

  it("guards reject a model output that smuggles an OTHER_SUBJECT finding", () => {
    const input = wrongSubjectNoiseFixture();
    const hash = computeStageInputHash(input);
    const honest = composeExecutiveSummaryDeterministic(richEvidenceFixture(), hash);
    const malicious: ExecutiveSummaryStageOutput = {
      ...honest,
      keyFindings: [
        ...honest.keyFindings.slice(0, 3),
        {
          findingId: "f-composer-opera",
          title: "Связь с оперой",
          basisKind: "CONFIRMED_FACT",
          factualBasis: "Опера включена в репертуар.",
          clientImpact: "Влияет на восприятие.",
          confidence: 0.9,
          recommendedAction: "Учесть.",
        },
      ],
    };
    const violations = runExecutiveSummaryGuards(input, malicious);
    assert.ok(violations.some((v) => v.guard === "NON_SUBJECT_CLAIM" || v.guard === "EXCLUDED_FINDING_IN_SUMMARY"));
  });
});

describe("4. conflicting-source fixture", () => {
  it("downgrades conflicted-source findings to preliminary signals and discloses the conflict", async () => {
    const dir = freshDir("conflict");
    const result = await runExecutiveSummaryStage({ input: conflictingSourceFixture(), artifactsDir: dir });
    assert.equal(result.status, "OK");
    const out = result.output!;
    const offshore = out.keyFindings.find((f) => f.findingId === "f-offshore");
    assert.ok(offshore, "offshore finding expected in key findings");
    assert.notEqual(offshore!.basisKind, "CONFIRMED_FACT");
    assert.ok(
      out.dataLimitations.some((l) => l.includes("opencorporates.com")),
      "source conflict must be disclosed in dataLimitations"
    );
  });
});

describe("5. AI security-scrutiny finding reaches the summary", () => {
  it("includes f-ai-security among key findings and drives the verdict", async () => {
    const dir = freshDir("ai-security");
    const result = await runExecutiveSummaryStage({ input: richEvidenceFixture(), artifactsDir: dir });
    const out = result.output!;
    const ai = out.keyFindings.find((f) => f.findingId === "f-ai-security");
    assert.ok(ai, "AI security-scrutiny finding must appear in the summary");
    assert.equal(out.verdict, "HIGH");
    assert.ok(ai!.recommendedAction.length > 0);
  });
});

describe("6. no summary claim without findingId", () => {
  it("every key finding resolves to a verified finding in the bundle", async () => {
    const dir = freshDir("claims");
    const input = richEvidenceFixture();
    const result = await runExecutiveSummaryStage({ input, artifactsDir: dir });
    const ids = new Set(input.verifiedFindings.findings.map((f) => f.findingId));
    for (const kf of result.output!.keyFindings) {
      assert.ok(ids.has(kf.findingId), `keyFinding ${kf.findingId} has no backing finding`);
    }
  });

  it("guards reject a fabricated findingId", () => {
    const input = richEvidenceFixture();
    const hash = computeStageInputHash(input);
    const honest = composeExecutiveSummaryDeterministic(input, hash);
    const fabricated: ExecutiveSummaryStageOutput = {
      ...honest,
      keyFindings: [
        ...honest.keyFindings.slice(0, 3),
        { ...honest.keyFindings[0], findingId: "f-does-not-exist" },
      ],
    };
    const violations = runExecutiveSummaryGuards(input, fabricated);
    assert.ok(violations.some((v) => v.guard === "CLAIM_WITHOUT_FINDING_ID"));
  });
});

describe("7. idempotent stage result for identical input hash", () => {
  it("second run returns CACHED with byte-identical artifact", async () => {
    const dir = freshDir("idempotent");
    const input = richEvidenceFixture();
    const first = await runExecutiveSummaryStage({ input, artifactsDir: dir });
    assert.equal(first.status, "OK");
    const bytesAfterFirst = readFileSync(first.artifactPaths!.summary, "utf8");
    const second = await runExecutiveSummaryStage({ input: richEvidenceFixture(), artifactsDir: dir });
    assert.equal(second.status, "CACHED");
    assert.equal(second.inputHash, first.inputHash);
    const bytesAfterSecond = readFileSync(first.artifactPaths!.summary, "utf8");
    assert.equal(bytesAfterSecond, bytesAfterFirst);
    assert.deepEqual(second.output, first.output);
  });

  it("input hash is stable across key ordering and changes when content changes", () => {
    const a = richEvidenceFixture();
    const b = richEvidenceFixture();
    assert.equal(computeStageInputHash(a), computeStageInputHash(b));
    const mutated = richEvidenceFixture();
    mutated.subject = { ...mutated.subject, displayName: "Другой Субъект" };
    assert.notEqual(computeStageInputHash(a), computeStageInputHash(mutated));
  });
});
