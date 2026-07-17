/**
 * B-1 — route/UI wiring contract for the single canonical CTA (NETWORK_CALLS=0).
 *
 * Offline source-contract proof that the production CTA and report route flow
 * through the unified orchestrator (canonical prepare), with no legacy report
 * route on the primary path.
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-canonical-route-ui-e2e.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

const SRC = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");
const read = (rel: string): string => readFileSync(join(SRC, rel), "utf8");

describe("B-1 — single CTA route wiring", () => {
  const routeSrc = read("app/api/digital-profile/cases/[id]/unified-collection/route.ts");

  it("POST drives the unified orchestrator (canonical flow)", () => {
    assert.match(routeSrc, /export const POST/);
    assert.match(routeSrc, /startUnifiedOrionCollection/);
    assert.match(routeSrc, /getUnifiedCollectionStatus/);
  });

  it("route imports no legacy classic report service / composer", () => {
    assert.doesNotMatch(routeSrc, /orion-classic-audit-report-service/);
    assert.doesNotMatch(routeSrc, /orion-first36-deck-composer|orion-classic-audit-deck-composer/);
    assert.doesNotMatch(routeSrc, /report\/generate/);
  });
});

describe("B-1 — client CTA wiring", () => {
  const api = read("modules/digital-profile/client/api.ts");
  const view = read("modules/digital-profile/client/CaseDetailView.tsx");

  it("client api targets the unified-collection endpoint", () => {
    assert.match(api, /cases\/\$\{caseId\}\/unified-collection/);
    assert.match(api, /export function startUnifiedOrionCollection/);
  });

  it("primary CTA handler starts the unified collection and polls to a terminal stage", () => {
    assert.match(view, /startUnifiedOrionCollection\(caseId\)/);
    assert.match(view, /REPORT_READY/);
    assert.match(view, /COMPLETED_PARTIAL/);
  });
});
