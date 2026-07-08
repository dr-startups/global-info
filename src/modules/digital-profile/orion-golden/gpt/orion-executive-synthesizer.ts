/**

 * R10 — Executive synthesis AFTER all section analyses.

 */



import { z } from "zod";

import type { OrionGoldenExecutiveSynthesis, OrionGoldenSectionAnalysis } from "../types";

import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";

import type { EvidenceRoutingInspection } from "../evidence/orion-section-router";

import { callOpenAiStrictJson } from "./openai-json-client";
import { normalizeExecutiveSynthesis } from "./normalize-gpt-analysis";



const execSchema = z.object({

  executiveSummary: z.string().min(1),

  globalRiskLevel: z.enum(["low", "medium", "high", "critical", "review_required"]),

  riskMatrix: z.array(

    z.object({

      theme: z.string(),

      level: z.string(),

      summary: z.string(),

    })

  ),

  mainRisks: z.array(z.string()),

  possibleConsequences: z.array(z.string()),

  finalRecommendations: z.array(z.string()),

  nextSteps: z.array(z.string()),

});



const EXEC_SYSTEM_PROMPT = `Synthesize ORION executive summary and risk matrix in plain Russian.

Preliminary compliance framing only. Return ONE JSON object with keys:

executiveSummary, globalRiskLevel, riskMatrix, mainRisks, possibleConsequences, finalRecommendations, nextSteps.`;



export async function runOrionGoldenExecutiveSynthesis(input: {

  sectionAnalyses: OrionGoldenSectionAnalysis[];

  inventory: FullEvidenceInventory;

  routing: EvidenceRoutingInspection;

  requireAi: boolean;

}): Promise<OrionGoldenExecutiveSynthesis> {

  if (!input.requireAi) throw new Error("gpt55-required");



  const payload = {

    sectionSummaries: input.sectionAnalyses.map((s) => ({

      sectionKey: s.sectionKey,

      mainConclusion: s.mainConclusion,

      riskLevel: s.riskLevel,

      excludedNoiseSummary: s.excludedNoiseSummary,

    })),

    metrics: {

      searchResults: input.inventory.counts.searchResults,

      searchSurfaces: input.inventory.counts.searchSurfaces,

      riskFindings: input.inventory.counts.riskFindings,

      searchAccounted: input.routing.searchResultsAccounted,

      searchUnaccounted: input.routing.searchResultsUnaccounted,

    },

    excludedNoiseTotal: input.routing.sections.reduce((a, s) => a + s.excluded, 0),

  };



  const raw = await callOpenAiStrictJson({ systemPrompt: EXEC_SYSTEM_PROMPT, userPayload: payload });

  const normalized = normalizeExecutiveSynthesis(
    (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  );
  const parsed = execSchema.parse(normalized);

  return { ...parsed, generatedBy: "gpt-5.5" };

}


