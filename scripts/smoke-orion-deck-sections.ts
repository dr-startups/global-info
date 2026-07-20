/**
 * Prompt 3 mandatory offline tests — independent section packs, deterministic
 * DeckAssembler, cache reuse, lineage rejection and the RU-AI regression
 * scenario on saved report-72 data. NETWORK_CALLS=0.
 *
 * Run: npm run smoke:orion-deck-sections
 */

process.env.NETWORK_CALLS = "0";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleDeck,
  buildCoverageReconciliation,
  buildExecutiveSection,
  buildReportSectionManifest,
  buildRuProfileSection,
  buildScopedInput,
  buildSectionPackForFragment,
  buildSerpFragment,
  buildUaeProfileSection,
  composeExecutivePageStructure,
  composePageRowComposition,
  coverageContent,
  fragmentScope,
  pageRowCompositionBlocks,
  resolveEmptySurfaceCollection,
  runDeckBuild,
  validateAssembly,
  validateSectionPack,
  SECTION_PACK_SCHEMA_VERSION,
  SECTION_PACK_V2_SCHEMA_VERSION,
  type FragmentKey,
  type LegacySectionPackV2,
  type SectionBuildContext,
  type SectionPackV2,
  type V72PageInventoryItem,
} from "../src/modules/digital-profile/orion-golden/deck-sections";
import { loadReport72DeckInputs, loadReportAssets } from "./run-orion-deck-sections-report72";
import type { SectionValidationReport } from "../src/modules/digital-profile/orion-golden/deck-sections";
import { migratePack } from "./migrate-section-packs-v2-to-v3";

const inputs = loadReport72DeckInputs();
const { visualAssets } = loadReportAssets(inputs.evidenceIndex);

function makeCtx(): Omit<SectionBuildContext, "previousPacks" | "buildLog"> {
  return {
    caseId: inputs.caseId,
    reportRunId: inputs.reportRunId,
    sourceDatasetId: inputs.sourceDatasetId,
    contentVersion: "deck-sections-v14",
    subject: { displayName: "Сергей Глинка", aliases: ["Sergey Glinka"] },
    bundle: inputs.mergedBundle,
    surfaceUnits: structuredClone(inputs.surfaceUnits),
    metricSnapshot: inputs.metricSnapshot,
    evidenceIndex: inputs.evidenceIndex,
    extras: { executiveSummary: inputs.executiveSummary, visualAssets },
  };
}

function buildOnce(outputRoot: string, ctx = makeCtx()) {
  return runDeckBuild({
    ctx,
    bundleForValidation: inputs.mergedBundle,
    knownEvidenceRefs: inputs.knownEvidenceRefs,
    outputRoot,
    baseObservationCountBefore: inputs.baseCountBefore,
    baseObservationCountAfter: inputs.baseCountAfter,
  });
}

function validateAll(packs: SectionPackV2[]): Map<FragmentKey, SectionValidationReport> {
  const reports = new Map<FragmentKey, SectionValidationReport>();
  for (const pack of packs) {
    reports.set(
      pack.fragmentKey,
      validateSectionPack({
        pack,
        expectedCaseId: inputs.caseId,
        expectedReportRunId: inputs.reportRunId,
        expectedDatasetId: inputs.sourceDatasetId,
        bundle: inputs.mergedBundle,
        knownEvidenceRefs: inputs.knownEvidenceRefs,
      })
    );
  }
  return reports;
}

describe("independent section packs", () => {
  it("independent executive pack builds from scoped inputs only", () => {
    const packs = buildExecutiveSection({ ...makeCtx(), buildLog: [] });
    assert.equal(packs.length, 3);
    for (const p of packs) {
      assert.equal(p.sectionType, "EXECUTIVE");
      assert.equal(p.reportRunId, inputs.reportRunId);
      assert.equal(p.sourceDatasetId, inputs.sourceDatasetId);
      assert.ok(p.contentHash.startsWith("sha256:"));
      assert.ok(p.promptVersion.length > 0);
    }
    const summary = packs.find((p) => p.fragmentKey === "EXECUTIVE_SUMMARY")!;
    assert.equal(summary.status, "READY");
    assert.ok(summary.slides[0].content.narrative!.length >= 300);
  });

  it("independent RU pack: no UAE data leaks into RU fragments", () => {
    const packs = buildRuProfileSection({ ...makeCtx(), buildLog: [] });
    assert.equal(packs.length, 8);
    for (const p of packs) {
      assert.equal(p.sectionType, "RU_PROFILE");
      // No slide of an RU pack may cite evidence whose region is UAE-only.
      for (const slide of p.slides) {
        for (const ref of slide.evidenceRefs) {
          const e = inputs.evidenceIndex[ref];
          if (e?.region) assert.notEqual(e.region, "UAE", `${p.fragmentKey} cites UAE ref ${ref}`);
        }
      }
    }
  });

  it("independent UAE pack builds without RU claims", () => {
    const packs = buildUaeProfileSection({ ...makeCtx(), buildLog: [] });
    assert.equal(packs.length, 8);
    const serp = packs.find((p) => p.fragmentKey === "UAE_SERP")!;
    assert.equal(serp.status, "READY");
    for (const slide of serp.slides) {
      for (const ref of slide.evidenceRefs) {
        const e = inputs.evidenceIndex[ref];
        if (e?.region) assert.notEqual(e.region, "RU", `UAE_SERP cites RU ref ${ref}`);
      }
    }
  });

  it("LLM surface prompt receives only scoped findings", () => {
    const scoped = buildScopedInput({
      subject: { displayName: "Сергей Глинка", aliases: [] },
      bundle: inputs.mergedBundle,
      surfaceUnits: inputs.surfaceUnits,
      metricSnapshot: inputs.metricSnapshot,
      scope: fragmentScope("RU_SUGGESTIONS"),
      evidenceIndex: inputs.evidenceIndex,
    });
    // Only suggestion units of RU; no images, no UAE, no raw dataset.
    for (const u of scoped.surfaceUnits) {
      assert.equal(u.surface, "suggestions");
      assert.equal(u.region, "RU");
    }
    for (const f of scoped.findings) {
      assert.equal(f.subjectMatch, "SUBJECT_MATCH");
    }
    // Scoped evidence index may only contain refs reachable from the slice or
    // observation rows of the scoped surface+region (never foreign surfaces).
    const reachable = new Set([
      ...scoped.findings.flatMap((f) => f.evidenceRefs),
      ...scoped.surfaceUnits.flatMap((u) => [
        ...u.evidenceRefs,
        ...u.claims.flatMap((c) => c.evidenceRefs),
      ]),
    ]);
    for (const [ref, e] of Object.entries(scoped.evidenceIndex)) {
      if (reachable.has(ref)) continue;
      assert.equal(e.kind, "suggestions", `foreign-surface evidence in scope: ${ref} (${e.kind})`);
      assert.equal(e.region, "RU", `foreign-region evidence in scope: ${ref} (${e.region})`);
    }
  });

  it("section builder emits no global page numbers", () => {
    const packs = buildExecutiveSection({ ...makeCtx(), buildLog: [] });
    for (const p of packs) {
      const json = JSON.stringify(p);
      assert.ok(!json.includes('"pageNumber"'), `${p.fragmentKey} contains a page number`);
      assert.ok(!json.includes('"totalPageCount"'), `${p.fragmentKey} contains total page count`);
    }
  });
});

