/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import { createHash } from "node:crypto";
import type { FragmentKey, SectionType, SlideBody, SlideContentContract } from "../contracts";
import { SLIDE_CONTENT_SCHEMA_VERSION } from "../contracts";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import type { FragmentBuildOutput, FragmentExtras } from "./shared";
import {
  clampClientText,
  makeSlotSlide,
  sourceLine,
  themedClaim,
  uniqueRefs,
  withContinuations,
} from "./shared";

export function buildAppendixFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput
): FragmentBuildOutput {
  const ambiguous = scoped.findings.filter((f) => f.subjectMatch !== "SUBJECT_MATCH");
  if (ambiguous.length === 0) {
    return { slides: [], status: "EMPTY_VALID", emptyStateReason: "no-appendix-material" };
  }
  const base: SlideContentContract = {
    schemaVersion: SLIDE_CONTENT_SCHEMA_VERSION,
    slideId: "appendix_main_base",
    baseSlotId: "slot_appendix_main",
    sectionId,
    isContinuation: false,
    continuationOf: null,
    continuationIndex: null,
    templateId: "finding-cards",
    title: "Приложение: материалы, требующие идентификации",
    content: {
      bullets: ambiguous.map(
        (f) => clampClientText(themedClaim(f), 340) + ` [${f.findingId}]`
      ),
      sourceNote: sourceLine(scoped),
    },
    evidenceRefs: uniqueRefs(scoped),
    findingIds: ambiguous.map((f) => f.findingId),
    metrics: { items: ambiguous.length },
    visualAssetRefs: [],
  };
  return { slides: withContinuations(base, "finding-cards"), status: "READY" };
}

