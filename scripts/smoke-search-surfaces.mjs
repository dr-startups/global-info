/**
 * Smoke test for search surfaces (Stage H3). No API keys required.
 *
 * Verifies: manual create (suggestion/related/image/video/knowledge), dedup,
 * mock surface agent populates all surfaces + idempotency, provider capabilities,
 * unsupported surfaces don't fail, and existing mock/real agents still listed.
 *
 * Prerequisites: DIGITAL_PROFILE_ENABLED=true, dev server running.
 * Run:  npm run smoke:search-surfaces
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-surfaces" };

let failures = 0;
function check(name, ok, extra) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

async function req(method, url, body) {
  const res = await fetch(url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* */
  }
  return { status: res.status, json };
}

async function listSurfaces(caseId, type) {
  const r = await req("GET", `${API}/cases/${caseId}/search-surfaces${type ? `?type=${type}` : ""}`);
  return r.json?.data ?? [];
}

async function main() {
  console.log(`Smoke testing search surfaces at ${API}\n`);

  // Provider capabilities
  const prov = await req("GET", `${API}/providers`);
  check("GET providers -> 200", prov.status === 200);
  const google = (prov.json?.data ?? []).find((p) => p.name === "GOOGLE");
  check("provider has capabilities block", !!google?.capabilities);
  check("organicSearch supported (OFFICIAL_API)", google?.capabilities?.organicSearch?.method === "OFFICIAL_API");
  check("imageSearch NOT_SUPPORTED (no scraping)", google?.capabilities?.imageSearch?.method === "NOT_SUPPORTED");

  // Setup case
  const c = await req("POST", `${API}/cases`, {
    fullName: "Surface Test Person",
    aliases: ["S. Test"],
    targetRegions: ["RU"],
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  const caseId = c.json?.data?.id;
  check("setup: case created", c.status === 201 && !!caseId);
  if (!caseId) process.exit(1);

  // Manual creates
  const s1 = await req("POST", `${API}/cases/${caseId}/search-surfaces`, {
    type: "SUGGESTION",
    query: "surface test person biography",
  });
  check("manual suggestion -> 201", s1.status === 201);
  const r1 = await req("POST", `${API}/cases/${caseId}/search-surfaces`, {
    type: "RELATED_QUERY",
    query: "who is surface test person",
  });
  check("manual related query -> 201", r1.status === 201);
  const i1 = await req("POST", `${API}/cases/${caseId}/search-surfaces`, {
    type: "IMAGE_RESULT",
    title: "Manual image",
    url: "https://example.com/p",
    imageUrl: "https://example.com/p.jpg",
  });
  check("manual image -> 201", i1.status === 201);
  const v1 = await req("POST", `${API}/cases/${caseId}/search-surfaces`, {
    type: "VIDEO_RESULT",
    title: "Manual video",
    videoUrl: "https://video.example/watch?v=abc",
  });
  check("manual video -> 201", v1.status === 201);
  const k1 = await req("POST", `${API}/cases/${caseId}/search-surfaces`, {
    type: "KNOWLEDGE_BLOCK",
    title: "Manual knowledge",
    snippet: "Structured note",
  });
  check("manual knowledge -> 201", k1.status === 201);

  // Dedup: re-post the suggestion
  const dup = await req("POST", `${API}/cases/${caseId}/search-surfaces`, {
    type: "SUGGESTION",
    query: "surface test person biography",
  });
  check("duplicate item de-duped (200)", dup.status === 200 && dup.json?.data?.deduplicated === true);

  // Review + delete
  const sid = s1.json?.data?.item?.id;
  const rev = await req("PATCH", `${API}/search-surfaces/${sid}/review`, { reviewStatus: "REVIEWED" });
  check("review surface item", rev.status === 200 && rev.json?.data?.reviewStatus === "REVIEWED");

  // Mock surface agent
  const run1 = await req("POST", `${API}/cases/${caseId}/agents/MOCK_SEARCH_SURFACES/run`);
  check("mock surface agent -> 201 SUCCEEDED", run1.status === 201 && run1.json?.data?.status === "SUCCEEDED");

  const sugg = await listSurfaces(caseId, "SUGGESTION");
  const rel = await listSurfaces(caseId, "RELATED_QUERY");
  const imgs = await listSurfaces(caseId, "IMAGE_RESULT");
  const vids = await listSurfaces(caseId, "VIDEO_RESULT");
  const know = await listSurfaces(caseId, "KNOWLEDGE_BLOCK");
  check("suggestions populated (>=10 incl. manual)", sugg.length >= 10, String(sugg.length));
  check("related populated (>=8)", rel.length >= 8, String(rel.length));
  check("images populated (>=6)", imgs.length >= 6, String(imgs.length));
  check("videos populated (>=3)", vids.length >= 3, String(vids.length));
  check("knowledge populated (>=1)", know.length >= 1, String(know.length));
  check("mock items flagged demo + source=MOCK", sugg.some((s) => s.demo === true && s.source === "MOCK"));

  const totalBefore = (await listSurfaces(caseId)).length;
  await req("POST", `${API}/cases/${caseId}/agents/MOCK_SEARCH_SURFACES/run`);
  const totalAfter = (await listSurfaces(caseId)).length;
  check("mock surface re-run did not duplicate", totalAfter === totalBefore, `${totalBefore} -> ${totalAfter}`);

  // Real surface agent (capability notes; unsupported surfaces must not fail)
  const realRun = await req("POST", `${API}/cases/${caseId}/agents/REAL_SEARCH_SURFACES/run`);
  check("real surface agent -> 201 SUCCEEDED", realRun.status === 201 && realRun.json?.data?.status === "SUCCEEDED");
  const notes = (await listSurfaces(caseId, "MANUAL_NOTE")).filter((n) => n.classification === "CAPABILITY_NOTE");
  check("real surface produced capability notes", notes.length >= 1, String(notes.length));
  check("capability notes are real (demo=false)", notes.every((n) => n.demo === false));
  const totalReal1 = (await listSurfaces(caseId, "MANUAL_NOTE")).length;
  await req("POST", `${API}/cases/${caseId}/agents/REAL_SEARCH_SURFACES/run`);
  const totalReal2 = (await listSurfaces(caseId, "MANUAL_NOTE")).length;
  check("real surface re-run did not duplicate", totalReal1 === totalReal2, `${totalReal1} -> ${totalReal2}`);

  // Existing agents still present
  const agents = await req("GET", `${API}/cases/${caseId}/agents`);
  const names = (agents.json?.data ?? []).map((a) => a.name);
  check("mock agents still listed", ["YANDEX_SEARCH", "GOOGLE_SEARCH", "WIKIPEDIA"].every((n) => names.includes(n)));
  check("real wikipedia still listed", names.includes("REAL_WIKIPEDIA"));
  check("mock + real surface agents listed", names.includes("MOCK_SEARCH_SURFACES") && names.includes("REAL_SEARCH_SURFACES"));

  // Mock full audit not broken by H3
  const audit = await req("POST", `${API}/cases/${caseId}/audit/run`);
  check("mock full audit still works", audit.status === 201 && audit.json?.data?.outcome === "SUCCESS", audit.json?.data?.outcome);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
