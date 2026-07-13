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

  // AI overview → p19 knowledge_panel_2 (RU Alice + Google AI), never Wikipedia panel_1.
  const ruAi = aiAnswer.filter((r) => mapRegion(r.region) === "RU");
  const ruYandexAi = ruAi.filter((r) => String(r.engine).toUpperCase() === "YANDEX");
  const ruGoogleAi = ruAi.filter((r) => String(r.engine).toUpperCase() === "GOOGLE");
  const pickAnswer = (rows: typeof ruAi) =>
    rows.find((r) => /ИИ-ответ|AI Overview/i.test(String(r.title ?? "")));
  const yandexAnswer = pickAnswer(ruYandexAi);
  const googleRuAnswer = pickAnswer(ruGoogleAi);
  const ruAiLines: Array<{ label: string; meta?: string; evidenceRef: string }> = [];
  if (yandexAnswer?.snippet) {
    ruAiLines.push({
      label: String(yandexAnswer.snippet).slice(0, 160),
      meta: yandexAnswer.providerStatus === "NO_RESULTS" ? "Алиса · нет" : "Алиса",
      evidenceRef: `serp_observation:${yandexAnswer.id}`,
    });
  }
  if (googleRuAnswer?.snippet) {
    ruAiLines.push({
      label: String(googleRuAnswer.snippet).slice(0, 160),
      meta: googleRuAnswer.providerStatus === "NO_RESULTS" ? "Google AI · нет" : "Google AI",
      evidenceRef: `serp_observation:${googleRuAnswer.id}`,
    });
  }
  for (const src of [...ruYandexAi, ...ruGoogleAi]
    .filter((r) => r.domain !== "ai-serp")
    .slice(0, 6)) {
    ruAiLines.push({
      label: String(src.title ?? src.url).trim(),
      meta: `${String(src.engine).toUpperCase() === "YANDEX" ? "Алиса" : "Google"} · ${src.domain ?? "source"}`,
      evidenceRef: `serp_observation:${src.id}`,
    });
  }
  const ruAiAbsent =
    (yandexAnswer?.providerStatus === "NO_RESULTS" || !yandexAnswer) &&
    (googleRuAnswer?.providerStatus === "NO_RESULTS" || !googleRuAnswer);
  await pushPanel(assets, {
    assetRef: "ru_knowledge_panel_2",
    title: "Россия — ИИ-представление в поиске",
    engineLabel: "Алиса / Google AI",
    caption: ruAiAbsent
      ? "ИИ-ответ поиска не найден (Arsenkin ai-serp). Не энциклопедическая карточка Wikipedia."
      : "ИИ-ответ поиска (Arsenkin ai-serp: Алиса + Google AI Overview). Не энциклопедическая карточка Wikipedia.",
    lines: ruAiLines,
  });

  // UAE Google AI Overview → uae_knowledge_panel (separate from Wikipedia when overlay allows).
  const uaeAi = aiAnswer.filter((r) => mapRegion(r.region) === "UAE");
  const uaeAnswer = pickAnswer(uaeAi);
  const uaeLines: Array<{ label: string; meta?: string; evidenceRef: string }> = [];
  if (uaeAnswer?.snippet) {
    uaeLines.push({
      label: String(uaeAnswer.snippet).slice(0, 180),
      meta: uaeAnswer.providerStatus === "NO_RESULTS" ? "AI Overview · absent" : "AI Overview",
      evidenceRef: `serp_observation:${uaeAnswer.id}`,
    });
  }
  for (const src of uaeAi.filter((r) => r.domain !== "ai-serp").slice(0, 8)) {
    uaeLines.push({
      label: String(src.title ?? src.url).trim(),
      meta: src.domain ?? "source",
      evidenceRef: `serp_observation:${src.id}`,
    });
  }
  await pushPanel(assets, {
    assetRef: "uae_knowledge_panel",
    title: "ОАЭ — Google AI Overview",
    engineLabel: "Google AI Overview",
    caption:
      uaeAnswer?.providerStatus === "NO_RESULTS"
        ? "Google AI Overview не найден (Arsenkin ai-serp). Не энциклопедическая карточка Wikipedia."
        : "Google AI Overview (Arsenkin ai-serp). Не энциклопедическая карточка Wikipedia.",
    lines: uaeLines,
  });

  // URL enrichment (check-h + indexation) → p12 when google-suggest slot is free / preferred.
  const pageMeta = rows.filter((r) => r.surface === "page_meta" && r.provider === "arsenkin");
  const indexation = rows.filter((r) => r.surface === "indexation" && r.provider === "arsenkin");
  const urlLines: Array<{ label: string; meta?: string; evidenceRef: string }> = [];
  for (const m of pageMeta.slice(0, 5)) {
    urlLines.push({
      label: `${m.domain ?? m.url}: ${String(m.title ?? "").slice(0, 80)}`,
      meta: m.snippet ? String(m.snippet).slice(0, 60) : "meta",
      evidenceRef: `serp_observation:${m.id}`,
    });
  }
  for (const ix of indexation.slice(0, 5)) {
    urlLines.push({
      label: String(ix.title ?? ix.url).slice(0, 120),
      meta: "индекс",
      evidenceRef: `serp_observation:${ix.id}`,
    });
  }
  await pushPanel(assets, {
    assetRef: "ru_url_audit",
    title: "Россия — проверка URL (title / H1 / индекс)",
    engineLabel: "check-h / indexation",
    caption: "Обогащение URL из выдачи (Arsenkin check-h + indexation)",
    lines: urlLines,
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
  const safeOverlay = overlay.filter((a) => {
    if (a.assetRef !== "uae_knowledge_panel" && a.assetRef !== "ru_knowledge_panel") return true;
    const existing = base.find((b) => b.assetRef === a.assetRef);
    if (!existing) return true;
    // Never replace a ready Wikipedia knowledge panel with AI surface panel.
    const wikiReady =
      existing.kind === "knowledge_panel" &&
      existing.status === "ready" &&
      /wikipedia|википед/i.test(`${existing.title ?? ""} ${existing.caption ?? ""}`);
    return !wikiReady;
  });
  if (safeOverlay.length === 0) return base;
  const byRef = new Map(safeOverlay.map((a) => [a.assetRef, a]));
  const out = base.map((a) => byRef.get(a.assetRef) ?? a);
  for (const a of safeOverlay) {
    if (!out.some((x) => x.assetRef === a.assetRef)) out.push(a);
  }
  return out;
}
