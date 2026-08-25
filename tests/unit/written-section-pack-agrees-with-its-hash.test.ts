/**
 * Файл пакета сходится со своим хэшем, каким бы путём пакет ни попал на диск.
 *
 * Ветка реюза пересчитывает хэш сама, но она не единственный вход: точечный
 * ретрай стадии 2 (`runDeckGptCopyRetry`) берёт пакеты прямо из
 * `loadPreviousPacks` и отдаёт их как `prebuiltPacks`, а `runDeckBuild` в этом
 * случае вообще не зовёт `buildSectionPackForFragment`. Пакет, записанный до
 * канона, уезжал на диск канонической формой со старым хэшем — и файл переставал
 * сходиться сам с собой молча: внутри прогона хэш не с чем сравнить.
 */

import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contentHashOf,
  CONTENT_HASH_REPAIRED,
  FRAGMENT_ARTIFACT_PATHS,
  loadPreviousPacks,
  runDeckBuild,
  SectionPackV2Schema,
  type SectionBuildContext,
  type SectionPackV2,
} from "@/modules/digital-profile/orion-golden/deck-sections";
import { DECK_CONTENT_VERSION } from "@/modules/digital-profile/orion-golden/deck-sections/content-version";
import { loadReport72DeckInputs } from "../../scripts/run-orion-deck-sections-report72";

const inputs = loadReport72DeckInputs();

function makeCtx(): Omit<SectionBuildContext, "previousPacks" | "buildLog"> {
  return {
    caseId: inputs.caseId,
    reportRunId: inputs.reportRunId,
    sourceDatasetId: inputs.sourceDatasetId,
    contentVersion: DECK_CONTENT_VERSION,
    subject: { displayName: "Сергей Глинка", aliases: ["Sergey Glinka"] },
    bundle: inputs.mergedBundle,
    surfaceUnits: inputs.surfaceUnits,
    metricSnapshot: inputs.metricSnapshot,
    evidenceIndex: inputs.evidenceIndex,
    extras: {
      executiveSummary: inputs.executiveSummary as never,
      surfaceCollectionHints: inputs.surfaceCollectionHints,
      complianceScreenings: inputs.complianceScreenings,
      visualAssets: {},
    },
  };
}

function build(
  outputRoot: string,
  prebuilt?: { packs: SectionPackV2[]; withBuildLog: boolean }
) {
  return runDeckBuild({
    ctx: makeCtx(),
    bundleForValidation: inputs.mergedBundle,
    knownEvidenceRefs: inputs.knownEvidenceRefs,
    outputRoot,
    baseObservationCountBefore: inputs.baseCountBefore,
    baseObservationCountAfter: inputs.baseCountAfter,
    prebuiltPacks: prebuilt?.packs,
    prebuiltBuildLog: prebuilt?.withBuildLog
      ? prebuilt.packs.map((p) => ({ fragmentKey: p.fragmentKey, action: "REUSED_CACHE" as const }))
      : undefined,
  });
}

/** Пакеты с диска, чей хэш посчитан прежней формулой, — вход точечного ретрая. */
function staleFromDisk(root: string): SectionPackV2[] {
  return [...loadPreviousPacks(root).values()].map((p) => ({
    ...p,
    contentHash: "sha256:legacy-formula-hash",
  }));
}

function mismatchedOnDisk(root: string): string[] {
  const mismatched: string[] = [];
  for (const rel of Object.values(FRAGMENT_ARTIFACT_PATHS)) {
    const pack = SectionPackV2Schema.parse(JSON.parse(readFileSync(join(root, rel), "utf8")));
    if (contentHashOf(pack.slides) !== pack.contentHash) mismatched.push(rel);
  }
  return mismatched;
}

describe("пакет, записанный мимо ветки реюза", () => {
  it("уезжает на диск со своим собственным хэшем", () => {
    const root = mkdtempSync(join(tmpdir(), "prebuilt-pack-hash-"));
    build(root);
    build(root, { packs: staleFromDisk(root), withBuildLog: true });

    expect(mismatchedOnDisk(root)).toEqual([]);
  });

  it("оставляет след о починке, даже когда журнал сборки не передали", () => {
    /*
     * `prebuiltPacks` и `prebuiltBuildLog` — независимые поля входа: вызывающий
     * вправе передать пакеты без журнала. Тогда починка хэша не находила записи
     * своего фрагмента и молчала — ровно то молчание, ради которого
     * предупреждение и заводили.
     */
    const root = mkdtempSync(join(tmpdir(), "prebuilt-pack-log-"));
    build(root);
    const result = build(root, { packs: staleFromDisk(root), withBuildLog: false });

    expect(mismatchedOnDisk(root)).toEqual([]);
    expect(result.buildLog.length).toBe(Object.keys(FRAGMENT_ARTIFACT_PATHS).length);
    expect(
      result.buildLog.filter(
        (l) => l.warning === `${CONTENT_HASH_REPAIRED}:sha256:legacy-formula-hash`
      ).length
    ).toBe(result.buildLog.length);
  });
});
