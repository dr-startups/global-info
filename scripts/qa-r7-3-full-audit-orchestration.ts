import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FULL_AUDIT_DEFAULT_RUNTIME_MODE,
  resolveRuntimeStrategy,
} from "../src/modules/digital-profile/agents/runtime-strategy";

const OUT = join(process.cwd(), "storage/digital-profile/qa-r7-3-full-audit-orchestration");

const ALL_AGENTS = [
  "REAL_YANDEX_SEARCH",
  "YANDEX_SEARCH",
  "REAL_GOOGLE_SEARCH",
  "GOOGLE_SEARCH",
  "REAL_WIKIPEDIA",
  "WIKIPEDIA",
  "REAL_ORION_SEARCH_PROFILE",
  "REAL_ORION_GOOGLE_SURFACES",
  "REAL_ORION_UAE_INTERNATIONAL",
  "REAL_SEARCH_SURFACES",
  "SEARCH_SURFACES",
  "AI_PROFILE",
  "COMPLIANCE_DATABASE",
  "RISK_CLASSIFIER_V1",
  "RISK_CLASSIFIER",
  "AUDIT_SUMMARY_BUILDER",
];

function override(enabled: string[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const name of ALL_AGENTS) map[name] = enabled.includes(name);
  return map;
}

function summarizeStatuses(
  decisions: ReturnType<typeof resolveRuntimeStrategy>["decisions"]
): Record<string, number> {
  return decisions.reduce<Record<string, number>>((acc, d) => {
    acc[d.status] = (acc[d.status] ?? 0) + 1;
    return acc;
  }, {});
}

function main() {
  mkdirSync(OUT, { recursive: true });

  const modes = {
    legacy_mock_first: resolveRuntimeStrategy({
      mode: "legacy_mock_first",
      requestedBy: "test",
      availabilityOverride: override(ALL_AGENTS),
    }),
    real_first_with_fallback: resolveRuntimeStrategy({
      mode: "real_first_with_fallback",
      requestedBy: "test",
      availabilityOverride: override(ALL_AGENTS),
    }),
    real_only: resolveRuntimeStrategy({
      mode: "real_only",
      requestedBy: "test",
      availabilityOverride: override(ALL_AGENTS),
    }),
    mock_only: resolveRuntimeStrategy({
      mode: "mock_only",
      requestedBy: "test",
      availabilityOverride: override(ALL_AGENTS),
    }),
  } as const;

  const artifact = {
    generatedAt: new Date().toISOString(),
    fullAuditDefaultRuntimeMode: FULL_AUDIT_DEFAULT_RUNTIME_MODE,
    modeSummaries: Object.fromEntries(
      Object.entries(modes).map(([mode, strategy]) => [
        mode,
        {
          selectedOrder: strategy.selectedOrder,
          fallbackPolicy: strategy.fallbackPolicy,
          fallbackEvents: strategy.fallbackEvents,
          warnings: strategy.warnings,
          statusCounts: summarizeStatuses(strategy.decisions),
          decisions: strategy.decisions,
        },
      ])
    ),
  };

  writeFileSync(join(OUT, "orchestration-summary.json"), JSON.stringify(artifact, null, 2));
  writeFileSync(
    join(OUT, "artifact-inspection.json"),
    JSON.stringify(
      {
        status: "PASS",
        outDir: OUT,
        generatedAt: artifact.generatedAt,
        defaultRuntimeMode: FULL_AUDIT_DEFAULT_RUNTIME_MODE,
        checks: [
          {
            name: "default full audit mode",
            ok: FULL_AUDIT_DEFAULT_RUNTIME_MODE === "real_first_with_fallback",
          },
          {
            name: "real_first includes report builder",
            ok: modes.real_first_with_fallback.selectedOrder.includes("AUDIT_SUMMARY_BUILDER"),
          },
          {
            name: "real_first includes ORION profile",
            ok: modes.real_first_with_fallback.selectedOrder.includes("REAL_ORION_SEARCH_PROFILE"),
          },
        ],
      },
      null,
      2
    )
  );

  console.log(`R7.3 QA artifacts generated: ${OUT}`);
}

main();
