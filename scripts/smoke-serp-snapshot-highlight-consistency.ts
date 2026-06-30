/**
 * Smoke test — Stage R1.1.2 SERP snapshot highlight/theme consistency.
 *
 * Run: npm run smoke:serp-snapshot-highlight-consistency
 */

import {
  buildConsistentThemeGrouping,
  assertSnapshotHighlightInvariant,
} from "../src/modules/digital-profile/serp-snapshot/snapshot-consistency";
import {
  selectEngineRowsForSnapshot,
} from "../src/modules/digital-profile/serp-snapshot/data-loader";
import { resolveHighlight } from "../src/modules/digital-profile/serp-snapshot/highlight-resolver";
import type { LoadedResult } from "../src/modules/digital-profile/serp-snapshot/types";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const RENDERER_URL = process.env.RENDERER_URL ?? "http://localhost:8080";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-r112-highlight" };

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

function row(partial: Partial<LoadedResult> & { id: string }): LoadedResult {
  return {
    id: partial.id,
    engine: partial.engine ?? "YANDEX",
    rank: partial.rank ?? 1,
    title: partial.title ?? "Title",
    url: partial.url ?? "https://lenta.ru/a",
    domain: partial.domain ?? "lenta.ru",
    snippet: partial.snippet ?? "Snippet",
    classification: partial.classification ?? "UNCLASSIFIED",
    riskTheme: partial.riskTheme ?? null,
    region: null,
    language: null,
    source: partial.source ?? "real:YANDEX",
    createdAt: new Date(0),
    isHighlighted: partial.isHighlighted ?? false,
    themeTitle: partial.themeTitle ?? null,
  };
}

async function req(method: string, url: string, body?: unknown) {
  const res = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* */
  }
  return { status: res.status, json: json as Record<string, unknown> | null };
}

function data<T>(json: Record<string, unknown> | null): T | undefined {
  return json?.data as T | undefined;
}

function offlineChecks() {
  console.log("\n--- Offline highlight consistency ---\n");

  // 1. No highlighted rows => empty themes
  const neutral = [row({ id: "n1" }), row({ id: "n2", rank: 2 })];
  const g0 = buildConsistentThemeGrouping(neutral, "ru");
  check("no highlights => themeCount 0", g0.themes.length === 0);
  check("no highlights => highlightedCount 0", g0.highlightedCount === 0);
  check("invariant empty", assertSnapshotHighlightInvariant(g0));

  // 2. One LEGAL highlighted row => themeCount 1
  const legal = [
    ...neutral,
    row({ id: "l1", rank: 10, isHighlighted: true, riskTheme: "legal", classification: "LEGAL" }),
  ];
  const g1 = buildConsistentThemeGrouping(legal, "ru");
  check("one LEGAL highlight => themeCount 1", g1.themes.length === 1, String(g1.themes.length));
  check("one LEGAL highlight => highlightedCount 1", g1.highlightedCount === 1);
  check("invariant with highlight", assertSnapshotHighlightInvariant(g1));

  // 3. Highlight outside top-N still included in visible selection
  const mapped = [
    row({ id: "r1", rank: 1 }),
    row({ id: "r2", rank: 2 }),
    row({ id: "r3", rank: 3 }),
    row({ id: "r4", rank: 4 }),
    row({ id: "r5", rank: 5 }),
    row({ id: "h6", rank: 6, isHighlighted: true, riskTheme: "legal", classification: "LEGAL" }),
  ];
  const visible = selectEngineRowsForSnapshot(mapped, "prefer_real", 5);
  check("highlight rank 6 kept in top 5 cap", visible.some((r) => r.id === "h6"), visible.map((r) => r.id).join(","));
  check("highlight appears first in visible list", visible[0]?.id === "h6", visible.map((r) => r.id).join(","));
  const gCap = buildConsistentThemeGrouping(visible, "en");
  check("visible cap grouping themeCount 1", gCap.themes.length === 1);

  // 4. Clear manual classification removes highlight
  const cleared = resolveHighlight({
    enumClassification: "LEGAL",
    riskClassification: {
      manual: {
        classification: "NEUTRAL",
        riskTheme: null,
        rationale: null,
        reviewedBy: null,
        reviewedAt: "",
      },
    },
    findings: [],
  });
  check("manual neutral clears highlight", !cleared.isHighlighted);

  // 5. Unlinked finding does not highlight row without evidence link
  const unlinked = resolveHighlight({
    enumClassification: "UNCLASSIFIED",
    riskClassification: null,
    findings: [],
  });
  check("no linked finding => not highlighted", !unlinked.isHighlighted);
}

