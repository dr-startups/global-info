/**
 * Smoke test for the ORION-style synthetic SERP snapshot generator (Stage S1).
 *
 * Verifies end-to-end generation from stored search_results: valid PNG output,
 * storage key convention, SYNTHETIC metadata, highlighted themes for a rich case,
 * and graceful handling of empty / no-negative cases. NO API keys or secrets are
 * required — the generator is synthetic and key-free.
 *
 * Prerequisites: DIGITAL_PROFILE_ENABLED=true, dev server running.
 * Run:  npm run smoke:serp-snapshot
 */

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const API = `${BASE_URL}/api/digital-profile`;
const H = { "content-type": "application/json", "x-actor-id": "smoke-serp" };

let failures = 0;
function check(name, ok, extra) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

async function req(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: H,
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* */
  }
  return { status: res.status, json };
}

async function createCase(fullName) {
  const r = await req("POST", `${API}/cases`, {
    fullName,
    lawfulBasis: "LEGITIMATE_INTEREST",
    consentStatus: "NOT_REQUIRED",
  });
  return r.json?.data?.id;
}

async function addResult(caseId, engine, url, title, classification) {
  return req("POST", `${API}/cases/${caseId}/search-results`, {
    engine,
    url,
    title,
    classification,
  });
}

function isPng(bytes) {
  return (
    bytes.length > 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  );
}

async function fetchImage(signedUrl) {
  const res = await fetch(`${BASE_URL}${signedUrl}`, { headers: H });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, contentType: res.headers.get("content-type"), buf };
}

