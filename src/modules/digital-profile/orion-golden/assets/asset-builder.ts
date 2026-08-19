/**
 * Тип артефакта отчёта (`ReportAssetV1`) — контракт между сборкой ассетов и
 * рендерером.
 *
 * Здесь остались только объявления типов. Прежние построители ассетов
 * («классический» ORION-путь) не вызывались нигде, кроме самого файла, и
 * унесены: последний из них строил сетку изображений по своим правилам —
 * подпись «выделено кадров N» и `evidenceRefs` считались по всему набору, а не
 * по нарисованному, то есть воспроизводили ровно тот дефект, который отчёт
 * чинил в канонической сборке (`services/canonical-visual-assets.ts`).
 */

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
  highlightExplanations?: import("../evidence/highlight-explanation").HighlightExplanation[];
  /**
   * Typed asset metadata for First36 analysis (not provider raw payloads).
   * Prefer this over casting unknown fields onto ReportAssetV1.
   */
  meta?: {
    notKnowledgePanel?: boolean;
    subjectBinding?: "EXACT_SUBJECT" | "WRONG_SUBJECT" | "AMBIGUOUS" | "ABSENT" | string;
    arsenkinTool?: string;
    surface?: string;
    provider?: string;
    tool?: string;
    engine?: string;
    region?: string;
    observationCount?: number;
    capturedAt?: string;
    reportRunId?: string;
    suggestionRows?: string[];
  };
};
