import { loadFile } from "../storage/private-store";
import type { OrionManifestSlide } from "./types";

export async function embedVisualAssetsForSlides(
  slides: OrionManifestSlide[]
): Promise<OrionManifestSlide[]> {
  const out: OrionManifestSlide[] = [];
  for (const slide of slides) {
    if (slide.slideType !== "lexisnexis_visual_page" || slide.visuals.length === 0) {
      out.push(slide);
      continue;
    }
    const visualAssets: Array<{ storageKey: string; contentBase64: string }> = [];
    for (const storageKey of slide.visuals.slice(0, 1)) {
      if (!storageKey) continue;
      try {
        const bytes = await loadFile(storageKey);
        if (bytes.length > 0) {
          visualAssets.push({
            storageKey,
            contentBase64: bytes.toString("base64"),
          });
        }
      } catch {
        // Renderer will show fallback if asset cannot be loaded.
      }
    }
    out.push({
      ...slide,
      visualAssets,
    });
  }
  return out;
}
