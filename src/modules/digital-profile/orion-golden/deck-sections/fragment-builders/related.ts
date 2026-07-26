/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType } from "../contracts";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import type { FragmentBuildOutput, FragmentExtras } from "./shared";
import { collapseEmptySurfaceSlots } from "../empty-surface-collapse";
import {
  buildPageEvidenceView,
  claimText,
  clampClientText,
  distribute,
  pageFindingBlocks,
  visualSlide,
} from "./shared";

export function buildRelatedQueriesFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const slots = slotsForFragment(key);
  const units = scoped.surfaceUnits.filter((u) => u.surface === "paa_related");
  const claims = units.flatMap((u) => u.claims);
  const refs = units.flatMap((u) => u.evidenceRefs);
  const claimChunks = distribute(claims, slots.length);
  const refChunks = distribute(refs, slots.length);
  const slides = slots.map((slot, i) => {
    const lines = refChunks[i]
      .map((r) => scoped.evidenceIndex[r]?.title)
      .filter((t): t is string => Boolean(t))
      .slice(0, 10);
    // Sidebar strictly scoped to the related queries displayed on THIS page.
    const view = buildPageEvidenceView(scoped, refChunks[i]);
    return visualSlide({
      slot,
      sectionId,
      extras,
      scoped,
      content: {
        bullets: claimChunks[i].length
          ? claimChunks[i].map((c) => clampClientText(claimText(c), 400))
          : lines,
        ...pageFindingBlocks(scoped, view),
      },
      evidenceRefs: refChunks[i],
      findingIds: view.findings.map((f) => f.findingId),
      metrics: { items: refChunks[i].length },
      noUnderlyingData: refs.length === 0,
      noDataReason: "no-related",
    });
  });
  // Пустая поверхность занимает одну страницу, а не три одинаковые (шаг 15, E2).
  const collapsed = collapseEmptySurfaceSlots(slides);
  return { slides: collapsed.slides, status: "READY" };
}

// ---------------------------------------------------------------------------
// COMPLIANCE (p33..p36) — existing content, no source expansion
