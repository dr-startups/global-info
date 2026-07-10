import type { NormalizedEvidenceV1 } from "./normalized-evidence";
import { riskThemeLabel } from "./normalized-evidence";
import { buildOrionSingleEngineSerpPng } from "./orion-serp-snapshot-builder";
import {
  buildImageGridItems,
  buildImageGridSvg,
  buildKnowledgePanelSvg,
  buildVideoCardsSvg,
  svgToPngBase64,
} from "./media-asset-svg";
import { isSyntheticSerpNoiseHit } from "../serp-observation/filter-synthetic-serp-noise";

const IMAGE_ADVERSE_DOMAIN_RE =
  /rucriminal\.|cybercriminal\.|acompromat\.|rucompromat\.|compromat\.|rupep\.|opensanctions\.|ofac\.|justice\.gov|home\.treasury\.gov|vlasti\.|rumafia\.|dossier\.|kompromat\./i;
const IMAGE_SOFT_PROFILE_DOMAIN_RE =
  /forbes\.|klerk\.|tadviser\.|wikipedia\.|linkedin\.|rusprofile\.|audit-it\.|zachestnyibiznes\.|labyrinth\.|instagram\.|facebook\.|x\.com|twitter\.|youtube\.|amazon\./i;
const IMAGE_STRONG_ADVERSE_BLOB_RE =
  /adverse|undesirable|нежелат|негативн|санкц|sanction(?:ed|s)?|\bofac\b|корруп|corrupt|мошен|fraud|арест|arrest|уголов|\bcriminal\b|компромат|rucriminal|cybercriminal|acompromat|rupep|махмудов|makhmudov|бокарев|bokarev|defense\s+industry|оборонн|oligarch|олигарх|associate of sanction|под\s+санкц|\$100|dollar bills|пачк[аи]\s+(?:долларов|денег)/i;
/** Classical / composer / album noise for businessman subjects (Mikhail Glinka bleed). */
const IMAGE_CLASSICAL_NAMESAKE_RE =
  /choir|хор\b|chamber music|piano concerto|lyapunov|ляпунов|bolshoi|discogs|imslp|allmusic|russia sings|anthem of moscow|classicalarchives|симфон|оперн|композитор|sheet\s*music|leningrad\s+choir/i;

function imageEvidenceBlob(ev: NormalizedEvidenceV1): string {
  return `${ev.title ?? ""} ${ev.snippet ?? ""} ${ev.clientSafeSummary ?? ""} ${ev.domain ?? ""} ${ev.displayUrl ?? ""} ${ev.url ?? ""} ${ev.imageUrl ?? ""}`;
}

function subjectGivenName(subjectName: string): string {
  return subjectName.trim().split(/\s+/).filter(Boolean)[1] ?? "";
}

function blobHasSubjectGiven(blob: string, subjectName: string): boolean {
  const given = subjectGivenName(subjectName);
  if (!given || given.length < 2) return true;
  const latin = given
    .replace(/ё/gi, "e")
    .replace(/й/gi, "y")
    .replace(/сергей/i, "sergey|sergei|sergej")
    .replace(/михаил/i, "mikhail|michael");
  // Cyrillic given OR common latin forms for Сергей
  if (new RegExp(given.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(blob)) return true;
  if (/сергей/i.test(given) && /sergey|sergei|sergej/i.test(blob)) return true;
  if (/михаил/i.test(given) && /mikhail|michael/i.test(blob)) return true;
  void latin;
  return false;
}

/** Composer / classical / wrong-person image noise for the audit subject. */
export function isImageNamesakeNoise(ev: NormalizedEvidenceV1, subjectName: string): boolean {
  const blob = imageEvidenceBlob(ev);
  if (
    isSyntheticSerpNoiseHit(
      {
        title: ev.title ?? "",
        url: String(ev.url ?? ev.displayUrl ?? ""),
        snippet: ev.snippet ?? "",
        domain: ev.domain ?? "",
      },
      subjectName
    )
  ) {
    return true;
  }
  if (IMAGE_CLASSICAL_NAMESAKE_RE.test(blob) && !blobHasSubjectGiven(blob, subjectName)) {
    return true;
  }
  // YouTube/Amazon classical albums mentioning only surname Glinka
  const domain = String(ev.domain ?? "");
  if (/youtube\.|amazon\./i.test(domain) && IMAGE_CLASSICAL_NAMESAKE_RE.test(blob)) {
    return true;
  }
  return false;
}

function imageSubjectScore(ev: NormalizedEvidenceV1, subjectName: string): number {
  const blob = imageEvidenceBlob(ev);
  let score = 0;
  if (blobHasSubjectGiven(blob, subjectName)) score += 4;
  if (isImageEvidenceHighlighted(ev)) score += 5;
  if (/nutriband|бизнес|businessman|предпринимат|инвестор|investor|биограф/i.test(blob)) score += 2;
  if (/vlasti\.|rucriminal\.|acompromat\.|rupep\./i.test(blob)) score += 3;
  if (isImageNamesakeNoise(ev, subjectName)) score -= 10;
  if (ev.imageUrl) score += 1;
  return score;
}

/** Risk gate for image-search cells — red frame when domain/blob/theme is adverse. */
export function isImageEvidenceHighlighted(ev: NormalizedEvidenceV1): boolean {
  if (ev.reviewStatus === "excluded_noise") return false;
  const domain = String(ev.domain ?? ev.displayUrl ?? "");
  const url = String(ev.url ?? ev.displayUrl ?? ev.domain ?? "");
  const blob = imageEvidenceBlob(ev);
  if (IMAGE_ADVERSE_DOMAIN_RE.test(domain) || IMAGE_ADVERSE_DOMAIN_RE.test(url)) return true;
  if (IMAGE_STRONG_ADVERSE_BLOB_RE.test(blob)) return true;
  if (
    ev.reviewStatus === "official_record_found" ||
    ev.riskTheme === "adverse_media" ||
    ev.riskTheme === "sanctions_watchlist" ||
    ev.riskTheme === "pep" ||
    ev.riskTheme === "legal_regulatory"
  ) {
    // Soft bio hosts still need a strong blob unless theme is already adverse.
    if (IMAGE_SOFT_PROFILE_DOMAIN_RE.test(domain) && ev.riskTheme === "neutral_profile") {
      return false;
    }
    return true;
  }
  return false;
}

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
  /** Private-storage key for renderer DATA_ROOT reload when inline imageData is omitted. */
  storageKey?: string;
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

  const media = await buildRegionMediaComposites({
    subjectName: input.subjectName,
    evidence: input.evidence,
    regionPrefix: "ru",
    regionLabel: "Россия",
  });
  assets.push(...media);

  return assets;
}