describe("deck assembler", () => {
  const dir = mkdtempSync(join(tmpdir(), "orion-deck-asm-"));
  const build = buildOnce(dir);

  it("assembles all required sections with canonical baseSlotCoverage=36", () => {
    assert.equal(build.manifest.buildBlocked, false);
    assert.equal(build.assembly.errors.length, 0);
    assert.ok(build.assembly.deckManifest.pageCount >= 36);
    assert.equal(build.assembly.deckManifest.baseSlotCoverage, 36);
    assert.equal(build.assemblyValidation?.checks.canonicalBaseSlotCoverage, true);
  });

  it("optional EMPTY_VALID section omitted (appendix without ambiguous material)", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "orion-deck-empty-"));
    const ctx = makeCtx();
    // Subject-match-only bundle: the optional appendix has nothing to show.
    const filteredBundle = {
      ...ctx.bundle,
      findings: ctx.bundle.findings.filter((f) => f.subjectMatch === "SUBJECT_MATCH"),
    };
    const result = runDeckBuild({
      ctx: { ...ctx, bundle: filteredBundle },
      bundleForValidation: filteredBundle,
      knownEvidenceRefs: inputs.knownEvidenceRefs,
      outputRoot: dir2,
      baseObservationCountBefore: inputs.baseCountBefore,
      baseObservationCountAfter: inputs.baseCountAfter,
    });
    const appendix = result.packs.find((p) => p.fragmentKey === "APPENDIX_MAIN")!;
    assert.equal(appendix.status, "EMPTY_VALID");
    const omitted = result.assembly.rejections.find(
      (r) => r.fragmentKey === "APPENDIX_MAIN" && r.reason === "EMPTY_VALID_OMITTED"
    );
    assert.ok(omitted, "EMPTY_VALID optional fragment must be omitted");
    assert.ok(!result.assembly.deckManifest.slides.some((s) => s.sectionType === "APPENDIX"));
    assert.equal(result.assembly.deckManifest.baseSlotCoverage, 36);
  });

  it("continuation inserted directly after base slide", () => {
    const slides = build.assembly.deckManifest.slides;
    const conts = slides.filter((s) => s.isContinuation);
    assert.ok(conts.length > 0, "expected at least one continuation in report-72 deck");
    for (const c of conts) {
      const idx = slides.findIndex((s) => s.slideId === c.slideId);
      const prev = slides[idx - 1];
      assert.ok(
        prev.slideId === c.continuationOf || prev.continuationOf === c.continuationOf,
        `continuation ${c.slideId} not adjacent`
      );
    }
  });

  it("TOC is generated only after assembly and has no '(N стр.)' lines", () => {
    // Packs on disk contain an empty TOC slot...
    const frontMatter = JSON.parse(
      readFileSync(join(dir, "section-packs", "front-matter.json"), "utf8")
    ) as SectionPackV2;
    const tocSlide = frontMatter.slides.find((s) => s.templateId === "toc")!;
    assert.deepEqual(tocSlide.content.bullets, [], "builder must not fill TOC");
    // ...while the assembled deck carries computed ranges.
    assert.ok(build.assembly.deckManifest.toc.length >= 4);
    for (const t of build.assembly.deckManifest.toc) {
      assert.ok(/стр\. \d+–\d+/u.test(t.title));
      assert.ok(!/\(\d+\s*стр\.\)/u.test(t.title), "forbidden '(N стр.)' in TOC line");
    }
    const rendererToc = build.assembly.rendererSlides.find((s) => s.template === "orion_golden_toc")!;
    assert.ok((rendererToc.bullets ?? []).length >= 4, "assembler fills the TOC slide");
  });

  it("foreign reportRunId pack rejected", () => {
    const packs = build.packs.map((p) =>
      p.fragmentKey === "APPENDIX_MAIN" ? { ...p, reportRunId: "orion-foreign-run" } : p
    );
    const result = assembleDeck({
      manifest: build.manifest,
      packs,
      expectedCaseId: inputs.caseId,
      expectedReportRunId: inputs.reportRunId,
      expectedDatasetId: inputs.sourceDatasetId,
    });
    const rej = result.rejections.find((r) => r.fragmentKey === "APPENDIX_MAIN");
    assert.equal(rej?.reason, "FOREIGN_REPORT_RUN");
    assert.equal(result.errors.length, 0, "optional foreign pack must not block the deck");
    assert.ok(!result.deckManifest.slides.some((s) => s.sectionType === "APPENDIX"));
  });

  it("stale sourceDatasetId pack rejected; required stale pack blocks build", () => {
    const packs = build.packs.map((p) =>
      p.fragmentKey === "RU_SERP" ? { ...p, sourceDatasetId: "composite-stale-000" } : p
    );
    const result = assembleDeck({
      manifest: build.manifest,
      packs,
      expectedCaseId: inputs.caseId,
      expectedReportRunId: inputs.reportRunId,
      expectedDatasetId: inputs.sourceDatasetId,
    });
    const rej = result.rejections.find((r) => r.fragmentKey === "RU_SERP");
    assert.equal(rej?.reason, "STALE_DATASET");
    assert.ok(result.errors.length > 0, "required stale pack must stop the build");
    assert.equal(result.deckManifest.pageCount, 0);
  });

  it("failed required section blocks assembly", () => {
    const packs = build.packs.map((p) =>
      p.fragmentKey === "EXECUTIVE_SUMMARY"
        ? { ...p, status: "FAILED" as const, slides: [] }
        : p
    );
    const manifest = buildReportSectionManifest({
      caseId: inputs.caseId,
      reportRunId: inputs.reportRunId,
      sourceDatasetId: inputs.sourceDatasetId,
      packs,
      validationReports: validateAll(packs),
    });
    assert.equal(manifest.buildBlocked, true);
    const result = assembleDeck({
      manifest,
      packs,
      expectedCaseId: inputs.caseId,
      expectedReportRunId: inputs.reportRunId,
      expectedDatasetId: inputs.sourceDatasetId,
    });
    assert.ok(result.errors.length > 0);
    assert.equal(result.deckManifest.pageCount, 0);
  });

  it("assembler performs zero LLM calls (static guarantee)", () => {
    const src = readFileSync(
      join(
        process.cwd(),
        "src/modules/digital-profile/orion-golden/deck-sections/deck-assembler.ts"
      ),
      "utf8"
    );
    assert.ok(!/openai|callOpenAi|gpt|fetch\(/iu.test(src), "assembler must not reference LLM/network");
  });
});