async function main() {
  console.log(`Smoke testing SERP snapshot generator at ${API}\n`);

  // -------------------------------------------------------------------------
  // 1. Rich case with negative + neutral results across both engines.
  // -------------------------------------------------------------------------
  const richId = await createCase("Иван Петров Smoke");
  check("setup: rich case created", !!richId);
  if (!richId) process.exit(1);

  await addResult(richId, "YANDEX", "https://news.example/y-fraud-1", "Иван Петров — расследование о мошенничестве", "ADVERSE_MEDIA");
  await addResult(richId, "YANDEX", "https://court.example/y-case-2", "Судебное дело против Ивана Петрова", "LEGAL");
  await addResult(richId, "YANDEX", "https://corp.example/y-profile", "Иван Петров — профиль компании", "CORPORATE");
  await addResult(richId, "GOOGLE", "https://news.example/g-scandal-1", "Ivan Petrov fraud scandal coverage", "ADVERSE_MEDIA");
  await addResult(richId, "GOOGLE", "https://news.example/g-scandal-2", "More adverse media on Ivan Petrov", "ADVERSE_MEDIA");
  await addResult(richId, "GOOGLE", "https://linkedin.example/g-profile", "Ivan Petrov — LinkedIn", "SOCIAL_PROFILE");

  const gen = await req("POST", `${API}/cases/${richId}/serp-snapshot/generate`, { language: "ru" });
  const snap = gen.json?.data?.snapshot;
  check("rich: generate -> 201", gen.status === 201, String(gen.status));
  check("rich: snapshot returned", !!snap);
  check("rich: mode SYNTHETIC (no real provider / no keys)", snap?.mode === "SYNTHETIC", snap?.mode);
  check("rich: storageKey under serp-snapshots/", typeof snap?.storageKey === "string" && snap.storageKey.includes("/serp-snapshots/"), snap?.storageKey);
  check("rich: storageKey ends with png", (snap?.storageKey ?? "").endsWith("orion-serp-snapshot.png"));
  check("rich: themeCount > 0", (snap?.themeCount ?? 0) > 0, String(snap?.themeCount));
  check("rich: highlightedCount > 0", (snap?.highlightedCount ?? 0) > 0, String(snap?.highlightedCount));
  check("rich: resultCount > 0", (snap?.resultCount ?? 0) > 0, String(snap?.resultCount));
  check("rich: signedUrl present", typeof snap?.signedUrl === "string" && snap.signedUrl.length > 0);

  if (snap?.signedUrl) {
    const img = await fetchImage(snap.signedUrl);
    check("rich: image download -> 200", img.status === 200, String(img.status));
    check("rich: content-type image/png", (img.contentType ?? "").includes("image/png"), img.contentType ?? "");
    check("rich: valid PNG signature", isPng(img.buf), `${img.buf.length} bytes`);
    check("rich: PNG non-trivial size (>5KB)", img.buf.length > 5000, `${img.buf.length} bytes`);
  }

  // GET latest returns the same snapshot + SYNTHETIC metadata.
  const latest = await req("GET", `${API}/cases/${richId}/serp-snapshot`);
  const latestSnap = latest.json?.data?.snapshot;
  check("rich: GET latest -> 200", latest.status === 200);
  check("rich: latest matches generated id", latestSnap?.id === snap?.id, `${latestSnap?.id} vs ${snap?.id}`);
  check("rich: latest mode SYNTHETIC", latestSnap?.mode === "SYNTHETIC");

  // report_json carries the snapshot reference (non-breaking integration).
  await req("POST", `${API}/cases/${richId}/report/generate`);
  const rep = await req("GET", `${API}/cases/${richId}/report`);
  const repSnap = rep.json?.data?.reportJson?.serpSnapshot;
  check("rich: report_json.serpSnapshot present", !!repSnap, repSnap ? `mode=${repSnap.mode}` : "missing");
  check("rich: report_json.serpSnapshot mode SYNTHETIC", repSnap?.mode === "SYNTHETIC");

  // -------------------------------------------------------------------------
  // 2. No-negative case — results exist but none are risky.
  // -------------------------------------------------------------------------
  const neutralId = await createCase("Neutral Subject Smoke");
  await addResult(neutralId, "GOOGLE", "https://corp.example/n-1", "Neutral Subject — company", "CORPORATE");
  await addResult(neutralId, "YANDEX", "https://blog.example/n-2", "Neutral Subject blog", "RELEVANT");
  const gen2 = await req("POST", `${API}/cases/${neutralId}/serp-snapshot/generate`, {});
  const snap2 = gen2.json?.data?.snapshot;
  check("no-negative: generate -> 201 (no crash)", gen2.status === 201, String(gen2.status));
  check("no-negative: highlightedCount === 0", (snap2?.highlightedCount ?? -1) === 0, String(snap2?.highlightedCount));
  check("no-negative: themeCount === 0", (snap2?.themeCount ?? -1) === 0, String(snap2?.themeCount));
  if (snap2?.signedUrl) {
    const img2 = await fetchImage(snap2.signedUrl);
    check("no-negative: valid PNG", img2.status === 200 && isPng(img2.buf));
  }

  // -------------------------------------------------------------------------
  // 3. Empty case — no stored results at all.
  // -------------------------------------------------------------------------
  const emptyId = await createCase("Empty Subject Smoke");
  const gen3 = await req("POST", `${API}/cases/${emptyId}/serp-snapshot/generate`, {});
  const snap3 = gen3.json?.data?.snapshot;
  check("empty: generate -> 201 (no crash)", gen3.status === 201, String(gen3.status));
  check("empty: resultCount === 0", (snap3?.resultCount ?? -1) === 0, String(snap3?.resultCount));
  check("empty: highlightedCount === 0", (snap3?.highlightedCount ?? -1) === 0);
  if (snap3?.signedUrl) {
    const img3 = await fetchImage(snap3.signedUrl);
    check("empty: valid PNG", img3.status === 200 && isPng(img3.buf), `${img3.buf?.length ?? 0} bytes`);
  }

  // GET latest on a case with no snapshot returns null (separate fresh case).
  const noSnapId = await createCase("No Snapshot Smoke");
  const none = await req("GET", `${API}/cases/${noSnapId}/serp-snapshot`);
  check("no-snapshot: GET latest -> null", none.status === 200 && none.json?.data?.snapshot === null);

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
