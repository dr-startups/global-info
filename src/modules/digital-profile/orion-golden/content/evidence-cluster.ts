/**
 * R10.7c — Evidence clustering for client-facing content polish.
 * Groups duplicate registry/profile cards and similar findings without changing risk gates.
 */

import type { EvidenceJudgment } from "../evidence/evidence-judgment";

export type EvidenceClusterClientUse =
  | "AUTO_INCLUDE_CLIENT_REPORT"
  | "APPENDIX_ONLY"
  | "MANUAL_REVIEW_REQUIRED"
  | "EXCLUDE";

export type EvidenceCluster = {
  clusterId: string;
  evidenceIds: string[];
  title: string;
  sourceDomains: string[];
  subjectBinding: EvidenceJudgment["subjectBinding"];
  riskSignal: EvidenceJudgment["riskSignal"];
  clientUse: EvidenceClusterClientUse;
  summary: string;
  sectionIds: string[];
  identityAnchor?: {
    inn?: string;
    ogrn?: string;
    ogrnip?: string;
    companyName?: string;
  };
  duplicateCount: number;
};

const INN_RE = /\b(?:инн[:\s]*)?(\d{12}|\d{10})\b/i;
const OGRNIP_RE = /\b(?:огрнип[:\s]*)?(\d{15})\b/i;
const OGRN_RE = /\b(?:огрн[:\s]*)?(\d{13})\b/i;

const REGISTRY_SOURCES = new Set([
  "AUTHORITATIVE",
  "BUSINESS_REGISTRY_AGGREGATOR",
  "GOVERNMENT",
]);

function extractId(text: string, re: RegExp): string | undefined {
  const m = text.match(re);
  return m?.[1];
}

function normalizeTitleKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .replace(/[.…]+$/g, "")
    .trim()
    .slice(0, 80);
}

function bindingRank(b: EvidenceJudgment["subjectBinding"]): number {
  switch (b) {
    case "CONFIRMED":
      return 5;
    case "LIKELY":
      return 4;
    case "WEAK":
      return 2;
    case "UNKNOWN":
      return 1;
    case "WRONG_SUBJECT":
      return 0;
    default:
      return 0;
  }
}

