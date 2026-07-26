/**
 * Centralized client-language sanitizer for First36 slides.
 * Removes internal pipeline jargon from client-facing text.
 */

const INTERNAL_TOKEN_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bсверить\s+identity\b/gi, "сверить личность"],
  [/\bidentity\b/gi, "сверка личности"],
  [/\brelated\b/gi, "связанные запросы"],
  // Keep short nominative forms — long phrases break Russian case endings
  // (e.g. "комплаенс-проверка-процедурах", "публичное должностное лицо-статуса").
  [/\bcompliance\b/gi, "комплаенс"],
  [/\bsanctions\s*\/\s*watchlist\b/gi, "санкционный / наблюдательный список"],
  [/\bwatchlist\b/gi, "наблюдательный список"],
  [/\bsanctions\b/gi, "санкции"],
  [/\bWRONG[_\s-]?SUBJECT\b/gi, "другой субъект"],
  [/\bAMBIGUOUS\b/gi, "неоднозначно"],
  [/\bCONFIRMED[_\s-]?SUBJECT\b/gi, "подтверждённый субъект"],
  [/\bPROBABLE[_\s-]?SUBJECT\b/gi, "вероятный субъект"],
  [/\bUNRESOLVED\b/gi, "не определено"],
  [/\bPEP\b/g, "PEP"],
  [/\bRCA\b/g, "RCA"],
  [/\bevidenceRefs?\b/gi, "источники"],
  [/\bauditRunId\b/gi, "идентификатор запуска"],
  [/\breportRunId\b/gi, "идентификатор отчёта"],
  // Prefer prepositional case after «в/во».
  [/\bв\s+SERP\b/g, "в поисковой выдаче"],
  [/\bSERP\b/g, "поисковая выдача"],
  [/\bPAA\b/g, "похожие вопросы"],
  [/\bDEMO\b/g, ""],
];

/** Repair leftover mechanical enum/phrase breakage in client prose. */
export function repairBrokenClientPhrases(text: string): string {
  return String(text ?? "")
    .replace(/комплаенс-проверка-(?=процедур|статус|сигнал|баз)/gi, "комплаенс-")
    .replace(/публичное должностное лицо-(?=статус|сигнал|проверк)/gi, "PEP-")
    .replace(/сигналы публичное должностное лицо/gi, "сигналы PEP")
    .replace(/статус публичное должностное лицо/gi, "статус PEP")
    .replace(/\bв\s+поисковая\s+выдача\b/gi, "в поисковой выдаче")
    .replace(/\bпозиции\s+в\s+поисковая\s+выдача\b/gi, "позиции в поисковой выдаче")
    .replace(/\bсверить\s+сверка\s+личности\b/gi, "сверить личность")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const DANGLING_TAIL =
  /(?:^|[\s,;:.—–-])(как|что|чтобы|и|а|или|по|на|в|с|из|для|о|об|к|ко|у|от|до|при|без|над|под|про|через|в\s+т\.?\s*ч\.?)\s*$/i;

export function sanitizeClientLanguage(text: string): string {
  let out = String(text ?? "").replace(/\s+/g, " ").trim();
  for (const [re, repl] of INTERNAL_TOKEN_REPLACEMENTS) {
    out = out.replace(re, repl);
  }
  return repairBrokenClientPhrases(out.replace(/\s{2,}/g, " ").trim());
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
