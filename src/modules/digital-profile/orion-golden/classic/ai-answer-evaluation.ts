export type AiCollectionStatus =
  | "MEASURED"
  | "NO_RESULTS"
  | "NOT_COLLECTED"
  | "NOT_APPLICABLE"
  | "FAILED";

export type AiEngine = "yandex_alice" | "google_ai_overview";

export type AiAnswerObservation = {
  id: string;
  auditRunId: string;
  providerTaskId: string;
  provider: "arsenkin";
  surface: "ai_answer";
  engine: AiEngine;
  region: string;
  query: string;
  status: AiCollectionStatus;
  answerText: string | null;
  answerBlocks: string[];
  citations: Array<{
    title?: string;
    url: string;
    domain: string;
  }>;
  capturedAt: string;
  rawArtifactRef: string;
  evidenceRefs: string[];
};

export interface AiAnswerEvaluation {
  observationId: string;
  subjectMatch: "MATCH" | "POSSIBLE_MATCH" | "WRONG_SUBJECT" | "INSUFFICIENT_DATA";
  subjectMatchConfidence: number | null;
  tone: "POSITIVE" | "NEUTRAL" | "MIXED" | "ADVERSE" | "NOT_ASSESSABLE";
  summary: string;
  adverseClaims: Array<{
    claim: string;
    severity: "LOW" | "MEDIUM" | "HIGH";
    verificationRequired: boolean;
    evidenceRefs: string[];
  }>;
  ambiguousClaims: Array<{
    claim: string;
    reason: string;
    evidenceRefs: string[];
  }>;
  citedDomains: string[];
  citationCount: number;
  clientTakeaway: string;
  recommendedAction: string;
}

type RawAiRow = {
  id: string;
  auditRunId: string;
  providerTaskId: string | null;
  queryText: string;
  engine: string;
  region: string;
  providerStatus: string;
  title: string | null;
  snippet: string | null;
  url: string;
  domain: string | null;
  capturedAt: string;
};

const ADVERSE_RE = /(санкц|корруп|мошен|уголов|преступ|fraud|criminal|laundering|bribery)/i;
const AMBIGUOUS_RE = /(возможно|может быть|не исключено|однофамил|could be|possibly)/i;

function toAiEngine(engine: string): AiEngine {
  return /YANDEX/i.test(engine) ? "yandex_alice" : "google_ai_overview";
}

function sentenceSplit(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function clipSentence(s: string, max = 220): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const idx = Math.max(cut.lastIndexOf("."), cut.lastIndexOf(","), cut.lastIndexOf(" "));
  return `${cut.slice(0, idx > 40 ? idx : max).trim()}...`;
}

