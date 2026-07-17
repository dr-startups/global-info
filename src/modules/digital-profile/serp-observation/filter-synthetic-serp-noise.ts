/**
 * Drop obvious namesake / wrong-subject rows from synthetic SERP columns.
 * Keeps provider observations in DB; only affects the rendered snapshot.
 */

import { classifyWikipediaHit } from "./classify-wikipedia-hit";
import type { PersistedSerpObservation } from "./types";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when the hit is likely a different person / place / encyclopedia noise
 * for the given subject (e.g. a same-surname composer on Wikipedia/IMSLP).
 * Subject-agnostic: everything is derived from `subjectName`.
 */
export function isSyntheticSerpNoiseHit(
  obs: Pick<PersistedSerpObservation, "title" | "url" | "snippet" | "domain">,
  subjectName: string
): boolean {
  const title = obs.title ?? "";
  const url = obs.url ?? "";
  const snippet = obs.snippet ?? "";
  const domain = obs.domain ?? "";
  const blob = `${title} ${snippet} ${url} ${domain}`;
  const parts = subjectName.trim().split(/\s+/).filter(Boolean);
  const surname = parts[0] ?? "";
  const given = parts[1] ?? "";
  if (!surname) return false;

  // Wikipedia family / composer / surname-only pages
  if (/wikipedia\.org/i.test(url) || /wikipedia/i.test(title)) {
    const wiki = classifyWikipediaHit({ title, url, snippet, subjectName });
    if (wiki.status === "WRONG_SUBJECT" || wiki.status === "AMBIGUOUS") return true;
  }

  // Sheet-music / classical composer corpus (same-surname musician namesakes)
  if (/imslp\.|allmusic\.|discogs\.|classic-music|classicalarchives/i.test(`${url} ${domain}`)) {
    return true;
  }

  // Same-surname artistic/historical namesake whose given name is not the
  // subject's (composer/writer/poet/painter/general/prince/count).
  if (
    given &&
    new RegExp(`${escapeRe(surname)}`, "i").test(blob) &&
    !new RegExp(escapeRe(given), "i").test(blob) &&
    /композитор|composer|musician|писатель|поэт|painter|художник|генерал|княз|граф|poet|writer/i.test(
      blob
    )
  ) {
    return true;
  }

  // Surname-only Wikipedia-style titles with parenthetical identity that isn't the subject
  if (
    surname &&
    new RegExp(`^\\s*${escapeRe(surname)}\\s*\\([^)]+\\)`, "i").test(title) &&
    given &&
    !new RegExp(escapeRe(given), "i").test(title)
  ) {
    return true;
  }

  return false;
}

export function filterObservationsForSyntheticSerp(
  observations: PersistedSerpObservation[],
  subjectName: string
): PersistedSerpObservation[] {
  return observations.filter((o) => !isSyntheticSerpNoiseHit(o, subjectName));
}
