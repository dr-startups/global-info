import { digitalProfileConfig } from "../config";
import { loadFile } from "../storage/private-store";
import type { ReportAssetV1 } from "../orion-report-spec/asset-builder";
import type { OrionRealCaseContext } from "../orion-section-pipeline/real-case-data-adapter";

async function renderLexisPagesFromDocx(docxBase64: string): Promise<ReportAssetV1[]> {
  const url = `${digitalProfileConfig.rendererUrl}/lexis/process-docx`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ docxBase64 }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) return [];
  const json = (await res.json()) as {
    pages?: Array<{ pageNumber: number; contentBase64: string }>;
  };
  return (json.pages ?? []).slice(0, 12).map((page) => ({
    assetRef: `lexis_visual_page_${page.pageNumber}`,
    kind: "lexis_visual_page" as const,
    title: `LexisNexis — страница ${page.pageNumber}`,
    imageData: page.contentBase64,
    evidenceRefs: [],
    status: "ready" as const,
  }));
}

export async function buildLexisReportAssets(ctx: OrionRealCaseContext): Promise<ReportAssetV1[]> {
  const doc = (ctx.lexis.latestReady ?? ctx.lexis.latestAny) as Record<string, unknown> | null;
  if (!doc) return [];

  const pages = Array.isArray(doc.renderedPages)
    ? (doc.renderedPages as Array<Record<string, unknown>>)
    : [];
  const assets: ReportAssetV1[] = [];

  for (const page of pages.slice(0, 12)) {
    const pageNum = Number(page.pageNumber ?? assets.length + 1);
    const assetRef = `lexis_visual_page_${pageNum}`;
    const inline = String(page.imageBase64 ?? page.contentBase64 ?? "");
    let imageData: string | undefined;
    if (inline) {
      imageData = inline;
    } else {
      const key = String(page.storageKey ?? "");
      if (key) {
        try {
          imageData = (await loadFile(key)).toString("base64");
        } catch {
          continue;
        }
      }
    }
    if (!imageData) continue;
    assets.push({
      assetRef,
      kind: "lexis_visual_page",
      title: `LexisNexis — страница ${pageNum}`,
      imageData,
      evidenceRefs: [],
      status: "ready",
    });
  }

  if (assets.length > 0) return assets;

  const docxKey = String(doc.storageKey ?? "");
  if (!docxKey) return [];
  try {
    const docxBytes = await loadFile(docxKey);
    return renderLexisPagesFromDocx(docxBytes.toString("base64"));
  } catch {
    return [];
  }
}

export function lexisSummaryTakeaway(ctx: OrionRealCaseContext): string {
  const doc = (ctx.lexis.latestReady ?? ctx.lexis.latestAny) as Record<string, unknown> | null;
  if (!doc) {
    return ctx.lexis.uploadExists
      ? "Загруженный отчёт LexisNexis для данного прогона недоступен в клиентском формате."
      : "Отчёт LexisNexis для данного кейса не был доступен в этом прогоне.";
  }
  const parsed = (doc.parsedAnalytics ?? {}) as Record<string, unknown>;
  const summary = String(parsed.executiveSummaryClient ?? "").trim();
  if (summary) return summary.slice(0, 320);
  return `Обработан импорт LexisNexis: ${ctx.lexis.parsedSignals} сигнал(ов), ${ctx.lexis.visualPageCount} визуальная(ых) страниц(ы).`;
}
