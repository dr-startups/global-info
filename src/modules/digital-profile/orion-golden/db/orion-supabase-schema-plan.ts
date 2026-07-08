/**
 * R10 — Supabase/Postgres schema plan (documentation only; no migrations).
 */

export interface R10PlannedTable {
  table: string;
  purpose: string;
  fields: Array<{
    name: string;
    type: string;
    nullable?: boolean;
    internalOnly?: boolean;
    clientVisible?: boolean;
  }>;
  indexes: string[];
  relationKeys: string[];
  retentionNotes: string;
}

export interface OrionGoldenSupabaseSchemaPlan {
  version: "r10-orion-golden-schema-plan-v1";
  generatedAt: string;
  assumptions: string[];
  tables: R10PlannedTable[];
}

function tbl(input: R10PlannedTable): R10PlannedTable {
  return input;
}

export function buildOrionGoldenSupabaseSchemaPlan(): OrionGoldenSupabaseSchemaPlan {
  return {
    version: "r10-orion-golden-schema-plan-v1",
    generatedAt: new Date().toISOString(),
    assumptions: [
      "Additive tables only; reuse existing dp_cases as parent.",
      "Aligns with existing dp_orion_* where possible; R10 adds evidence_decisions and raw_assets.",
      "Heavy payloads in JSONB; client-safe fields separated in metadata.",
      "No destructive migrations in R10 scope.",
    ],
    tables: [
      tbl({
        table: "orion_report_runs",
        purpose: "One R10 golden pipeline execution per case.",
        fields: [
          { name: "id", type: "text" },
          { name: "case_id", type: "text" },
          { name: "mode", type: "text", internalOnly: true },
          { name: "architecture_version", type: "text", internalOnly: true },
          { name: "status", type: "text" },
          { name: "store_mode", type: "text", internalOnly: true },
          { name: "started_at", type: "timestamptz" },
          { name: "finished_at", type: "timestamptz", nullable: true },
          { name: "warnings_json", type: "jsonb", internalOnly: true },
          { name: "errors_json", type: "jsonb", internalOnly: true },
          { name: "page_count", type: "int4", clientVisible: true },
        ],
        indexes: ["(case_id, started_at desc)", "(status, started_at desc)"],
        relationKeys: ["case_id -> dp_cases.id"],
        retentionNotes: "Keep 90d hot; archive render artifacts separately.",
      }),
      tbl({
        table: "orion_agent_runs",
        purpose: "Per-agent execution log within a report run.",
        fields: [
          { name: "id", type: "text" },
          { name: "report_run_id", type: "text" },
          { name: "layer", type: "text" },
          { name: "agent_key", type: "text" },
          { name: "status", type: "text" },
          { name: "input_summary_json", type: "jsonb", internalOnly: true },
          { name: "output_summary_json", type: "jsonb", internalOnly: true },
          { name: "started_at", type: "timestamptz" },
          { name: "finished_at", type: "timestamptz", nullable: true },
        ],
        indexes: ["(report_run_id, layer)", "(agent_key, started_at desc)"],
        relationKeys: ["report_run_id -> orion_report_runs.id"],
        retentionNotes: "Internal QA and audit trail.",
      }),
      tbl({
        table: "orion_raw_evidence",
        purpose: "Collection layer raw evidence items (full inventory snapshot refs).",
        fields: [
          { name: "id", type: "text" },
          { name: "report_run_id", type: "text" },
          { name: "inventory_id", type: "text" },
          { name: "source", type: "text" },
          { name: "provider", type: "text" },
          { name: "region", type: "text" },
          { name: "payload_json", type: "jsonb", internalOnly: true },
          { name: "collected_at", type: "timestamptz" },
        ],
        indexes: ["(report_run_id)", "(inventory_id)"],
        relationKeys: ["report_run_id -> orion_report_runs.id"],
        retentionNotes: "Full raw retention for replay/debug.",
      }),
      tbl({
        table: "orion_raw_assets",
        purpose: "Screenshots, Lexis pages, image/video asset refs.",
        fields: [
          { name: "id", type: "text" },
          { name: "report_run_id", type: "text" },
          { name: "asset_kind", type: "text" },
          { name: "storage_ref", type: "text", internalOnly: true },
          { name: "caption", type: "text", clientVisible: true },
          { name: "metadata_json", type: "jsonb", internalOnly: true },
        ],
        indexes: ["(report_run_id, asset_kind)"],
        relationKeys: ["report_run_id -> orion_report_runs.id"],
        retentionNotes: "Binary assets in object storage; DB holds refs only.",
      }),
      tbl({
        table: "orion_normalized_evidence",
        purpose: "Filtering layer normalized evidence.",
        fields: [
          { name: "id", type: "text" },
          { name: "report_run_id", type: "text" },
          { name: "inventory_id", type: "text" },
          { name: "payload_json", type: "jsonb", internalOnly: true },
        ],
        indexes: ["(report_run_id)", "(inventory_id)"],
        relationKeys: ["report_run_id -> orion_report_runs.id"],
        retentionNotes: "Normalized mirror of raw; no deletion.",
      }),
      tbl({
        table: "orion_evidence_decisions",
        purpose: "Relevance/risk/routing decisions with reasons.",
        fields: [
          { name: "id", type: "text" },
          { name: "report_run_id", type: "text" },
          { name: "inventory_id", type: "text" },
          { name: "relevance_class", type: "text" },
          { name: "include_in_client_report", type: "bool" },
          { name: "include_in_appendix", type: "bool" },
          { name: "exclusion_reason", type: "text", nullable: true },
          { name: "human_reason", type: "text", clientVisible: true },
          { name: "decision_json", type: "jsonb", internalOnly: true },
        ],
        indexes: ["(report_run_id, relevance_class)"],
        relationKeys: ["report_run_id -> orion_report_runs.id"],
        retentionNotes: "Required for audit of filtering decisions.",
      }),
      tbl({
        table: "orion_selected_evidence",
        purpose: "Selected evidence per section.",
        fields: [
          { name: "id", type: "text" },
          { name: "report_run_id", type: "text" },
          { name: "section_key", type: "text" },
          { name: "payload_json", type: "jsonb" },
        ],
        indexes: ["(report_run_id, section_key)"],
        relationKeys: ["report_run_id -> orion_report_runs.id"],
        retentionNotes: "Client-facing subset + analysis superset metrics.",
      }),
      tbl({
        table: "orion_excluded_evidence",
        purpose: "Excluded evidence with reasons (never deleted).",
        fields: [
          { name: "id", type: "text" },
          { name: "report_run_id", type: "text" },
          { name: "section_key", type: "text", nullable: true },
          { name: "payload_json", type: "jsonb", internalOnly: true },
        ],
        indexes: ["(report_run_id)"],
        relationKeys: ["report_run_id -> orion_report_runs.id"],
        retentionNotes: "Count excluded for QA routing checks.",
      }),
      tbl({
        table: "orion_section_evidence_packs",
        purpose: "Section-level evidence packs for GPT and renderer.",
        fields: [
          { name: "id", type: "text" },
          { name: "report_run_id", type: "text" },
          { name: "section_key", type: "text" },
          { name: "metrics_json", type: "jsonb", clientVisible: true },
          { name: "payload_json", type: "jsonb", internalOnly: true },
        ],
        indexes: ["(report_run_id, section_key)"],
        relationKeys: ["report_run_id -> orion_report_runs.id"],
        retentionNotes: "Primary input to GPT section analyzer.",
      }),
      tbl({
        table: "orion_section_analyses",
        purpose: "GPT section analysis JSON outputs.",
        fields: [
          { name: "id", type: "text" },
          { name: "report_run_id", type: "text" },
          { name: "section_key", type: "text" },
          { name: "generated_by", type: "text" },
          { name: "payload_json", type: "jsonb", clientVisible: true },
        ],
        indexes: ["(report_run_id, section_key)"],
        relationKeys: ["report_run_id -> orion_report_runs.id"],
        retentionNotes: "Client narrative source; no raw IDs.",
      }),
      tbl({
        table: "orion_executive_syntheses",
        purpose: "Executive summary and risk matrix generated after all section analyses.",
        fields: [
          { name: "id", type: "text" },
          { name: "report_run_id", type: "text" },
          { name: "generated_by", type: "text" },
          { name: "global_risk_level", type: "text", clientVisible: true },
          { name: "payload_json", type: "jsonb", clientVisible: true },
          { name: "section_analysis_refs", type: "jsonb", internalOnly: true },
        ],
        indexes: ["(report_run_id)"],
        relationKeys: ["report_run_id -> orion_report_runs.id"],
        retentionNotes: "Must be created only after orion_section_analyses rows exist.",
      }),
      tbl({
        table: "orion_report_specs",
        purpose: "Final ReportSpec JSON — sole renderer input.",
        fields: [
          { name: "id", type: "text" },
          { name: "report_run_id", type: "text" },
          { name: "version", type: "text" },
          { name: "payload_json", type: "jsonb", clientVisible: true },
        ],
        indexes: ["(report_run_id)"],
        relationKeys: ["report_run_id -> orion_report_runs.id"],
        retentionNotes: "Immutable snapshot per successful run.",
      }),
      tbl({
        table: "orion_render_artifacts",
        purpose: "PPTX/PDF/PNG render outputs.",
        fields: [
          { name: "id", type: "text" },
          { name: "report_run_id", type: "text" },
          { name: "artifact_kind", type: "text" },
          { name: "storage_ref", type: "text", internalOnly: true },
          { name: "size_bytes", type: "int8" },
          { name: "page_count", type: "int4", clientVisible: true },
        ],
        indexes: ["(report_run_id, artifact_kind)"],
        relationKeys: ["report_run_id -> orion_report_runs.id"],
        retentionNotes: "Client downloads reference these rows.",
      }),
      tbl({
        table: "orion_quality_checks",
        purpose: "QA gate results per run.",
        fields: [
          { name: "id", type: "text" },
          { name: "report_run_id", type: "text" },
          { name: "verdict", type: "text" },
          { name: "payload_json", type: "jsonb", internalOnly: true },
        ],
        indexes: ["(report_run_id)", "(verdict, created_at desc)"],
        relationKeys: ["report_run_id -> orion_report_runs.id"],
        retentionNotes: "PASS/BLOCKED_* verdict history.",
      }),
    ],
  };
}

export function exportOrionGoldenSchemaPlanJson(): string {
  return JSON.stringify(buildOrionGoldenSupabaseSchemaPlan(), null, 2);
}
