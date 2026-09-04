/**
 * Реплей разрешения субъекта на сохранённом бандле прогона.
 *
 * Отвечает на один вопрос: что изменит правка классификатора на **реальном**
 * корпусе, а не на фикстуре. Заведён для шага 0054 (якоря субъекта) после
 * прогона DPA-2026-0049, где 585 материалов «о субъекте» принадлежали четырём
 * разным людям.
 *
 * В офлайн-контур (`npm run ci`) не входит: ему нужен бандл диагностики,
 * которого в репозитории нет и быть не может — там материалы по делам живых
 * людей. Запускается руками:
 *
 *   npx tsx scripts/replay-subject-resolution.ts <путь-к-бандлу> [--anchors <файл.json>]
 *
 * Читается **корневой** `composite-serp-observations.json` бандла: в
 * `analytics/`-копии сниппеты срезаны, а якорь чаще всего стоит именно в
 * сниппете.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildSubjectResolution,
  subjectIdentityFromProfile,
  type ClassifierSubjectProfile,
} from "../src/modules/digital-profile/orion-golden/analytics/subject-resolution-classifier";
import type { SubjectAnchors } from "../src/modules/digital-profile/orion-golden/analytics/subject-anchors";
import type { RawInventoryItem } from "../src/modules/digital-profile/orion-golden/types";

type BundleObservation = {
  observationKey?: string;
  title?: string;
  snippet?: string;
  url?: string;
  domain?: string;
  engine?: string;
  region?: string;
  surface?: string;
  provider?: string;
  query?: string;
};

function itemsOf(bundleDir: string): RawInventoryItem[] {
  const raw = JSON.parse(
    readFileSync(join(bundleDir, "composite-serp-observations.json"), "utf8")
  ) as { observations?: BundleObservation[] };
  const observations = raw.observations ?? [];
  return observations.map((o, index) => ({
    inventoryId: `replay-${index}`,
    caseId: "replay",
    reportRunId: "replay-run",
    source: "serp_observation",
    provider: o.provider ?? "unknown",
    region: o.region ?? "RU",
    query: o.query,
    collectedAt: "2026-01-01T00:00:00.000Z",
    evidenceType: "search_result",
    title: o.title ?? "",
    snippet: o.snippet ?? "",
    sourceUrl: o.url,
    rawMetadata: { engine: o.engine, surface: o.surface, provider: o.provider },
  })) as unknown as RawInventoryItem[];
}

/** Грубая разметка кластеров однофамильцев — только чтобы прочитать итог глазами. */
const CLUSTERS: Array<{ label: string; re: RegExp }> = [
  { label: "судья/Краснодар", re: /судь|арбитраж|председател|краснодар|кубан|прокурат/i },
  { label: "офтальмолог", re: /офтальм|глаз|глауком|клиник|пирогов|рнимуб|рниму|д\.м\.н|профессор|подольск/i },
  { label: "ИП/реестры", re: /\bинн\b|огрн|егрип|егрюл|предпринимател|rusprofile|checko|list-org|audit-it/i },
  { label: "депутат/иное", re: /депутат|дума|партия|единая россия/i },
];

function clusterOf(item: RawInventoryItem): string {
  const text = `${item.title ?? ""} ${item.snippet ?? ""} ${item.sourceUrl ?? ""}`;
  for (const c of CLUSTERS) if (c.re.test(text)) return c.label;
  return "прочее";
}

function tally(
  items: RawInventoryItem[],
  profile: ClassifierSubjectProfile
): { byDecision: Record<string, number>; byReason: Record<string, number>; matchClusters: Record<string, number> } {
  const resolution = buildSubjectResolution({
    caseId: "replay",
    datasetId: "replay",
    subject: subjectIdentityFromProfile(profile),
    items,
    sourceHashes: [],
  });
  const byRef = new Map(resolution.items.map((r) => [r.evidenceRef, r]));
  const byDecision: Record<string, number> = {};
  const byReason: Record<string, number> = {};
  const matchClusters: Record<string, number> = {};
  for (const item of items) {
    const row = byRef.get(`inventory:${item.inventoryId}`);
    if (!row) continue;
    byDecision[row.decision] = (byDecision[row.decision] ?? 0) + 1;
    byReason[row.reasonCode] = (byReason[row.reasonCode] ?? 0) + 1;
    if (row.decision === "SUBJECT_MATCH") {
      const c = clusterOf(item);
      matchClusters[c] = (matchClusters[c] ?? 0) + 1;
    }
  }
  return { byDecision, byReason, matchClusters };
}

