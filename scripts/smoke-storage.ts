/**
 * Smoke test for Stage M2 storage + download policy — no dev server, no DB.
 *
 * Uses a throwaway temp storage root so it never touches real artifacts.
 *
 * Run:  npm run smoke:storage   (uses tsx)
 */

import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";

let failures = 0;
function check(name: string, ok: boolean, extra?: string) {
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${extra ? ` — ${extra}` : ""}`);
}

async function main() {
  // Configure an isolated local storage root BEFORE importing config-bound modules.
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "dp-smoke-storage-"));
  process.env.DIGITAL_PROFILE_STORAGE_DRIVER = "local";
  process.env.DIGITAL_PROFILE_STORAGE_ROOT = tmpRoot;
  process.env.DIGITAL_PROFILE_SIGNED_URL_SECRET = "smoke-storage-secret";
  process.env.DIGITAL_PROFILE_STORAGE_SIGNED_URL_TTL_SECONDS = "900";

  const { getStorageProvider, __resetStorageProvider } = await import(
    "../src/modules/digital-profile/storage/storage-provider"
  );
  const { buildStorageKey, validateStorageKey, StorageKeyError } = await import(
    "../src/modules/digital-profile/storage/keys"
  );
  const { createSignedToken, verifySignedToken } = await import(
    "../src/modules/digital-profile/storage/signed-url"
  );
  const { authorizeReportDownload, isReportDraft } = await import(
    "../src/modules/digital-profile/auth/download-policy"
  );
  const { resolveCaseAccess, accessLevelSatisfies } = await import(
    "../src/modules/digital-profile/auth/access-rules"
  );

  __resetStorageProvider();
  const store = getStorageProvider();

  // 1. put/get/exists.
  const key = buildStorageKey.reportArtifact("case1", "rv1", "pdf");
  const payload = Buffer.from("hello-storage");
  const put = await store.putObject(key, payload);
  const got = await store.getObject(key);
  const exists = await store.exists(key);
  check("local put/get round-trips", got.equals(payload) && exists);
  check("putObject reports size + sha256", put.sizeBytes === payload.byteLength && put.sha256.length === 64);

  // listObjects sees the file under its case prefix.
  const listed = await store.listObjects("cases/case1");
  check("listObjects finds the object", listed.some((o) => o.storageKey === key));

  // deleteObject removes it.
  await store.deleteObject(key);
  check("deleteObject removes the object", !(await store.exists(key)));

  // 2. path traversal / absolute paths rejected.
  const traversal = ["../etc/passwd", "cases/../../secret", "/abs/path", "C:\\win", "a/../../b"];
  let allRejected = true;
  for (const bad of traversal) {
    if (validateStorageKey(bad)) allRejected = false;
    let threw = false;
    try {
      await store.getObject(bad);
    } catch (e) {
      threw = e instanceof StorageKeyError || e instanceof Error;
    }
    if (!threw) allRejected = false;
  }
  check("path traversal + absolute keys rejected", allRejected);
  check("valid key accepted by validateStorageKey", validateStorageKey(key));

  // 3. signed token valid.
  const goodToken = createSignedToken(key, 900);
  check("signed token verifies for its key", verifySignedToken(key, goodToken.token));
  check("createSignedReadUrl returns a verifiable token", (() => {
    const signed = store.createSignedReadUrl(key, {
      resource: { kind: "report", reportVersionId: "rv1", type: "pdf" },
    });
    return (
      verifySignedToken(key, signed.token) &&
      signed.url.includes("/reports/rv1/download") &&
      signed.expiresAt > Math.floor(Date.now() / 1000)
    );
  })());

  // 4. expired token rejected.
  const expired = createSignedToken(key, -10);
  check("expired token rejected", !verifySignedToken(key, expired.token));

  // 5. invalid token rejected (tampered + wrong key).
  const tampered = goodToken.token.slice(0, -3) + "xyz";
  check("tampered token rejected", !verifySignedToken(key, tampered));
  check("token bound to its key (other key rejected)", !verifySignedToken("cases/case1/reports/rv1/report.pptx", goodToken.token));

  // 6. client viewer cannot download an internal/draft report.
  const draftMeta = isReportDraft("DRAFT", "ЧЕРНОВИК");
  const finalMeta = isReportDraft("FINAL", null);
  check("isReportDraft flags draft/watermarked", draftMeta && !finalMeta);
  check(
    "client viewer denied for internal/draft report",
    authorizeReportDownload({ role: "CLIENT_VIEWER", isDraft: true }).allowed === false
  );

  // 7. assigned client viewer can download a client-safe (final) report.
  const assigned = resolveCaseAccess("CLIENT_VIEWER", "VIEWER");
  check(
    "assigned client viewer can download final client report",
    authorizeReportDownload({ role: "CLIENT_VIEWER", isDraft: false }).allowed === true &&
      assigned.canView === true &&
      accessLevelSatisfies(assigned.level, "VIEWER")
  );

  // 8. unassigned client viewer has no case access.
  const unassigned = resolveCaseAccess("CLIENT_VIEWER", null);
  check(
    "unassigned client viewer cannot access the case",
    unassigned.canView === false && !accessLevelSatisfies(unassigned.level, "VIEWER")
  );

  // Staff retain internal download capability.
  check(
    "staff (ANALYST) can download internal report",
    authorizeReportDownload({ role: "ANALYST", isDraft: true }).allowed === true
  );

  rmSync(tmpRoot, { recursive: true, force: true });

  console.log("");
  if (failures > 0) {
    console.error(`smoke:storage FAILED (${failures} check(s))`);
    process.exit(1);
  }
  console.log("smoke:storage OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
