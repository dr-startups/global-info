-- REMEDIATION 9.3 follow-up: drop ORION section-pipeline microstage tables.
-- Keeps dp_orion_report_runs, dp_orion_arsenkin_stage_runs, and ReportVersion.

DROP TABLE IF EXISTS "dp_orion_report_consistency_checks";
DROP TABLE IF EXISTS "dp_orion_report_json_versions";
DROP TABLE IF EXISTS "dp_orion_final_deck_manifests";
DROP TABLE IF EXISTS "dp_orion_section_deck_artifacts";
DROP TABLE IF EXISTS "dp_orion_section_slide_manifests";
DROP TABLE IF EXISTS "dp_orion_section_analyses";
DROP TABLE IF EXISTS "dp_orion_section_evidence_packs";
DROP TABLE IF EXISTS "dp_orion_evidence_files";
DROP TABLE IF EXISTS "dp_orion_excluded_evidence";
DROP TABLE IF EXISTS "dp_orion_selected_evidence";
DROP TABLE IF EXISTS "dp_orion_normalized_evidence";
DROP TABLE IF EXISTS "dp_orion_raw_evidence";
DROP TABLE IF EXISTS "dp_orion_section_agent_runs";
DROP TABLE IF EXISTS "dp_orion_report_micro_stages";
DROP TABLE IF EXISTS "dp_orion_report_macro_sections";
