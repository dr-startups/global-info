/**
 * R10.7b — Deterministic subject binding scorer.
 * Binding and risk are separate dimensions: CONFIRMED identity does not bypass risk gates.
 */

import type { RawInventoryItem } from "../types";
import type { SubjectBindingScoreResult, SubjectIdentityProfile } from "./subject-identity-profile";
import { assessHomonymSignals } from "./homonym-disambiguation-policy";

function lower(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е");
}

function hay(item: Pick<RawInventoryItem, "title" | "snippet" | "sourceUrl" | "provider" | "evidenceType">): string {
  return [item.title, item.snippet, item.sourceUrl, item.provider, item.evidenceType]
    .filter(Boolean)
    .join(" ");
}

function extractInns(text: string): string[] {
  const out: string[] = [];
  const re = /\b(?:инн[:\s]*)?(\d{12}|\d{10})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function extractOgrn(text: string): { ogrn: string[]; ogrnip: string[] } {
  const ogrnip: string[] = [];
  const ogrn: string[] = [];
  const reIp = /\b(?:огрнип[:\s]*)?(\d{15})\b/gi;
  const re = /\b(?:огрн[:\s]*)?(\d{13})\b/gi;
  let m: RegExpExecArray | null;
  while ((m = reIp.exec(text)) !== null) {
    if (m[1]) ogrnip.push(m[1]);
  }
  while ((m = re.exec(text)) !== null) {
    if (m[1] && m[1].length === 13) ogrn.push(m[1]);
  }
  return { ogrn, ogrnip };
}

function includesAny(text: string, needles: string[]): string | undefined {
  const low = lower(text);
  for (const n of needles) {
    const nn = lower(n);
    if (nn.length > 2 && low.includes(nn)) return n;
  }
  return undefined;
}

/**
 * Score subject binding for one evidence item against the identity profile.
 */
export function scoreSubjectBinding(
  evidence: Pick<RawInventoryItem, "title" | "snippet" | "sourceUrl" | "provider" | "evidenceType">,
  profile: SubjectIdentityProfile
): SubjectBindingScoreResult {
  const text = hay(evidence);
  const low = lower(text);
  const titleLow = lower(evidence.title ?? "");
  const positive: string[] = [];
  const negative: string[] = [];
  let score = 0;

  const full = profile.fullNameRu;
  const display = lower(profile.displayName);
  const homonym = assessHomonymSignals(text, profile);

  // --- Strong negatives first ---
  for (const wrong of profile.negativeIdentitySignals.wrongNames) {
    if (low.includes(lower(wrong))) {
      const subjectPresent =
        low.includes(display) ||
        (full ? low.includes(lower(`${full.lastName} ${full.firstName}`)) : false);
      if (!subjectPresent || /e2e|lexis ui|r7\.5/i.test(profile.displayName)) {
        negative.push(`wrong_name:${wrong}`);
        score -= 80;
      }
    }
  }

  if (homonym.famousUnrelatedPerson && !includesAny(text, [profile.displayName, ...(profile.aliases ?? [])])) {
    negative.push("famous_unrelated_without_subject");
    score -= 70;
  }

  if (homonym.hasPatronymicMismatch) {
    for (const p of homonym.mismatchedPatronymics) negative.push(`patronymic_mismatch:${p}`);
    score -= 55;
  }

  if (homonym.titleAboutOtherPerson) {
    negative.push("title_about_other_person");
    score -= 40;
  }

  // --- Strong positives: identifiers ---
  const knownInns = profile.knownIdentifiers.inn ?? [];
  const foundInns = extractInns(text);
  const innHit = foundInns.find((id) => knownInns.includes(id));
  if (innHit) {
    positive.push(`exact_inn:${innHit}`);
    score += 70;
  } else if (foundInns.length && knownInns.length) {
    // Different INN with subject name → possible wrong person / company
    negative.push(`inn_mismatch:${foundInns[0]}`);
    score -= 25;
  }

  const { ogrn, ogrnip } = extractOgrn(text);
  const knownOgrn = profile.knownIdentifiers.ogrn ?? [];
  const knownOgrnip = profile.knownIdentifiers.ogrnip ?? [];
  const ogrnipHit = ogrnip.find((id) => knownOgrnip.includes(id));
  const ogrnHit = ogrn.find((id) => knownOgrn.includes(id));
  if (ogrnipHit) {
    positive.push(`exact_ogrnip:${ogrnipHit}`);
    score += 55;
  }
  if (ogrnHit) {
    positive.push(`exact_ogrn:${ogrnHit}`);
    score += 50;
  }

  // --- Name matches ---
  if (full) {
    const last = lower(full.lastName);
    const first = lower(full.firstName);
    const pat = full.patronymic ? lower(full.patronymic) : undefined;
    const exactFull = pat ? `${last} ${first} ${pat}` : `${last} ${first}`;
    const reverseFull = pat ? `${first} ${pat} ${last}` : `${first} ${last}`;

    if (low.includes(exactFull) || low.includes(reverseFull)) {
      positive.push(pat ? "exact_full_name_with_patronymic" : "exact_full_name");
      score += pat ? 45 : 35;
    } else if (low.includes(`${last} ${first}`) || low.includes(`${first} ${last}`)) {
      positive.push("surname_first_name_match");
      score += 25;
    } else if (low.includes(last) && low.includes(first)) {
      positive.push("surname_and_first_present");
      score += 18;
    } else if (low.includes(last)) {
      positive.push("surname_only");
      score += 5;
      if (homonym.hasSurnameOnlyMatch) negative.push("surname_only_weak");
    }

    if (titleLow.includes(exactFull) || (pat && titleLow.includes(`${last} ${first} ${pat}`))) {
      positive.push("title_exact_full_name");
      score += 15;
    } else if (titleLow.includes(`${last} ${first}`)) {
      positive.push("title_surname_first");
      score += 10;
    }
  } else if (display.length > 4 && low.includes(display)) {
    positive.push("display_name_match");
    score += 30;
  }

  const aliasHit = includesAny(text, profile.aliases);
  if (aliasHit) {
    positive.push(`alias_match:${aliasHit}`);
    score += 12;
  }

  const translitHit = includesAny(text, profile.transliterations);
  if (translitHit) {
    positive.push(`transliteration_match:${translitHit}`);
    score += 10;
  }

  // Supporting context
  if (/\b(инн|огрн|огрнип|егрюл|егрип|ип\b|контрагент|реестр)\b/i.test(text) && positive.length > 0) {
    positive.push("registry_profile_context");
    score += 8;
  }

  const locHit = includesAny(text, profile.knownIdentifiers.locations ?? []);
  if (locHit && positive.some((p) => p.includes("name") || p.includes("surname") || p.includes("inn"))) {
    positive.push(`location_support:${locHit}`);
    score += 5;
  }

  if (homonym.hasMultiPersonSnippet && !innHit && !ogrnipHit) {
    negative.push("multi_person_ambiguous");
    score -= 12;
  }

  if (/\[demo\]|\.example|mock:/i.test(text)) {
    negative.push("demo_or_mock_content");
    score -= 20;
  }

  // Clamp
  score = Math.max(-100, Math.min(100, score));

  // --- Decide binding ---
  let binding: SubjectBindingScoreResult["binding"] = "UNKNOWN";

  const strongId = Boolean(innHit || ogrnipHit || ogrnHit);
  const ownPatronymicPresent = Boolean(
    full?.patronymic && low.includes(lower(full.patronymic))
  );
  const exactNameWithPat =
    positive.includes("exact_full_name_with_patronymic") || positive.includes("title_exact_full_name");
  const nameOk =
    positive.includes("exact_full_name") ||
    positive.includes("exact_full_name_with_patronymic") ||
    positive.includes("surname_first_name_match") ||
    positive.includes("display_name_match");
  const registrySupport = positive.includes("registry_profile_context");

  // Wrong-patronymic pages: never CONFIRMED unless own patronymic also present + strong ID
  if (homonym.hasPatronymicMismatch && !ownPatronymicPresent) {
    binding = strongId ? "WEAK" : "WRONG_SUBJECT";
    if (strongId) negative.push("patronymic_mismatch_with_id_kept_weak");
  } else if (homonym.titleAboutOtherPerson && !strongId) {
    binding = "WRONG_SUBJECT";
  } else if (score <= -40 && !strongId) {
    binding = "WRONG_SUBJECT";
  } else if (strongId && (nameOk || exactNameWithPat || score >= 50)) {
    // Exact INN/OGRN with name context → CONFIRMED even if patronymic absent in snippet
    binding = "CONFIRMED";
  } else if (exactNameWithPat && !homonym.hasPatronymicMismatch && score >= 35) {
    binding = "CONFIRMED";
  } else if (nameOk && !homonym.hasPatronymicMismatch && score >= 40) {
    binding = "CONFIRMED";
  } else if (nameOk && !homonym.hasPatronymicMismatch && (score >= 20 || (score >= 16 && registrySupport))) {
    binding = "LIKELY";
  } else if (homonym.hasPatronymicMismatch) {
    binding = score >= 10 ? "WEAK" : "WRONG_SUBJECT";
  } else if (score >= 12 || positive.includes("surname_and_first_present") || positive.includes("surname_only")) {
    binding = "WEAK";
  } else if (score <= -20) {
    binding = "WRONG_SUBJECT";
  } else {
    binding = "UNKNOWN";
  }

  // Safety: never CONFIRMED on patronymic mismatch without own patronymic in text
  if (binding === "CONFIRMED" && homonym.hasPatronymicMismatch && !ownPatronymicPresent) {
    binding = "WEAK";
    negative.push("downgraded_confirmed_due_to_patronymic_mismatch");
  }

  const explanation = [
    `score=${score}`,
    positive.length ? `+ ${positive.slice(0, 6).join(", ")}` : "",
    negative.length ? `- ${negative.slice(0, 6).join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("; ");

  return {
    binding,
    score,
    positiveSignals: positive,
    negativeSignals: negative,
    explanation,
  };
}
