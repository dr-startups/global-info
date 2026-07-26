import { createHash } from "node:crypto";

/** Stable queryId for a run-scoped observation group (not a DB FK). */
export function buildSerpQueryId(input: {
  auditRunId: string;
  provider: string;
  engine: string;
  region: string;
  language: string;
  queryText: string;
  surface?: string;
}): string {
  const normalized = input.queryText.trim().replace(/\s+/g, " ").toLowerCase();
  const material = [
    input.auditRunId,
    input.provider,
    input.engine,
    input.region,
    input.language,
    input.surface ?? "organic",
    normalized,
  ].join("|");
  return createHash("sha256").update(material, "utf8").digest("hex").slice(0, 24);
}