describe("canonical coverage and visual assets", () => {
  const dir = mkdtempSync(join(tmpdir(), "orion-deck-cov-"));
  const build = buildOnce(dir);
  const baseline = JSON.parse(
    readFileSync(join(process.cwd(), "baselines", "report-72", "baseline.json"), "utf8")
  ) as { pageInventory: { value: V72PageInventoryItem[] } };

  it("coverage reconciliation maps all 36 base slots and all 43 v72 pages", () => {
    const rec = buildCoverageReconciliation({
      deckManifest: build.assembly.deckManifest,
      packs: build.packs,
      bundle: inputs.mergedBundle,
      v72PageInventory: baseline.pageInventory.value,
    });
    assert.equal(rec.failed, false);
    assert.equal(rec.baseSlotCoverage, 36);
    assert.equal(rec.slots.length, 36);
    assert.equal(rec.v72Pages.length, 43);
    assert.deepEqual(rec.missingBaseSlots, []);
    assert.deepEqual(rec.missingPromotedFindings, []);
    assert.deepEqual(rec.missingSurfaces, []);
    for (const p of rec.v72Pages) {
      if (p.status === "EMPTY_COLLAPSED") {
        assert.ok(p.emptyEvidence, `EMPTY_COLLAPSED v72 page ${p.v72Page} needs evidence`);
      }
    }
  });

  it("reconciliation fails closed when a base slot disappears", () => {
    const mutilated = {
      ...build.assembly.deckManifest,
      slides: build.assembly.deckManifest.slides.filter((s) => s.baseSlotId !== "p13_ru_wikipedia"),
      baseSlotCoverage: 35,
    };
    const rec = buildCoverageReconciliation({
      deckManifest: mutilated,
      packs: build.packs,
      bundle: inputs.mergedBundle,
      v72PageInventory: baseline.pageInventory.value,
    });
    assert.equal(rec.failed, true);
    assert.deepEqual(rec.missingBaseSlots, ["p13_ru_wikipedia"]);
  });

  it("available visual asset is bound, never rendered as placeholder", () => {
    const withAssets = build.packs
      .flatMap((p) => p.slides)
      .filter((s) => Object.keys(visualAssets).includes(s.baseSlotId));
    assert.ok(withAssets.length >= 10, "expected asset-bound slides in report-72 deck");
    for (const s of withAssets.filter((s) => !s.isContinuation)) {
      assert.ok(
        s.visualAssetRefs.length > 0,
        `slot ${s.baseSlotId} has an available asset but no visualAssetRefs`
      );
      assert.notEqual(s.emptyStateReason, "VISUAL_ASSET_UNAVAILABLE");
    }
    assert.equal(build.assemblyValidation?.checks.noPlaceholderWithAvailableAsset, true);
  });

  it("missing visual asset falls back to explicit VISUAL_ASSET_UNAVAILABLE only", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "orion-deck-noassets-"));
    const ctx = makeCtx();
    const result = runDeckBuild({
      ctx: { ...ctx, extras: { ...ctx.extras, visualAssets: {} } },
      bundleForValidation: inputs.mergedBundle,
      knownEvidenceRefs: inputs.knownEvidenceRefs,
      outputRoot: dir2,
      baseObservationCountBefore: inputs.baseCountBefore,
      baseObservationCountAfter: inputs.baseCountAfter,
    });
    const serpShot = result.packs
      .find((p) => p.fragmentKey === "RU_SERP_SCREENSHOT")!
      .slides.find((s) => s.baseSlotId === "p10_ru_serp_visual")!;
    assert.equal(serpShot.emptyStateReason, "VISUAL_ASSET_UNAVAILABLE");
    assert.deepEqual(serpShot.visualAssetRefs, []);
    // Validation for the report-72 build (with assets) stays green.
    assert.equal(
      validateAssembly({
        manifest: result.manifest,
        deckManifest: result.assembly.deckManifest,
        rendererSlides: result.assembly.rendererSlides,
        packs: result.packs,
        bundle: inputs.mergedBundle,
        baseObservationCountBefore: inputs.baseCountBefore,
        baseObservationCountAfter: inputs.baseCountAfter,
      }).checks.canonicalBaseSlotCoverage,
      true
    );
  });
});