async function apiChecks() {
  console.log("\n--- API integration ---\n");

  try {
    const h = await fetch(`${RENDERER_URL}/health`);
    check("renderer /health ok", h.status === 200);
  } catch (e) {
    check("renderer /health ok", false, String(e));
    return;
  }

  const caseRes = await req("POST", `${API}/cases`, {
    fullName: "R1.1.2 Highlight Consistency",
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  const caseId = data<{ id: string }>(caseRes.json)?.id;
  check("case created", !!caseId);
  if (!caseId) return;

  // Real neutral rows only
  for (let i = 1; i <= 3; i++) {
    await req("POST", `${API}/cases/${caseId}/search-results`, {
      engine: "YANDEX",
      url: `https://lenta.ru/r112-neutral-${i}`,
      title: `Neutral article ${i}`,
      classification: "UNCLASSIFIED",
    });
  }

  // Pending unlinked compliance finding (DATABASE_PROFILE evidence, no search row link)
  await req("POST", `${API}/cases/${caseId}/compliance/manual-import`, {
    provider: "DOW_JONES",
    matchedName: "R1.1.2 Unlinked Subject",
    riskTypes: ["SANCTIONS"],
    matchScore: 72,
    confidence: "MEDIUM",
  });

  await req("POST", `${API}/cases/${caseId}/serp-snapshot/generate`, {});
  const snap1 = data<{ snapshot: { themeCount: number; highlightedCount: number } }>(
    (await req("GET", `${API}/cases/${caseId}/serp-snapshot`)).json
  )?.snapshot;
  check("unlinked findings => themeCount 0", (snap1?.themeCount ?? -1) === 0, String(snap1?.themeCount));
  check("unlinked findings => highlightedCount 0", (snap1?.highlightedCount ?? -1) === 0, String(snap1?.highlightedCount));

  const gen1 = await req("POST", `${API}/cases/${caseId}/report/generate`, { reportLanguage: "ru" });
  const warnings1 = ((data<{ reportJson: { meta?: { reportWarnings?: unknown[] } } }>(gen1.json)?.reportJson?.meta
    ?.reportWarnings ?? []) as unknown[]);
  check(
    "internal warning for unlinked findings",
    warnings1.some((w) => {
      const text = typeof w === "string" ? w : (w as { text?: string })?.text ?? "";
      return /несвязанн|unlinked/i.test(text);
    })
  );

  // Manually mark one row LEGAL
  const listRes = await req("GET", `${API}/cases/${caseId}/search-results`);
  const results = data<Array<{ id: string }>>(listRes.json);
  const target = results?.[0]?.id;
  if (target) {
    await req("PATCH", `${BASE_URL}/api/digital-profile/search-results/${target}/classification`, {
      classification: "LEGAL_DISPUTE",
      riskTheme: "legal_dispute",
    });
  }
  check("manual LEGAL classification set", !!target);

  await req("POST", `${API}/cases/${caseId}/serp-snapshot/generate`, {});
  const snap2 = data<{ snapshot: { themeCount: number; highlightedCount: number } }>(
    (await req("GET", `${API}/cases/${caseId}/serp-snapshot`)).json
  )?.snapshot;
  check("manual LEGAL => themeCount 1", snap2?.themeCount === 1, String(snap2?.themeCount));
  check("manual LEGAL => highlightedCount 1", snap2?.highlightedCount === 1, String(snap2?.highlightedCount));
  check(
    "theme/highlight counts consistent",
    (snap2?.themeCount ?? 0) > 0 === (snap2?.highlightedCount ?? 0) > 0
  );

  const enRender = await req("POST", `${API}/cases/${caseId}/report/render`, {
    templateVersion: "report-template-v3",
    audience: "client",
    watermarkMode: "none",
    reportLanguage: "en",
  });
  const en = data<{ slideCount: number; watermarkMode: string; warnings?: string[] }>(enRender.json);
  check("EN/Client render", enRender.status === 201);
  check("EN 50 slides", en?.slideCount === 50, String(en?.slideCount));
  check(
    "EN no unlinked/internal SERP warning in render warnings",
    !(en?.warnings ?? []).some((w) => /unlinked|несвязанн|demo\/mock/i.test(w))
  );
}

async function main() {
  console.log("Smoke testing R1.1.2 SERP snapshot highlight consistency\n");
  offlineChecks();
  await apiChecks();
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