function mapClientUse(j: EvidenceJudgment): EvidenceClusterClientUse {
  if (j.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT") return "AUTO_INCLUDE_CLIENT_REPORT";
  if (j.reviewDecision === "APPENDIX_ONLY") return "APPENDIX_ONLY";
  if (j.reviewDecision === "MANUAL_REVIEW_REQUIRED") return "MANUAL_REVIEW_REQUIRED";
  return "EXCLUDE";
}

function isRegistryLike(j: EvidenceJudgment): boolean {
  return (
    REGISTRY_SOURCES.has(j.sourceReliability) ||
    j.flags.includes("exact_inn_match") ||
    /\b(инн|огрн|огрнип|егрюл|егрип|реестр|ип\b)/i.test(`${j.title} ${j.clientSafeSummary}`)
  );
}

function clusterKey(j: EvidenceJudgment): string {
  const hay = `${j.title} ${j.clientSafeSummary}`;
  const inn = extractId(hay, INN_RE);
  const ogrnip = extractId(hay, OGRNIP_RE);
  const ogrn = extractId(hay, OGRN_RE);

  if (inn && isRegistryLike(j)) return `inn:${inn}`;
  if (ogrnip && isRegistryLike(j)) return `ogrnip:${ogrnip}`;
  if (ogrn && isRegistryLike(j)) return `ogrn:${ogrn}`;

  const domain = (j.sourceDomain ?? "unknown").toLowerCase();
  if (isRegistryLike(j)) {
    return `registry:${domain}:${normalizeTitleKey(j.title)}`;
  }
  return `item:${domain}:${normalizeTitleKey(j.title)}:${j.evidenceId}`;
}

function buildClusterSummary(members: EvidenceJudgment[], anchor: EvidenceCluster["identityAnchor"]): string {
  const domains = [...new Set(members.map((m) => m.sourceDomain).filter(Boolean))] as string[];
  const confirmed = members.some((m) => m.subjectBinding === "CONFIRMED");
  const auto = members.some((m) => m.reviewDecision === "AUTO_INCLUDE_CLIENT_REPORT");
  const inn = anchor?.inn;
  const ogrnip = anchor?.ogrnip ?? anchor?.ogrn;

  if (inn && (confirmed || auto)) {
    const idBits = [
      `ИНН ${inn}`,
      ogrnip ? (ogrnip.length === 15 ? `ОГРНИП ${ogrnip}` : `ОГРН ${ogrnip}`) : null,
    ]
      .filter(Boolean)
      .join(", ");
    return (
      `По субъекту обнаружены подтверждённые реестровые сведения с совпадением по ${idBits}. ` +
      `Материалы (${members.length} карточек; источники: ${domains.slice(0, 4).join(", ") || "реестры"}) ` +
      `используются как нейтральное подтверждение присутствия субъекта в открытых деловых/реестровых источниках ` +
      `и не трактуются как негативный фактор.`
    );
  }

  if (isRegistryLike(members[0]!)) {
    return (
      `Сгруппированы ${members.length} близких реестровых/профильных карточек ` +
      `(${domains.slice(0, 3).join(", ") || "источники"}). ` +
      `Дубликаты не повторяются в ключевых выводах.`
    );
  }

  return members[0]?.clientSafeSummary?.slice(0, 280) || members[0]?.title || "Кластер материалов";
}

/**
 * Cluster judgments for client presentation. Prefer CONFIRMED/AUTO_INCLUDE registry facts.
 */
export function clusterEvidenceJudgments(
  judgments: EvidenceJudgment[],
  options?: { sectionIdsByEvidenceId?: Map<string, string[]> }
): EvidenceCluster[] {
  const groups = new Map<string, EvidenceJudgment[]>();
  for (const j of judgments) {
    if (j.subjectBinding === "WRONG_SUBJECT" || j.reviewDecision === "EXCLUDE_WRONG_SUBJECT") continue;
    if (j.reviewDecision === "EXCLUDE_NOISE") continue;
    const key = clusterKey(j);
    const list = groups.get(key) ?? [];
    list.push(j);
    groups.set(key, list);
  }

  const clusters: EvidenceCluster[] = [];
  let i = 0;
  for (const [key, members] of groups) {
    members.sort((a, b) => bindingRank(b.subjectBinding) - bindingRank(a.subjectBinding));
    const primary = members[0]!;
    const hay = `${primary.title} ${primary.clientSafeSummary}`;
    const identityAnchor = {
      inn: extractId(hay, INN_RE),
      ogrnip: extractId(hay, OGRNIP_RE),
      ogrn: extractId(hay, OGRN_RE),
    };
    const sectionIds = [
      ...new Set(
        members.flatMap((m) => options?.sectionIdsByEvidenceId?.get(m.evidenceId) ?? [])
      ),
    ];
    const clientUses = members.map(mapClientUse);
    const clientUse: EvidenceClusterClientUse = clientUses.includes("AUTO_INCLUDE_CLIENT_REPORT")
      ? "AUTO_INCLUDE_CLIENT_REPORT"
      : clientUses.includes("MANUAL_REVIEW_REQUIRED")
        ? "MANUAL_REVIEW_REQUIRED"
        : clientUses.includes("APPENDIX_ONLY")
          ? "APPENDIX_ONLY"
          : "EXCLUDE";

    clusters.push({
      clusterId: `cl-${++i}-${key.slice(0, 40).replace(/[^a-z0-9:_-]/gi, "")}`,
      evidenceIds: members.map((m) => m.evidenceId),
      title: primary.title.slice(0, 120),
      sourceDomains: [...new Set(members.map((m) => m.sourceDomain).filter(Boolean))] as string[],
      subjectBinding: primary.subjectBinding,
      riskSignal: primary.riskSignal,
      clientUse,
      summary: buildClusterSummary(members, identityAnchor),
      sectionIds,
      identityAnchor,
      duplicateCount: Math.max(0, members.length - 1),
    });
  }

  return clusters.sort((a, b) => {
    const useRank = (u: EvidenceClusterClientUse) =>
      u === "AUTO_INCLUDE_CLIENT_REPORT" ? 3 : u === "MANUAL_REVIEW_REQUIRED" ? 2 : u === "APPENDIX_ONLY" ? 1 : 0;
    return useRank(b.clientUse) - useRank(a.clientUse) || bindingRank(b.subjectBinding) - bindingRank(a.subjectBinding);
  });
}

export function registryClusters(clusters: EvidenceCluster[]): EvidenceCluster[] {
  return clusters.filter(
    (c) =>
      Boolean(c.identityAnchor?.inn || c.identityAnchor?.ogrn || c.identityAnchor?.ogrnip) ||
      c.clusterId.includes("registry:") ||
      c.clusterId.includes("inn:")
  );
}

export function countDuplicateFindingsRemoved(clusters: EvidenceCluster[]): number {
  return clusters.reduce((sum, c) => sum + c.duplicateCount, 0);
}
