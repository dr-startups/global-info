/**
 * EXECUTIVE_SUMMARY stage runner.
 * - Runs only on a formed VerifiedFindingBundle (cross-surface findings) —
 *   never on the raw dataset or the PDF.
 * - Idempotent: sha256(canonical input + prompt version) keys the result;
 *   an existing artifact with the same hash is returned without recompute.
 * - Model caller is injectable; default is the deterministic offline composer
 *   so tests run with NETWORK_CALLS=0. Guards apply to any caller's output.
 */

import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  EXECUTIVE_SUMMARY_PROMPT_VERSION,
  EXECUTIVE_SUMMARY_SYSTEM_PROMPT,
  EXECUTIVE_SUMMARY_TEXT_CONSTRAINTS,
  type ExecutiveSummaryPromptVersionArtifact,
} from "./prompt-version";
import {
  EXECUTIVE_SUMMARY_STAGE_INPUT_SCHEMA_VERSION,
  EXECUTIVE_SUMMARY_STAGE_OUTPUT_SCHEMA_VERSION,
  ExecutiveSummaryStageInputSchema,
  ExecutiveSummaryStageOutputSchema,
  type ExecutiveSummaryEvidenceMap,
  type ExecutiveSummaryStageInput,
  type ExecutiveSummaryStageOutput,
} from "./stage-contracts";
import { composeExecutiveSummaryDeterministic } from "./deterministic-composer";
import { runExecutiveSummaryGuards, type GuardViolation } from "./guards";

export type SummaryModelCaller = (
  input: ExecutiveSummaryStageInput,
  inputHash: string,
  systemPrompt: string
) => Promise<ExecutiveSummaryStageOutput> | ExecutiveSummaryStageOutput;

export type ExecutiveSummaryStageResult = {
  status: "OK" | "CACHED" | "GUARD_FAILED" | "SCHEMA_FAILED";
  inputHash: string;
  promptVersion: string;
  output: ExecutiveSummaryStageOutput | null;
  guardViolations: GuardViolation[];
  schemaIssues: string[];
  artifactPaths: {
    summary: string;
    evidenceMap: string;
    promptVersion: string;
  } | null;
};

/** Stable JSON: object keys sorted recursively so equal inputs hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function computeStageInputHash(input: ExecutiveSummaryStageInput): string {
  return sha256Hex(`${EXECUTIVE_SUMMARY_PROMPT_VERSION}\n${canonicalJson(input)}`);
}

function buildEvidenceMap(
  input: ExecutiveSummaryStageInput,
  output: ExecutiveSummaryStageOutput,
  inputHash: string
): ExecutiveSummaryEvidenceMap {
  const byId = new Map(input.verifiedFindings.findings.map((f) => [f.findingId, f]));
  return {
    schemaVersion: "executive-summary-evidence-map-v1",
    caseId: input.caseId,
    datasetId: input.datasetId,
    inputHash,
    entries: output.keyFindings.map((kf) => {
      const src = byId.get(kf.findingId);
      return {
        findingId: kf.findingId,
        evidenceRefs: src?.evidenceRefs ?? [],
        sourceDomains: src?.sourceDomains ?? [],
        providers: src?.providers ?? [],
        basisKind: kf.basisKind,
      };
    }),
    excludedAsOtherSubject: input.verifiedFindings.findings
      .filter((f) => f.subjectMatch === "OTHER_SUBJECT")
      .map((f) => f.findingId),
    excludedAsAmbiguous: input.ambiguousFindings.map((f) => f.findingId),
  };
}

export function buildPromptVersionArtifact(): ExecutiveSummaryPromptVersionArtifact {
  return {
    schemaVersion: "executive-summary-prompt-version-v1",
    promptVersion: EXECUTIVE_SUMMARY_PROMPT_VERSION,
    systemPromptSha256: sha256Hex(EXECUTIVE_SUMMARY_SYSTEM_PROMPT),
    systemPrompt: EXECUTIVE_SUMMARY_SYSTEM_PROMPT,
    outputSchemaVersion: EXECUTIVE_SUMMARY_STAGE_OUTPUT_SCHEMA_VERSION,
    inputSchemaVersion: EXECUTIVE_SUMMARY_STAGE_INPUT_SCHEMA_VERSION,
    constraints: EXECUTIVE_SUMMARY_TEXT_CONSTRAINTS,
  };
}

export async function runExecutiveSummaryStage(options: {
  input: ExecutiveSummaryStageInput;
  artifactsDir: string;
  modelCaller?: SummaryModelCaller;
}): Promise<ExecutiveSummaryStageResult> {
  const input = ExecutiveSummaryStageInputSchema.parse(options.input);
  const inputHash = computeStageInputHash(input);
  const dir = options.artifactsDir;
  const paths = {
    summary: join(dir, "executive-summary.json"),
    evidenceMap: join(dir, "executive-summary-evidence-map.json"),
    promptVersion: join(dir, "executive-summary-prompt-version.json"),
  };

  // Idempotency: same input hash + prompt version → return persisted result.
  if (existsSync(paths.summary)) {
    try {
      const prior = JSON.parse(readFileSync(paths.summary, "utf8")) as ExecutiveSummaryStageOutput;
      if (prior.inputHash === inputHash && prior.promptVersion === EXECUTIVE_SUMMARY_PROMPT_VERSION) {
        return {
          status: "CACHED",
          inputHash,
          promptVersion: EXECUTIVE_SUMMARY_PROMPT_VERSION,
          output: prior,
          guardViolations: [],
          schemaIssues: [],
          artifactPaths: paths,
        };
      }
    } catch {
      // Corrupt prior artifact: fall through and regenerate.
    }
  }

  const caller: SummaryModelCaller =
    options.modelCaller ?? ((inp, hash) => composeExecutiveSummaryDeterministic(inp, hash));
  const rawOutput = await caller(input, inputHash, EXECUTIVE_SUMMARY_SYSTEM_PROMPT);

  const parsed = ExecutiveSummaryStageOutputSchema.safeParse(rawOutput);
  if (!parsed.success) {
    return {
      status: "SCHEMA_FAILED",
      inputHash,
      promptVersion: EXECUTIVE_SUMMARY_PROMPT_VERSION,
      output: null,
      guardViolations: [],
      schemaIssues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      artifactPaths: null,
    };
  }

  const violations = runExecutiveSummaryGuards(input, parsed.data);
  if (violations.length > 0) {
    return {
      status: "GUARD_FAILED",
      inputHash,
      promptVersion: EXECUTIVE_SUMMARY_PROMPT_VERSION,
      output: null,
      guardViolations: violations,
      schemaIssues: [],
      artifactPaths: null,
    };
  }

  mkdirSync(dir, { recursive: true });
  const evidenceMap = buildEvidenceMap(input, parsed.data, inputHash);
  writeFileSync(paths.summary, `${JSON.stringify(sortValue(parsed.data), null, 2)}\n`, "utf8");
  writeFileSync(paths.evidenceMap, `${JSON.stringify(sortValue(evidenceMap), null, 2)}\n`, "utf8");
  writeFileSync(
    paths.promptVersion,
    `${JSON.stringify(sortValue(buildPromptVersionArtifact()), null, 2)}\n`,
    "utf8"
  );

  return {
    status: "OK",
    inputHash,
    promptVersion: EXECUTIVE_SUMMARY_PROMPT_VERSION,
    output: parsed.data,
    guardViolations: [],
    schemaIssues: [],
    artifactPaths: paths,
  };
}
