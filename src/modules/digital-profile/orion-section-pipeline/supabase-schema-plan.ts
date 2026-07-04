export interface PlannedTable {
  table: string;
  purpose: string;
  columns: Array<{ name: string; type: string; nullable?: boolean; internalOnly?: boolean; clientVisible?: boolean }>;
  indexes: string[];
  foreignKeys: string[];
  rls: string[];
  migrationRisk: "low" | "medium" | "high";
}

export interface OrionSupabaseSchemaPlan {
  mode: "orion_section_pipeline_v1";
  generatedAt: string;
  assumptions: string[];
  tables: PlannedTable[];
  minimalAdditionsOnly: string[];
}

function tbl(input: PlannedTable): PlannedTable {
  return input;
}

export function buildOrionSupabaseSchemaPlan(): OrionSupabaseSchemaPlan {
  return {
    mode: "orion_section_pipeline_v1",
    generatedAt: new Date().toISOString(),
    assumptions: [
      "Reuse existing case/report_version tables and link by case_id/report_version_id when available.",
      "Avoid destructive migrations and avoid changing existing R7/R8 paths.",
      "Persist client-facing and internal-only fields in separate columns/JSON blocks.",
    ],
    minimalAdditionsOnly: [
      "Additive tables only; no existing table drops/renames.",
      "Reuse existing case ids and report version ids as FK parents.",
      "Store heavy evidence payloads in JSONB with safe evidence ids.",
    ],
    tables: [
      tbl({
        table: "report_runs",
        purpose: "One pipeline execution per case and mode.",
        columns: [
          { name: "id", type: "uuid" },
          { name: "case_id", type: "uuid" },
          { name: "mode", type: "text", clientVisible: false },
          { name: "status", type: "text" },
          { name: "started_at", type: "timestamptz" },
          { name: "finished_at", type: "timestamptz", nullable: true },
          { name: "warnings_json", type: "jsonb", internalOnly: true },
          { name: "errors_json", type: "jsonb", internalOnly: true },
        ],
        indexes: ["(case_id, started_at desc)", "(mode, started_at desc)"],
        foreignKeys: ["case_id -> cases.id"],
        rls: ["analyst/admin can read/write", "client read only finalized client-safe rows"],
        migrationRisk: "low",
      }),
      tbl({
        table: "report_macro_sections",
        purpose: "Section-level execution and composition state.",
        columns: [
          { name: "id", type: "uuid" },
          { name: "report_run_id", type: "uuid" },
          { name: "macro_section_key", type: "text" },
          { name: "section_number", type: "text", nullable: true },
          { name: "order_no", type: "int4" },
          { name: "title_ru", type: "text" },
          { name: "section_manifest_json", type: "jsonb", internalOnly: true },
        ],
        indexes: ["(report_run_id, order_no)"],
        foreignKeys: ["report_run_id -> report_runs.id"],
        rls: ["inherit report_runs ownership"],
        migrationRisk: "low",
      }),
      tbl({
        table: "report_micro_stages",
        purpose: "Micro-stage lifecycle and metadata.",
        columns: [
          { name: "id", type: "uuid" },
          { name: "report_run_id", type: "uuid" },
          { name: "report_macro_section_id", type: "uuid" },
          { name: "micro_stage_key", type: "text" },
          { name: "status", type: "text" },
          { name: "order_no", type: "int4" },
          { name: "requires_gpt55", type: "bool" },
          { name: "requires_visual_evidence", type: "bool" },
          { name: "started_at", type: "timestamptz" },
          { name: "finished_at", type: "timestamptz", nullable: true },
        ],
        indexes: ["(report_run_id, order_no)", "(micro_stage_key)"],
        foreignKeys: ["report_run_id -> report_runs.id", "report_macro_section_id -> report_macro_sections.id"],
        rls: ["inherit report_runs ownership"],
        migrationRisk: "low",
      }),
      tbl({
        table: "section_agent_runs",
        purpose: "Agent invocation details per micro-stage.",
        columns: [
          { name: "id", type: "uuid" },
          { name: "report_micro_stage_id", type: "uuid" },
          { name: "provider_id", type: "text" },
          { name: "agent_name", type: "text" },
          { name: "status", type: "text" },
          { name: "reason", type: "text", nullable: true, internalOnly: true },
          { name: "output_summary_json", type: "jsonb", internalOnly: true },
        ],
        indexes: ["(report_micro_stage_id)", "(provider_id, status)"],
        foreignKeys: ["report_micro_stage_id -> report_micro_stages.id"],
        rls: ["internal only by default"],
        migrationRisk: "low",
      }),
      ...[
        "raw_evidence",
        "normalized_evidence",
        "selected_evidence",
        "excluded_evidence",
        "section_evidence_packs",
        "section_analysis",
        "section_slide_manifests",
      ].map((table) =>
        tbl({
          table,
          purpose: `Per-micro-stage ${table.replace(/_/g, " ")} snapshot.`,
          columns: [
            { name: "id", type: "uuid" },
            { name: "report_micro_stage_id", type: "uuid" },
            { name: "payload_json", type: "jsonb", internalOnly: table !== "section_slide_manifests" },
            { name: "client_payload_json", type: "jsonb", nullable: true, clientVisible: table === "section_slide_manifests" },
            { name: "created_at", type: "timestamptz" },
          ],
          indexes: ["(report_micro_stage_id, created_at desc)"],
          foreignKeys: ["report_micro_stage_id -> report_micro_stages.id"],
          rls: ["internal payload hidden for client role", "client payload readable only when report finalized"],
          migrationRisk: "medium",
        })
      ),
      tbl({
        table: "evidence_files",
        purpose: "Visual references (screenshots/pages/images) metadata.",
        columns: [
          { name: "id", type: "uuid" },
          { name: "report_micro_stage_id", type: "uuid" },
          { name: "safe_evidence_id", type: "text" },
          { name: "file_kind", type: "text" },
          { name: "storage_key", type: "text", internalOnly: true },
          { name: "client_asset_ref", type: "text", nullable: true, clientVisible: true },
          { name: "created_at", type: "timestamptz" },
        ],
        indexes: ["(report_micro_stage_id)", "(safe_evidence_id)"],
        foreignKeys: ["report_micro_stage_id -> report_micro_stages.id"],
        rls: ["never expose storage_key to client role"],
        migrationRisk: "medium",
      }),
      tbl({
        table: "section_deck_artifacts",
        purpose: "Optional per-section rendered artifacts.",
        columns: [
          { name: "id", type: "uuid" },
          { name: "report_macro_section_id", type: "uuid" },
          { name: "audience", type: "text" },
          { name: "pptx_storage_key", type: "text", internalOnly: true },
          { name: "pdf_storage_key", type: "text", internalOnly: true },
          { name: "manifest_json", type: "jsonb" },
        ],
        indexes: ["(report_macro_section_id, audience)"],
        foreignKeys: ["report_macro_section_id -> report_macro_sections.id"],
        rls: ["signed URL indirection for binary access"],
        migrationRisk: "medium",
      }),
      tbl({
        table: "final_deck_manifests",
        purpose: "Final composed deck metadata and TOC pagination.",
        columns: [
          { name: "id", type: "uuid" },
          { name: "report_run_id", type: "uuid" },
          { name: "manifest_json", type: "jsonb" },
          { name: "composition_inspection_json", type: "jsonb", internalOnly: true },
          { name: "client_manifest_json", type: "jsonb", clientVisible: true },
          { name: "created_at", type: "timestamptz" },
        ],
        indexes: ["(report_run_id, created_at desc)"],
        foreignKeys: ["report_run_id -> report_runs.id"],
        rls: ["client reads client_manifest_json only"],
        migrationRisk: "low",
      }),
      tbl({
        table: "report_json_versions",
        purpose: "Internal/client report_json snapshots generated from pipeline.",
        columns: [
          { name: "id", type: "uuid" },
          { name: "report_run_id", type: "uuid" },
          { name: "audience", type: "text" },
          { name: "report_json", type: "jsonb" },
          { name: "policy_hash", type: "text" },
          { name: "created_at", type: "timestamptz" },
        ],
        indexes: ["(report_run_id, audience, created_at desc)"],
        foreignKeys: ["report_run_id -> report_runs.id"],
        rls: ["client audience row only for client role"],
        migrationRisk: "low",
      }),
      tbl({
        table: "report_consistency_checks",
        purpose: "Cross-section validation outcomes with offenders.",
        columns: [
          { name: "id", type: "uuid" },
          { name: "report_run_id", type: "uuid" },
          { name: "status", type: "text" },
          { name: "violations_json", type: "jsonb" },
          { name: "warnings_json", type: "jsonb" },
          { name: "created_at", type: "timestamptz" },
        ],
        indexes: ["(report_run_id, created_at desc)", "(status)"],
        foreignKeys: ["report_run_id -> report_runs.id"],
        rls: ["internal only except summarized status for client"],
        migrationRisk: "low",
      }),
    ],
  };
}

