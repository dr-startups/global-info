/**
 * REMEDIATION §7.2 — material dates and prior-report diff.
 *
 * Freshness footnotes use real collectedAt from composite observations.
 * Report-diff compares normalized observation keys against the previous
 * successful job for the same case (sibling artifact dir).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { unifiedArtifactsDir, unifiedJobDir } from "./unified-collection-job-store";

const EPOCH_MS = Date.parse("1970-01-01T00:00:00.000Z");

export type MaterialFreshness = {
  earliestAt: string;
  latestAt: string;
};

export type ReportDiffArtifact = {
  version: "report-diff-v1";
  caseId: string;
  currentJobId: string;
  previousJobId: string | null;
  status: "OK" | "NO_PREVIOUS" | "PREVIOUS_UNREADABLE";
  addedCount: number;
  removedCount: number;
  /** Sample of newly appeared material keys (bounded). */
  addedSample: string[];
  /** Sample of keys that left the SERP set. */
  removedSample: string[];
  generatedAt: string;
};

export function isUsableCollectedAt(iso: string | null | undefined): iso is string {
  if (!iso || typeof iso !== "string") return false;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms > EPOCH_MS;
}

/** Keep the newer ISO timestamp (for merge dedup). */
export function preferNewerCollectedAt(
  a: string | null | undefined,
  b: string | null | undefined
): string | undefined {
  const aOk = isUsableCollectedAt(a) ? a : undefined;
  const bOk = isUsableCollectedAt(b) ? b : undefined;
  if (!aOk) return bOk;
  if (!bOk) return aOk;
  return Date.parse(aOk) >= Date.parse(bOk) ? aOk : bOk;
}

/** DD.MM.YYYY in Europe/Moscow-style local calendar (UTC+3 fixed for client RU copy). */
export function formatRuDate(iso: string): string | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= EPOCH_MS) return null;
  const d = new Date(ms + 3 * 60 * 60 * 1000);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getUTCFullYear());
  return `${dd}.${mm}.${yyyy}`;
}

export function computeMaterialFreshness(
  dates: Array<string | null | undefined>
): MaterialFreshness | null {
  let earliestMs = Number.POSITIVE_INFINITY;
  let latestMs = Number.NEGATIVE_INFINITY;
  let earliestAt: string | undefined;
  let latestAt: string | undefined;
  for (const iso of dates) {
    if (!isUsableCollectedAt(iso)) continue;
    const ms = Date.parse(iso);
    if (ms < earliestMs) {
      earliestMs = ms;
      earliestAt = iso;
    }
    if (ms > latestMs) {
      latestMs = ms;
      latestAt = iso;
    }
  }
  if (!earliestAt || !latestAt) return null;
  return { earliestAt, latestAt };
}

/** Client footnote: «данные собраны ДД.ММ.ГГГГ; самый свежий материал — …». */
export function freshnessFootnote(freshness: MaterialFreshness): string | undefined {
  const collected = formatRuDate(freshness.earliestAt);
  const latest = formatRuDate(freshness.latestAt);
  if (!collected || !latest) return undefined;
  if (collected === latest) {
    return `данные собраны ${collected}`;
  }
  return `данные собраны ${collected}; самый свежий материал — ${latest}`;
}

export function reportDiffClientLine(diff: Pick<ReportDiffArtifact, "addedCount" | "removedCount" | "previousJobId">): string | undefined {
  if (!diff.previousJobId) return undefined;
  return `Новых материалов с прошлого отчёта: ${diff.addedCount}, ушло из выдачи: ${diff.removedCount}`;
}

export function diffMaterialKeys(currentKeys: string[], previousKeys: string[]): {
  added: string[];
  removed: string[];
} {
  const cur = new Set(currentKeys.filter(Boolean));
  const prev = new Set(previousKeys.filter(Boolean));
  const added: string[] = [];
  const removed: string[] = [];
  for (const k of cur) if (!prev.has(k)) added.push(k);
  for (const k of prev) if (!cur.has(k)) removed.push(k);
  added.sort();
  removed.sort();
  return { added, removed };
}

type CompositeFileShape = {
  observations?: Array<{ key?: string }>;
};

function readObservationKeys(jobDir: string): string[] | null {
  const path = join(jobDir, "composite-serp-observations.json");
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as CompositeFileShape;
    if (!Array.isArray(raw.observations)) return null;
    return raw.observations
      .map((o) => String(o?.key ?? "").trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Pick the most recent sibling job dir (by directory mtime) that has a readable
 * composite observations file, excluding the current job.
 */
export function findPreviousReportObservationKeys(input: {
  caseId: string;
  currentJobId: string;
  /** Test hook: override case root. */
  caseRootDir?: string;
}): { previousJobId: string; keys: string[] } | null {
  const root = input.caseRootDir ?? unifiedJobDir(input.caseId);
  if (!existsSync(root)) return null;
  const candidates: Array<{ id: string; mtime: number; keys: string[] }> = [];
  for (const name of readdirSync(root)) {
    if (name === input.currentJobId) continue;
    if (!name.startsWith("unified-")) continue;
    const dir = join(root, name);
    let mtime = 0;
    try {
      mtime = statSync(dir).mtimeMs;
    } catch {
      continue;
    }
    const keys = readObservationKeys(dir);
    if (!keys || keys.length === 0) continue;
    // Prefer jobs that reached prepare/render (honest prior report).
    const hasPrepare =
      existsSync(join(dir, "canonical-prepare-summary.json")) ||
      existsSync(join(dir, "render-checkpoint.json")) ||
      existsSync(join(dir, "golden-render-meta.json"));
    candidates.push({
      id: name,
      mtime: hasPrepare ? mtime + 1e15 : mtime,
      keys,
    });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  const best = candidates[0]!;
  return { previousJobId: best.id, keys: best.keys };
}

export function buildReportDiffArtifact(input: {
  caseId: string;
  currentJobId: string;
  currentKeys: string[];
  caseRootDir?: string;
  now?: Date;
}): ReportDiffArtifact {
  const generatedAt = (input.now ?? new Date()).toISOString();
  const prior = findPreviousReportObservationKeys({
    caseId: input.caseId,
    currentJobId: input.currentJobId,
    caseRootDir: input.caseRootDir,
  });
  if (!prior) {
    return {
      version: "report-diff-v1",
      caseId: input.caseId,
      currentJobId: input.currentJobId,
      previousJobId: null,
      status: "NO_PREVIOUS",
      addedCount: 0,
      removedCount: 0,
      addedSample: [],
      removedSample: [],
      generatedAt,
    };
  }
  const { added, removed } = diffMaterialKeys(input.currentKeys, prior.keys);
  return {
    version: "report-diff-v1",
    caseId: input.caseId,
    currentJobId: input.currentJobId,
    previousJobId: prior.previousJobId,
    status: "OK",
    addedCount: added.length,
    removedCount: removed.length,
    addedSample: added.slice(0, 12),
    removedSample: removed.slice(0, 12),
    generatedAt,
  };
}

/** Resolve prior job artifact dir (for tests / diagnostics). */
export function previousJobArtifactsDir(caseId: string, previousJobId: string): string {
  return unifiedArtifactsDir(caseId, previousJobId);
}
