/**
 * R10.8b — Artifact-backed AdminReviewDecisionRepository.
 * Preserves decision history in a sidecar history file; active decisions remain in admin-review-decisions.json.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdminReviewDecision, AdminReviewDecisionSet } from "./admin-review-decision";
import {
  ORION_GOLDEN_QA_STORAGE_ROOT,
  caseScopedArtifactRoot,
  loadAdminReviewDecisions,
  saveAdminReviewDecisions,
} from "./admin-review-decision-store";
import type { AdminReviewDecisionRepository } from "./admin-review-decision-repository";
import {
  newDecisionId,
  type AdminReviewDecisionRecord,
  type SaveAdminReviewDecisionInput,
} from "./admin-review-decision-record";

type HistoryFile = {
  version: "r10-8b-admin-review-decision-history-v1";
  caseId: string;
  records: AdminReviewDecisionRecord[];
};

export type ArtifactAdminReviewDecisionRepositoryOptions = {
  /** Override storage root (for isolated QA). Default: ORION_GOLDEN_QA_STORAGE_ROOT */
  artifactRoot?: string;
  /**
   * When true (default for production artifact mode), store under cases/<caseId>/.
   * Set false only for isolated single-case QA roots that already are case-specific.
   */
  caseScoped?: boolean;
};

export class ArtifactAdminReviewDecisionRepository implements AdminReviewDecisionRepository {
  readonly mode = "artifact" as const;
  private readonly root: string;
  private readonly caseScoped: boolean;

  constructor(options?: ArtifactAdminReviewDecisionRepositoryOptions) {
    this.root = options?.artifactRoot ?? ORION_GOLDEN_QA_STORAGE_ROOT;
    this.caseScoped = options?.caseScoped ?? this.root === ORION_GOLDEN_QA_STORAGE_ROOT;
  }

  private rootForCase(caseId: string): string {
    return this.caseScoped ? caseScopedArtifactRoot(this.root, caseId) : this.root;
  }

  private decisionsPath(caseId: string): string {
    return join(this.rootForCase(caseId), "admin-review-decisions.json");
  }

  private historyPath(caseId: string): string {
    return join(this.rootForCase(caseId), "admin-review-decision-history.json");
  }

  private writeJsonAtomic(path: string, value: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  }

  private loadLegacySet(caseId: string): AdminReviewDecisionSet | null {
    if (this.root === ORION_GOLDEN_QA_STORAGE_ROOT) {
      return loadAdminReviewDecisions(caseId);
    }
    const path = this.decisionsPath(caseId);
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf-8")) as AdminReviewDecisionSet;
    if (raw.caseId !== caseId) {
      return {
        version: "r10-5-admin-review-decisions-v1",
        caseId,
        generatedAt: new Date().toISOString(),
        decisions: [],
      };
    }
    return raw;
  }

  private saveLegacySet(caseId: string, decisionSet: AdminReviewDecisionSet): void {
    if (this.root === ORION_GOLDEN_QA_STORAGE_ROOT) {
      saveAdminReviewDecisions(caseId, decisionSet);
      return;
    }
    this.writeJsonAtomic(this.decisionsPath(caseId), {
      ...decisionSet,
      version: "r10-5-admin-review-decisions-v1",
      caseId,
      updatedAt: new Date().toISOString(),
      qaSampleOnly: false,
    });
  }

  private loadFullHistory(caseId: string): HistoryFile {
    const path = this.historyPath(caseId);
    if (!existsSync(path)) {
      return { version: "r10-8b-admin-review-decision-history-v1", caseId, records: [] };
    }
    const raw = JSON.parse(readFileSync(path, "utf-8")) as HistoryFile;
    return {
      version: "r10-8b-admin-review-decision-history-v1",
      caseId: raw.caseId || caseId,
      records: (raw.records ?? []).filter((r) => r.caseId === caseId || !r.caseId),
    };
  }

  private saveFullHistory(caseId: string, records: AdminReviewDecisionRecord[]): void {
    this.writeJsonAtomic(this.historyPath(caseId), {
      version: "r10-8b-admin-review-decision-history-v1",
      caseId,
      updatedAt: new Date().toISOString(),
      records: records.filter((r) => r.caseId === caseId),
    });
  }

