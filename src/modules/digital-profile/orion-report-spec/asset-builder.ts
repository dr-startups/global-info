import type { NormalizedEvidenceV1 } from "./normalized-evidence";
import { riskThemeLabel } from "./normalized-evidence";
import { buildOrionSingleEngineSerpPng } from "./orion-serp-snapshot-builder";
import {
  buildImageGridItems,
  buildImageGridSvg,
  buildKnowledgePanelSvg,
  buildSurfacePanelSvg,
  buildVideoCardsSvg,
  svgToPngBase64,
} from "./media-asset-svg";
import { isSyntheticSerpNoiseHit } from "../serp-observation/filter-synthetic-serp-noise";
import { isClientSafeEvidence } from "./client-safe-evidence";
import {
  assertValidHighlightExplanation,
  isValidSourceDomain,
  resolveFrameTone,
  type HighlightExplanation,
  type HighlightIdentityStatus,
  type HighlightRiskCategory,
} from "./highlight-explanation";

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

/** Client-facing reason why an image cell is red-framed (ORION prose). */
export function explainImageHighlightReason(ev: NormalizedEvidenceV1): string {
  const domain = String(ev.domain ?? extractDomainFromEvidence(ev) ?? "источник").replace(/^www\./i, "");
  const blob = imageEvidenceBlob(ev);
  if (IMAGE_ADVERSE_DOMAIN_RE.test(domain) || IMAGE_ADVERSE_DOMAIN_RE.test(String(ev.url ?? ""))) {
    return `${domain} — домен с компрометирующим, криминальным или санкционным контекстом`;
  }
  if (/санкц|sanction|\bofac\b|под\s+санкц/i.test(blob)) {
    return `${domain} — в контексте кадра есть санкционный сигнал`;
  }
  if (/компромат|rucriminal|cybercriminal|acompromat|нежелат|adverse/i.test(blob)) {
    return `${domain} — компрометирующий / нежелательный медиаконтекст`;
  }
  if (ev.riskTheme === "sanctions_watchlist") {
    return `${domain} — ${riskThemeLabel(ev.riskTheme)}`;
  }
  if (ev.riskTheme === "adverse_media" || ev.riskTheme === "legal_regulatory" || ev.riskTheme === "pep") {
    return `${domain} — ${riskThemeLabel(ev.riskTheme)}`;
  }
  if (ev.reviewStatus === "official_record_found") {
    return `${domain} — официальный/подтверждённый риск-сигнал в выдаче изображений`;
  }
  return `${domain} — отмечен как нежелательный по риск-признакам поисковой выдачи`;
}

function classifyImageIdentity(
  ev: NormalizedEvidenceV1,
  subjectName: string
): HighlightIdentityStatus {
  if (isImageNamesakeNoise(ev, subjectName)) return "namesake";
  const blob = imageEvidenceBlob(ev);
  const hasGiven = blobHasSubjectGiven(blob, subjectName);
  if (hasGiven && /бизнес|businessman|предпринимат|инвестор|investor|nutriband|трансмаш/i.test(blob)) {
    return "likely_subject";
  }
  if (hasGiven) return "likely_subject";
  if (IMAGE_CLASSICAL_NAMESAKE_RE.test(blob)) return "namesake";
  return "unverified";
}

function classifyImageRiskCategory(ev: NormalizedEvidenceV1): HighlightRiskCategory {
  const blob = imageEvidenceBlob(ev);
  if (ev.riskTheme === "pep" || /rupep|pep|политич/i.test(blob)) return "sanctions_pep";
  if (ev.riskTheme === "sanctions_watchlist" || /санкц|sanction|ofac/i.test(blob)) return "sanctions_pep";
  if (ev.riskTheme === "legal_regulatory" || /уголов|criminal|арест|суд/i.test(blob)) return "criminal_legal";
  if (IMAGE_ADVERSE_DOMAIN_RE.test(String(ev.domain ?? ""))) return "adverse_source";
  if (ev.riskTheme === "adverse_media") return "reputational";
  return "unverified";
}

