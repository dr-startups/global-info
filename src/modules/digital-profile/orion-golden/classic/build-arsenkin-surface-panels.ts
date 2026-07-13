/**
 * Build First36 surface_panel assets from run-scoped Arsenkin SerpObservations
 * (autocomplete → suggestions, paa → related).
 */

import { listSerpObservationsForAuditRun } from "../../serp-observation";
import type { ReportAssetV1 } from "../../orion-report-spec/asset-builder";
import { buildSurfacePanelSvg, svgToPngBase64 } from "../../orion-report-spec/media-asset-svg";

function mapRegion(raw: string): "RU" | "UAE" {
  const r = String(raw ?? "").toUpperCase();
  if (/UAE|AE|INTL/.test(r)) return "UAE";
  return "RU";
}

async function pushPanel(
  assets: ReportAssetV1[],
  opts: {
    assetRef: string;
    title: string;
    engineLabel: string;
    caption: string;
    lines: Array<{ label: string; meta?: string; evidenceRef: string }>;
  }
): Promise<void> {
  if (opts.lines.length === 0) return;
  assets.push({
    assetRef: opts.assetRef,
    kind: "surface_panel",
    title: opts.title,
    caption: opts.caption,
    imageData: await svgToPngBase64(
      buildSurfacePanelSvg({
        title: opts.title,
        subtitle: `${opts.lines.length} строк · Arsenkin`,
        engineLabel: opts.engineLabel,
        items: opts.lines.slice(0, 10).map((x) => ({
          label: x.label,
          meta: x.meta,
        })),
      })
    ),
    evidenceRefs: opts.lines.slice(0, 10).map((x) => x.evidenceRef),
    status: "ready",
  });
}

/**
 * Prefer Arsenkin panels when present: returns assets that should overlay
 * (same assetRefs as classic surface panels).
 */
