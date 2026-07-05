import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(
  process.cwd(),
  "storage",
  "digital-profile",
  "qa-r9-5b-orion-ui-e2e"
);

const HEADERS = {
  Accept: "application/json",
  "x-actor-id": "qa-r9-5b",
};

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures += 1;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: HEADERS, cache: "no-store" });
  return res.json();
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function pickCaseId(): Promise<string> {
  const list = (await getJson(
    "http://localhost:3000/api/digital-profile/cases?page=1&pageSize=1"
  )) as {
    ok: boolean;
    data?: { items?: Array<{ id: string }> };
  };
  if (!list.ok || !list.data?.items?.[0]?.id) {
    throw new Error("No case found for QA.");
  }
  return list.data.items[0].id;
}

async function pollStatus(caseId: string): Promise<Record<string, unknown>> {
  for (let i = 0; i < 80; i += 1) {
    await new Promise((r) => setTimeout(r, 2000));
    const status = (await getJson(
      `http://localhost:3000/api/digital-profile/cases/${caseId}/report/orion-v2`
    )) as { ok: boolean; data?: Record<string, unknown> };
    if (!status.ok) continue;
    const state = String(status.data?.status ?? "");
    if (["completed", "failed", "success", "generated"].includes(state)) {
      return status.data ?? {};
    }
  }
  throw new Error("ORION v2 status polling timeout.");
}

function parseArtifactPath(downloadUrl: string): string {
  return downloadUrl.split("?")[0] ?? "";
}

function hasForbidden(value: string): string[] {
  const forbidden = [
    "storageKey",
    "rawPrompt",
    "rawModelResponse",
    "providerInternal",
    "runtimeInternal",
    "C:\\\\",
    "/mnt/",
  ];
  return forbidden.filter((token) =>
    value.toLowerCase().includes(token.toLowerCase())
  );
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  const health = (await getJson(
    "http://localhost:3000/api/digital-profile/health"
  )) as Record<string, unknown>;
  writeJson(join(OUT, "qa-r95b-health.json"), health);
  check("app health ok", String(health.ok) === "true");

  const caseId = await pickCaseId();
  writeFileSync(join(OUT, "qa-r95b-case-id.txt"), `${caseId}\n`, "utf-8");

  const post = (await postJson(
    `http://localhost:3000/api/digital-profile/cases/${caseId}/report/orion-v2`,
    {}
  )) as { ok: boolean; data?: Record<string, unknown> };
  writeJson(join(OUT, "qa-r95b-post.json"), post);
  check("ORION v2 POST ok", post.ok === true);

  const status = await pollStatus(caseId);
  writeJson(join(OUT, "qa-r95b-status.json"), status);
  check(
    "ORION v2 terminal status completed",
    String(status.status) === "completed",
    String(status.status)
  );
  check(
    "client page count > 0",
    Number(status.clientPageCount ?? 0) > 0,
    String(status.clientPageCount ?? 0)
  );
  check("client policy PASS", String(status.clientPolicyStatus) === "PASS");
  check("client PDF available", Boolean((status.artifacts as any)?.clientPdf?.available));
  check("client PPTX available", Boolean((status.artifacts as any)?.clientPptx?.available));

  const safeUrls = {
    clientPdfPath: parseArtifactPath(String((status.artifacts as any)?.clientPdf?.downloadUrl ?? "")),
    clientPptxPath: parseArtifactPath(String((status.artifacts as any)?.clientPptx?.downloadUrl ?? "")),
    internalPdfPath: parseArtifactPath(String((status.artifacts as any)?.internalDraftPdf?.downloadUrl ?? "")),
  };
  writeJson(join(OUT, "qa-r95b-safe-url-paths.json"), safeUrls);
  check("download paths are API routes", safeUrls.clientPdfPath.includes("/api/digital-profile/"));

  const uiText = readFileSync(
    join(process.cwd(), "src/modules/digital-profile/client/OrionV2ReportPanel.tsx"),
    "utf-8"
  );
  const forbiddenUiHits = hasForbidden(uiText);
  writeJson(join(OUT, "qa-r95b-forbidden-ui-check.json"), { forbiddenUiHits });
  check("forbidden labels absent in ORION panel", forbiddenUiHits.length === 0, forbiddenUiHits.join(", "));

  writeJson(join(OUT, "qa-r95b-summary.json"), {
    status: failures ? "BLOCKED" : "PASS",
    failures,
    caseId,
    finalStatus: status.status,
    clientPageCount: status.clientPageCount,
    lexisVisualPageCount: status.lexisVisualPageCount,
  });

  process.exit(failures ? 1 : 0);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