/** Structured highlight for one image cell — never derived from caption splitting. */
export function buildImageHighlightExplanation(
  ev: NormalizedEvidenceV1,
  subjectName: string,
  itemIndex: number
): HighlightExplanation | null {
  const identityStatus = classifyImageIdentity(ev, subjectName);
  const adverseSignal = isImageEvidenceHighlighted(ev);
  const namesake = identityStatus === "namesake";
  if (!adverseSignal && !namesake) return null;

  const domainRaw = String(ev.domain ?? extractDomainFromEvidence(ev) ?? "").replace(/^www\./i, "");
  if (!isValidSourceDomain(domainRaw)) return null;

  const riskCategory = namesake ? "namesake_confusion" : classifyImageRiskCategory(ev);
  const frameTone = resolveFrameTone(identityStatus, adverseSignal || namesake);
  if (frameTone === "none") return null;

  let clientReason: string;
  if (identityStatus === "namesake") {
    clientReason = `${domainRaw} — исторический или однофамильный контекст; риск смешения профилей, не подтверждённый негатив субъекта.`;
  } else if (identityStatus === "unverified") {
    clientReason = `${domainRaw} — совпадение по ФИО; принадлежность субъекту не подтверждена.`;
  } else if (riskCategory === "sanctions_pep") {
    clientReason = `${domainRaw} — карточка или материал с PEP/санкционным контекстом; требуется сверка идентификаторов.`;
  } else if (riskCategory === "criminal_legal") {
    clientReason = `${domainRaw} — публикация с уголовным или судебным контекстом; нужна сверка первоисточника.`;
  } else {
    clientReason = `${domainRaw} — источник с нежелательным контекстом в выдаче изображений; сверить принадлежность субъекту.`;
  }

  const ex: HighlightExplanation = {
    evidenceRef: ev.evidenceRef,
    itemIndex,
    displayLabel: String(ev.title ?? domainRaw).slice(0, 80),
    sourceDomain: domainRaw,
    riskCategory,
    identityStatus,
    clientReason,
    confidence:
      identityStatus === "likely_subject" || identityStatus === "confirmed_subject" ? "medium" : "low",
    frameTone,
  };
  assertValidHighlightExplanation(ex);
  return ex;
}

function extractDomainFromEvidence(ev: NormalizedEvidenceV1): string {
  return String(ev.domain ?? ev.displayUrl ?? "").trim();
}

export type ReportAssetKind =
  | "synthetic_serp"
  | "captured_serp"
  | "live_serp"
  | "image_grid"
  | "video_cards"
  | "knowledge_panel"
  | "surface_panel"
  | "lexis_visual_page"
  | "compliance_visual_page";

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
  /** Structured red/amber frame reasons — never parse from caption. */
  highlightExplanations?: import("./highlight-explanation").HighlightExplanation[];
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

