const API = "http://localhost:3000/api/digital-profile";
const H = { "content-type": "application/json", "x-actor-id": "manual-qa-o1-o4" };

async function req(method: string, path: string, body?: unknown) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = (await r.json()) as { data?: unknown };
  return { status: r.status, data: (j.data ?? j) as Record<string, unknown> };
}

async function main() {
  const existingId = process.argv[2];
  let id = existingId;
  if (!id) {
    const c = await req("POST", "/cases", {
      fullName: "Томилин Константин Романович",
      lawfulBasis: "LEGITIMATE_INTEREST",
      consentStatus: "NOT_REQUIRED",
      targetRegions: ["RU", "UAE", "INTERNATIONAL"],
    });
    id = String(c.data.id);
  }
  console.log("CASE_ID", id);

  for (const a of [
    "REAL_ORION_SEARCH_PROFILE",
    "REAL_ORION_GOOGLE_SURFACES",
    "REAL_ORION_UAE_INTERNATIONAL",
    "RISK_CLASSIFIER_V1",
  ]) {
    const r = await req("POST", `/cases/${id}/agents/${a}/run`, {});
    console.log(a, r.data.status, r.data.summary ?? r.data.saved);
  }

  const sr = await req("GET", `/cases/${id}/search-results`);
  const ss = await req("GET", `/cases/${id}/search-surfaces`);
  const organic = (Array.isArray(sr.data) ? sr.data : (sr.data.items as unknown[])) ?? [];
  const surfaces = (Array.isArray(ss.data) ? ss.data : (ss.data.items as unknown[])) ?? [];
  console.log("organic", organic.length);
  console.log("surfaces", surfaces.length);
  const byType: Record<string, number> = {};
  const byRegion: Record<string, number> = {};
  for (const s of surfaces as Array<{ type: string; region?: string }>) {
    byType[s.type] = (byType[s.type] ?? 0) + 1;
    const reg = (s.region ?? "?").toUpperCase();
    byRegion[reg] = (byRegion[reg] ?? 0) + 1;
  }
  console.log("byType", JSON.stringify(byType));
  console.log("byRegion", JSON.stringify(byRegion));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
