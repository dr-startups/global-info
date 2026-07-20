/**
 * First36 geometry v2 focused tests — role-aware layout QA.
 * LIVE API NOT RUN.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildGeometryReportFromParts,
  classifyShapeRole,
  geometryReportIsClean,
  inspectLayoutTelemetry,
  inspectMissingVisualAssets,
  inspectRoleAwareShapes,
  loadGeometryFixture,
  resolveRequiredVisualForSlide,
  SLIDE_H,
  SLIDE_W,
} from "../src/modules/digital-profile/orion-golden/classic/generate-first36-geometry-artifacts";

const FIXTURE_DIR = join(
  process.cwd(),
  "src/modules/digital-profile/orion-golden/classic/fixtures/geometry"
);

function it(name: string, fn: () => void | Promise<void>) {
  return { name, fn };
}

async function runPythonInspector(pptx: string) {
  const script = join(process.cwd(), "scripts", "inspect-first36-pptx-geometry.py");
  const py = spawnSync("python", [script, pptx], { encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 });
  assert.equal(py.status, 0, py.stderr || py.stdout);
  return JSON.parse(py.stdout) as {
    overlaps: unknown[];
    overflow: unknown[];
    clipping: unknown[];
    inspectorVersion?: string;
  };
}

const tests = [
  it("full-slide background + textbox = PASS (pure shapes)", () => {
    const shapes = [
      {
        id: 0,
        name: "orion_bg_full",
        role: "background" as const,
        bbox: { x: 0, y: 0, cx: SLIDE_W, cy: SLIDE_H },
        hasText: false,
        textLength: 0,
      },
      {
        id: 1,
        name: "orion_text_title",
        role: "text" as const,
        bbox: { x: 480_000, y: 800_000, cx: 8_000_000, cy: 1_200_000 },
        hasText: true,
        textLength: 40,
      },
    ];
    const r = inspectRoleAwareShapes(shapes, 1);
    assert.equal(r.overlaps.length, 0);
    assert.equal(r.overflow.length, 0);
  }),

  it("textbox inside card = PASS", () => {
    const shapes = [
      {
        id: 0,
        name: "orion_card_main",
        role: "container" as const,
        bbox: { x: 480_000, y: 700_000, cx: 10_000_000, cy: 4_000_000 },
      },
      {
        id: 1,
        name: "orion_text_body",
        role: "text" as const,
        bbox: { x: 700_000, y: 1_000_000, cx: 9_000_000, cy: 2_000_000 },
        hasText: true,
        textLength: 40,
      },
    ];
    const r = inspectRoleAwareShapes(shapes, 1);
    assert.equal(r.overlaps.length, 0);
  }),

  it("two conflicting text boxes = CRITICAL", () => {
    const shapes = [
      {
        id: 0,
        name: "t1",
        role: "text" as const,
        bbox: { x: 500_000, y: 800_000, cx: 5_000_000, cy: 1_500_000 },
        hasText: true,
        textLength: 40,
      },
      {
        id: 1,
        name: "t2",
        role: "text" as const,
        bbox: { x: 1_500_000, y: 1_000_000, cx: 5_000_000, cy: 1_500_000 },
        hasText: true,
        textLength: 40,
      },
    ];
    const r = inspectRoleAwareShapes(shapes, 1);
    assert.ok(r.overlaps.some((o) => o.code === "text-text-collision" && o.severity === "CRITICAL"));
  }),

  it("shape past slide bounds = CRITICAL", () => {
    const shapes = [
      {
        id: 0,
        name: "oob",
        role: "text" as const,
        bbox: { x: 500_000, y: 6_800_000, cx: 4_000_000, cy: 1_200_000 },
        hasText: true,
        textLength: 40,
      },
    ];
    const r = inspectRoleAwareShapes(shapes, 1);
    assert.ok(r.overflow.some((o) => o.code === "out-of-bounds" && o.severity === "CRITICAL"));
  }),

  it("text clipping telemetry = CRITICAL", () => {
    const dir = join(process.cwd(), "storage/digital-profile/qa-geometry-v2-tmp");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "layout-telemetry.json");
    writeFileSync(
      path,
      JSON.stringify({
        entries: [
          {
            page: 3,
            name: "body",
            clipped: true,
            requiredHeight: 900_000,
            availableHeight: 200_000,
          },
        ],
      }),
      "utf-8"
    );
    const issues = inspectLayoutTelemetry(path);
    assert.ok(issues.some((i) => i.code === "text-clipping" && i.severity === "CRITICAL"));
  }),

  it("missing required image from registry = BLOCKER", () => {
    const issues = inspectMissingVisualAssets(
      [{ pageNumber: 10, slideKey: "p10_ru_serp_visual", assetRefs: [] }],
      []
    );
    assert.ok(issues.some((i) => i.code === "missing-asset" && i.severity === "BLOCKER"));
    assert.equal(resolveRequiredVisualForSlide({ pageNumber: 10, slideKey: "p10_ru_serp_visual" }), true);
    assert.equal(resolveRequiredVisualForSlide({ pageNumber: 1, slideKey: "p01_cover" }), false);
  }),

  it("clean fixture report = PASS; conflict fixtures fail", () => {
    assert.equal(geometryReportIsClean(loadGeometryFixture("clean-page.json")), true);
    assert.equal(loadGeometryFixture("overlap.json").summary.severity, "CRITICAL");
    assert.equal(loadGeometryFixture("clipping-overflow.json").summary.severity, "CRITICAL");
    assert.equal(loadGeometryFixture("missing-image.json").summary.severity, "BLOCKER");
  }),

  it("classifyShapeRole recognizes background and footer", () => {
    assert.equal(
      classifyShapeRole({ name: "orion_bg_full", bbox: { x: 0, y: 0, cx: SLIDE_W, cy: SLIDE_H } }),
      "background"
    );
    assert.equal(
      classifyShapeRole({
        name: "orion_footer_p1",
        bbox: { x: 480_000, y: SLIDE_H - 400_000, cx: 1_000_000, cy: 250_000 },
        hasText: true,
        textLength: 5,
      }),
      "footer"
    );
  }),

  it("integration PPTX fixtures: intentional overlaps PASS, collisions FAIL", async () => {
    const builder = join(process.cwd(), "scripts", "build-first36-geometry-fixtures.py");
    const built = spawnSync("python", [builder], { encoding: "utf-8" });
    assert.equal(built.status, 0, built.stderr || built.stdout);

    const bg = await runPythonInspector(join(FIXTURE_DIR, "fixture-bg-plus-text.pptx"));
    assert.equal(bg.overlaps.length, 0, JSON.stringify(bg.overlaps));
    assert.equal(bg.overflow.length, 0, JSON.stringify(bg.overflow));

    const card = await runPythonInspector(join(FIXTURE_DIR, "fixture-textbox-in-card.pptx"));
    assert.equal(card.overlaps.length, 0, JSON.stringify(card.overlaps));

    const collide = await runPythonInspector(join(FIXTURE_DIR, "fixture-text-collision.pptx"));
    assert.ok(collide.overlaps.length > 0, "expected text-text collision");

    const oob = await runPythonInspector(join(FIXTURE_DIR, "fixture-out-of-bounds.pptx"));
    assert.ok(oob.overflow.length > 0, "expected out-of-bounds");

    const intentional = await runPythonInspector(join(FIXTURE_DIR, "fixture-intentional-overlaps.pptx"));
    assert.equal(intentional.overlaps.length, 0, JSON.stringify(intentional.overlaps));
    assert.ok(String(intentional.inspectorVersion || "").includes("first36-geometry-v2"));
  }),

  it("36 correct PNG count + clean report = PASS", async () => {
    const report = buildGeometryReportFromParts({
      overlaps: [],
      overflow: [],
      blank: [],
      clipping: [],
      missingAssets: [],
      emptyContent: [],
      emptyPages: [],
      pageCount: 36,
    });
    assert.equal(geometryReportIsClean(report), true);
    assert.equal(report.inspectorVersion, "first36-geometry-v2");
  }),
];

async function main() {
  let passed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`PASS ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`FAIL ${t.name}`);
      console.error(err);
      process.exitCode = 1;
      return;
    }
  }
  console.log(`geometry-v2 ${passed}/${tests.length}`);
  // silence unused
  void existsSync;
}

main();
