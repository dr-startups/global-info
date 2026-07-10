import type { NormalizedEvidenceV1 } from "./normalized-evidence";
import { buildOrionSingleEngineSerpPng } from "./orion-serp-snapshot-builder";
import {
  buildImageGridItems,
  buildImageGridSvg,
  buildKnowledgePanelSvg,
  buildVideoCardsSvg,
  svgToPngBase64,
} from "./media-asset-svg";

export type ReportAssetKind =
  | "synthetic_serp"
  | "captured_serp"
  | "live_serp"
  | "image_grid"
  | "video_cards"
  | "knowledge_panel"
  | "lexis_visual_page";

export type ReportAssetV1 = {
  assetRef: string;
  kind: ReportAssetKind;
  title: string;
  caption?: string;
  imageData?: string;
  imageUrl?: string;
  evidenceRefs: string[];
  status: "ready" | "missing";
  /** LIVE SERP capture metadata (optional). */
  geoStatus?: "VERIFIED" | "UNVERIFIED" | "UNKNOWN";
  connectionMode?: "PROXY" | "DIRECT";
  captureId?: string;
};

async function buildProviderSerpAsset(input: {
  assetRef: "ru_yandex_serp_snapshot" | "ru_google_serp_snapshot";
  provider: "yandex" | "google";
  query: string;
  subjectName: string;
  evidence: NormalizedEvidenceV1[];
}): Promise<ReportAssetV1> {
  const title = input.provider === "yandex" ? "Яндекс — поисковая выдача" : "Google — поисковая выдача";
  const rows = input.evidence.filter(
    (e) => e.sourceKind === "search_result" && e.provider === input.provider
  );
  if (rows.length === 0) {
    return {
      assetRef: input.assetRef,
      kind: "synthetic_serp",
      title,
      status: "missing",
      evidenceRefs: [],
    };
  }
  const png = await buildOrionSingleEngineSerpPng({
    provider: input.provider,
    query: input.query,
    subjectName: input.subjectName,
    evidence: rows,
  });
  if (!png) {
    return {
      assetRef: input.assetRef,
      kind: "synthetic_serp",
      title,
      status: "missing",
      evidenceRefs: [],
    };
  }
  return {
    assetRef: input.assetRef,
    kind: "synthetic_serp",
    title,
    caption: `Запрос: ${input.query}`,
    imageData: png.toString("base64"),
    evidenceRefs: rows.slice(0, 8).map((r) => r.evidenceRef),
    status: "ready",
  };
}

export async function buildRuSearchAssets(input: {
  subjectName: string;
  evidence: NormalizedEvidenceV1[];
}): Promise<ReportAssetV1[]> {
  const query =
    input.evidence.find((e) => e.query)?.query ?? `${input.subjectName} биография`;
  const assets: ReportAssetV1[] = [];

  assets.push(
    await buildProviderSerpAsset({
      assetRef: "ru_yandex_serp_snapshot",
      provider: "yandex",
      query,
      subjectName: input.subjectName,
      evidence: input.evidence,
    })
  );
  assets.push(
    await buildProviderSerpAsset({
      assetRef: "ru_google_serp_snapshot",
      provider: "google",
      query,
      subjectName: input.subjectName,
      evidence: input.evidence,
    })
  );

  const images = input.evidence.filter((e) => e.sourceKind === "image_result");
  if (images.length > 0) {
    const gridItems = await buildImageGridItems(
      images.slice(0, 6).map((e) => ({
        title: e.title ?? e.domain ?? "Изображение",
        domain: e.domain,
        imageUrl: e.imageUrl,
      }))
    );
    assets.push({
      assetRef: "ru_image_grid",
      kind: "image_grid",
      title: "Изображения в поиске",
      imageData: await svgToPngBase64(buildImageGridSvg({ title: "Изображения в поиске", items: gridItems })),
      evidenceRefs: images.slice(0, 6).map((e) => e.evidenceRef),
      status: "ready",
    });
  }

  const videos = input.evidence.filter((e) => e.sourceKind === "video_result");
  if (videos.length > 0) {
    assets.push({
      assetRef: "ru_video_cards",
      kind: "video_cards",
      title: "Видео в поиске",
      imageData: await svgToPngBase64(
        buildVideoCardsSvg({
          title: "Видео в поиске",
          items: videos.slice(0, 4).map((e) => ({
            label: e.title ?? "Видео",
            domain: e.domain,
            context: e.snippet?.slice(0, 120),
          })),
        })
      ),
      evidenceRefs: videos.slice(0, 4).map((e) => e.evidenceRef),
      status: "ready",
    });
  }

  const knowledge = input.evidence.filter((e) => e.sourceKind === "knowledge_panel");
  if (knowledge.length > 0) {
    const k = knowledge[0]!;
    assets.push({
      assetRef: "ru_knowledge_panel",
      kind: "knowledge_panel",
      title: "Блок знаний",
      imageData: await svgToPngBase64(
        buildKnowledgePanelSvg({
          title: k.title ?? "Блок знаний",
          summary: k.snippet ?? k.clientSafeSummary ?? "",
          facts: knowledge.slice(0, 4).map((e) => e.title ?? e.snippet ?? "").filter(Boolean),
        })
      ),
      evidenceRefs: knowledge.slice(0, 4).map((e) => e.evidenceRef),
      status: "ready",
    });
  }

  return assets;
}

export async function buildReportAssets(input: {
  subjectName: string;
  ruSearchEvidence: NormalizedEvidenceV1[];
}): Promise<ReportAssetV1[]> {
  return buildRuSearchAssets({ subjectName: input.subjectName, evidence: input.ruSearchEvidence });
}
