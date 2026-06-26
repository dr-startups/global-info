/**
 * Smoke test for Stage N1.2 — ORION snapshot source preference logic.
 *
 * Pure/offline unit checks — NO API keys, NO dev server, NO DB, NO network.
 * Exercises the deterministic helpers that decide which stored rows feed the
 * snapshot per the requested sourcePreference, plus the derived sourceMode /
 * per-engine breakdown:
 *   - prefer_real / real_only / mock_only / mixed selection;
 *   - real Yandex + mock Google -> overall MIXED;
 *   - real_only with no Google real -> Google EMPTY;
 *   - prefer_real never mixes mock Yandex when real Yandex exists;
 *   - per-engine sourceMode derivation;
 *   - default preference is prefer_real;
 *   - no secret-like tokens leak through the selection.
 *
 * Run:  npm run smoke:serp-snapshot-real-source   (uses tsx)
 */

import {
  DEFAULT_SOURCE_PREFERENCE,
  deriveSourceMode,
  engineSourceModeOf,
  selectByPreference,
} from "../src/modules/digital-profile/serp-snapshot";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

type Row = { id: string; source: string | null };

const realY = (i: number): Row => ({ id: `ry${i}`, source: "real:YANDEX" });
const mockY = (i: number): Row => ({ id: `my${i}`, source: null });
const mockG = (i: number): Row => ({ id: `mg${i}`, source: "mock" });
const realG = (i: number): Row => ({ id: `rg${i}`, source: "real:GOOGLE" });

function ids(rows: Row[]): string {
  return rows.map((r) => r.id).join(",");
}

function main() {
  console.log("Smoke testing SERP snapshot source preference (offline)\n");

  // 0. Default preference is prefer_real.
  check("default preference is prefer_real", DEFAULT_SOURCE_PREFERENCE === "prefer_real");

  // 1. Mock-only case -> MOCK_ONLY.
  const mockOnlyRows = [mockY(1), mockY(2), mockG(1)];
  check(
    "mock only -> MOCK_ONLY",
    deriveSourceMode(mockOnlyRows) === "MOCK_ONLY",
    deriveSourceMode(mockOnlyRows)
  );

  // 2. Real Yandex + mock Google -> overall MIXED, perEngine REAL/MOCK.
  const yReal = selectByPreference([realY(1), realY(2), mockY(3)], "prefer_real");
  const gMock = selectByPreference([mockG(1), mockG(2)], "prefer_real");
  const combined = [...yReal, ...gMock];
  check("yandex real + google mock -> MIXED", deriveSourceMode(combined) === "MIXED", deriveSourceMode(combined));
  check("yandex engine -> REAL", engineSourceModeOf(yReal) === "REAL");
  check("google engine -> MOCK", engineSourceModeOf(gMock) === "MOCK");

  // 3. real_only with no Google real -> Google EMPTY.
  const yRealOnly = selectByPreference([realY(1), mockY(2)], "real_only");
  const gRealOnly = selectByPreference([mockG(1), mockG(2)], "real_only");
  check("real_only yandex keeps only real", ids(yRealOnly) === "ry1", ids(yRealOnly));
  check("real_only google with no real -> empty", gRealOnly.length === 0);
  check("real_only google engine -> EMPTY", engineSourceModeOf(gRealOnly) === "EMPTY");
  check(
    "real_only overall (real yandex only) -> REAL_ONLY",
    deriveSourceMode([...yRealOnly, ...gRealOnly]) === "REAL_ONLY"
  );

  // 4. prefer_real never includes mock Yandex when real Yandex exists.
  const preferReal = selectByPreference([realY(1), mockY(2), realY(3)], "prefer_real");
  check(
    "prefer_real excludes mock yandex when real present",
    preferReal.every((r) => r.source === "real:YANDEX") && preferReal.length === 2,
    ids(preferReal)
  );

  // 5. prefer_real falls back to mock when no real exists.
  const preferFallback = selectByPreference([mockY(1), mockY(2)], "prefer_real");
  check("prefer_real falls back to mock", ids(preferFallback) === "my1,my2");

  // 6. mock_only excludes real rows.
  const mockOnly = selectByPreference([realY(1), mockY(2), realG(1), mockG(3)], "mock_only");
  check(
    "mock_only excludes real rows",
    mockOnly.every((r) => r.source === null || r.source === "mock"),
    ids(mockOnly)
  );

  // 7. mixed keeps every row in order.
  const mixedInput = [realY(1), mockY(2), mockG(3)];
  const mixed = selectByPreference(mixedInput, "mixed");
  check("mixed keeps all rows in order", ids(mixed) === "ry1,my2,mg3");
  check("mixed overall -> MIXED", deriveSourceMode(mixed) === "MIXED");

  // 8. Empty selection -> EMPTY.
  check("empty rows -> EMPTY", deriveSourceMode([]) === "EMPTY");
  check("empty engine -> EMPTY", engineSourceModeOf([]) === "EMPTY");

  // 9. Selection returns the same objects (no synthetic secret injection).
  const probe = selectByPreference([realY(1)], "prefer_real");
  const serialized = JSON.stringify(probe);
  check(
    "no secret-like tokens in selection output",
    !/api[-_ ]?key|folder|secret|YANDEX_SEARCH/i.test(serialized),
    serialized
  );

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  if (failures > 0) process.exit(1);
}

main();