/** Заголовки подтверждённых материалов — их читают глазами, а не по счётчику. */
function dumpMatches(
  items: RawInventoryItem[],
  profile: ClassifierSubjectProfile,
  limit: number
): void {
  const resolution = buildSubjectResolution({
    caseId: "replay",
    datasetId: "replay",
    subject: subjectIdentityFromProfile(profile),
    items,
    sourceHashes: [],
  });
  const byRef = new Map(resolution.items.map((r) => [r.evidenceRef, r]));
  const seen = new Set<string>();
  let shown = 0;
  for (const item of items) {
    if (shown >= limit) break;
    const row = byRef.get(`inventory:${item.inventoryId}`);
    if (row?.decision !== "SUBJECT_MATCH") continue;
    const key = String(item.sourceUrl ?? item.title ?? "");
    if (seen.has(key)) continue;
    seen.add(key);
    shown += 1;
    console.log(`  [${row.reasonCode}] ${String(item.title ?? "").slice(0, 80)} — ${key.slice(0, 70)}`);
  }
}

function print(title: string, out: ReturnType<typeof tally>): void {
  console.log(`\n=== ${title}`);
  console.log("  решения:", JSON.stringify(out.byDecision, null, 0));
  const reasons = Object.entries(out.byReason).sort((a, b) => b[1] - a[1]);
  console.log("  причины:", reasons.map(([k, v]) => `${k}=${v}`).join(", "));
  console.log("  «о субъекте» по кластерам:", JSON.stringify(out.matchClusters, null, 0));
}

function main(): void {
  const [bundleDir, ...rest] = process.argv.slice(2);
  if (!bundleDir) {
    console.error("usage: replay-subject-resolution.ts <bundle-dir> [--anchors <file.json>]");
    process.exit(2);
  }
  const anchorsFlag = rest.indexOf("--anchors");
  const anchors: SubjectAnchors | null =
    anchorsFlag >= 0 && rest[anchorsFlag + 1]
      ? (JSON.parse(readFileSync(rest[anchorsFlag + 1]!, "utf8")) as SubjectAnchors)
      : null;

  const items = itemsOf(bundleDir);
  const identity = JSON.parse(
    readFileSync(join(bundleDir, "subject-identity-profile.json"), "utf8")
  ) as Record<string, unknown>;

  const base: ClassifierSubjectProfile = {
    displayName: String(identity.displayName ?? ""),
    fullNameRu: identity.fullNameRu as ClassifierSubjectProfile["fullNameRu"],
    givenNames: (identity.givenNames as string[]) ?? [],
    familyNames: (identity.familyNames as string[]) ?? [],
    patronymics: (identity.patronymics as string[]) ?? [],
    aliases: (identity.aliases as string[]) ?? [],
    transliterations: (identity.transliterations as string[]) ?? [],
    contextIdentifiers: (identity.contextIdentifiers as string[]) ?? [],
    namesakeProfiles: (identity.namesakeProfiles as ClassifierSubjectProfile["namesakeProfiles"]) ?? [],
    knownIdentifiers: {
      inn: ((identity.knownIdentifiers as { inn?: string[] })?.inn ?? []) as string[],
    },
    negativeIdentitySignals: identity.negativeIdentitySignals as ClassifierSubjectProfile["negativeIdentitySignals"],
  };

  console.log(`наблюдений: ${items.length}; субъект: ${base.displayName}`);
  print("как было (ИНН из корпуса, контекст намайнен)", tally(items, base));
  print(
    "как стало без якорей (ИНН из корпуса не идентификатор, майнер выключен)",
    tally(items, { ...base, knownIdentifiers: { inn: [] }, contextIdentifiers: base.contextIdentifiers })
  );
  if (anchors) {
    const anchored = { ...base, knownIdentifiers: { inn: anchors.inn }, anchors };
    print("с якорями оператора", tally(items, anchored));
    if (rest.includes("--dump")) {
      console.log("\n=== подтверждённые материалы (уникальные адреса)");
      dumpMatches(items, anchored, 200);
    }
  }
}

main();
