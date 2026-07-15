/**
 * R10.2 — Central client-facing text sanitizer for ORION Golden deck/report output.
 */

const RISK_LEVEL_LABELS: Record<string, string> = {
  review_required: "Требует ручной проверки",
  requires_review: "Требует ручной проверки",
  manual_review: "Требует ручной проверки",
  unknown: "Требует уточнения",
  no_data: "Недостаточно данных",
  low: "Низкий уровень",
  medium: "Средний уровень",
  high: "Высокий уровень",
  critical: "Критический уровень",
};

const THEME_LABELS: Record<string, string> = {
  risk: "Риск требует оценки",
  // Keep PEP as acronym in running text — long nominative phrase breaks Russian cases.
  pep: "PEP",
  adverse_media: "негативные публикации",
  compliance: "комплаенс",
  sanctions_watchlist: "санкционные списки",
  legal_regulatory: "правовые и регуляторные риски",
  corporate_ownership: "корпоративная структура",
  identity_profile: "идентификационный профиль",
  neutral_profile: "нейтральный профиль",
  excluded_from_risk: "исключено из оценки риска",
  confirmed: "подтверждено",
  likely: "вероятное совпадение",
};

const VERIFICATION_LABELS: Record<string, string> = {
  requires_review: "Требует ручной проверки",
  confirmed: "Подтверждено",
  likely: "Вероятное совпадение",
  excluded_from_risk: "Исключено из оценки риска",
};

/** Raw tokens that must never appear in client-facing ORION Golden text. */
export const ORION_GOLDEN_FORBIDDEN_RAW_TOKENS = [
  "review_required",
  "requires_review",
  "manual_review",
  "unknown",
  "fallback",
  "mock",
  "debug",
  "manifest",
  "micro-stage",
  "micro_stage",
  "localhost",
  "storage/",
  "/app/",
  "evidence_",
  "openai",
  "deterministic",
  "storagekey",
  "no_data",
  "excluded_noise",
  "strong_relevant",
  "potentially_relevant",
  "weak_match",
] as const;

const ENUM_TOKEN_PATTERN = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi;

const ALLOWED_SNAKE_TOKENS = new Set(["lexis_nexis"]);

function replaceMappedToken(raw: string, map: Record<string, string>): string {
  const key = raw.toLowerCase();
  return map[key] ?? raw;
}

export function humanizeRiskLevel(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return RISK_LEVEL_LABELS.review_required;
  const key = raw.toLowerCase().replace(/\s+/g, "_");
  if (RISK_LEVEL_LABELS[key]) return RISK_LEVEL_LABELS[key];
  if (["низк", "low"].some((k) => key.includes(k))) return RISK_LEVEL_LABELS.low;
  if (["средн", "medium", "moderate"].some((k) => key.includes(k))) return RISK_LEVEL_LABELS.medium;
  if (["высок", "high", "elevated"].some((k) => key.includes(k))) return RISK_LEVEL_LABELS.high;
  if (["крит", "critical"].some((k) => key.includes(k))) return RISK_LEVEL_LABELS.critical;
  if (["провер", "review", "manual"].some((k) => key.includes(k))) return RISK_LEVEL_LABELS.review_required;
  if (["уточн", "unknown"].some((k) => key.includes(k))) return RISK_LEVEL_LABELS.unknown;
  return RISK_LEVEL_LABELS.review_required;
}

export function humanizeRiskTheme(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return THEME_LABELS.risk;
  const key = raw.toLowerCase().replace(/\s+/g, "_");
  if (THEME_LABELS[key]) return THEME_LABELS[key];
  if (/^риск$/i.test(raw)) return THEME_LABELS.risk;
  if (/pep|политическ/.test(key)) return THEME_LABELS.pep;
  if (/adverse|негатив/.test(key)) return THEME_LABELS.adverse_media;
  if (/compliance|комплаенс/.test(key)) return THEME_LABELS.compliance;
  if (/sanction|санкц/.test(key)) return THEME_LABELS.sanctions_watchlist;
  return raw.replace(/_/g, " ").replace(/\s+/g, " ").trim() || THEME_LABELS.risk;
}

export function humanizeVerificationStatus(value: unknown): string {
  const key = String(value ?? "").trim().toLowerCase();
  return VERIFICATION_LABELS[key] ?? humanizeRiskLevel(key);
}