export function buildAiAnswerObservations(rows: RawAiRow[]): AiAnswerObservation[] {
  const grouped = new Map<string, RawAiRow[]>();
  for (const row of rows) {
    const k = `${row.auditRunId}|${row.engine}|${row.region}|${row.queryText}`;
    const list = grouped.get(k) ?? [];
    list.push(row);
    grouped.set(k, list);
  }

  const out: AiAnswerObservation[] = [];
  for (const group of grouped.values()) {
    const first = group[0]!;
    const answerRow = group.find((r) => (r.domain ?? "") === "ai-serp" && (r.snippet?.trim() || r.title?.trim()));
    const citationRows = group.filter((r) => (r.domain ?? "") !== "ai-serp" && /^https?:\/\//i.test(r.url));
    const answerText = answerRow?.snippet?.trim() || null;
    const status: AiCollectionStatus = answerText
      ? "MEASURED"
      : /NO_RESULTS/i.test(first.providerStatus)
        ? "NO_RESULTS"
        : /FAILED|BLOCKED/i.test(first.providerStatus)
          ? "FAILED"
          : "NOT_COLLECTED";

    out.push({
      id: `ai:${first.id}`,
      auditRunId: first.auditRunId,
      providerTaskId: String(first.providerTaskId ?? ""),
      provider: "arsenkin",
      surface: "ai_answer",
      engine: toAiEngine(first.engine),
      region: first.region,
      query: first.queryText,
      status,
      answerText,
      answerBlocks: answerText ? sentenceSplit(answerText) : [],
      citations: citationRows.map((r) => ({
        title: r.title ?? undefined,
        url: r.url,
        domain: String(r.domain ?? "").toLowerCase(),
      })),
      capturedAt: first.capturedAt,
      rawArtifactRef: `serp_observation:${first.id}`,
      evidenceRefs: group.map((r) => `serp_observation:${r.id}`),
    });
  }
  return out;
}

export function evaluateAiAnswerObservation(input: {
  subjectFullName: string;
  aliases: string[];
  observation: AiAnswerObservation;
}): AiAnswerEvaluation | null {
  const obs = input.observation;
  if (obs.status !== "MEASURED" || !obs.answerText?.trim()) return null;

  const text = obs.answerText;
  const hay = text.toLowerCase();
  const nameTokens = [input.subjectFullName, ...input.aliases]
    .join(" ")
    .toLowerCase()
    .split(/\s+/)
    .filter((x) => x.length >= 3);
  const matchCount = nameTokens.filter((t) => hay.includes(t)).length;
  const subjectMatch =
    matchCount >= 2
      ? "MATCH"
      : matchCount === 1
        ? "POSSIBLE_MATCH"
        : obs.citations.length > 0
          ? "INSUFFICIENT_DATA"
          : "WRONG_SUBJECT";
  const subjectMatchConfidence =
    subjectMatch === "MATCH" ? 0.85 : subjectMatch === "POSSIBLE_MATCH" ? 0.55 : null;

  const sentences = sentenceSplit(text);
  const adverseClaims = sentences
    .filter((s) => ADVERSE_RE.test(s))
    .slice(0, 5)
    .map((s) => ({
      claim: clipSentence(s),
      severity: /санкц|criminal|уголов/i.test(s) ? "HIGH" : /корруп|fraud|мошен/i.test(s) ? "MEDIUM" : "LOW",
      verificationRequired: true,
      evidenceRefs: obs.evidenceRefs.slice(0, 3),
    })) as AiAnswerEvaluation["adverseClaims"];
  const ambiguousClaims = sentences
    .filter((s) => AMBIGUOUS_RE.test(s))
    .slice(0, 5)
    .map((s) => ({
      claim: clipSentence(s),
      reason: "Формулировка неоднозначна и требует ручной сверки.",
      evidenceRefs: obs.evidenceRefs.slice(0, 3),
    })) as AiAnswerEvaluation["ambiguousClaims"];

  const tone: AiAnswerEvaluation["tone"] =
    subjectMatch === "WRONG_SUBJECT"
      ? "NOT_ASSESSABLE"
      : adverseClaims.length > 0
      ? ambiguousClaims.length > 0
        ? "MIXED"
        : "ADVERSE"
      : sentences.length === 0
        ? "NOT_ASSESSABLE"
        : "NEUTRAL";

  const citedDomains = [...new Set(obs.citations.map((c) => c.domain).filter(Boolean))];
  return {
    observationId: obs.id,
    subjectMatch,
    subjectMatchConfidence,
    tone,
    summary:
      tone === "NOT_ASSESSABLE" && subjectMatch === "WRONG_SUBJECT"
        ? "Текст ИИ относится к другому субъекту; итоговая тональность по проверяемому лицу не выставляется."
        : tone === "ADVERSE"
        ? "В ответе ИИ присутствуют прямые негативные утверждения, требующие подтверждения источниками."
        : tone === "MIXED"
          ? "Ответ ИИ содержит смешанные сигналы: часть формулировок негативна, часть неоднозначна."
          : "Ответ ИИ не содержит явных негативных утверждений, но подлежит верификации по источникам.",
    adverseClaims,
    ambiguousClaims,
    citedDomains,
    citationCount: obs.citations.length,
    clientTakeaway:
      tone === "NOT_ASSESSABLE" && subjectMatch === "WRONG_SUBJECT"
        ? "Ответ ИИ вероятно относится к другому лицу; требуется уточнить запрос и идентификаторы."
        : tone === "ADVERSE"
        ? "ИИ-ответ формирует рискованное первое впечатление; ключевые тезисы нужно проверить по первичным источникам."
        : "ИИ-ответ требует аккуратной проверки цитируемых источников перед выводами о репутационном риске.",
    recommendedAction:
      tone === "NOT_ASSESSABLE" && subjectMatch === "WRONG_SUBJECT"
        ? "Не использовать этот ответ в оценке субъекта; запустить повторный сбор с уточнённым identity query."
        : adverseClaims.length > 0
        ? "Провести ручную верификацию каждого негативного тезиса по цитируемым доменам."
        : "Проверить, что упомянутые факты действительно относятся к проверяемому субъекту.",
  };
}
