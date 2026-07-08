/**
 * R10.8b — Artifact-backed AdminReviewDecisionRepository.
 * Preserves decision history in a sidecar history file; active decisions remain in admin-review-decisions.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdminReviewDecision, AdminReviewDecisionSet } from "./admin-review-decision";
import {
  ORION_GOLDEN_QA_STORAGE_ROOT,
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
};

export class ArtifactAdminReviewDecisionRepository implements AdminReviewDecisionRepository {
  readonly mode = "artifact" as const;
  private readonly root: string;

  constructor(options?: ArtifactAdminReviewDecisionRepositoryOptions) {
    this.root = options?.artifactRoot ?? ORION_GOLDEN_QA_STORAGE_ROOT;
  }

  private decisionsPath(): string {
    return join(this.root, "admin-review-decisions.json");
  }

  private historyPath(): string {
    return join(this.root, "admin-review-decision-history.json");
  }

  private writeJsonAtomic(path: string, value: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  }

  private loadLegacySet(caseId: string): AdminReviewDecisionSet | null {
    if (this.root === ORION_GOLDEN_QA_STORAGE_ROOT) {
      return loadAdminReviewDecisions(caseId);
    }
    const path = this.decisionsPath();
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
    this.writeJsonAtomic(this.decisionsPath(), {
      ...decisionSet,
      version: "r10-5-admin-review-decisions-v1",
      caseId,
      updatedAt: new Date().toISOString(),
      qaSampleOnly: false,
    });
  }

  private loadFullHistory(): HistoryFile {
    const path = this.historyPath();
    if (!existsSync(path)) {
      return { version: "r10-8b-admin-review-decision-history-v1", caseId: "", records: [] };
    }
    const raw = JSON.parse(readFileSync(path, "utf-8")) as HistoryFile;
    return {
      version: "r10-8b-admin-review-decision-history-v1",
      caseId: raw.caseId ?? "",
      records: raw.records ?? [],
    };
  }

  private saveFullHistory(records: AdminReviewDecisionRecord[]): void {
    this.writeJsonAtomic(this.historyPath(), {
      version: "r10-8b-admin-review-decision-history-v1",
      updatedAt: new Date().toISOString(),
      records,
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
    const full = this.loadFullHistory();
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
    const full = this.loadFullHistory();
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
    const full = this.loadFullHistory();
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
    const full = this.loadFullHistory();
    const caseRecords = full.records.filter((r) => r.caseId === caseId);
    const otherRecords = full.records.filter((r) => r.caseId !== caseId);

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
    this.saveFullHistory([...otherRecords, ...caseRecords]);

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
    const full = this.loadFullHistory();
    const idx = full.records.findIndex((r) => r.id === decisionId);
    if (idx < 0) return null;
    const now = new Date().toISOString();
    const target = full.records[idx];
    full.records[idx] = { ...target, isActive: false, updatedAt: now };
    this.saveFullHistory(full.records);
    const activeForCase = full.records.filter((r) => r.caseId === target.caseId && r.isActive);
    this.syncActiveSet(target.caseId, activeForCase);
    return full.records[idx];
  }
}
