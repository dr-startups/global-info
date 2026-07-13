/**
 * Pure matching helpers for Arsenkin provenance backfill (no DB / no API).
 */

export type BackfillTaskTip = {
  tool: string;
  engine: string;
  region: string;
  queryText?: string;
};

export type BackfillTaskCandidate = {
  id: string;
  toolName: string;
  engine: string | null;
  region: string | null;
  queries: string[];
};

export function classifyBackfillMatch(
  tip: BackfillTaskTip,
  candidates: BackfillTaskCandidate[]
): { kind: "unique" | "ambiguous" | "unmatched"; ids: string[] } {
  const matched = candidates.filter((task) => {
    if (task.toolName !== tip.tool) return false;
    if (task.engine && task.engine.toUpperCase() !== tip.engine.toUpperCase()) return false;
    const tipRegion = tip.region.toUpperCase();
    if (task.region && task.region.toUpperCase() !== tipRegion) return false;
    if (tip.queryText && task.queries.length) {
      if (!task.queries.some((q) => q === tip.queryText || q.includes(tip.queryText!))) return false;
    }
    return true;
  });
  if (matched.length === 1) return { kind: "unique", ids: [matched[0]!.id] };
  if (matched.length > 1) return { kind: "ambiguous", ids: matched.map((m) => m.id) };
  return { kind: "unmatched", ids: [] };
}
