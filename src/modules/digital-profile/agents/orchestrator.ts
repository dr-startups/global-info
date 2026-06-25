/**
 * Orchestrator entry point for running agents.
 *
 * The DB/audit-aware execution lives in `agent-run-service`; this module is the
 * stable "agents" facade that the API routes call, plus the canonical full-audit
 * order. Keeping a single implementation avoids divergence between "run one
 * agent" and "run full audit".
 */

export { runAgent, runFullAudit } from "../services/agent-run-service";
export { FULL_AUDIT_ORDER } from "./registry";
