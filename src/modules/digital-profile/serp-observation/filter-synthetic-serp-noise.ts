/**
 * Drop obvious namesake / wrong-subject rows from synthetic SERP columns.
 * Keeps provider observations in DB; only affects the rendered snapshot.
 */

import { classifyWikipediaHit } from "../orion-golden/classic/orion-classic-theme-set";
import type { PersistedSerpObservation } from "./types";

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True when the hit is likely a different person / place / encyclopedia noise
 * for the given subject (e.g. composer Mikhail Glinka on Wikipedia/IMSLP).
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

  // Sheet-music / classical composer corpus (Mikhail Glinka)
  if (/imslp\.|allmusic\.|discogs\.|classic-music|classicalarchives/i.test(`${url} ${domain}`)) {
    return true;
  }

  // Explicit composer / historical namesake when subject given name differs
  if (given && !/михаил|mikhail/i.test(given)) {
    if (
      /(?:mikhail|михаил)\s+glinka|glinka\s+(?:mikhail|михаил)|композитор\s+глинк|composer\s+glinka/i.test(
        blob
      )
    ) {
      return true;
    }
  }
  if (given && !/ф[её]дор|fedor|fyodor/i.test(given)) {
    if (/(?:fedor|fyodor|ф[её]дор)\s+glinka|glinka,?\s+(?:fedor|fyodor)/i.test(blob)) {
      return true;
    }
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
