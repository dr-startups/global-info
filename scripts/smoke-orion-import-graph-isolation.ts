/**
 * B-1 — production import-graph isolation (NETWORK_CALLS=0).
 *
 * Two rigorous checks:
 *   1. REPORT PATH (strict: static + dynamic import()): the canonical prepare +
 *      render adapter graph — the ONLY path that sets REPORT_READY — has zero
 *      reachability to the legacy monolithic composer. This is the fail-closed
 *      guarantee: production report generation can never invoke legacy.
 *   2. PRODUCTION ENTRIES (static bundle): the CTA route + unified orchestrator
 *      + canonical prepare eagerly bundle nothing legacy.
 *
 * The arsenkin enrichment subsystem still carries a *dynamic*, diagnostic-only
 * edge to the legacy classic report renderer (its own stepRendering). That edge
 * is never on the unified REPORT_READY path and is the explicit target of B-2B;
 * it is asserted to remain OFF the canonical report path here.
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-orion-import-graph-isolation.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

const SRC_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");

const LEGACY_COMPOSER_RE =
  /classic\/(orion-classic-theme-set|orion-first36-deck-composer|orion-classic-audit-deck-composer|orion-classic-client-content-to-report-spec|orion-classic-text-utils|serp-position-tables)|orion-classic-audit-report-service|run-r10-orion-golden-e2e/;
// Subject-identity literals only (proper nouns tied to the baseline subject).
// Generic role vocabulary ("композитор"/"composer") is universal namesake logic.
const IDENTITY_LEAK_RE =
  /глинк|glinka|махмудов|makhmudov|бокарев|bokarev|ликсутов|liksutov|трансмаш|transmash|лаврова|lavrova|дерипаск|deripaska|nutriband|773800015809/i;

function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(SRC_ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = join(dirname(fromFile), spec);
  else return null;
  for (const cand of [`${base}.ts`, join(base, "index.ts"), `${base}.tsx`]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

function specifiers(src: string, opts: { dynamic: boolean }): string[] {
  const out: string[] = [];
  const fromRe = /(?:^|\n)\s*(?:import|export)\b([^;\n]*?)\bfrom\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(src)) !== null) {
    const clause = (m[1] ?? "").trimStart();
    if (clause.startsWith("type")) continue; // type-only import = erased, no runtime edge
    out.push(m[2]!);
  }
  const sideRe = /(?:^|\n)\s*import\s*["']([^"']+)["']/g;
  while ((m = sideRe.exec(src)) !== null) out.push(m[1]!);
  if (opts.dynamic) {
    const dynRe = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
    while ((m = dynRe.exec(src)) !== null) out.push(m[1]!);
  }
  return out;
}

function buildGraph(entries: string[], opts: { dynamic: boolean }): {
  graph: Set<string>;
  parent: Map<string, string>;
} {
  const parent = new Map<string, string>();
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file) || !existsSync(file)) continue;
    seen.add(file);
    for (const spec of specifiers(readFileSync(file, "utf8"), opts)) {
      const resolved = resolveImport(file, spec);
      if (resolved) {
        if (!parent.has(resolved)) parent.set(resolved, file);
        queue.push(resolved);
      }
    }
  }
  return { graph: seen, parent };
}

function chainTo(parent: Map<string, string>, file: string): string {
  const rels: string[] = [];
  let cur: string | undefined = file;
  let guard = 0;
  while (cur && guard++ < 60) {
    rels.push(cur.replace(/\\/g, "/").replace(/.*\/src\//, "src/"));
    cur = parent.get(cur);
  }
  return rels.reverse().join("\n   -> ");
}

const CANONICAL_REPORT_ENTRIES = [
  join(SRC_ROOT, "modules/digital-profile/services/canonical-report-prepare.ts"),
  join(SRC_ROOT, "modules/digital-profile/services/render-deck-artifacts.ts"),
];
const PRODUCTION_ENTRIES = [
  join(SRC_ROOT, "app/api/digital-profile/cases/[id]/unified-collection/route.ts"),
  join(SRC_ROOT, "modules/digital-profile/services/unified-orion-collection-orchestrator.ts"),
  ...CANONICAL_REPORT_ENTRIES,
];

describe("B-1 — production import-graph isolation", () => {
  it("all production entry files exist", () => {
    for (const f of PRODUCTION_ENTRIES) assert.ok(existsSync(f), `missing entry: ${f}`);
  });

  it("REPORT PATH is legacy-free (static + dynamic): canonical prepare never reaches legacy", () => {
    const { graph, parent } = buildGraph(CANONICAL_REPORT_ENTRIES, { dynamic: true });
    const offenders = [...graph].filter((f) => LEGACY_COMPOSER_RE.test(f.replace(/\\/g, "/")));
    if (offenders.length) for (const o of offenders) console.error(`\nCHAIN:\n   ${chainTo(parent, o)}\n`);
    assert.deepEqual(
      offenders,
      [],
      `legacy reachable from the canonical REPORT path: ${offenders.join(", ")}`
    );
  });

  it("PRODUCTION ENTRIES bundle nothing legacy (static graph)", () => {
    const { graph, parent } = buildGraph(PRODUCTION_ENTRIES, { dynamic: false });
    const offenders = [...graph].filter((f) => LEGACY_COMPOSER_RE.test(f.replace(/\\/g, "/")));
    if (offenders.length) for (const o of offenders) console.error(`\nCHAIN:\n   ${chainTo(parent, o)}\n`);
    assert.deepEqual(
      offenders,
      [],
      `legacy statically bundled by production entries: ${offenders.join(", ")}`
    );
  });

  it("canonical report path carries no subject-identity (Glinka) literals", () => {
    const { graph } = buildGraph(CANONICAL_REPORT_ENTRIES, { dynamic: true });
    const offenders: string[] = [];
    for (const f of graph) {
      const rel = f.replace(/\\/g, "/");
      if (/\/(fixtures|__fixtures__|sample-contracts|baselines)\//.test(rel) || /\.test\.ts$/.test(rel)) {
        continue;
      }
      const hit = readFileSync(f, "utf8").match(IDENTITY_LEAK_RE);
      if (hit) offenders.push(`${rel}: ${hit[0]}`);
    }
    assert.deepEqual(offenders, [], `Glinka literals in canonical report path:\n${offenders.join("\n")}`);
  });
});
