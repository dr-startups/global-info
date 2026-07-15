import { overlayInventoryByCoverageCells } from "../src/modules/digital-profile/orion-golden/classic/composite-serp-overlay-merge";
import type { FullEvidenceInventory } from "../src/modules/digital-profile/orion-golden/evidence/full-evidence-inventory";
import type { RawInventoryItem } from "../src/modules/digital-profile/orion-golden/types";

let failures = 0;
const check = (name: string, ok: boolean, extra?: string) => {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
};

function item(id: string, region: "RU" | "UAE", engine: "GOOGLE" | "YANDEX", surface: "organic" | "autocomplete"): RawInventoryItem {
  return {
    inventoryId: id,
    caseId: "c",
    reportRunId: "base-run",
    source: "serp_observation",
    provider: engine,
    region,
    query: "q",
    collectedAt: new Date().toISOString(),
    evidenceType: surface === "organic" ? "search_result" : "suggestion",
    title: `${id}-title`,
    snippet: "",
    sourceUrl: `https://example.org/${id}`,
    rawMetadata: { engine, surface, observationKey: id },
  };
}

const base: FullEvidenceInventory = {
  caseId: "c",
  reportRunId: "base-run",
  generatedAt: new Date().toISOString(),
  warnings: [],
  items: [item("b1", "RU", "GOOGLE", "organic"), item("b2", "UAE", "GOOGLE", "autocomplete")],
  counts: { searchResults: 1 },
  countsByEvidenceType: { search_result: 1, suggestion: 1, related_query: 0 },
  mediaAvailability: { suggestions: 1, relatedQueries: 0 },
};

const enrich = [item("e1", "RU", "GOOGLE", "organic")];
const coverage = new Map<string, { region: string; engine: string; surface: string; count: number; status: "COLLECTED" }>();
coverage.set("RU|GOOGLE|organic", { region: "RU", engine: "GOOGLE", surface: "organic", count: 1, status: "COLLECTED" });

const merged = overlayInventoryByCoverageCells({
  baseInventory: base,
  enrichmentItems: enrich,
  coveredCells: coverage,
  baseReportRunId: "base-run",
  enrichmentRunIds: ["enrich-run"],
});

check("RU organic replaced by enrichment", merged.inventory.items.some((x) => x.inventoryId === "e1"));
check("base-only UAE autocomplete preserved", merged.inventory.items.some((x) => x.inventoryId === "b2"));
check("composite provenance generated", merged.provenance.version === "composite-serp-merge-v1");

if (failures > 0) process.exitCode = 1;
console.log(failures ? `FAILED ${failures}` : "ALL PASS");
