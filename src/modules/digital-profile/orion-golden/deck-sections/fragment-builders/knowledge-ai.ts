/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType, SlideContentContract } from "../contracts";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import type { FragmentBuildOutput, FragmentExtras } from "./shared";
import {
  buildPageEvidenceView,
  claimText,
  clampClientText,
  coverageContent,
  emptyStatusForReason,
  pageFindingBlocks,
  visualSlide,
  withContinuations,
} from "./shared";

export function buildKnowledgeAiFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const slots = slotsForFragment(key);
  const aiUnits = scoped.surfaceUnits.filter((u) => u.surface === "ai_answers");
  const aiClaims = aiUnits.flatMap((u) => u.claims);
  // Source answers are never truncated: full claim text; pagination is done
  // via continuations, not by cutting text.
  const aiBullets = aiClaims.map(claimText);
  const aiTitles = aiUnits
    .flatMap((u) => u.evidenceRefs)
    .map((r) => scoped.evidenceIndex[r]?.title)
    .filter((t): t is string => Boolean(t));
  const slides: SlideContentContract[] = [];

  const panelSlot = slots.find((s) => s.templateId === "wikipedia-knowledge");
  const aiSlot = slots.find((s) => s.templateId === "ai-overview") ?? slots[0];

  if (panelSlot) {
    const knowledgeRefs = Object.entries(scoped.evidenceIndex)
      .filter(([, e]) => e.kind === "knowledge_block")
      .map(([ref]) => ref);
    // Sidebar strictly scoped to this surface's own observations.
    const panelView = buildPageEvidenceView(scoped, knowledgeRefs);
    slides.push(
      visualSlide({
        slot: panelSlot,
        sectionId,
        extras,
        scoped,
        content: {
          narrative:
            "Панель знаний и структурированные блоки поисковых систем по проверяемому субъекту.",
          ...pageFindingBlocks(scoped, panelView),
        },
        evidenceRefs: knowledgeRefs,
        findingIds: panelView.findings.map((f) => f.findingId),
        metrics: { knowledgeBlocks: knowledgeRefs.length },
        noUnderlyingData: false,
      })
    );
  }

  const aiRefs = aiUnits.flatMap((u) => u.evidenceRefs);
  const aiView = buildPageEvidenceView(scoped, aiRefs);
  const aiBase = visualSlide({
    slot: aiSlot,
    sectionId,
    extras,
    scoped,
    content: {
      bullets: aiBullets.length ? aiBullets : aiTitles,
      ...pageFindingBlocks(scoped, aiView),
    },
    evidenceRefs: aiRefs,
    findingIds: aiView.findings.map((f) => f.findingId),
    metrics: { answers: Math.max(aiClaims.length, aiTitles.length) },
    noUnderlyingData: aiUnits.length === 0,
    noDataReason: "no-ai-answers",
  });
  slides.push(...withContinuations(aiBase, "ai-overview"));

  return { slides, status: "READY" };
}

// ---------------------------------------------------------------------------
// RELATED (RU p20..p22; UAE p32)
// ---------------------------------------------------------------------------
