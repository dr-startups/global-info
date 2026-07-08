/**
 * R10.8b — Planned Prisma model for admin review decisions (documentation only).
 * Do NOT apply this migration in R10.8b. Additive, non-destructive when approved later.
 */

export const ORION_ADMIN_REVIEW_DECISION_TABLE_PLAN = {
  version: "r10-8b-admin-review-decision-table-plan-v1" as const,
  mode: "artifact_now_db_plan" as const,
  tableName: "dp_orion_admin_review_decisions",
  prismaModelName: "OrionAdminReviewDecision",
  rationale: [
    "No existing Prisma model stores ORION Golden admin review decisions.",
    "orion_evidence_decisions (schema plan) is for relevance/routing filters, not analyst admin review.",
    "AuditLog is event-oriented and unsuitable as the primary decision store.",
    "Artifact JSON remains default until an additive migration is explicitly approved and applied.",
  ],
  fields: [
    { name: "id", type: "String @id @default(cuid())" },
    { name: "caseId", type: "String" },
    { name: "evidenceId", type: "String" },
    {
      name: "status",
      type: "String",
      notes: "PENDING|APPROVED|APPROVED_WITH_CAVEAT|APPENDIX_ONLY|EXCLUDED|NEEDS_MORE_SOURCES|WRONG_SUBJECT",
    },
    { name: "reviewerNote", type: "String?", notes: "required for WRONG_SUBJECT/EXCLUDED/NEEDS_MORE_SOURCES in app layer" },
    { name: "approvedClientSummary", type: "String?" },
    { name: "caveatText", type: "String?", notes: "required for APPROVED_WITH_CAVEAT in app layer" },
    { name: "requestedSources", type: "String[] @default([])" },
    { name: "reviewedBy", type: "String?" },
    { name: "reviewedAt", type: "DateTime?" },
    { name: "createdAt", type: "DateTime @default(now())" },
    { name: "updatedAt", type: "DateTime @updatedAt" },
    { name: "decisionVersion", type: "Int" },
    { name: "source", type: "String", notes: "admin_ui|imported_artifact|test_fixture" },
    { name: "isActive", type: "Boolean @default(true)" },
    { name: "previousDecisionId", type: "String?" },
    { name: "metadata", type: "Json?" },
  ],
  indexes: [
    "@@index([caseId, evidenceId, isActive])",
    "@@index([caseId, updatedAt])",
    "@@index([evidenceId])",
    "@@index([status])",
  ],
  relations: ["case Case @relation(fields: [caseId], references: [id], onDelete: Cascade)"],
  historyPolicy: [
    "Never overwrite an existing row in place for a new decision.",
    "On save: set previous active row isActive=false, insert new row with decisionVersion+1 and previousDecisionId.",
    "Latest active decision: WHERE caseId=? AND evidenceId=? AND isActive=true ORDER BY decisionVersion DESC LIMIT 1.",
  ],
  migrationSafety: [
    "Additive CREATE TABLE only.",
    "No DROP, no ALTER destructive, no migrate reset, no db push in R10.8b.",
    "Do not apply to production until R10.8b+ approval.",
  ],
  prismaSchemaSnippet: `
model OrionAdminReviewDecision {
  id                     String   @id @default(cuid())
  caseId                 String
  evidenceId             String
  status                 String
  reviewerNote           String?
  approvedClientSummary  String?
  caveatText             String?
  requestedSources       String[] @default([])
  reviewedBy             String?
  reviewedAt             DateTime?
  createdAt              DateTime @default(now())
  updatedAt              DateTime @updatedAt
  decisionVersion        Int
  source                 String
  isActive               Boolean  @default(true)
  previousDecisionId     String?
  metadata               Json?

  case Case @relation(fields: [caseId], references: [id], onDelete: Cascade)

  @@index([caseId, evidenceId, isActive])
  @@index([caseId, updatedAt])
  @@index([evidenceId])
  @@index([status])
  @@map("dp_orion_admin_review_decisions")
}
`.trim(),
} as const;
