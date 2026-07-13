/**
 * Centralized client-language sanitizer for First36 slides.
 * Removes internal pipeline jargon from client-facing text.
 */

const INTERNAL_TOKEN_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bidentity\b/gi, "сверка личности"],
  [/\brelated\b/gi, "связанные запросы"],
  [/\bcompliance\b/gi, "комплаенс-проверка"],
  [/\bsanctions\s*\/\s*watchlist\b/gi, "санкционный / наблюдательный список"],
  [/\bwatchlist\b/gi, "наблюдательный список"],
  [/\bsanctions\b/gi, "санкции"],
  [/\bWRONG[_\s-]?SUBJECT\b/gi, "другой субъект"],
  [/\bAMBIGUOUS\b/gi, "неоднозначно"],
  [/\bCONFIRMED[_\s-]?SUBJECT\b/gi, "подтверждённый субъект"],
  [/\bPROBABLE[_\s-]?SUBJECT\b/gi, "вероятный субъект"],
  [/\bUNRESOLVED\b/gi, "не определено"],
  [/\bPEP\b/g, "публичное должностное лицо"],
  [/\bRCA\b/g, "связь с публичным лицом"],
  [/\bevidenceRefs?\b/gi, "источники"],
  [/\bauditRunId\b/gi, "идентификатор запуска"],
  [/\breportRunId\b/gi, "идентификатор отчёта"],
  [/\bSERP\b/g, "поисковая выдача"],
  [/\bPAA\b/g, "похожие вопросы"],
  [/\bDEMO\b/g, ""],
];

const DANGLING_TAIL =
  /(?:^|[\s,;:.—–-])(как|что|чтобы|и|а|или|по|на|в|с|из|для|о|об|к|ко|у|от|до|при|без|над|под|про|через|в\s+т\.?\s*ч\.?)\s*$/i;

export function sanitizeClientLanguage(text: string): string {
  let out = String(text ?? "").replace(/\s+/g, " ").trim();
  for (const [re, repl] of INTERNAL_TOKEN_REPLACEMENTS) {
    out = out.replace(re, repl);
  }
  return out.replace(/\s{2,}/g, " ").trim();
}

export function hasDanglingSentenceTail(text: string): boolean {
  const t = String(text ?? "").trim();
  if (!t) return false;
  if (/[.!?…»)]\s*$/.test(t)) return false;
  if (DANGLING_TAIL.test(t)) return true;
  if (/[,;:—–:-]\s*$/.test(t)) return true;
  if (/(?:\s|^)(?:с\s+)?[А-ЯA-Z]\.?\s*$/.test(t)) return true;
  return false;
}

/** Keep complete sentences only; drop dangling incomplete last clause. */
export function enforceCompleteSentences(text: string, fallback: string): string {
  const cleaned = sanitizeClientLanguage(text);
  const sentences = cleaned
    .split(/(?<=[.!?…])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const complete = sentences.filter((s) => /[.!?…]$/.test(s) && !hasDanglingSentenceTail(s));
  if (complete.length > 0) return complete.join(" ");
  if (sentences[0] && !hasDanglingSentenceTail(sentences[0])) return sentences[0];
  return sanitizeClientLanguage(fallback);
}

export function observationKey(parts: {
  auditRunId: string;
  provider: string;
  engine: string;
  region: string;
  language: string;
  device?: string;
  surface: string;
  queryId: string;
  rank: number;
  normalizedUrlOrHash: string;
}): string {
  return [
    parts.auditRunId,
    parts.provider,
    parts.engine,
    parts.region,
    parts.language,
    parts.device ?? "DESKTOP",
    parts.surface,
    parts.queryId,
    String(parts.rank),
    parts.normalizedUrlOrHash,
  ]
    .map((x) => String(x ?? "").trim().toLowerCase())
    .join("|");
}