  private legacyToActiveRecord(
    caseId: string,
    decision: AdminReviewDecision,
    extras?: Partial<AdminReviewDecisionRecord>
  ): AdminReviewDecisionRecord {
    const now = new Date().toISOString();
    return {
      id: extras?.id ?? `legacy_${caseId}_${decision.evidenceId}`,
      caseId,
      evidenceId: decision.evidenceId,
      status: decision.status,
      reviewerNote: decision.reviewerNote,
      approvedClientSummary: decision.approvedClientSummary,
      caveatText: decision.caveatText,
      requestedSources: decision.requestedSources,
      reviewedBy: decision.reviewedBy,
      reviewedAt: decision.reviewedAt,
      createdAt: extras?.createdAt ?? decision.reviewedAt ?? now,
      updatedAt: extras?.updatedAt ?? decision.reviewedAt ?? now,
      decisionVersion: extras?.decisionVersion ?? 1,
      source: extras?.source ?? "imported_artifact",
      isActive: extras?.isActive ?? true,
      previousDecisionId: extras?.previousDecisionId,
      metadata: extras?.metadata,
    };
  }

  private syncActiveSet(caseId: string, activeRecords: AdminReviewDecisionRecord[]): void {
    const existing = this.loadLegacySet(caseId);
    const set: AdminReviewDecisionSet = {
      version: "r10-5-admin-review-decisions-v1",
      caseId,
      generatedAt: existing?.generatedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      qaSampleOnly: false,
      decisions: activeRecords.map((r) => ({
        evidenceId: r.evidenceId,
        status: r.status,
        reviewerNote: r.reviewerNote,
        reviewedBy: r.reviewedBy,
        reviewedAt: r.reviewedAt,
        approvedClientSummary: r.approvedClientSummary,
        caveatText: r.caveatText,
        requestedSources: r.requestedSources,
      })),
    };
    this.saveLegacySet(caseId, set);
  }

  async listDecisions(caseId: string): Promise<AdminReviewDecisionRecord[]> {
    const full = this.loadFullHistory(caseId);
    const activeFromHistory = full.records.filter((r) => r.caseId === caseId && r.isActive);
    const legacy = this.loadLegacySet(caseId);
    if (activeFromHistory.length === 0) {
      return (legacy?.decisions ?? []).map((d) => this.legacyToActiveRecord(caseId, d));
    }
    const covered = new Set(activeFromHistory.map((r) => r.evidenceId));
    const merged = [
      ...activeFromHistory,
      ...(legacy?.decisions ?? [])
        .filter((d) => !covered.has(d.evidenceId))
        .map((d) => this.legacyToActiveRecord(caseId, d)),
    ];
    return merged.sort((a, b) => a.evidenceId.localeCompare(b.evidenceId));
  }

  async getActiveDecision(
    caseId: string,
    evidenceId: string
  ): Promise<AdminReviewDecisionRecord | null> {
    const full = this.loadFullHistory(caseId);
    const fromHistory = full.records
      .filter((r) => r.caseId === caseId && r.evidenceId === evidenceId && r.isActive)
      .sort((a, b) => b.decisionVersion - a.decisionVersion)[0];
    if (fromHistory) return fromHistory;

    const legacy = this.loadLegacySet(caseId);
    const d = legacy?.decisions.find((x) => x.evidenceId === evidenceId);
    return d ? this.legacyToActiveRecord(caseId, d) : null;
  }

  async getDecision(caseId: string, evidenceId: string): Promise<AdminReviewDecisionRecord | null> {
    return this.getActiveDecision(caseId, evidenceId);
  }

  async listDecisionHistory(
    caseId: string,
    evidenceId: string
  ): Promise<AdminReviewDecisionRecord[]> {
    const full = this.loadFullHistory(caseId);
    const rows = full.records
      .filter((r) => r.caseId === caseId && r.evidenceId === evidenceId)
      .sort((a, b) => b.decisionVersion - a.decisionVersion);
    if (rows.length > 0) return rows;

    const active = await this.getActiveDecision(caseId, evidenceId);
    return active ? [active] : [];
  }