/** Region-neutral image/video/knowledge/surface composite PNGs (`ru_*` / `uae_*`). */
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
    const rank = (pool: NormalizedEvidenceV1[]) =>
      [...pool].sort((a, b) => {
        const sa = imageSubjectScore(a, input.subjectName);
        const sb = imageSubjectScore(b, input.subjectName);
        if (sb !== sa) return sb - sa;
        const ha = isImageEvidenceHighlighted(a) ? 1 : 0;
        const hb = isImageEvidenceHighlighted(b) ? 1 : 0;
        return hb - ha;
      });
    const preferred = rank(filtered.length > 0 ? filtered : images);
    const preferredRefs = new Set(preferred.map((e) => e.evidenceRef));
    const backfill = rank(images.filter((e) => !preferredRefs.has(e.evidenceRef)));
    const maxPages = prefix === "ru" ? 4 : 1;
    const pageSize = 6;
    const ranked = [...preferred, ...backfill].slice(0, maxPages * pageSize);
    for (let page = 0; page < maxPages; page += 1) {
      const chunk = ranked.slice(page * pageSize, page * pageSize + pageSize);
      if (chunk.length === 0) break;
      const explanations: HighlightExplanation[] = [];
      const gridItems = await buildImageGridItems(
        chunk.map((e, idx) => {
          const ex = buildImageHighlightExplanation(e, input.subjectName, idx);
          if (ex) explanations.push(ex);
          const frameTone = ex?.frameTone ?? "none";
          return {
            title: e.title ?? e.domain ?? "Изображение",
            domain: e.domain,
            imageUrl: e.imageUrl,
            highlight: frameTone === "red" || frameTone === "amber",
            frameTone,
            themeLabel:
              frameTone === "amber"
                ? "Требует сверки"
                : frameTone === "red"
                  ? e.riskTheme && e.riskTheme !== "unknown" && e.riskTheme !== "neutral_profile"
                    ? riskThemeLabel(e.riskTheme)
                    : "Нежелательное"
                  : undefined,
          };
        })
      );
      const framed = explanations.filter((x) => x.frameTone === "red" || x.frameTone === "amber");
      const redCount = framed.filter((x) => x.frameTone === "red").length;
      const amberCount = framed.filter((x) => x.frameTone === "amber").length;
      const pageNo = page + 1;
      const assetRef = page === 0 ? `${prefix}_image_grid` : `${prefix}_image_grid_${pageNo}`;
      // Caption is provenance only — never the source of risk reasons.
      const caption =
        framed.length > 0
          ? `Подборка изображений (${label}): выделено кадров ${framed.length} (красных ${redCount}, янтарных ${amberCount}).`
          : `Подборка изображений из поиска по субъекту (${label}). Выделенных кадров на этой странице нет.`;
      assets.push({
        assetRef,
        kind: "image_grid",
        title:
          maxPages > 1
            ? `${label} — изображения в поиске (${pageNo})`
            : `${label} — изображения в поиске`,
        caption,
        imageData: await svgToPngBase64(
          buildImageGridSvg({
            title:
              framed.length > 0
                ? `${label}: изображения — выделенные кадры (${framed.length})`
                : `${label}: изображения в поиске`,
            items: gridItems,
          })
        ),
        evidenceRefs: chunk.map((e) => e.evidenceRef),
        status: "ready",
        highlightExplanations: framed,
      });
    }
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

  const knowledge = input.evidence.filter(
    (e) => e.sourceKind === "knowledge_panel" && isClientSafeEvidence(e)
  );
  if (knowledge.length > 0) {
    // Prefer engine knowledge blocks first; Wikipedia-derived panels fill remaining slots.
    const engineKb = knowledge.filter((e) => e.provider !== "wikipedia");
    const wikiKb = knowledge.filter((e) => e.provider === "wikipedia");
    const ordered = [...engineKb, ...wikiKb];
    const maxKnowledge = prefix === "ru" ? 2 : 1;
    for (let page = 0; page < Math.min(maxKnowledge, ordered.length); page += 1) {
      const k = ordered[page]!;
      const fromWiki = k.provider === "wikipedia";
      const assetRef = page === 0 ? `${prefix}_knowledge_panel` : `${prefix}_knowledge_panel_${page + 1}`;
      assets.push({
        assetRef,
        kind: "knowledge_panel",
        title:
          maxKnowledge > 1
            ? fromWiki
              ? `${label} — Wikipedia (${page + 1})`
              : `${label} — блок знаний (${page + 1})`
            : fromWiki
              ? `${label} — Wikipedia`
              : `${label} — блок знаний`,
        caption: fromWiki
          ? "Справочная карточка на основе проверки Wikipedia"
          : "Справочная панель из поисковой поверхности",
        imageData: await svgToPngBase64(
          buildKnowledgePanelSvg({
            title: k.title ?? (fromWiki ? "Wikipedia" : "Блок знаний"),
            summary: k.snippet ?? k.clientSafeSummary ?? "",
            facts: [k.url, k.domain, k.clientSafeSummary].filter(Boolean).map(String).slice(0, 4),
          })
        ),
        evidenceRefs: [k.evidenceRef],
        status: "ready",
      });
    }
  }

  const allSurface = input.evidence.filter((e) => e.sourceKind === "search_surface");
  const suggestFinal = allSurface.filter((e) => /sf-suggest/i.test(e.evidenceRef));
  const relatedFinal = allSurface.filter((e) => /sf-related/i.test(e.evidenceRef));

  async function pushSurfacePanel(opts: {
    assetRef: string;
    title: string;
    engineLabel?: string;
    items: NormalizedEvidenceV1[];
  }): Promise<void> {
    if (opts.items.length === 0) return;
    const honestCaption =
      opts.engineLabel === "Сохранено"
        ? "Сохранённые строки подсказок; движок Яндекс не подтверждён"
        : opts.engineLabel === "Подсказки"
          ? "Отдельные связанные запросы не сохранены; показан второй набор подсказок"
          : "Визуализация сохранённых строк поисковой поверхности";
    assets.push({
      assetRef: opts.assetRef,
      kind: "surface_panel",
      title: opts.title,
      caption: honestCaption,
      imageData: await svgToPngBase64(
        buildSurfacePanelSvg({
          title: opts.title,
          subtitle: `${opts.items.length} сохранённых строк`,
          engineLabel: opts.engineLabel,
          items: opts.items.slice(0, 10).map((e) => ({
            label: e.title ?? e.snippet ?? e.query ?? e.clientSafeSummary ?? "—",
            meta: e.provider === "yandex" ? "Яндекс" : e.provider === "google" ? "Google" : e.domain,
          })),
        })
      ),
      evidenceRefs: opts.items.slice(0, 10).map((e) => e.evidenceRef),
      status: "ready",
    });
  }

  if (prefix === "ru") {
    const yandexSuggest = suggestFinal.filter((e) => e.provider === "yandex");
    const googleSuggest = suggestFinal.filter((e) => e.provider === "google");
    const otherSuggest = suggestFinal.filter((e) => e.provider !== "yandex" && e.provider !== "google");
    // Prefer real Yandex; otherwise use unlabeled/saved rows with an honest engine label.
    const yandexOrSaved = yandexSuggest.length > 0 ? yandexSuggest : otherSuggest.slice(0, 10);
    await pushSurfacePanel({
      assetRef: "ru_suggestions_yandex",
      title:
        yandexSuggest.length > 0
          ? `${label} — подсказки Яндекс`
          : `${label} — сохранённые подсказки`,
      engineLabel: yandexSuggest.length > 0 ? "Яндекс" : "Сохранено",
      items: yandexOrSaved,
    });
    await pushSurfacePanel({
      assetRef: "ru_suggestions_google",
      title: `${label} — подсказки Google`,
      engineLabel: "Google",
      items: googleSuggest.slice(0, 10),
    });
    const relatedCount = relatedFinal.length;
    const relatedPageSize = relatedCount > 0 ? Math.max(1, Math.ceil(relatedCount / 3)) : 0;
    for (let i = 0; i < 3; i += 1) {
      const chunk = relatedFinal.slice(i * relatedPageSize, i * relatedPageSize + relatedPageSize);
      if (chunk.length === 0) continue;
      await pushSurfacePanel({
        assetRef: `ru_related_${i + 1}`,
        title: `${label} — связанные запросы (${i + 1})`,
        items: chunk,
      });
    }
    const firstRelated = assets.find((a) => a.assetRef === "ru_related_1");
    if (firstRelated) {
      assets.push({ ...firstRelated, assetRef: "ru_related" });
    }
  } else {
    await pushSurfacePanel({
      assetRef: "uae_suggestions",
      title: `${label} — подсказки поиска`,
      engineLabel: "Google",
      items: suggestFinal.slice(0, 10),
    });
    const relatedIsSecondary = relatedFinal.some((e) => /related-alt/i.test(e.evidenceRef));
    await pushSurfacePanel({
      assetRef: "uae_related",
      title: relatedIsSecondary
        ? `${label} — дополнительные подсказки поиска`
        : `${label} — связанные запросы`,
      engineLabel: relatedIsSecondary ? "Подсказки" : "Google",
      items: relatedFinal.slice(0, 10),
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
