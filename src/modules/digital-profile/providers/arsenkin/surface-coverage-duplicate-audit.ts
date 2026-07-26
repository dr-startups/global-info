/**
 * Pure duplicate detection for SurfaceCollectionCoverage business key.
 */

export type SurfaceCoverageDupRow = {
  id: string;
  reportRunId: string;
  provider: string;
  tool: string;
  queryId: string;
  surface: string;
  engine: string;
  region: string;
  language: string;
  device: string;
  providerTaskId?: string | null;
  resultCount?: number;
  status?: string;
  createdAt?: Date | string;
};

export type SurfaceCoverageDupGroup = {
  key: string;
  count: number;
  ids: string[];
  reportRunId: string;
  provider: string;
  tool: string;
  queryId: string;
  surface: string;
  engine: string;
  region: string;
  language: string;
  device: string;
};

export function coverageBusinessKey(row: SurfaceCoverageDupRow): string {
  return [
    row.reportRunId,
    row.provider,
    row.tool,
    row.queryId,
    row.surface,
    row.engine,
    row.region,
    row.language,
    row.device,
  ].join("|");
}

export function findSurfaceCoverageDuplicateGroups(rows: SurfaceCoverageDupRow[]): {
  totalRows: number;
  duplicateGroupCount: number;
  duplicateRowCount: number;
  groups: SurfaceCoverageDupGroup[];
} {
  const byKey = new Map<string, SurfaceCoverageDupRow[]>();
  for (const row of rows) {
    const key = coverageBusinessKey(row);
    byKey.set(key, [...(byKey.get(key) ?? []), row]);
  }
  const groups: SurfaceCoverageDupGroup[] = [];
  for (const [key, list] of byKey) {
    if (list.length <= 1) continue;
    const first = list[0]!;
    groups.push({
      key,
      count: list.length,
      ids: list.map((r) => r.id).sort(),
      reportRunId: first.reportRunId,
      provider: first.provider,
      tool: first.tool,
      queryId: first.queryId,
      surface: first.surface,
      engine: first.engine,
      region: first.region,
      language: first.language,
      device: first.device,
    });
  }
  groups.sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  return {
    totalRows: rows.length,
    duplicateGroupCount: groups.length,
    duplicateRowCount: groups.reduce((n, g) => n + g.count, 0),
    groups,
  };
}
