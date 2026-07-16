/**
 * R10.6a — One-off GPT section runtime debug (safe, no secrets logged).
 */
import { readFileSync } from "node:fs";
import { callOpenAiStrictJson } from "../src/modules/digital-profile/orion-golden/gpt/openai-json-client";
import { normalizeSectionAnalysis } from "../src/modules/digital-profile/orion-golden/gpt/normalize-section-analysis";
import { digitalProfileConfig } from "../src/modules/digital-profile/config";
import { z } from "zod";

const sectionAnalysisSchema = z.object({
  sectionId: z.string(),
  status: z.enum(["HAS_FINDINGS", "NO_FINDINGS", "DATA_POOR", "NOT_APPLICABLE", "MANUAL_REVIEW_PENDING"]),
  clientNarrative: z.string(),
  keyFindings: z.array(
    z.object({
      title: z.string(),
      summary: z.string(),
      evidenceRefs: z.array(z.string()),
      confidence: z.enum(["Высокая", "Средняя", "Низкая"]),
      caveat: z.string().optional(),
    })
  ),
  risks: z.array(
    z.object({
      theme: z.string(),
      level: z.enum(["Низкий", "Средний", "Высокий", "Критический", "Требует проверки"]),
      summary: z.string(),
      evidenceRefs: z.array(z.string()),
      requiresManualReview: z.boolean(),
    })
  ),
  limitations: z.array(z.string()),
  recommendations: z.array(z.string()),
});

const SECTION_SYSTEM_PROMPT = `You are ORION section analyst. Analyze ONLY the single section provided.
Return ONE JSON object with keys: sectionId, status, clientNarrative, keyFindings, risks, limitations, recommendations.`;

async function main() {
  const bundlePath =
    process.argv[2] ??
    "storage/digital-profile/qa-r10-orion-golden-parallel/section-bundles/11_ru_search_links.input.json";
  const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));

  console.log("config", {
    enabled: digitalProfileConfig.aiAnalyst.enabled,
    model: digitalProfileConfig.aiAnalyst.model,
    hasKey: Boolean(digitalProfileConfig.aiAnalyst.openAiApiKey),
    maxOutputTokens: digitalProfileConfig.aiAnalyst.maxOutputTokens,
    timeoutMs: digitalProfileConfig.aiAnalyst.timeoutMs,
  });

  const userPayload = {
    sectionId: bundle.sectionId,
    sectionTitle: bundle.title,
    allowedEvidence: bundle.allowedEvidence.slice(0, 3),
    dataSufficiency: bundle.dataSufficiency,
  };

  try {
    const raw = await callOpenAiStrictJson({ systemPrompt: SECTION_SYSTEM_PROMPT, userPayload });
    console.log("rawType", typeof raw);
    console.log("rawKeys", raw && typeof raw === "object" ? Object.keys(raw as object) : []);
    console.log("rawSample", JSON.stringify(raw).slice(0, 2000));
    const normalized = normalizeSectionAnalysis(
      (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>,
      bundle.sectionId
    );
    const parsed = sectionAnalysisSchema.safeParse(normalized);
    if (!parsed.success) {
      console.log("zodError", JSON.stringify(parsed.error.issues.slice(0, 8), null, 2));
    } else {
      console.log("ok", parsed.data.sectionId, parsed.data.status);
    }
  } catch (err) {
    const e = err as Error & { issues?: unknown[] };
    console.log("errorName", e?.constructor?.name);
    console.log("errorMessage", e?.message);
    if (e?.issues) console.log("issues", JSON.stringify(e.issues.slice(0, 5), null, 2));
  }
}

main().catch((e) => {
  console.error("fatal", e?.message ?? e);
  process.exit(1);
});
