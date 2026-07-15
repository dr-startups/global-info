/**
 * Client-copy QA for First36 — blocks incomplete/technical phrases in client-facing text.
 */

export type ClientCopyIssue = {
  code: string;
  detail: string;
  page?: number;
  slotId?: string;
};

/** Patterns that must never appear in client copy (spec §12). */
export const CLIENT_COPY_FORBIDDEN: Array<{ code: string; pattern: RegExp }> = [
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /\bпо\s+С\.\s*$/i },
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /\bДанные\s+не(?!\s+собраны)\b/i },
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /\bNOT_COLLECTED\b/i },
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /\bNO_RESULTS\b/i },
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /\breportRunId\b/i },
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /\bвторой\s+наб/i },
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /\bru_related_\d/i },
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /\buae_related\b/i },
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /без\s+копирования\s+соседних\s+слайдов/i },
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /сверить\s+сверка\s+личности/i },
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /визуализация\s+сохранённых\s+строк/i },
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /\bassetRef\b/i },
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /\bprovider_task:/i },
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /\b0\s*\/\s*0\b(?!.*(?:не\s+собран|NOT_COLLECTED|данные\s+не))/i },
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /Оценка\s+профиля\.\s*$/i },
  { code: "CLIENT_COPY_INCOMPLETE", pattern: /[а-яёa-z]{2,}-$/i },
];

const DANGLING_END = /(?:^|[\s:;])(?:по|на|в|с|к|о|об|от|для|из|у|и|или|а|но)\s*\.?\s*$/i;

export function inspectClientCopyText(
  text: string,
  ctx?: { page?: number; slotId?: string }
): ClientCopyIssue[] {
  const issues: ClientCopyIssue[] = [];
  const t = String(text ?? "").trim();
  if (!t) return issues;
  for (const rule of CLIENT_COPY_FORBIDDEN) {
    if (rule.pattern.test(t)) {
      issues.push({
        code: rule.code,
        detail: t.slice(0, 120),
        page: ctx?.page,
        slotId: ctx?.slotId,
      });
    }
  }
  if (DANGLING_END.test(t)) {
    issues.push({
      code: "CLIENT_COPY_INCOMPLETE",
      detail: `dangling preposition: ${t.slice(-40)}`,
      page: ctx?.page,
      slotId: ctx?.slotId,
    });
  }
  return issues;
}

export function inspectClientCopySlides(
  slides: Array<{
    pageNumber: number;
    slotId?: string;
    baseSlotId?: string;
    title?: string;
    narrative?: string;
    bullets?: string[];
    clientTakeaway?: string;
    visualAnalysis?: {
      whatIsVisible?: string;
      whyItMatters?: string;
      clientMeaning?: string;
      headlineConclusion?: string;
    };
    statusBadge?: { label?: string };
  }>
): ClientCopyIssue[] {
  const out: ClientCopyIssue[] = [];
  for (const slide of slides) {
    const ctx = { page: slide.pageNumber, slotId: slide.slotId ?? slide.baseSlotId };
    const chunks = [
      slide.title,
      slide.narrative,
      slide.clientTakeaway,
      slide.statusBadge?.label,
      ...(slide.bullets ?? []),
      slide.visualAnalysis?.whatIsVisible,
      slide.visualAnalysis?.whyItMatters,
      slide.visualAnalysis?.clientMeaning,
      slide.visualAnalysis?.headlineConclusion,
    ].filter(Boolean) as string[];
    for (const c of chunks) out.push(...inspectClientCopyText(c, ctx));
  }
  return out;
}
