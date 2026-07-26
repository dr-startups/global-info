export type EvidenceSourceKind =
  | "search_result"
  | "search_surface"
  | "synthetic_serp"
  | "image_result"
  | "video_result"
  | "knowledge_panel"
  | "wikipedia"
  | "compliance"
  | "lexisnexis"
  | "manual";

export type EvidenceProvider = "yandex" | "google" | "serper" | "wikipedia" | "lexisnexis" | "manual";

export type EvidenceLocale = "ru" | "en" | "uae" | "intl";

export type EvidenceRiskTheme =
  | "sanctions_watchlist"
  | "adverse_media"
  | "pep"
  | "legal_regulatory"
  | "corporate_ownership"
  | "identity_profile"
  | "neutral_profile"
  | "unknown";

export type EvidenceReviewStatus =
  | "official_record_found"
  | "requires_review"
  | "confirmed_low_risk"
  | "excluded_noise"
  | "not_available";

export type NormalizedEvidenceV1 = {
  evidenceRef: string;
  sectionKey: string;
  sourceKind: EvidenceSourceKind;
  provider?: EvidenceProvider;
  title?: string;
  domain?: string;
  url?: string;
  displayUrl?: string;
  snippet?: string;
  imageUrl?: string;
  screenshotRef?: string;
  visualRef?: string;
  query?: string;
  locale?: EvidenceLocale;
  riskTheme?: EvidenceRiskTheme;
  reviewStatus: EvidenceReviewStatus;
  confidence?: number;
  sourceLabel: string;
  clientSafeSummary?: string;
  createdAt?: string;
  /** Typed identity binding when known (Wikipedia / entity match). */
  subjectBinding?:
    | "CONFIRMED_SUBJECT"
    | "PROBABLE_SUBJECT"
    | "AMBIGUOUS"
    | "WRONG_SUBJECT"
    | "UNRESOLVED";
};

export const FORBIDDEN_CLIENT_TERMS = [
  "mock",
  "fallback",
  "provider",
  "runtime",
  "debug",
  "manifest",
  "micro-stage",
  "ORION_STATIC",
  "COMMERCIAL_CONTEXT",
  "compliance_db_correction",
  "storage/",
  "C:\\",
  "/mnt/",
  "OPENAI_API_KEY",
  "rawPrompt",
  "rawModelResponse",
] as const;

export function stableEvidenceRef(sectionKey: string, suffix: string): string {
  const base = `${sectionKey}-${suffix}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
  return base;
}

export function stripProtocol(url: string | undefined | null): string {
  const value = String(url ?? "").trim();
  if (!value) return "";
  return value.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
}

export function extractDomain(url: string | undefined | null, fallback?: string | null): string {
  const fromFallback = String(fallback ?? "").trim().replace(/^www\./i, "").toLowerCase();
  const raw = String(url ?? "").trim();
  if (!raw && fromFallback) return fromFallback;
  try {
    const normalized = raw.startsWith("http") ? raw : `https://${raw}`;
    const host = new URL(normalized).hostname.replace(/^www\./i, "").toLowerCase();
    return host || fromFallback;
  } catch {
    const stripped = stripProtocol(raw).split("/")[0]?.toLowerCase() ?? "";
    return stripped || fromFallback;
  }
}

export function mapRiskTheme(raw: unknown): EvidenceRiskTheme {
  const val = String(raw ?? "").toLowerCase();
  if (!val) return "unknown";
  if (/sanction|watchlist|ofac|sdn/.test(val)) return "sanctions_watchlist";
  if (/adverse|negative|reputational|undesirable/.test(val)) return "adverse_media";
  if (/pep|politic/.test(val)) return "pep";
  if (/legal|regulator|court|litigation/.test(val)) return "legal_regulatory";
  if (/owner|corporate|company|ubo/.test(val)) return "corporate_ownership";
  if (/identity|profile|bio|wikipedia/.test(val)) return "identity_profile";
  if (/neutral|low|irrelevant|namesake/.test(val)) return "neutral_profile";
  return "unknown";
}

export function mapReviewStatus(input: {
  classification?: string | null;
  reviewStatus?: string | null;
  sourceKind?: EvidenceSourceKind;
}): EvidenceReviewStatus {
  const review = String(input.reviewStatus ?? "").toUpperCase();
  const cls = String(input.classification ?? "").toLowerCase();
  if (input.sourceKind === "manual" && cls === "not_available") return "not_available";
  if (/MATCH_CONFIRMED|REVIEWED/.test(review) && /adverse|sanction|pep|legal|confirmed/.test(cls)) {
    return "official_record_found";
  }
  if (/FALSE_POSITIVE|DISMISSED|EXCLUDED|NOISE|IRRELEVANT|DUPLICATE/.test(review + cls)) {
    return "excluded_noise";
  }
  if (/PENDING|REQUIRES|REVIEW|UNCERTAIN/.test(review)) return "requires_review";
  if (/confirmed_low|low_risk|neutral/.test(cls)) return "confirmed_low_risk";
  if (/potential|neutral/.test(cls)) return "requires_review";
  return "requires_review";
}

export function clientSourceLabel(provider?: EvidenceProvider, sourceKind?: EvidenceSourceKind): string {
  if (sourceKind === "wikipedia") return "Wikipedia";
  if (sourceKind === "compliance") return "База комплаенс-проверки";
  if (sourceKind === "lexisnexis") return "LexisNexis";
  if (provider === "yandex") return "Яндекс";
  if (provider === "google") return "Google";
  if (sourceKind === "image_result") return "Поиск изображений";
  if (sourceKind === "video_result") return "Поиск видео";
  if (sourceKind === "knowledge_panel") return "Блок знаний";
  if (sourceKind === "synthetic_serp") return "Снимок поисковой выдачи";
  return "Открытые источники";
}

export function riskThemeLabel(theme: EvidenceRiskTheme | undefined): string {
  switch (theme) {
    case "sanctions_watchlist":
      return "Санкционные / watchlist сигналы";
    case "adverse_media":
      return "Негативные публикации";
    case "pep":
      return "PEP / политическая экспозиция";
    case "legal_regulatory":
      return "Правовые / регуляторные сигналы";
    case "corporate_ownership":
      return "Корпоративная структура";
    case "identity_profile":
      return "Публичный профиль";
    case "neutral_profile":
      return "Нейтральный профиль";
    default:
      return "Требует ручной проверки";
  }
}

export function reviewStatusLabel(status: EvidenceReviewStatus): string {
  switch (status) {
    case "official_record_found":
      return "Подтверждённый сигнал";
    case "requires_review":
      return "Требует ручной проверки";
    case "confirmed_low_risk":
      return "Низкий риск";
    case "excluded_noise":
      return "Исключено как шум";
    case "not_available":
      return "Данные недоступны";
    default:
      return "Требует ручной проверки";
  }
}
