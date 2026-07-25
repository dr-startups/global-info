/**

 * R10 — GPT-5.5 section analysis (strict JSON, blocks on failure).

 */



import { z } from "zod";

import { OpenAiRateLimitError } from "./openai-rate-limit";

import type { SectionEvidencePack, OrionGoldenSectionAnalysis } from "../types";

import { callOpenAiStrictJson } from "./openai-json-client";
import { buildSectionAnalysisPayload } from "./section-analysis-payload";
import { normalizeGoldenSectionAnalysis } from "./normalize-gpt-analysis";



const GPT_SECTION_KEYS = [

  "ru_audit_summary",

  "ru_search_results",

  "ru_wikipedia",

  "uae_audit_summary",

  "uae_search_results",

  "uae_wikipedia",

  "compliance_databases",

  "lexisnexis_summary",

  "dow_jones_world_check_summary",

  "offer_recommendation",

] as const;



export type OrionGoldenGptSectionKey = (typeof GPT_SECTION_KEYS)[number];



const analysisSchema = z.object({

  sectionKey: z.string().min(1),

  clientTitle: z.string().min(1),

  mainConclusion: z.string().min(1),

  riskLevel: z.enum(["low", "medium", "high", "critical", "review_required", "no_data"]),

  whatWasChecked: z.array(z.string()),

  whatWasFound: z.array(z.string()),

  whyItMatters: z.array(z.string()),

  riskInterpretation: z.array(z.string()),

  manualReviewNeeded: z.array(z.string()),

  recommendedActions: z.array(z.string()),

  keyEvidence: z.array(

    z.object({

      title: z.string(),

      domain: z.string().optional(),

      sourceType: z.string(),

      whyRelevant: z.string(),

      verificationStatus: z.enum(["confirmed", "likely", "requires_review", "excluded_from_risk"]),

    })

  ),

  excludedNoiseSummary: z.array(z.string()),

  clientNarrative: z.string().min(1),

  slidePlan: z.array(

    z.object({

      slideKey: z.string(),

      template: z.string(),

      title: z.string(),

    })

  ),

});



const SECTION_TITLES: Record<OrionGoldenGptSectionKey, string> = {

  ru_audit_summary: "Россия — резюме аудита",

  ru_search_results: "Россия — результаты поиска",

  ru_wikipedia: "Россия — Википедия",

  uae_audit_summary: "ОАЭ — резюме аудита",

  uae_search_results: "ОАЭ — результаты поиска",

  uae_wikipedia: "ОАЭ — Википедия",

  compliance_databases: "Compliance-базы данных",

  lexisnexis_summary: "LexisNexis — аналитическая сводка",

  dow_jones_world_check_summary: "Dow Jones / World-Check",

  offer_recommendation: "Рекомендации и следующие шаги",

};



const SYSTEM_PROMPT = `You are ORION Golden Report analyst for client-facing due diligence reports.

Write plain Russian. No raw IDs, storage paths, enum keys, or legal conclusions.

Compliance/sanctions/PEP statements must be preliminary unless confirmed by source.

Evidence marked [ТРЕБУЕТ РУЧНОЙ ПРОВЕРКИ — НЕ ПОДТВЕРЖДЕНО] must NEVER be presented as confirmed negative facts.
Use manualReviewNeeded for such items. Do not elevate them to keyEvidence with verificationStatus "confirmed".

Evidence marked [ПРИЛОЖЕНИЕ — ОГРАНИЧЕННЫЙ ВЫВОД] may appear only with caveats, not as strong findings.

Each selectedEvidence item carries: ref, title, snippet, domain, url, region, sourceType,
publishedAt, relevance, riskTheme, riskLevel, entityMatchScore.
State when material is dated and distinguish recent coverage from years-old items;
never imply a date for an item that has none. Ground every statement in the snippet text —
name what the material actually says (who, what, where, which organisation, which amount).
Generic due-diligence commentary that would fit any subject is not acceptable output.
Never assert anything the snippets do not support; if a snippet is cut (snippetTruncated),
do not guess its ending. Attribute a source only to its own domain field.
A low entityMatchScore means the material may concern a namesake — hedge accordingly.
When evidenceOmitted is present, some weaker materials were left out of this call; say that
coverage is partial rather than implying the section was exhaustively reviewed.

Return ONE JSON object with keys:

sectionKey, clientTitle, mainConclusion, riskLevel, whatWasChecked, whatWasFound, whyItMatters,

riskInterpretation, manualReviewNeeded, recommendedActions, keyEvidence, excludedNoiseSummary,

clientNarrative, slidePlan.`;



function mapPackKey(sectionKey: OrionGoldenGptSectionKey): string {

  const map: Partial<Record<OrionGoldenGptSectionKey, string>> = {

    lexisnexis_summary: "lexisnexis",

    dow_jones_world_check_summary: "compliance_databases",

    offer_recommendation: "offer_context",

  };

  return map[sectionKey] ?? sectionKey;

}



async function callGpt(

  sectionKey: OrionGoldenGptSectionKey,

  pack: SectionEvidencePack | undefined,

  subjectName: string

): Promise<OrionGoldenSectionAnalysis> {

  const userPayload = buildSectionAnalysisPayload({

    sectionKey,

    clientTitle: SECTION_TITLES[sectionKey],

    subjectName,

    pack,

  });



  const raw = await callOpenAiStrictJson({ systemPrompt: SYSTEM_PROMPT, userPayload });

  const normalized = normalizeGoldenSectionAnalysis(
    (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>,
    sectionKey,
    SECTION_TITLES[sectionKey]
  );
  const parsed = analysisSchema.parse(normalized);

  return { ...parsed, sectionKey, generatedBy: "gpt-5.5" };

}



export async function runOrionGoldenSectionAnalyses(input: {

  packs: SectionEvidencePack[];

  subjectName: string;

  requireAi: boolean;

}): Promise<OrionGoldenSectionAnalysis[]> {

  if (!input.requireAi) throw new Error("gpt55-required");

  const out: OrionGoldenSectionAnalysis[] = [];

  for (const sectionKey of GPT_SECTION_KEYS) {

    try {

      const pack = input.packs.find((p) => p.sectionKey === mapPackKey(sectionKey));

      out.push(await callGpt(sectionKey, pack, input.subjectName));

    } catch (err) {

      if (err instanceof OpenAiRateLimitError) throw err;

      throw err;

    }

  }

  return out;

}



export { GPT_SECTION_KEYS, SECTION_TITLES };


