/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { SectionType } from "../contracts";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import { freshnessFootnote } from "../../../services/report-material-freshness";
import type { FragmentBuildOutput } from "./shared";
import { makeSlotSlide } from "./shared";

export function buildFrontMatterFragment(
  sectionId: SectionType,
  scoped: ScopedFragmentInput
): FragmentBuildOutput {
  const [cover, toc] = slotsForFragment("FRONT_MATTER_MAIN");
  return {
    slides: [
      makeSlotSlide({
        slot: cover,
        sectionId,
        title: `Отчёт о цифровом профиле — ${scoped.subject.displayName}`,
        content: { narrative: "Конфиденциально. Подготовлено для внутреннего использования клиента." },
        evidenceRefs: [],
        findingIds: [],
      }),
      // TOC content (titles/pages) is assembler-owned; slot only reserved here.
      makeSlotSlide({
        slot: toc,
        sectionId,
        content: { bullets: [] },
        evidenceRefs: [],
        findingIds: [],
      }),
    ],
    status: "READY",
  };
}
