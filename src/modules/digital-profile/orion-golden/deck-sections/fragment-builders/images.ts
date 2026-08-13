/**
 * Independent surface fragment builders — canonical-slot aware.
 * Split from fragment-builders.ts (REMEDIATION §9.5) — mechanical move only.
 */

import type { FragmentKey, SectionType } from "../contracts";
import type { ScopedFragmentInput } from "../scoped-input";
import { slotsForFragment } from "../canonical-slots";
import type { FragmentBuildOutput, FragmentExtras } from "./shared";
import { pluralRu } from "../../analytics/finding-synthesizer";
import {
  adverseVisualSidebar,
  buildPageEvidenceView,
  claimText,
  clampClientText,
  distribute,
  pageFindingBlocks,
  visualSlide,
} from "./shared";

export function buildImagesFragment(
  key: FragmentKey,
  sectionId: SectionType,
  regionLabel: string,
  scoped: ScopedFragmentInput,
  extras: FragmentExtras
): FragmentBuildOutput {
  const slots = slotsForFragment(key);
  const units = scoped.surfaceUnits.filter((u) => u.surface === "images");
  // Same normalized claim text must not repeat across the image slides.
  const seenClaimText = new Set<string>();
  const claims = units
    .flatMap((u) => u.claims)
    .filter((c) => {
      const norm = c.text.trim().toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "");
      if (seenClaimText.has(norm)) return false;
      seenClaimText.add(norm);
      return true;
    });
  const refs = units.flatMap((u) => u.evidenceRefs);
  const claimChunks = distribute(claims, slots.length);
  const slides = slots.map((slot, i) => {
    // Red-framed image cards on THIS page's bound grid (§7.1 / PDF p19):
    // page scope = visible tiles only — never region-level refChunks.
    const sidebar = adverseVisualSidebar(slot.slotId, extras, scoped, "изображение");
    const pageRefs =
      sidebar.gridRefs.length > 0
        ? sidebar.gridRefs
        : (extras.visualAssets?.[slot.slotId] ?? [])
            .flatMap((a) => (a.visibleItems ?? []).map((v) => v.ref))
            .filter((r) => Boolean(scoped.evidenceIndex[r]));
    const view = buildPageEvidenceView(scoped, pageRefs);
    const pageBlocks = pageFindingBlocks(scoped, view);
    const pageDomainSet = new Set(
      view.domains.map((d) => d.toLowerCase()).filter((d) => d && d !== "—")
    );
    // Drop claim bullets that cite domains not on this grid.
    const pageClaims = claimChunks[i].filter((c) => {
      const domains = (c.text.match(/\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\b/giu) ?? []).map((d) =>
        d.toLowerCase()
      );
      if (domains.length === 0) return true;
      if (pageDomainSet.size === 0) return true;
      return domains.some((d) => pageDomainSet.has(d));
    });
    // Четыре страницы картинок подряд отличались только числами внутри текста,
    // и читатель видел четыре одинаковых заголовка. Заголовок теперь называет
    // вывод именно этой страницы.
    const shown = sidebar.visibleRows.length;
    const adverse = sidebar.adverseRows.length;
    const verdictTitle =
      shown > 0
        ? `${slot.title}: ${
            adverse > 0
              ? `${adverse} ${pluralRu(
                  adverse,
                  "изображение ведёт на негативный источник",
                  "изображения ведут на негативные источники",
                  "изображений ведут на негативные источники"
                )}`
              : "негативных источников нет"
          }`
        : undefined;
    return visualSlide({
      slot,
      sectionId,
      extras,
      scoped,
      ...(verdictTitle ? { title: verdictTitle } : {}),
      content: {
        bullets: pageClaims.map((c) => clampClientText(claimText(c), 400)),
        ...pageBlocks,
        ...(sidebar.explanations.length
          ? {
              whatWasFound: clampClientText(
                `Изображения на этой странице: ${Math.min(sidebar.visibleRows.length, 6)}; выделено красным (ведут на негативные источники): ${sidebar.adverseRows.length}.`,
                400
              ),
              // Consistent with the red frames: the page DOES carry adverse
              // visual signals, so the meaning block must not claim otherwise.
              whyItMatters: clampClientText(
                "Выделенные изображения связаны с негативными источниками и формируют нежелательный визуальный фон в блоке «Картинки»: пользователь видит их до перехода на сайты.",
                320
              ),
              // The generic page status says "no risk conclusions" when the
              // page findings are empty — contradicting the red frames above.
              statusNote: `Изображений, ведущих на негативные источники, — ${sidebar.adverseRows.length}; каждое требует сверки с первоисточником.`,
              whatToCheck: clampClientText(
                "Проверить сайты-источники выделенных изображений и подготовить позицию по каждому негативному материалу.",
                220
              ),
              highlightExplanations: sidebar.explanations,
            }
          : {}),
      },
      evidenceRefs: [...new Set(pageRefs)],
      findingIds: [
        ...new Set([...view.findings.map((f) => f.findingId), ...sidebar.explainedFindingIds]),
      ],
      metrics: { items: pageRefs.length, adverseImages: sidebar.adverseRows.length },
      noUnderlyingData: refs.length === 0,
      noDataReason: i === 0 ? "no-images" : "no-images-continued",
    });
  });
  return { slides, status: "READY" };
}
