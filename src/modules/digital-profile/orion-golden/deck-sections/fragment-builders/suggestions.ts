/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType, SlideContentContract } from "../contracts";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import type { FragmentBuildOutput, FragmentExtras } from "./shared";
import {
  adverseVisualSidebar,
  buildPageEvidenceView,
  claimText,
  clampClientText,
  pageFindingBlocks,
  visualSlide,
} from "./shared";

export function buildSuggestionsFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const slots = slotsForFragment(key);
  const units = scoped.surfaceUnits.filter((u) => u.surface === "suggestions");
  const slides: SlideContentContract[] = [];
  for (const slot of slots) {
    const engine = slot.slotId.includes("yandex")
      ? "YANDEX"
      : slot.slotId.includes("google")
        ? "GOOGLE"
        : null;
    const slotUnits = engine ? units.filter((u) => (u.engine ?? "").toUpperCase() === engine) : units;
    const refs = slotUnits.flatMap((u) => u.evidenceRefs);
    const bullets = slotUnits
      .flatMap((u) => u.claims)
      .map((c) => clampClientText(claimText(c), 400));
    const suggestionLines = refs
      .map((r) => scoped.evidenceIndex[r]?.title)
      .filter((t): t is string => Boolean(t))
      .slice(0, 10);
    // Sidebar strictly scoped to the queries displayed on THIS page.
    const view = buildPageEvidenceView(scoped, refs);
    const sidebar = adverseVisualSidebar(slot.slotId, extras, scoped, "подсказка");
    slides.push(
      visualSlide({
        slot,
        sectionId,
        extras,
        scoped,
        content: {
          bullets: bullets.length ? bullets : suggestionLines,
          ...pageFindingBlocks(scoped, view),
          ...(sidebar.explanations.length
            ? {
                whatWasFound: clampClientText(
                  `Подсказок на панели: ${sidebar.visibleRows.length}; выделено красным (негативные формулировки): ${sidebar.adverseRows.length}.`,
                  400
                ),
                whyItMatters: clampClientText(
                  "Негативные подсказки видны пользователю ещё до просмотра результатов: они формируют первое впечатление и подталкивают к поиску компрометирующих материалов.",
                  320
                ),
                highlightExplanations: sidebar.explanations,
              }
            : {}),
        },
        evidenceRefs: [...new Set([...refs, ...sidebar.gridRefs])],
        findingIds: [
          ...new Set([...view.findings.map((f) => f.findingId), ...sidebar.explainedFindingIds]),
        ],
        metrics: { items: refs.length, adverseSuggestions: sidebar.adverseRows.length },
        noUnderlyingData: refs.length === 0,
        noDataReason: "no-suggestions",
      })
    );
  }
  return { slides, status: "READY" };
}