describe("regression scenario: change only the RU AI fixture (report-72 data)", () => {
  const dir = mkdtempSync(join(tmpdir(), "orion-deck-regr-"));

  it("full pipeline: rebuild regenerates only RU AI; unchanged fragments reuse by contentHash", () => {
    // 1. Build all SectionPacks from saved report-72 data; save hashes.
    const build1 = buildOnce(dir);
    assert.equal(build1.manifest.buildBlocked, false);
    const hashes1 = new Map(build1.packs.map((p) => [p.fragmentKey, p.contentHash]));
    const pages1 = build1.assembly.deckManifest.pageCount;
    const deckHash1 = build1.assembly.deckManifest.assembledDeckHash;
    const tocRu1 = build1.assembly.deckManifest.toc.find((t) => t.title.includes("Россия"))!;

    // 2. Unchanged rebuild: every fragment reuses cache.
    const build2 = buildOnce(dir);
    assert.ok(
      build2.buildLog.every((l) => l.action === "REUSED_CACHE"),
      "unchanged rebuild must reuse every pack"
    );
    for (const p of build2.packs) {
      assert.equal(p.contentHash, hashes1.get(p.fragmentKey), `hash drift in ${p.fragmentKey}`);
    }
    assert.equal(build2.assembly.deckManifest.assembledDeckHash, deckHash1);

    // 3. Change ONLY the RU AI fixture: new AI answers appear in RU.
    const ctx3 = makeCtx();
    const ruAiUnit = ctx3.surfaceUnits.find((u) => u.surface === "ai_answers" && u.region === "RU");
    assert.ok(ruAiUnit, "report-72 data must contain an RU ai_answers unit");
    const existingRef = ruAiUnit!.evidenceRefs[0] ?? ruAiUnit!.claims[0]?.evidenceRefs[0];
    for (let i = 0; i < 8; i += 1) {
      ruAiUnit!.claims.push({
        claimId: `fixture-ru-ai-${i}`,
        text: `Обновлённый AI-ответ №${i + 1}: нейтральное упоминание делового профиля Сергея Глинки в сводке поисковой системы.`,
        subjectMatch: "SUBJECT_MATCH",
        evidenceRefs: existingRef ? [existingRef] : [],
      });
    }

    // 4. Rebuild.
    const build3 = buildOnce(dir, ctx3);

    // 5a. Only the RU AI fragment regenerated; UAE and COMPLIANCE reused.
    const regenerated = build3.buildLog.filter((l) => l.action === "REGENERATED").map((l) => l.fragmentKey);
    assert.deepEqual(regenerated, ["RU_KNOWLEDGE_AI"], `regenerated: ${regenerated.join(",")}`);
    for (const key of ["UAE_SERP", "UAE_SUMMARY", "UAE_IMAGES", "COMPLIANCE_MAIN"] as const) {
      assert.equal(
        build3.buildLog.find((l) => l.fragmentKey === key)?.action,
        "REUSED_CACHE",
        `${key} must not rebuild`
      );
    }

    // 5b. EXECUTIVE rebuilt only if a finding reached the summary — it did not.
    for (const key of ["EXECUTIVE_SUMMARY", "RISK_MATRIX", "DIGITAL_PROFILE_OVERVIEW"] as const) {
      assert.equal(build3.buildLog.find((l) => l.fragmentKey === key)?.action, "REUSED_CACHE");
    }

    // 5c. RU_PROFILE manifest updated: only the RU AI entry hash changed.
    const entries1 = new Map(build1.manifest.entries.map((e) => [e.fragmentKey, e.contentHash]));
    for (const e of build3.manifest.entries) {
      if (e.fragmentKey === "RU_KNOWLEDGE_AI") {
        assert.notEqual(e.contentHash, entries1.get(e.fragmentKey), "RU AI hash must change");
      } else {
        assert.equal(e.contentHash, entries1.get(e.fragmentKey), `${e.fragmentKey} hash must not change`);
      }
    }

    // 5d. Assembler rebuilt the final deck; numbering and TOC updated.
    assert.notEqual(build3.assembly.deckManifest.assembledDeckHash, deckHash1);
    assert.ok(
      build3.assembly.deckManifest.pageCount > pages1,
      "new AI answers must add continuation pages"
    );
    const tocRu3 = build3.assembly.deckManifest.toc.find((t) => t.title.includes("Россия"))!;
    assert.notEqual(tocRu3.title, tocRu1.title, "RU TOC range must shift");
    assert.equal(build3.assemblyValidation?.passed, true);
  });
});

