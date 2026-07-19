/**
 * Russian client-language labels for the data we hand to GPT.
 *
 * The model tends to echo tokens from its input payload. Raw internal enums
 * (SUBJECT_MATCH, riskLevel "high", surface "organic", findingId with
 * snake_case theme ids) then land in generated client text and are rejected
 * by the forbidden-token scanner, silently discarding whole GPT sections.
 * Feeding the model client-safe Russian labels removes the leak at the source.
 */

export function riskLevelRu(level: string): string {
  const map: Record<string, string> = {
    critical: "критический",
    high: "высокий",
    medium: "средний",
    low: "низкий",
    none: "нет риска",
  };
  return map[level.toLowerCase()] ?? "требует уточнения";
}

export function subjectMatchRu(value: string): string {
  const map: Record<string, string> = {
    SUBJECT_MATCH: "о проверяемом лице",
    LIKELY_SUBJECT: "вероятно о проверяемом лице",
    AMBIGUOUS: "принадлежность требует подтверждения",
    OTHER_SUBJECT: "о другом лице (тёзке)",
  };
  return map[value] ?? "принадлежность требует подтверждения";
}

export function surfaceRu(surface: string): string {
  const map: Record<string, string> = {
    organic: "органическая выдача",
    suggestions: "поисковые подсказки",
    related: "связанные запросы",
    paa: "вопросы «Люди также спрашивают»",
    images: "блок изображений",
    wikipedia: "энциклопедические источники",
    knowledge_panel: "панель знаний",
    ai_overview: "ответы ИИ-поиска",
    url_audit: "проверка индексации адресов",
    indexation: "проверка индексации адресов",
    news: "новостная выдача",
    videos: "видео",
  };
  return map[surface.toLowerCase()] ?? "поисковая поверхность";
}

export function engineRu(engine: string | undefined): string {
  if (!engine) return "поисковые системы";
  const map: Record<string, string> = {
    google: "Google",
    yandex: "Яндекс",
    bing: "Bing",
    arsenkin: "поисковые системы",
  };
  return map[engine.toLowerCase()] ?? "поисковые системы";
}

export function metricKeyRu(key: string): string {
  const map: Record<string, string> = {
    totalCount: "всего материалов",
    subjectMatchCount: "о проверяемом лице",
    likelySubjectCount: "вероятно о субъекте",
    ambiguousCount: "требуют подтверждения",
    otherSubjectCount: "о других лицах",
    adverseCount: "негативных",
    adverseFindingCount: "негативных выводов",
    emptyMarkerCount: "пустых блоков",
    indexedCount: "проиндексировано",
    notIndexedCount: "не проиндексировано",
  };
  return map[key] ?? key.replace(/[_-]+/g, " ");
}