  async saveDecision(
    caseId: string,
    evidenceId: string,
    decision: SaveAdminReviewDecisionInput
  ): Promise<AdminReviewDecisionRecord> {
    const now = new Date().toISOString();
    const full = this.loadFullHistory(caseId);
    const caseRecords = full.records.filter((r) => r.caseId === caseId);
    const otherRecords: AdminReviewDecisionRecord[] = [];

    const previousActive = caseRecords
      .filter((r) => r.evidenceId === evidenceId && r.isActive)
      .sort((a, b) => b.decisionVersion - a.decisionVersion)[0];

    let previousVersion = previousActive?.decisionVersion ?? 0;
    let previousId = previousActive?.id;

    if (!previousActive) {
      const legacy = this.loadLegacySet(caseId)?.decisions.find((d) => d.evidenceId === evidenceId);
      if (legacy && legacy.status !== decision.status) {
        previousVersion = Math.max(previousVersion, 1);
        previousId = `legacy_${caseId}_${evidenceId}`;
        if (!caseRecords.some((r) => r.id === previousId)) {
          caseRecords.push(
            this.legacyToActiveRecord(caseId, legacy, {
              id: previousId,
              decisionVersion: 1,
              isActive: false,
              source: "imported_artifact",
            })
          );
        }
      }
    }

    for (const r of caseRecords) {
      if (r.evidenceId === evidenceId && r.isActive) {
        r.isActive = false;
        r.updatedAt = now;
      }
    }

    const next: AdminReviewDecisionRecord = {
      id: newDecisionId(),
      caseId,
      evidenceId,
      status: decision.status,
      reviewerNote: decision.reviewerNote,
      approvedClientSummary: decision.approvedClientSummary,
      caveatText: decision.caveatText,
      requestedSources: decision.requestedSources,
      reviewedBy: decision.reviewedBy,
      reviewedAt: decision.reviewedAt ?? now,
      createdAt: now,
      updatedAt: now,
      decisionVersion: previousVersion + 1,
      source: decision.source ?? "admin_ui",
      isActive: true,
      previousDecisionId: previousId,
      metadata: decision.metadata,
    };

    caseRecords.push(next);
    this.saveFullHistory(caseId, [...otherRecords, ...caseRecords]);

    const activeRecords = caseRecords.filter((r) => r.isActive);
    const legacy = this.loadLegacySet(caseId);
    const covered = new Set(activeRecords.map((r) => r.evidenceId));
    const mergedActive = [
      ...activeRecords,
      ...(legacy?.decisions ?? [])
        .filter((d) => !covered.has(d.evidenceId))
        .map((d) => this.legacyToActiveRecord(caseId, d)),
    ];
    this.syncActiveSet(caseId, mergedActive);
    return next;
  }

  async deactivateDecision(decisionId: string): Promise<AdminReviewDecisionRecord | null> {
    // Decision ids are unique; scan known case roots is not available — require caseId in id prefix
    // Fallback: search under default root cases/ directories is expensive; keep history lookup by scanning
    // the decision id's embedded case is not guaranteed. Use shared scan of case folders only when
    // caseScoped; otherwise single history file.
    if (!this.caseScoped) {
      const path = join(this.root, "admin-review-decision-history.json");
      if (!existsSync(path)) return null;
      const full = JSON.parse(readFileSync(path, "utf-8")) as HistoryFile;
      const idx = (full.records ?? []).findIndex((r) => r.id === decisionId);
      if (idx < 0) return null;
      const now = new Date().toISOString();
      const target = full.records[idx];
      full.records[idx] = { ...target, isActive: false, updatedAt: now };
      this.saveFullHistory(target.caseId, full.records.filter((r) => r.caseId === target.caseId));
      const activeForCase = full.records.filter((r) => r.caseId === target.caseId && r.isActive);
      this.syncActiveSet(target.caseId, activeForCase);
      return full.records[idx];
    }

    // Case-scoped: decision id alone is insufficient without caseId — return null if not found
    // in a lightweight scan of cases/*/history (bounded).
    const casesDir = join(this.root, "cases");
    if (!existsSync(casesDir)) return null;
    for (const entry of readdirSync(casesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = this.loadFullHistory(entry.name);
      const idx = full.records.findIndex((r) => r.id === decisionId);
      if (idx < 0) continue;
      const now = new Date().toISOString();
      const target = full.records[idx];
      full.records[idx] = { ...target, isActive: false, updatedAt: now };
      this.saveFullHistory(target.caseId, full.records);
      const activeForCase = full.records.filter((r) => r.isActive);
      this.syncActiveSet(target.caseId, activeForCase);
      return full.records[idx];
    }
    return null;
  }
}
