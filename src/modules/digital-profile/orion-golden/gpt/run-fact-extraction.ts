/**
 * Step 05.2(c2) — orchestration for fact extraction.
 *
 * Kept apart from `fact-extraction.ts` so the verification rules stay a pure,
 * network-free module: this file owns the flag, the batching per theme, the
 * GPT call and the artifact, and delegates every decision about what may enter
 * the report to the verifier.
 *
 * Fail-open by design: a section whose extraction fails keeps the deterministic
 * text it had before. Losing the richer copy is acceptable; losing the report
 * is not.
 */

import { CANONICAL_THEME_IDS } from "../contracts/canonical-claim";
import type { CanonicalClaimsBundle, CanonicalThemeId } from "../contracts/canonical-claim";
import { themeLabelRu } from "../analytics/canonical-themes";
import type { RepresentativeEvidenceSelection } from "../contracts/representative-evidence";
import type { RawInventoryItem } from "../types";
import { digitalProfileConfig } from "../../config";
import { publishedAtOf, toDisplayDate } from "../../providers/published-date";
import {
  ExtractedFactsResponseSchema,
  FACT_EXTRACTION_PROMPT_VERSION,
  FACT_EXTRACTION_SYSTEM_PROMPT,
  FACT_EXTRACTION_VERSION,
  verifyExtractedFacts,
  type FactSourceMaterial,
  type VerifiedFact,
} from "./fact-extraction";

/** Same shape the other GPT stages inject, so tests can pass a fake. */
export type GptJsonCaller = (input: {
  systemPrompt: string;
  userPayload: unknown;
}) => Promise<unknown>;

/** Materials per call — enough for a theme, small enough to stay cheap. */
export const FACT_EXTRACTION_MAX_MATERIALS = 12;

export type FactExtractionArtifact = {
  version: typeof FACT_EXTRACTION_VERSION;
  promptVersion: typeof FACT_EXTRACTION_PROMPT_VERSION;
  generatedAt: string;
  caseId: string;
  datasetId: string;
  enabled: boolean;
  factsByTheme: Record<string, VerifiedFact[]>;
  diagnostics: {
    themesProcessed: number;
    proposed: number;
    accepted: number;
    rejected: number;
    rejectedByReason: Record<string, number>;
    /** Theme ids whose call failed; they keep deterministic text. */
    failedThemes: string[];
    /** Facts the model moved to a theme other than the one requested. */
    reassignedByModel: number;
    /**
     * Themes extraction actually ran for. Lets consumers tell "no facts because
     * extraction was off" from "no facts because nothing in this theme's
     * materials could be stated as a verified fact".
     */
    processedThemeIds: string[];
  };
};

export function isFactExtractionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicit = String(env.ORION_GPT_FACTS ?? "").trim();
  if (explicit === "0" || explicit.toLowerCase() === "false") return false;
  if (explicit === "1" || explicit.toLowerCase() === "true") return true;
  if (env.NETWORK_CALLS === "0") return false;
  // Default: on wherever the AI analyst is actually configured.
  return Boolean(digitalProfileConfig.aiAnalyst.enabled && digitalProfileConfig.aiAnalyst.openAiApiKey);
}

function defaultCaller(): GptJsonCaller {
  return async (args) => {
    const { callOpenAiStrictJson } = await import("./openai-json-client");
    return callOpenAiStrictJson(args);
  };
}

function emptyArtifact(input: {
  caseId: string;
  datasetId: string;
  enabled: boolean;
}): FactExtractionArtifact {
  return {
    version: FACT_EXTRACTION_VERSION,
    promptVersion: FACT_EXTRACTION_PROMPT_VERSION,
    generatedAt: new Date().toISOString(),
    caseId: input.caseId,
    datasetId: input.datasetId,
    enabled: input.enabled,
    factsByTheme: {},
    diagnostics: {
      themesProcessed: 0,
      proposed: 0,
      accepted: 0,
      rejected: 0,
      rejectedByReason: {},
      failedThemes: [],
      reassignedByModel: 0,
      processedThemeIds: [],
    },
  };
}

const ALLOWED_THEMES: readonly CanonicalThemeId[] = CANONICAL_THEME_IDS;
const ALLOWED_THEME_SET: ReadonlySet<string> = new Set<string>(CANONICAL_THEME_IDS);

