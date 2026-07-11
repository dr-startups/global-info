/**
 * Unit tests for First36 v57 highlight explanations + client-safe gate.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertValidHighlightExplanation,
  isValidSourceDomain,
  resolveFrameTone,
  type HighlightExplanation,
} from "../src/modules/digital-profile/orion-report-spec/highlight-explanation";
import {
  containsForbiddenClientVisibleText,
  isClientSafeEvidence,
} from "../src/modules/digital-profile/orion-report-spec/client-safe-evidence";
import { buildDeterministicVisualAnalysis } from "../src/modules/digital-profile/orion-golden/classic/orion-first36-deck-composer";
import { ORION_FIRST36_REGISTRY_V1 } from "../src/modules/digital-profile/orion-golden/classic/orion-first36-registry.v1";
import type { ReportAssetV1 } from "../src/modules/digital-profile/orion-report-spec/asset-builder";

describe("v57 highlight explanations", () => {
  it("domain with dots is never treated as TLD-only", () => {
    assert.equal(isValidSourceDomain("rucriminal.info"), true);
    assert.equal(isValidSourceDomain("vlasti.io"), true);
    assert.equal(isValidSourceDomain("kompromat1.online"), true);
    assert.equal(isValidSourceDomain("info"), false);
    assert.equal(isValidSourceDomain("com"), false);
    assert.equal(isValidSourceDomain("online"), false);
  });

  it("namesake resolves to amber, not red", () => {
    assert.equal(resolveFrameTone("namesake", true), "amber");
    assert.equal(resolveFrameTone("unverified", true), "amber");
    assert.equal(resolveFrameTone("unrelated", true), "none");
    assert.equal(resolveFrameTone("likely_subject", true), "red");
    assert.equal(resolveFrameTone("confirmed_subject", true), "red");
  });

  it("red frame explanation must include evidenceRef/identity/clientReason", () => {
    const ex: HighlightExplanation = {
      evidenceRef: "img-1",
      itemIndex: 0,
      displayLabel: "rupep.org",
      sourceDomain: "rupep.org",
      riskCategory: "sanctions_pep",
      identityStatus: "likely_subject",
      clientReason: "rupep.org — карточка PEP с совпадением по ФИО; требуется сверка.",
      confidence: "medium",
      frameTone: "red",
    };
    assert.doesNotThrow(() => assertValidHighlightExplanation(ex));
    assert.throws(() =>
      assertValidHighlightExplanation({
        ...ex,
        identityStatus: "namesake",
        frameTone: "red",
      })
    );
  });

  it("suggestions/related sidebar is not titled Почему выделено", () => {
    const slot = ORION_FIRST36_REGISTRY_V1.find((s) => s.kind === "suggestions_visual")!;
    const asset: ReportAssetV1 = {
      assetRef: "ru_suggest",
      kind: "surface_panel",
      title: "Подсказки",
      caption: "Сохранённые строки",
      status: "ready",
      evidenceRefs: [],
      imageData: "x".repeat(900),
    };
    const a = buildDeterministicVisualAnalysis(asset, slot);
    assert.notEqual(a.sidebarMode, "adverse_explanation");
    assert.ok(a.sidebarMode === "interpretation" || a.sidebarMode === "status");
  });

  it("no technical tokens in client sidebar fields", () => {
    const slot = ORION_FIRST36_REGISTRY_V1.find((s) => s.page === 14)!;
    const asset: ReportAssetV1 = {
      assetRef: "ru_image_grid",
      kind: "image_grid",
      title: "images",
      caption: "Подборка изображений",
      status: "ready",
      evidenceRefs: ["e1"],
      imageData: "x".repeat(900),
      highlightExplanations: [
        {
          evidenceRef: "e1",
          itemIndex: 0,
          displayLabel: "vlasti.io",
          sourceDomain: "vlasti.io",
          riskCategory: "adverse_source",
          identityStatus: "likely_subject",
          clientReason: "vlasti.io — источник с нежелательным контекстом; сверить принадлежность субъекту.",
          confidence: "medium",
          frameTone: "red",
        },
      ],
    };
    const a = buildDeterministicVisualAnalysis(asset, slot);
    const blob = [a.headlineConclusion, a.whatIsVisible, a.clientMeaning, a.provenanceLabel, ...(a.recommendedActions || [])].join(
      " "
    );
    assert.equal(containsForbiddenClientVisibleText(blob), false);
    assert.ok(!blob.includes("…") && !blob.includes("..."));
    assert.equal(a.sidebarMode, "adverse_explanation");
    assert.ok((a.highlightExplanations?.length ?? 0) >= 1);
  });

  it("blocks DEMO knowledge evidence", () => {
    assert.equal(
      isClientSafeEvidence({
        title: "[DEMO] Knowledge",
        url: "https://example.com/%2Fstorage%2Finternal",
      }),
      false
    );
    assert.equal(
      isClientSafeEvidence({
        title: "Сергей Глинка",
        url: "https://ru.wikipedia.org/wiki/Test",
        snippet: "бизнесмен",
      }),
      true
    );
  });
});
