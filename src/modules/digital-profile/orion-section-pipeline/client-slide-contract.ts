import type { OrionGpt55SectionAnalysis, OrionManifestSlide } from "./types";

const FORBIDDEN_CLIENT_TOKENS = [
  "orion_static",
  "internaldebug",
  "providererror",
  "storagekey",
  "openai_api_key",
  "sk-",
  "c:\\",
  "/mnt/",
  "storage/digital-profile",
] as const;

const ENGLISH_STATUS_LABELS =
  /\b(requires review|confirmed|needs review|pending review|false positive)\b/i;

export interface OrionSlideTableRow extends Record<string, unknown> {
  label: string;
  value: string;
  note?: string;
  evidenceRef?: string;
}

function cleanText(value: unknown, maxLen = 480): string {
  let text = String(value ?? "").replace(/\s+/g, " ").trim();
  for (const token of FORBIDDEN_CLIENT_TOKENS) {
    if (token.includes("\\")) {
      if (text.toLowerCase().includes(token.toLowerCase())) text = text.replaceAll(token, "");
      continue;
    }
    text = text.replace(new RegExp(token, "gi"), "");
  }
  text = text.replace(/\b(row)\b/gi, "").trim();
  return text.slice(0, maxLen).trim();
}

function isPlaceholderLabel(label: string): boolean {
  const lower = label.toLowerCase();
  return !label || lower === "row" || lower === "key" || lower === "label";
}

export function normalizeSlideTableRows(
  rows: Array<Record<string, unknown>>
): OrionSlideTableRow[] {
  const out: OrionSlideTableRow[] = [];
  for (const row of rows) {
    const label = cleanText(row.label ?? row.key ?? row.field ?? row.name, 96);
    const value = cleanText(row.value ?? row.text ?? row.summary, 220);
    if (isPlaceholderLabel(label) || !value) continue;
    out.push({
      label,
      value,
      note: cleanText(row.note, 160) || undefined,
      evidenceRef: cleanText(row.evidenceRef ?? row.safeEvidenceId, 64) || undefined,
    });
  }
  return out.slice(0, 8);
}

export function normalizeMetricCards(
  cards: Array<Record<string, unknown>>
): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const card of cards) {
    const label = cleanText(card.label ?? card.title, 64);
    const rawValue = card.value ?? card.count ?? card.total;
    if (!label) continue;
    if (rawValue === undefined || rawValue === null || String(rawValue).trim() === "") continue;
    const value = cleanText(rawValue, 48);
    if (!value) continue;
    if (ENGLISH_STATUS_LABELS.test(label) || ENGLISH_STATUS_LABELS.test(value)) continue;
    out.push({ label, value });
  }
  return out.slice(0, 6);
}

export function buildNarrativeBlocksFromAnalysis(
  analysis: OrionGpt55SectionAnalysis
): Array<{ title: string; text: string }> {
  const blocks: Array<{ title: string; text: string }> = [];
  const push = (title: string, text: unknown) => {
    const cleaned = cleanText(text, 520);
    if (cleaned) blocks.push({ title, text: cleaned });
  };

  push("Краткий вывод", analysis.clientNarrative.plainConclusion);
  for (const item of analysis.clientNarrative.whatWasFound.slice(0, 4)) {
    push("Что обнаружено", item);
  }
  for (const item of analysis.clientNarrative.whatWasNotConfirmed.slice(0, 2)) {
    push("Что не подтверждено", item);
  }
  push("Почему это важно", analysis.clientNarrative.whyItMatters);
  for (const item of analysis.clientNarrative.whatRequiresReview.slice(0, 3)) {
    push("Очередь ручной проверки", item);
  }
  for (const item of analysis.clientNarrative.recommendedActions.slice(0, 2)) {
    push("Рекомендуемые шаги", item);
  }

  for (const block of analysis.slideContent.narrativeBlocks) {
    const title = cleanText(block.title ?? "Комментарий", 64) || "Комментарий";
    const text = cleanText(block.text ?? block.body ?? block.summary, 520);
    if (!text) continue;
    if (blocks.some((x) => x.text === text)) continue;
    blocks.push({ title, text });
  }

  return blocks.slice(0, 8);
}

export function buildEvidenceExampleRows(
  analysis: OrionGpt55SectionAnalysis
): OrionSlideTableRow[] {
  const refs = new Set(analysis.slideContent.evidenceRefs);
  const rows: OrionSlideTableRow[] = [];
  for (const ref of refs) {
    if (!ref || rows.length >= 4) break;
    rows.push({
      label: "Доказательство",
      value: ref,
      evidenceRef: ref,
    });
  }
  return rows;
}

export function buildClientSubheadline(
  analysis: OrionGpt55SectionAnalysis,
  microStageTitleRu: string
): string {
  const candidate = cleanText(analysis.slideContent.subheadline, 160);
  if (candidate && candidate !== "Этап анализа") return candidate;
  const summary = cleanText(analysis.clientNarrative.plainConclusion, 160);
  if (summary) return summary;
  return cleanText(microStageTitleRu, 96);
}

export function sanitizeClientSlide(slide: OrionManifestSlide): OrionManifestSlide {
  const tables = normalizeSlideTableRows(slide.tables);
  const metrics = normalizeMetricCards(slide.metrics);
  const narrativeBlocks = (slide.narrativeBlocks ?? [])
    .map((block) => ({
      title: cleanText(block.title ?? "Комментарий", 64) || "Комментарий",
      text: cleanText(block.text ?? block.body ?? block.summary, 520),
    }))
    .filter((block) => block.text.length > 0);

  return {
    ...slide,
    title: cleanText(slide.title, 120) || "Раздел отчёта",
    subtitle: cleanText(slide.subtitle, 160) || undefined,
    metrics,
    tables,
    narrativeBlocks,
  };
}

export function scanClientReportText(json: string): string[] {
  const issues: string[] = [];
  const lower = json.toLowerCase();
  if (/\borion_static\b/.test(lower)) issues.push("ORION_STATIC leak");
  if (/(^|[\s"'/:])row([\s"'/:]|$)/i.test(json)) issues.push('literal "row" placeholder');
  if (/этап анализа/i.test(json)) issues.push('generic "Этап анализа" subheadline');
  const englishLabelPattern =
    /"(?:text|title|subtitle|headline|label|value|plainConclusion|whyItMatters|snippet)"\s*:\s*"[^"]*\b(requires review|needs review|pending review|false positive)\b[^"]*"/i;
  const englishConfirmedPattern =
    /"(?:text|title|subtitle|headline|label|value|plainConclusion|whyItMatters|snippet)"\s*:\s*"[^"]*\bconfirmed\b[^"]*"/i;
  if (englishLabelPattern.test(json) || englishConfirmedPattern.test(json)) {
    issues.push("english status labels in RU report");
  }
  if (/\"label\"\s*:\s*\"\"\s*,\s*\"value\"\s*:\s*\"\"/i.test(json)) issues.push("empty table row");
  for (const token of FORBIDDEN_CLIENT_TOKENS) {
    if (token.includes("\\")) {
      if (lower.includes(token.toLowerCase())) issues.push(`forbidden token: ${token}`);
      continue;
    }
    if (new RegExp(token, "i").test(lower)) issues.push(`forbidden token: ${token}`);
  }
  return issues;
}