export async function buildArsenkinSurfacePanelAssets(input: {
  auditRunId: string;
}): Promise<{ assets: ReportAssetV1[]; autocomplete: number; paa: number; aiAnswer: number }> {
  const rows = await listSerpObservationsForAuditRun(input.auditRunId);
  const autocomplete = rows.filter((r) => r.surface === "autocomplete" && r.provider === "arsenkin");
  const paa = rows.filter((r) => r.surface === "paa" && r.provider === "arsenkin");
  const aiAnswer = rows.filter((r) => r.surface === "ai_answer" && r.provider === "arsenkin");
  const assets: ReportAssetV1[] = [];

  const ruYandexSuggest = autocomplete.filter(
    (r) => mapRegion(r.region) === "RU" && String(r.engine).toUpperCase() === "YANDEX"
  );
  const ruGoogleSuggest = autocomplete.filter(
    (r) => mapRegion(r.region) === "RU" && String(r.engine).toUpperCase() === "GOOGLE"
  );
  const uaeSuggest = autocomplete.filter((r) => mapRegion(r.region) === "UAE");

  await pushPanel(assets, {
    assetRef: "ru_suggestions_yandex",
    title: "Россия — подсказки Яндекс",
    engineLabel: "Яндекс",
    caption: "Подсказки Arsenkin (Yandex suggest)",
    lines: ruYandexSuggest.map((r) => ({
      label: String(r.title ?? r.queryText).trim(),
      meta: "Яндекс",
      evidenceRef: `serp_observation:${r.id}`,
    })),
  });
  await pushPanel(assets, {
    assetRef: "ru_suggestions_google",
    title: "Россия — подсказки Google",
    engineLabel: "Google",
    caption: "Подсказки Arsenkin (Google suggest)",
    lines: ruGoogleSuggest.map((r) => ({
      label: String(r.title ?? r.queryText).trim(),
      meta: "Google",
      evidenceRef: `serp_observation:${r.id}`,
    })),
  });
  await pushPanel(assets, {
    assetRef: "uae_suggestions",
    title: "ОАЭ — подсказки поиска",
    engineLabel: "Google",
    caption: "Подсказки Arsenkin",
    lines: uaeSuggest.map((r) => ({
      label: String(r.title ?? r.queryText).trim(),
      meta: "Google",
      evidenceRef: `serp_observation:${r.id}`,
    })),
  });

  const ruPaa = paa.filter((r) => mapRegion(r.region) === "RU");
  const uaePaa = paa.filter((r) => mapRegion(r.region) === "UAE");
  const pageSize = ruPaa.length > 0 ? Math.max(1, Math.ceil(ruPaa.length / 3)) : 0;
  for (let i = 0; i < 3; i += 1) {
    const chunk = ruPaa.slice(i * pageSize, i * pageSize + pageSize);
    await pushPanel(assets, {
      assetRef: `ru_related_${i + 1}`,
      title: `Россия — вопросы People Also Ask (${i + 1})`,
      engineLabel: "Google PAA",
      caption: "People Also Ask (Arsenkin, Google-only)",
      lines: chunk.map((r) => ({
        label: String(r.title ?? "").trim(),
        meta: r.snippet ? String(r.snippet).slice(0, 80) : "PAA",
        evidenceRef: `serp_observation:${r.id}`,
      })),
    });
  }
  const firstRelated = assets.find((a) => a.assetRef === "ru_related_1");
  if (firstRelated) {
    assets.push({ ...firstRelated, assetRef: "ru_related" });
  }
  await pushPanel(assets, {
    assetRef: "uae_related",
    title: "ОАЭ — вопросы People Also Ask",
    engineLabel: "Google PAA",
    caption: "People Also Ask (Arsenkin)",
    lines: uaePaa.map((r) => ({
      label: String(r.title ?? "").trim(),
      meta: r.snippet ? String(r.snippet).slice(0, 80) : "PAA",
      evidenceRef: `serp_observation:${r.id}`,
    })),
  });

  // AI overview → p19 knowledge_panel_2 only (never replaces Wikipedia panel_1).
  const ruAi = aiAnswer.filter((r) => mapRegion(r.region) === "RU");
  const aiAnswerText = ruAi.find((r) => /ИИ-ответ/i.test(String(r.title ?? "")));
  const aiSources = ruAi.filter((r) => r.domain !== "ai-serp");
  const aiLines: Array<{ label: string; meta?: string; evidenceRef: string }> = [];
  if (aiAnswerText?.snippet) {
    aiLines.push({
      label: String(aiAnswerText.snippet).slice(0, 180),
      meta: aiAnswerText.providerStatus === "NO_RESULTS" ? "ИИ не найден" : "ИИ-текст",
      evidenceRef: `serp_observation:${aiAnswerText.id}`,
    });
  }
  for (const src of aiSources.slice(0, 8)) {
    aiLines.push({
      label: String(src.title ?? src.url).trim(),
      meta: src.domain ?? "source",
      evidenceRef: `serp_observation:${src.id}`,
    });
  }
  await pushPanel(assets, {
    assetRef: "ru_knowledge_panel_2",
    title: "Россия — ИИ-представление в поиске",
    engineLabel: "Яндекс Алиса",
    caption:
      aiAnswerText?.providerStatus === "NO_RESULTS"
        ? "ИИ-ответ поиска не найден (Arsenkin ai-serp). Не энциклопедическая карточка Wikipedia."
        : "ИИ-ответ поиска (Arsenkin ai-serp). Не энциклопедическая карточка Wikipedia.",
    lines: aiLines,
  });

  return {
    assets,
    autocomplete: autocomplete.length,
    paa: paa.length,
    aiAnswer: aiAnswer.length,
  };
}

/** Overlay Arsenkin panels onto classic assets (replace same assetRef when Arsenkin has data). */
export function overlaySurfacePanelAssets(
  base: ReportAssetV1[],
  overlay: ReportAssetV1[]
): ReportAssetV1[] {
  if (overlay.length === 0) return base;
  const byRef = new Map(overlay.map((a) => [a.assetRef, a]));
  const out = base.map((a) => byRef.get(a.assetRef) ?? a);
  for (const a of overlay) {
    if (!out.some((x) => x.assetRef === a.assetRef)) out.push(a);
  }
  return out;
}
