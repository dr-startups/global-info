/**
 * B-2B — final zero-allowlist src/** subject-identity scan (NETWORK_CALLS=0).
 *
 * Walks every runtime TypeScript file under src/** and asserts NONE carries a
 * subject-identity (Glinka case) literal. There is NO per-file allowlist: the
 * only exclusions are structural — fixtures, tests, samples and baselines —
 * where subject-specific data is legitimately allowed to live.
 *
 * Any runtime module that still hardcodes the subject's name, aliases,
 * associates or benchmark facts is a universality violation and must be
 * removed, relocated to a fixture/baseline, or parameterized from
 * SubjectIdentityProfile.
 *
 * Run: NETWORK_CALLS=0 npx tsx --test scripts/smoke-orion-src-identity-scan.ts
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

before(() => {
  process.env.NETWORK_CALLS = "0";
});

const SRC_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "src");

// Subject-identity literals only (proper nouns tied to the baseline subject):
// name, aliases, associates, companies and identifiers. Generic role vocabulary
// such as "композитор"/"composer" is universal namesake logic and is NOT listed.
const IDENTITY_LEAK_RE =
  /глинк|glinka|махмудов|makhmudov|бокарев|bokarev|ликсутов|liksutov|трансмаш|transmash|лаврова|lavrova|дерипаск|deripaska|nutriband|773800015809/i;

/** Structural (path-convention) exclusions — fixtures/tests/samples/baselines only. */
function isExcluded(rel: string): boolean {
  return (
    /\/(fixtures|__fixtures__|__tests__|__mocks__|baselines)\//.test(rel) ||
    /\.test\.tsx?$/.test(rel) ||
    /\.fixtures\.tsx?$/.test(rel) ||
    /\/fixtures\.tsx?$/.test(rel) ||
    /\/sample-contracts\.tsx?$/.test(rel)
  );
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
}

describe("B-2B — zero-allowlist src/** subject-identity scan", () => {
  const files: string[] = [];
  walk(SRC_ROOT, files);

  it("no runtime src/** module carries a subject-identity literal", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const rel = f.replace(/\\/g, "/").replace(/.*\/src\//, "src/");
      if (isExcluded(rel)) continue;
      const m = readFileSync(f, "utf8").match(IDENTITY_LEAK_RE);
      if (m) offenders.push(`${rel}: ${m[0]}`);
    }
    assert.deepEqual(
      offenders,
      [],
      `subject-identity literals in runtime src/** (must relocate/parameterize):\n${offenders.join("\n")}`
    );
  });
});