describe("rendered artifacts parity", () => {
  it("PDF/PPTX/PNG have the same pageCount (report-72 deck)", () => {
    const root = join(process.cwd(), "baselines", "report-72", "artifacts", "deck-sections");
    const pptx = join(root, "rendered-client.pptx");
    const pdf = join(root, "rendered-client.pdf");
    const pages = join(root, "pages-png");
    assert.ok(existsSync(pptx) && existsSync(pdf), "run run-orion-deck-sections-report72 first");
    const out = execFileSync(
      "python",
      [
        "-X",
        "utf8",
        "-c",
        [
          "import sys, json, glob",
          "from pptx import Presentation",
          "import fitz",
          "pptx_n = len(Presentation(sys.argv[1]).slides)",
          "pdf_n = fitz.open(sys.argv[2]).page_count",
          "png_n = len(glob.glob(sys.argv[3] + '/page-*.png'))",
          "print(json.dumps({'pptx': pptx_n, 'pdf': pdf_n, 'png': png_n}))",
        ].join("\n"),
        pptx,
        pdf,
        pages,
      ],
      { encoding: "utf8" }
    );
    const counts = JSON.parse(out.trim().split("\n").pop()!) as {
      pptx: number;
      pdf: number;
      png: number;
    };
    const deckManifest = JSON.parse(
      readFileSync(join(root, "report-deck-manifest.json"), "utf8")
    ) as { pageCount: number };
    assert.equal(counts.pptx, deckManifest.pageCount);
    assert.equal(counts.pdf, deckManifest.pageCount);
    assert.equal(counts.png, deckManifest.pageCount);
  });

  it("NETWORK_CALLS=0: deck-sections modules make no network/LLM calls", () => {
    assert.equal(process.env.NETWORK_CALLS, "0");
    const dirPath = join(process.cwd(), "src/modules/digital-profile/orion-golden/deck-sections");
    for (const file of [
      "contracts.ts",
      "canonical-slots.ts",
      "coverage-reconciliation.ts",
      "template-registry.ts",
      "prompts.ts",
      "scoped-input.ts",
      "fragment-builders.ts",
      "section-builders.ts",
      "section-validation.ts",
      "section-manifest.ts",
      "deck-assembler.ts",
      "assembly-validation.ts",
      "run-deck-build.ts",
    ]) {
      const src = readFileSync(join(dirPath, file), "utf8");
      assert.ok(!/callOpenAi|openai|https?:\/\/api\.|fetch\(/iu.test(src), `${file} touches network`);
    }
  });
});

describe("sidebar evidence scope (fail closed)", () => {
  const ctx = { ...makeCtx(), buildLog: [] as never[] };
  const ruPacks = buildRuProfileSection(ctx);
  const uaePacks = buildUaeProfileSection(ctx);
  const allPacks = [...ruPacks, ...uaePacks];
  const ruShot = ruPacks
    .find((p) => p.fragmentKey === "RU_SERP_SCREENSHOT")!
    .slides.find((s) => s.baseSlotId === "p10_ru_serp_visual")!;
  const uaeShot = uaePacks
    .find((p) => p.fragmentKey === "UAE_SERP_SCREENSHOT")!
    .slides.find((s) => s.baseSlotId === "p27_uae_serp_visual")!;
  const slideText = (s: typeof ruShot): string =>
    [
      s.content.narrative,
      s.content.whatWasFound,
      s.content.whyItMatters,
      s.content.whatToCheck,
      s.content.sourceNote,
      s.content.statusNote,
      ...(s.content.highlightExplanations ?? []).map((h) => h.clientReason),
    ]
      .filter(Boolean)
      .join(" ");

  it("sidebar findingIds are a subset of the fragment's sourceFindingIds", () => {
    for (const p of allPacks) {
      const allowed = new Set(p.inputs.findingIds);
      for (const s of p.slides) {
        for (const id of s.findingIds) {
          assert.ok(allowed.has(id), `${p.fragmentKey}/${s.slideId}: finding ${id} outside scope`);
        }
      }
    }
  });

  it("sidebar evidenceRefs are a subset of the fragment's evidenceRefs", () => {
    for (const p of allPacks) {
      const allowed = new Set(p.inputs.evidenceRefs);
      for (const s of p.slides) {
        for (const ref of s.evidenceRefs) {
          assert.ok(allowed.has(ref), `${p.fragmentKey}/${s.slideId}: ref ${ref} outside scope`);
        }
      }
    }
  });

  it("region-scope isolation: RU sidebar cites no UAE evidence and vice versa", () => {
    for (const p of allPacks) {
      const region = p.fragmentKey.startsWith("RU_") ? "RU" : "UAE";
      for (const s of p.slides) {
        for (const ref of s.evidenceRefs) {
          const e = inputs.evidenceIndex[ref];
          if (!e?.region) continue;
          if (region === "RU") assert.equal(e.region, "RU", `${p.fragmentKey} cites ${e.region}`);
          else assert.notEqual(e.region, "RU", `${p.fragmentKey} cites RU evidence ${ref}`);
        }
      }
    }
  });

  it("surface-scope isolation: sidebar findings carry the fragment's surface", () => {
    const surfaceOf: Record<string, string> = {
      RU_SUGGESTIONS: "suggestions",
      UAE_SUGGESTIONS: "suggestions",
      RU_IMAGES: "images",
      UAE_IMAGES: "images",
      RU_RELATED: "paa_related",
      UAE_RELATED: "paa_related",
    };
    const byId = new Map(inputs.mergedBundle.findings.map((f) => [f.findingId, f]));
    for (const p of allPacks) {
      const surface = surfaceOf[p.fragmentKey];
      if (!surface) continue;
      for (const s of p.slides) {
        for (const id of s.findingIds) {
          const kinds = (byId.get(id)?.surfaceKinds ?? []) as string[];
          if (kinds.length === 0) continue;
          assert.ok(kinds.includes(surface), `${p.fragmentKey}: finding ${id} lacks ${surface}`);
        }
      }
    }
  });

  it("source footer is derived from the sidebar's own evidence refs", () => {
    const domainToken = /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.[a-z]{2,}\b/giu;
    for (const slide of [ruShot, uaeShot]) {
      const normRefs = new Set(
        slide.evidenceRefs.map((r) =>
          r
            .replace(/^serp_observation:/u, "")
            .replace(/^inventory:serp-obs-/u, "")
            .replace(/^inventory:ss-/u, "")
        )
      );
      const allowed = new Set<string>();
      for (const [ref, e] of Object.entries(inputs.evidenceIndex)) {
        if (!e.domain || e.domain === "—") continue;
        const norm = ref
          .replace(/^serp_observation:/u, "")
          .replace(/^inventory:serp-obs-/u, "")
          .replace(/^inventory:ss-/u, "");
        if (normRefs.has(norm)) allowed.add(e.domain.toLowerCase());
      }
      for (const m of (slide.content.sourceNote ?? "").matchAll(domainToken)) {
        assert.ok(allowed.has(m[0].toLowerCase()), `footer domain ${m[0]} not from slide evidence`);
      }
    }
  });

  it("page 13: explanations and footer cover exactly the highlighted frames (x.com, rupep.org)", () => {
    const footer = ruShot.content.sourceNote ?? "";
    assert.ok(footer.includes("x.com"), "page 13 footer must include x.com");
    assert.ok(footer.includes("rupep.org"), "page 13 footer must include rupep.org");
    const explanations = ruShot.content.highlightExplanations ?? [];
    assert.equal(explanations.length, 2, "one explanation per red frame");
    assert.ok(explanations.some((h) => h.clientReason.includes("x.com")));
    assert.ok(explanations.some((h) => h.clientReason.includes("rupep.org")));
    // No duplication between the opening conclusion and the explanations.
    for (const h of explanations) {
      assert.notEqual(ruShot.content.whatWasFound, h.clientReason);
    }
  });

  it("page 31: no RU criminal/judicial evidence; scoped to the visible UAE PEP signal", () => {
    const text = slideText(uaeShot);
    for (const d of ["audit-it.ru", "m.sledst.org", "sledst.org", "x.com"]) {
      assert.ok(!text.includes(d), `page 31 must not mention RU criminal domain ${d}`);
    }
    assert.ok(text.includes("rupep.org"), "page 31 must discuss the visible rupep.org signal");
    assert.ok(/PEP/u.test(text), "page 31 must name the PEP/RCA theme");
    // Visible coverage limitation: Google holds the highlighted result, the
    // Yandex panel has no stored results. It must live in a field the sidebar
    // actually renders on adverse pages (whyItMatters), not only in narrative.
    assert.ok(/Google/u.test(text) && /Яндекс/u.test(text), "coverage limitation must be stated");
    const why = uaeShot.content.whyItMatters ?? "";
    assert.ok(
      /Google/u.test(why) && /Яндекс/u.test(why),
      "coverage limitation must be in the rendered sidebar copy (whyItMatters)"
    );
    // The criminal finding must not be attached to the UAE snapshot sidebar.
    const criminal = inputs.mergedBundle.findings.find((f) =>
      /Криминальные/u.test(f.theme) && f.subjectMatch === "SUBJECT_MATCH"
    )!;
    assert.ok(!uaeShot.findingIds.includes(criminal.findingId));
  });

  it("no global-finding fallback: empty page → no-finding; non-empty rows → composition (§7.1)", () => {
    const ruSuggestions = ruPacks.find((p) => p.fragmentKey === "RU_SUGGESTIONS")!;
    for (const s of ruSuggestions.slides) {
      if (s.findingIds.length === 0) {
        const found = s.content.whatWasFound ?? "";
        assert.ok(
          found.includes("не обнаружено") || /Показано \d+/u.test(found),
          `${s.slideId}: empty findings must be no-finding OR row-composition, got: ${found.slice(0, 120)}`
        );
      }
    }
    // SERP: non-empty table must never keep the empty-finding boilerplate.
    for (const key of ["RU_SERP", "UAE_SERP"] as const) {
      const pack = [...ruPacks, ...uaePacks].find((p) => p.fragmentKey === key);
      if (!pack) continue;
      for (const s of pack.slides) {
        const rows = s.content.table?.rows?.length ?? 0;
        if (rows === 0) continue;
        const found = s.content.whatWasFound ?? "";
        assert.ok(found.length > 0, `${s.slideId}: sidebar must not be blank`);
        assert.ok(
          !found.includes("не обнаружено") || s.findingIds.length > 0,
          `${s.slideId}: non-empty table must not use empty-finding boilerplate`
        );
      }
    }
    // And the section QA gate fails closed on an out-of-scope finding.
    const shotPack = uaePacks.find((p) => p.fragmentKey === "UAE_SERP_SCREENSHOT")!;
    const criminal = inputs.mergedBundle.findings.find((f) =>
      /Криминальные/u.test(f.theme) && f.subjectMatch === "SUBJECT_MATCH"
    )!;
    const tampered: SectionPackV2 = structuredClone(shotPack);
    tampered.inputs.findingIds = tampered.inputs.findingIds.filter(
      (id) => id !== criminal.findingId
    );
    tampered.slides[0].findingIds = [...tampered.slides[0].findingIds, criminal.findingId];
    const report = validateSectionPack({
      pack: tampered,
      expectedCaseId: inputs.caseId,
      expectedReportRunId: inputs.reportRunId,
      expectedDatasetId: inputs.sourceDatasetId,
      bundle: inputs.mergedBundle,
      knownEvidenceRefs: inputs.knownEvidenceRefs,
      evidenceIndex: inputs.evidenceIndex,
    });
    assert.equal(report.passed, false);
    assert.ok(report.issues.some((i) => i.includes("outside fragment scope")));
  });
});

describe("REMEDIATION §7.4 empty surface collection status", () => {
  it("EMPTY_VALID / MEASURED units → «проверено, пусто»; FAILED → «не удалось собрать»", () => {
    const measuredScoped = {
      subject: { displayName: "Test", aliases: [] as string[] },
      findings: [],
      surfaceUnits: [
        {
          surface: "suggestions" as const,
          region: "RU",
          metrics: [
            { key: "totalCount", value: 0, sampleStatus: "MEASURED" as const, denominator: 0 },
            { key: "emptyMarkerCount", value: 1, sampleStatus: "MEASURED" as const },
          ],
          claims: [],
          evidenceRefs: ["inventory:empty-suggest"],
        },
      ],
      metricSnapshot: makeCtx().metricSnapshot,
      scope: fragmentScope("RU_SUGGESTIONS"),
      evidenceIndex: {},
      surfaceCollectionHints: [
        { surface: "suggestions", region: "RU", status: "NO_RESULTS" },
      ],
    };
    const measured = resolveEmptySurfaceCollection(measuredScoped as never, "suggestions");
    assert.equal(measured.kind, "MEASURED_EMPTY");
    const measuredCopy = coverageContent("no-suggestions", measured);
    assert.match(String(measuredCopy.narrative), /проверен/i);
    assert.match(String(measuredCopy.narrative), /результат проверки/i);
    assert.ok(!/NOT_COLLECTED|NO_RESULTS|EMPTY_VALID|HTTP_500/i.test(JSON.stringify(measuredCopy)));

    const failedScoped = {
      ...measuredScoped,
      surfaceUnits: [],
      surfaceCollectionHints: [
        {
          surface: "ai_answer",
          region: "RU",
          status: "HTTP_500",
          errorCode: "PROVIDER_TIMEOUT",
        },
      ],
    };
    const failed = resolveEmptySurfaceCollection(failedScoped as never, "ai_answers");
    assert.equal(failed.kind, "COLLECTION_FAILED");
    assert.match(String(failed.reasonLabel), /ошибка|не удалось/i);
    const failedCopy = coverageContent("no-ai-answers", failed);
    assert.match(String(failedCopy.narrative), /Не удалось собрать/i);
    assert.ok(!/HTTP_500|PROVIDER_TIMEOUT/i.test(JSON.stringify(failedCopy)));

    const skippedScoped = {
      ...measuredScoped,
      surfaceUnits: [],
      surfaceCollectionHints: [
        { surface: "images", region: "RU", status: "SKIPPED", errorCode: "DISABLED" },
      ],
    };
    const skipped = resolveEmptySurfaceCollection(skippedScoped as never, "images");
    assert.equal(skipped.kind, "COLLECTION_FAILED");
    const skippedCopy = coverageContent("no-images", skipped);
    assert.match(String(skippedCopy.narrative), /агент отключён|Не удалось собрать/i);
    assert.ok(!/\bDISABLED\b|\bSKIPPED\b/i.test(JSON.stringify(skippedCopy)));

    const absentScoped = {
      ...measuredScoped,
      surfaceUnits: [],
      surfaceCollectionHints: [],
    };
    const absent = resolveEmptySurfaceCollection(absentScoped as never, "paa_related");
    assert.equal(absent.kind, "NOT_COLLECTED");
    const absentCopy = coverageContent("no-related", absent);
    assert.match(String(absentCopy.narrative), /не собиралась/i);
  });
});

describe("REMEDIATION §7.3 executive sparse structure", () => {
  it("composeExecutivePageStructure yields ≥3 content blocks (coverage + identity + actions)", () => {
    const ctx = makeCtx();
    const es = {
      verdict: "INSUFFICIENT_DATA",
      executiveConclusion:
        "Собранных подтверждённых данных по субъекту недостаточно для доказательного вывода о репутационных рисках. Значительная часть найденных материалов относится к другому лицу и не может использоваться в выводах.",
      keyFindings: [] as Array<{
        findingId: string;
        title: string;
        factualBasis: string;
        clientImpact: string;
        recommendedAction: string;
      }>,
      priorityActions: ["Расширить проверку по незакрытым направлениям до принятия решений."],
      identityCaveats: [
        "В выдаче присутствуют материалы о другом лице — Тёзка (12 набл.); они исключены из выводов о проверяемом субъекте.",
        "4 наблюдений не удалось однозначно отнести к проверяемому лицу; они не учитывались как факты.",
      ],
      dataLimitations: ["Комплаенс-базы: выборка ограничена доступными провайдерами."],
      regionalOverview: [
        { region: "RU", oneLiner: "Регион RU: негативные материалы — 2 из 40 (5%).", totalCount: 40 },
      ],
    };
    const scoped = {
      subject: ctx.subject,
      findings: [],
      surfaceUnits: ctx.surfaceUnits.slice(0, 6),
      metricSnapshot: {
        ...ctx.metricSnapshot,
        compositeCount: 80,
        subjectMatchCount: 3,
        likelySubjectCount: 7,
        ambiguousCount: 4,
        otherSubjectCount: 12,
        adverseFindingCount: 0,
        perRegionCounts: { RU: 50, UAE: 30 },
      },
      scope: fragmentScope("EXECUTIVE_SUMMARY"),
      evidenceIndex: ctx.evidenceIndex,
    };
    const structure = composeExecutivePageStructure(scoped as never, es);
    const blockCount =
      structure.narrativeParagraphs.length + structure.factCards.length + (structure.recommendations ? 1 : 0);
    assert.ok(blockCount >= 3, `expected ≥3 blocks, got ${blockCount}`);
    assert.ok(structure.narrativeParagraphs.some((p) => /Карта покрытия/i.test(p)));
    assert.ok(
      structure.narrativeParagraphs.some((p) => /другом лице|требуют подтвержд|неоднознач/i.test(p)) ||
        structure.factCards.some((p) => /другом лице|требуют подтвержд|неоднознач/i.test(p))
    );
    assert.match(structure.recommendations, /Расширить проверку|проверка/i);

    const pack = buildSectionPackForFragment("EXECUTIVE_SUMMARY", {
      ...ctx,
      metricSnapshot: scoped.metricSnapshot,
      extras: { executiveSummary: es, visualAssets: ctx.extras.visualAssets },
      buildLog: [],
    });
    assert.equal(pack.status, "READY");
    const slide = pack.slides[0]!;
    const paras = String(slide.content.narrative ?? "").split(/\n+/).filter(Boolean);
    assert.ok(paras.length >= 2, "sparse narrative must not be a single collapsed paragraph");
    assert.ok(slide.content.bullets && slide.content.bullets.length >= 2);
    assert.ok(String(slide.content.whatToCheck ?? "").length > 20);
    assert.ok(
      slide.content.kpis?.some((k) => k.label === "Вероятно о субъекте" && k.value === "7")
    );
  });
});

describe("REMEDIATION §7.1 page row composition sidebar", () => {
  it("composePageRowComposition counts subject / likely / adverse / domains", () => {
    const scoped = {
      subject: { displayName: "Test", aliases: [] },
      findings: [],
      surfaceUnits: [],
      metricSnapshot: makeCtx().metricSnapshot,
      scope: fragmentScope("RU_SERP"),
      evidenceIndex: {
        "inventory:a": {
          title: "Санкции против субъекта",
          domain: "rbc.ru",
          subjectDecision: "SUBJECT_MATCH",
          adverse: true,
        },
        "inventory:b": {
          title: "Обычная новость",
          domain: "example.com",
          subjectDecision: "LIKELY_SUBJECT",
        },
        "inventory:c": {
          title: "Биография",
          domain: "rbc.ru",
          subjectDecision: "SUBJECT_MATCH",
        },
      },
    };
    const c = composePageRowComposition(scoped as never, [
      "inventory:a",
      "inventory:b",
      "inventory:c",
    ]);
    assert.equal(c.shown, 3);
    assert.equal(c.subjectMatch, 2);
    assert.equal(c.likelySubject, 1);
    assert.ok(c.adverseHeadlines >= 1);
    assert.equal(c.topDomains[0], "rbc.ru");
    const blocks = pageRowCompositionBlocks(c, {
      refs: ["inventory:a", "inventory:b", "inventory:c"],
      domains: ["rbc.ru", "example.com"],
      findings: [],
      supportDomains: new Map(),
    });
    assert.match(String(blocks.whatWasFound), /Показано 3/);
    assert.match(String(blocks.whatWasFound), /о субъекте — 2/);
    assert.match(String(blocks.whatWasFound), /вероятно о субъекте — 1/);
    assert.ok(!String(blocks.whatWasFound).includes("не обнаружено"));
  });

  it("SERP with rows but no page findings uses composition, not empty boilerplate", () => {
    const ctx = makeCtx();
    // Build a scoped organic slice whose findings do not intersect page refs.
    const organicUnits = ctx.surfaceUnits.filter((u) => u.surface === "organic");
    const refs = organicUnits.flatMap((u) => u.evidenceRefs).slice(0, 5);
    assert.ok(refs.length >= 2, "fixture must have organic refs");
    const scoped = {
      subject: ctx.subject,
      findings: [], // force empty page findings
      surfaceUnits: organicUnits,
      metricSnapshot: ctx.metricSnapshot,
      scope: fragmentScope("RU_SERP"),
      evidenceIndex: ctx.evidenceIndex,
    };
    const out = buildSerpFragment("RU_SERP", "RU_PROFILE", "Россия", scoped as never);
    assert.ok(out.slides.length >= 1);
    for (const s of out.slides) {
      const rows = s.content.table?.rows?.length ?? 0;
      if (rows === 0) continue;
      assert.match(String(s.content.whatWasFound), /Показано \d+/u);
      assert.ok(!String(s.content.whatWasFound).includes("не обнаружено"));
      // Renderer reads narrative above the table — must carry the same copy.
      assert.equal(s.content.narrative, s.content.whatWasFound);
      // Continuations must keep a filled sidebar (§7.1).
      if (s.isContinuation) {
        assert.ok(String(s.content.whatWasFound ?? "").length > 20);
      }
    }
  });
});

describe("section pack contract invariants", () => {
  it("stable slideId/baseSlotId across rebuilds of the same fragment", () => {
    const a = buildSectionPackForFragment("RU_SERP", { ...makeCtx(), buildLog: [] });
    const b = buildSectionPackForFragment("RU_SERP", { ...makeCtx(), buildLog: [] });
    assert.deepEqual(
      a.slides.map((s) => [s.slideId, s.baseSlotId]),
      b.slides.map((s) => [s.slideId, s.baseSlotId])
    );
  });

  it("OTHER_SUBJECT findings never enter subject sections; appendix retains them", () => {
    const packs = [
      ...buildRuProfileSection({ ...makeCtx(), buildLog: [] }),
      ...buildUaeProfileSection({ ...makeCtx(), buildLog: [] }),
      ...buildExecutiveSection({ ...makeCtx(), buildLog: [] }),
    ];
    const otherIds = new Set(
      inputs.mergedBundle.findings
        .filter((f) => f.subjectMatch === "OTHER_SUBJECT")
        .map((f) => f.findingId)
    );
    for (const p of packs) {
      for (const s of p.slides) {
        for (const id of s.findingIds) {
          assert.ok(!otherIds.has(id), `OTHER_SUBJECT ${id} leaked into ${p.fragmentKey}`);
        }
      }
    }
  });
});

describe("B-0 self-contained SectionPack lineage (PHASE A check 24)", () => {
  const build = buildOnce(mkdtempSync(join(tmpdir(), "orion-deck-b0-")));

  it("every pack carries explicit caseId/datasetId/reportRunId/hash/scope (v3)", () => {
    const packs = buildRuProfileSection({ ...makeCtx(), buildLog: [] });
    for (const p of packs) {
      assert.equal(p.schemaVersion, SECTION_PACK_SCHEMA_VERSION);
      assert.equal(p.caseId, inputs.caseId);
      assert.ok(p.caseId.length > 0, "caseId must never be undefined/empty");
      assert.equal(p.datasetId, inputs.sourceDatasetId);
      assert.equal(p.datasetId, p.sourceDatasetId);
      assert.equal(p.reportRunId, inputs.reportRunId);
      assert.ok(p.contentHash.startsWith("sha256:"));
      assert.deepEqual(p.sourceFindingIds, p.inputs.findingIds);
      assert.deepEqual(p.evidenceRefs, p.inputs.evidenceRefs);
    }
  });

  it("assembler rejects a foreign-case pack fail-closed", () => {
    const packs = build.packs.map((p) =>
      p.fragmentKey === "RU_SERP" ? { ...p, caseId: "case-foreign-000" } : p
    );
    const result = assembleDeck({
      manifest: build.manifest,
      packs,
      expectedCaseId: inputs.caseId,
      expectedReportRunId: inputs.reportRunId,
      expectedDatasetId: inputs.sourceDatasetId,
    });
    const rej = result.rejections.find((r) => r.fragmentKey === "RU_SERP");
    assert.equal(rej?.reason, "FOREIGN_CASE");
    assert.ok(result.errors.length > 0, "required foreign-case pack must stop the build");
    assert.equal(result.deckManifest.pageCount, 0);
  });

  it("section QA rejects a caseId=undefined pack", () => {
    const good = buildSectionPackForFragment("RU_SERP", { ...makeCtx(), buildLog: [] });
    const undef = { ...good, caseId: undefined } as unknown as SectionPackV2;
    const report = validateSectionPack({
      pack: undef,
      expectedCaseId: inputs.caseId,
      expectedReportRunId: inputs.reportRunId,
      expectedDatasetId: inputs.sourceDatasetId,
      bundle: inputs.mergedBundle,
      knownEvidenceRefs: inputs.knownEvidenceRefs,
    });
    assert.equal(report.passed, false);
    assert.ok(report.issues.some((i) => /caseId/u.test(i)));
  });
});

describe("B-0 offline v2->v3 migration (lineage-safe)", () => {
  const build = buildOnce(mkdtempSync(join(tmpdir(), "orion-deck-b0mig-")));
  function legacyFrom(pack: SectionPackV2): LegacySectionPackV2 {
    const clone = structuredClone(pack) as Record<string, unknown>;
    delete clone.caseId;
    delete clone.datasetId;
    delete clone.sourceFindingIds;
    delete clone.evidenceRefs;
    clone.schemaVersion = SECTION_PACK_V2_SCHEMA_VERSION;
    return clone as unknown as LegacySectionPackV2;
  }
  const manifest = {
    caseId: inputs.caseId,
    reportRunId: inputs.reportRunId,
    sourceDatasetId: inputs.sourceDatasetId,
    entries: build.manifest.entries.map((e) => ({
      fragmentKey: e.fragmentKey,
      contentHash: e.contentHash,
    })),
  };

  it("backfills caseId/datasetId/scope and produces a valid v3 pack", () => {
    const legacy = legacyFrom(build.packs.find((p) => p.fragmentKey === "RU_SERP")!);
    const { pack, reject } = migratePack({ legacy, manifest });
    assert.equal(reject, undefined);
    assert.ok(pack);
    assert.equal(pack!.schemaVersion, SECTION_PACK_SCHEMA_VERSION);
    assert.equal(pack!.caseId, inputs.caseId);
    assert.equal(pack!.datasetId, inputs.sourceDatasetId);
    assert.deepEqual(pack!.sourceFindingIds, pack!.inputs.findingIds);
    assert.deepEqual(pack!.evidenceRefs, pack!.inputs.evidenceRefs);
  });

  it("rejects a legacy pack with a foreign reportRunId", () => {
    const legacy = legacyFrom(build.packs.find((p) => p.fragmentKey === "RU_SERP")!);
    legacy.reportRunId = "orion-foreign-run";
    const { pack, reject } = migratePack({ legacy, manifest });
    assert.equal(pack, undefined);
    assert.ok(reject && /reportRunId/u.test(reject));
  });

  it("rejects a legacy pack whose content hash was tampered", () => {
    const legacy = legacyFrom(build.packs.find((p) => p.fragmentKey === "RU_SERP")!);
    legacy.slides[0].title = `${legacy.slides[0].title} (tampered)`;
    const { pack, reject } = migratePack({ legacy, manifest });
    assert.equal(pack, undefined);
    assert.ok(reject && /hash/u.test(reject));
  });
});