/** Materials behind the claims a theme actually shows, deduplicated by ref. */
export function materialsForTheme(input: {
  themeId: CanonicalThemeId;
  claimsBundle: CanonicalClaimsBundle;
  representative: RepresentativeEvidenceSelection;
  itemsByRef: Map<string, RawInventoryItem>;
}): FactSourceMaterial[] {
  const selected = input.representative.selectedByTheme[input.themeId] ?? [];
  const claimIds = new Set(selected.map((s) => s.claimId));
  const evidenceRefs = new Set<string>();
  for (const claim of input.claimsBundle.claims) {
    if (!claimIds.has(claim.claimId)) continue;
    for (const ref of claim.evidenceRefs) evidenceRefs.add(ref);
  }

  const materials: FactSourceMaterial[] = [];
  for (const ref of evidenceRefs) {
    const item = input.itemsByRef.get(ref);
    if (!item?.title) continue;
    const publishedIso = item.publishedAt ?? publishedAtOf(item.rawMetadata);
    materials.push({
      ref: `e${materials.length + 1}`,
      evidenceRef: ref,
      title: item.title,
      ...(item.snippet ? { snippet: item.snippet } : {}),
      ...(isPublicUrl(item.sourceUrl) ? { url: item.sourceUrl! } : {}),
      ...(isPublicUrl(item.sourceUrl) && domainOf(item.sourceUrl!)
        ? { domain: domainOf(item.sourceUrl!) }
        : {}),
      ...(toDisplayDate(publishedIso) ? { publishedAt: toDisplayDate(publishedIso)! } : {}),
    });
    if (materials.length >= FACT_EXTRACTION_MAX_MATERIALS) break;
  }
  return materials;
}

/**
 * Public domain of a material, or "" when there is none.
 *
 * Surfaces without a published source (Arsenkin AI answers, PAA) carry a
 * synthetic `arsenkin://other/<id>` handle. Parsing that as a URL yields the
 * hostname "other", which reached the client as the name of a source — 15 of 35
 * facts on the first live run were attributed to «other». Only http(s) origins
 * are real sources; anything else means "no public source", and the attribution
 * must then be omitted rather than invented (step 05.3).
 */
function domainOf(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    return parsed.hostname.replace(/^www\./iu, "").toLowerCase();
  } catch {
    return "";
  }
}

/** True for internal handles that must never be shown as a source link. */
function isPublicUrl(url: string | undefined): boolean {
  return Boolean(url && /^https?:\/\//iu.test(url));
}

/**
 * Extracts verified facts for every theme the report will show.
 *
 * Themes are processed sequentially: the GPT queue already serialises calls,
 * and a report build is not latency-critical.
 */
export async function runFactExtraction(input: {
  caseId: string;
  datasetId: string;
  subjectName: string;
  claimsBundle: CanonicalClaimsBundle;
  representative: RepresentativeEvidenceSelection;
  itemsByRef: Map<string, RawInventoryItem>;
  enabled?: boolean;
  caller?: GptJsonCaller;
}): Promise<FactExtractionArtifact> {
  const enabled = input.enabled ?? isFactExtractionEnabled();
  const artifact = emptyArtifact({
    caseId: input.caseId,
    datasetId: input.datasetId,
    enabled,
  });
  if (!enabled) return artifact;

  const caller = input.caller ?? defaultCaller();
  const themeIds = Object.keys(input.representative.selectedByTheme) as CanonicalThemeId[];

  for (const themeId of themeIds) {
    const materials = materialsForTheme({
      themeId,
      claimsBundle: input.claimsBundle,
      representative: input.representative,
      itemsByRef: input.itemsByRef,
    });
    if (materials.length === 0) continue;
    artifact.diagnostics.themesProcessed += 1;
    artifact.diagnostics.processedThemeIds.push(themeId);

    try {
      const raw = await caller({
        systemPrompt: FACT_EXTRACTION_SYSTEM_PROMPT,
        userPayload: {
          subjectName: input.subjectName,
          themeId,
          allowedThemes: ALLOWED_THEMES.map((id) => ({ id, label: themeLabelRu(id) })),
          materials: materials.map((m) => ({
            ref: m.ref,
            title: m.title,
            ...(m.snippet ? { snippet: m.snippet } : {}),
            ...(m.publishedAt ? { publishedAt: m.publishedAt } : {}),
          })),
        },
      });

      const parsed = ExtractedFactsResponseSchema.safeParse(raw);
      if (!parsed.success) {
        artifact.diagnostics.failedThemes.push(themeId);
        continue;
      }

      const outcome = verifyExtractedFacts({
        facts: parsed.data.facts,
        materials,
        allowedThemes: ALLOWED_THEME_SET,
      });
      artifact.diagnostics.proposed += parsed.data.facts.length;
      artifact.diagnostics.accepted += outcome.accepted.length;
      artifact.diagnostics.rejected += outcome.rejected.length;
      for (const [reason, count] of Object.entries(outcome.rejectedByReason)) {
        artifact.diagnostics.rejectedByReason[reason] =
          (artifact.diagnostics.rejectedByReason[reason] ?? 0) + count;
      }
      // Facts land under the theme they belong to, not the theme they were
      // requested for: inheriting the call's theme published a company-founding
      // fact under «Регуляторные расследования» (step 06.2).
      for (const fact of outcome.accepted) {
        const target = fact.themeId ?? themeId;
        (artifact.factsByTheme[target] ??= []).push(fact);
        if (fact.themeId && fact.themeId !== themeId) {
          artifact.diagnostics.reassignedByModel += 1;
        }
      }
    } catch {
      // Fail-open: this theme keeps its deterministic text.
      artifact.diagnostics.failedThemes.push(themeId);
    }
  }

  return artifact;
}
