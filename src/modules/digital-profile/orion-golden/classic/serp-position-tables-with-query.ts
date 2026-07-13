/**
 * Build First36 SERP position tables with explicit query column.
 * Rank repeats are allowed only across different queries.
 */

import type { FullEvidenceInventory } from "../evidence/full-evidence-inventory";
import { truncateAtWordBoundary } from "./orion-classic-text-utils";

type RegionBucket = "RU" | "UAE";

function domainOf(url: string | undefined): string {
  if (!url) return "";
  return url
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .split("/")[0]
    ?.slice(0, 48) ?? "";
}

function matchesRegion(itemRegion: string | undefined, bucket: RegionBucket): boolean {
  const r = String(itemRegion ?? "").toUpperCase();
  if (bucket === "RU") return r === "RU" || r === "RUSSIA" || r === "RF";
  return r === "UAE" || r === "AE" || r === "INTL" || r === "EN" || r === "GLOBAL_INTL";
}

function shortQuery(q: string): string {
  const t = q.trim().replace(/\s+/g, " ");
  if (t.length <= 42) return t || "основной запрос";
  return `${t.slice(0, 39)}…`;
}

function statusOf(title: string, domain: string, classification?: string): string {
  const blob = `${title} ${domain} ${classification ?? ""}`;
  if (/нежелат|санкц|PEP|adverse|риск|criminal|компромат|rupep/i.test(blob)) return "Нежелательный";
  if (/проверк|требует|смешан/i.test(blob)) return "Требует проверки";
  return "Нейтральный";
}

export function buildSerpPositionTablesWithQuery(
  inventory: FullEvidenceInventory | undefined,
  region: RegionBucket,
  maxRows = 10
): Array<{ headers: string[]; rows: string[][] }> {
  if (!inventory) return [];

  type Row = {
    rank: number;
    query: string;
    domain: string;
    title: string;
    url: string;
    classification?: string;
  };

  const byQuery = new Map<string, Row[]>();
  for (const item of inventory.items) {
    if (item.evidenceType !== "search_result") continue;
    if (!matchesRegion(item.region, region)) continue;
    const query = String(item.query ?? item.rawMetadata?.queryText ?? "основной запрос").trim();
    const list = byQuery.get(query) ?? [];
    const url = String(item.sourceUrl ?? "");
    // Do NOT dedupe URL across queries — same URL under different queries is a distinct observation.
    const rank =
      Number(item.rawMetadata?.rank ?? 0) ||
      list.length + 1;
    list.push({
      rank,
      query,
      domain: domainOf(item.sourceUrl),
      title: truncateAtWordBoundary(item.title, 70),
      url: url.slice(0, 120) || "—",
      classification: item.classification,
    });
    byQuery.set(query, list);
  }

  const tables: Array<{ headers: string[]; rows: string[][] }> = [];
  const sorted = [...byQuery.entries()].sort((a, b) => b[1].length - a[1].length);
  // Prefer one combined table with query column (clearer than silent rank repeats).
  const combined: Row[] = [];
  for (const [, rows] of sorted.slice(0, 4)) {
    combined.push(...rows.sort((a, b) => a.rank - b.rank).slice(0, 6));
  }
  const ordered = combined.slice(0, maxRows);
  if (ordered.length === 0) return [];

  tables.push({
    headers: ["Запрос", "Позиция", "Домен", "Заголовок", "Статус"],
    rows: ordered.map((r) => [
      shortQuery(r.query),
      String(r.rank),
      r.domain || "—",
      r.title,
      statusOf(r.title, r.domain, r.classification),
    ]),
  });
  return tables;
}