/** Region-neutral image/video/knowledge composite PNGs (`ru_*` / `uae_*`). */
export async function buildRegionMediaComposites(input: {
  subjectName: string;
  evidence: NormalizedEvidenceV1[];
  regionPrefix: "ru" | "uae";
  regionLabel: string;
}): Promise<ReportAssetV1[]> {
  const assets: ReportAssetV1[] = [];
  const prefix = input.regionPrefix;
  const label = input.regionLabel;

  const images = input.evidence.filter((e) => e.sourceKind === "image_result");
  if (images.length > 0) {
    const filtered = images.filter((e) => !isImageNamesakeNoise(e, input.subjectName));
    const pool = filtered.length > 0 ? filtered : images;
    const ranked = [...pool].sort((a, b) => {
      const sa = imageSubjectScore(a, input.subjectName);
      const sb = imageSubjectScore(b, input.subjectName);
      if (sb !== sa) return sb - sa;
      const ha = isImageEvidenceHighlighted(a) ? 1 : 0;
      const hb = isImageEvidenceHighlighted(b) ? 1 : 0;
      return hb - ha;
    });
    const gridItems = await buildImageGridItems(
      ranked.slice(0, 6).map((e) => {
        const highlight = isImageEvidenceHighlighted(e);
        return {
          title: e.title ?? e.domain ?? "Изображение",
          domain: e.domain,
          imageUrl: e.imageUrl,
          highlight,
          themeLabel: highlight
            ? e.riskTheme && e.riskTheme !== "unknown" && e.riskTheme !== "neutral_profile"
              ? riskThemeLabel(e.riskTheme)
              : /санкц|sanction/i.test(imageEvidenceBlob(e))
                ? "Санкции"
                : "Нежелательное"
            : undefined,
        };
      })
    );
    const adverseCount = gridItems.filter((g) => g.highlight).length;
    assets.push({
      assetRef: `${prefix}_image_grid`,
      kind: "image_grid",
      title: `${label} — изображения в поиске`,
      caption:
        adverseCount > 0
          ? `Нежелательные изображения отмечены красной рамкой (${adverseCount})`
          : "Поисковая выдача по изображениям",
      imageData: await svgToPngBase64(
        buildImageGridSvg({
          title:
            adverseCount > 0
              ? `${label}: изображения — нежелательные отмечены (${adverseCount})`
              : `${label}: изображения в поиске`,
          items: gridItems,
        })
      ),
      evidenceRefs: ranked.slice(0, 6).map((e) => e.evidenceRef),
      status: "ready",
    });
  }

  const videos = input.evidence.filter((e) => e.sourceKind === "video_result");
  if (videos.length > 0) {
    assets.push({
      assetRef: `${prefix}_video_cards`,
      kind: "video_cards",
      title: `${label} — видео в поиске`,
      imageData: await svgToPngBase64(
        buildVideoCardsSvg({
          title: `${label}: видео в поиске`,
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
      assetRef: `${prefix}_knowledge_panel`,
      kind: "knowledge_panel",
      title: `${label} — блок знаний`,
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
  uaeSearchEvidence?: NormalizedEvidenceV1[];
}): Promise<ReportAssetV1[]> {
  const ru = await buildRuSearchAssets({
    subjectName: input.subjectName,
    evidence: input.ruSearchEvidence,
  });
  const uae =
    input.uaeSearchEvidence && input.uaeSearchEvidence.length > 0
      ? await buildRegionMediaComposites({
          subjectName: input.subjectName,
          evidence: input.uaeSearchEvidence,
          regionPrefix: "uae",
          regionLabel: "ОАЭ",
        })
      : [];
  return [...ru, ...uae];
}