function stripTechnicalSnippets(text: string): string {
  return text
    .replace(/\bcmr[a-z0-9]{10,}\b/gi, "")
    .replace(/\borion_[a-z0-9_]+\b/gi, "")
    .replace(/\b[a-z]+_rf-[a-z0-9_-]+\b/gi, "")
    .replace(/\bC:\\[^\s]+/gi, "")
    .replace(/\b\/mnt\/[^\s]+/gi, "")
    .replace(/\bstorage\/[^\s]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Strip obfuscated / impossible profile fields that leak into client cards
 * (e.g. RuPEP «Категория: Aячцжмтщш», «Гражданство: Еяцюмэл», «Дата рождения: 11.55.1840»).
 */
export function sanitizeOrionGoldenEvidenceSnippet(text: string): string {
  if (!text) return "";
  let out = sanitizeOrionGoldenClientText(text);

  // Category labels on aggregator cards are often cipher/OCR garbage — never show raw.
  out = out.replace(/(?:Категория|Category|Сategory)\s*:\s*[^\n·•|;]{1,64}/gi, "");

  // Citizenship / residence / birthplace: keep only recognizable geo labels.
  const GEO_OK =
    /росси|russia|рф\b|молдав|moldova|украин|ukraine|беларус|belarus|москв|moscow|санкт|петербург|cyprus|кипр|uae|оаэ|dubai|дубай|london|лондон|switzerland|швейцар|austria|австр|germany|герман|france|франц|israel|израил|china|кита|usa|сша|united\s+states|великобритан|britain|\buk\b|казах|kazakhstan|итал|italy|испан|spain|турц|turkey|грузи|georgia|армен|armenia|азербайдж|azerbaijan/i;
  out = out.replace(
    /(?:Гражданство|Citizen(?:ship)?|Прожива(?:ет|ние)|Resident(?:ce)?|Место рождения|Place of birth)\s*:\s*[^\n·•|;]{1,64}/gi,
    (m) => {
      const val = m.split(":").slice(1).join(":").trim();
      return GEO_OK.test(val) ? m : "";
    }
  );
  // Trailing «Имеет …» / «Has …» cipher tails on RuPEP cards
  out = out.replace(/(?:Имеет|Has)\s+[^\n·•|;]{1,48}/gi, (m) => (GEO_OK.test(m) ? m : ""));

  let droppedInvalidDob = false;
  out = out.replace(
    /(?:Дата рождения|Date of birth|DOB)\s*:\s*[^\n·•|;]{1,64}/gi,
    (m) => {
      const dm = m.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
      if (!dm) {
        droppedInvalidDob = true;
        return "";
      }
      const day = Number(dm[1]);
      const month = Number(dm[2]);
      const year = Number(dm[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1920 || year > 2015) {
        droppedInvalidDob = true;
        return "";
      }
      return m;
    }
  );

  // If DOB was garbage, paired taxpayer fields on the same obfuscated card are untrusted.
  if (droppedInvalidDob) {
    out = out.replace(
      /(?:ИНН|INN|Individual Taxpayer(?:\s+Number)?)\s*:?\s*[^\n·•|;]{0,40}/gi,
      ""
    );
  } else {
    out = out.replace(
      /(?:ИНН|INN|Individual Taxpayer(?:\s+Number)?)\s*:\s*[^\n·•|;]{1,40}/gi,
      (m) => {
        const digits = (m.match(/\d{10,12}/) ?? [])[0];
        if (!digits || !/^\d{10}$|^\d{12}$/.test(digits)) return "";
        return m;
      }
    );
  }

  // Drop any remaining labeled field whose value looks like keyboard-cipher mash.
  out = out.replace(
    /([A-Za-zА-Яа-яЁё][^:\n·•|;]{0,24}:\s*)([^\n·•|;]{3,48})/g,
    (full, label, val) => {
      const letters = String(val).replace(/[^A-Za-zА-Яа-яЁё]/g, "");
      if (letters.length < 5) return full;
      if (GEO_OK.test(val) || /\d{4}/.test(val)) return full;
      const vowels = (letters.match(/[аеиоуыэюяaeiouyё]/gi) ?? []).length;
      const vowelRatio = vowels / letters.length;
      const cyrCluster = /[бвгджзклмнпрстфхцчшщъь]{4,}/i.test(letters);
      const latCluster = /[bcdfghjklmnpqrstvwxz]{5,}/i.test(letters);
      const mixedScript = /[A-Za-z]{2,}/.test(letters) && /[А-Яа-яЁё]{2,}/.test(letters);
      if (vowelRatio < 0.2 || cyrCluster || latCluster || mixedScript) return "";
      return full;
    }
  );

  return out
    .replace(/\s*[·•|;]\s*[·•|;]\s*/g, " · ")
    .replace(/^[·•|;,\s]+|[·•|;,\s]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function sanitizeOrionGoldenClientText(text: string): string {
  if (!text) return "";

  let out = text;
  // Do not replace tokens that are part of a hyphen/slash compound
  // (e.g. "compliance-рисков" must not become "Комплаенс-проверка-рисков").
  for (const [key, label] of Object.entries({ ...RISK_LEVEL_LABELS, ...THEME_LABELS, ...VERIFICATION_LABELS })) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b(?![-/])`, "gi");
    out = out.replace(pattern, label);
  }
  // Prefer natural Russian compounds over broken enum leftovers.
  out = out
    .replace(/\bcompliance[-/]риск/gi, "комплаенс-риск")
    .replace(/\bcompliance[-/]вывод/gi, "комплаенс-вывод")
    .replace(/\bcompliance[-/]баз/gi, "комплаенс-баз")
    .replace(/\bcompliance[-/]команд/gi, "комплаенс-команд")
    .replace(/\bcompliance[-/]систем/gi, "комплаенс-систем")
    .replace(/\bcompliance[-/]сигнал/gi, "комплаенс-сигнал")
    .replace(/\bcompliance[-/]процедур/gi, "комплаенс-процедур")
    .replace(/комплаенс-проверка-(?=процедур|статус|сигнал|баз)/gi, "комплаенс-")
    .replace(/публичное должностное лицо-(?=статус|сигнал|проверк)/gi, "PEP-")
    .replace(/сигналы публичное должностное лицо/gi, "сигналы PEP")
    .replace(/\badverse[-/]media\b/gi, THEME_LABELS.adverse_media)
    .replace(/\bCAVEATED[_\s-]?ANALYSIS\b/gi, "анализ с оговоркой")
    .replace(/\bCONTROVERSIAL[_\s-]?DUAL[_\s-]?USE\b/gi, "спорный / двойной контекст")
    .replace(/\bAPPENDIX[_\s-]?ONLY\b/gi, "только в приложении")
    .replace(/\bDISMISSED\b/gi, "снято с рассмотрения")
    .replace(/\bCORPORATE[_\s-]?REGISTRY\b/gi, "корпоративный реестр")
    .replace(/\bUNCLASSIFIED\b/gi, "без классификации");

  out = out.replace(ENUM_TOKEN_PATTERN, (hit) => {
    const lower = hit.toLowerCase();
    if (ALLOWED_SNAKE_TOKENS.has(lower)) return hit;
    if (RISK_LEVEL_LABELS[lower]) return RISK_LEVEL_LABELS[lower];
    if (THEME_LABELS[lower]) return THEME_LABELS[lower];
    if (VERIFICATION_LABELS[lower]) return VERIFICATION_LABELS[lower];
    if (lower.includes("review")) return RISK_LEVEL_LABELS.review_required;
    if (lower.includes("risk")) return THEME_LABELS.risk;
    return hit.replace(/_/g, " ");
  });

  return stripTechnicalSnippets(out);
}

export function scanOrionGoldenClientTextForForbiddenTokens(text: string): string[] {
  const issues = new Set<string>();
  const lower = text.toLowerCase();

  for (const token of ORION_GOLDEN_FORBIDDEN_RAW_TOKENS) {
    if (lower.includes(token.toLowerCase())) issues.add(`forbidden:${token}`);
  }

  if (/\bcmr[a-z0-9]{10,}\b/i.test(text)) issues.add("forbidden:raw-case-id");

  const enumHits = text.match(ENUM_TOKEN_PATTERN) ?? [];
  for (const hit of enumHits) {
    const h = hit.toLowerCase();
    if (ALLOWED_SNAKE_TOKENS.has(h)) continue;
    if (/^https?:\/\//i.test(hit)) continue;
    if (h.includes("example") || h.includes("gosuslugi")) continue;
    issues.add(`raw-enum:${hit}`);
  }

  return [...issues];
}
