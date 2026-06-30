/**
 * Stage R1.1.3 — subject identity matching and namesake guards.
 *
 * PURE. Used by the search-result classifier and highlight resolver to avoid
 * treating registry/social/biography rows — or other people with the same surname
 * — as adverse hits on the audit subject.
 */

export type IdentityConfidence = "HIGH" | "MEDIUM" | "LOW" | "NONE";

export interface SubjectIdentity {
  fullName: string;
  surname: string | null;
  givenName: string | null;
  patronymic: string | null;
}

const PATRONYMIC_SUFFIXES =
  "александрович|георгиевич|михайлович|николаевич|владимирович|сергеевич|андреевич|петрович|иванович|романович|олегович|дмитриевич|викторович|юрьевич|анатольевич|borisovich|константинович";

const PATRONYMIC_RE = new RegExp(
  `(?:^|[\\s,.(—–-])([а-яёa-z]+)\\s+(${PATRONYMIC_SUFFIXES})`,
  "gi"
);

/** Parses a Russian-style full name into surname / given / patronymic parts. */
export function parseSubjectName(fullName: string): SubjectIdentity {
  const trimmed = fullName.trim().replace(/\s+/g, " ");
  const parts = trimmed.split(" ").filter(Boolean);
  if (parts.length >= 3) {
    return {
      fullName: trimmed,
      surname: parts[0] ?? null,
      givenName: parts[1] ?? null,
      patronymic: parts[2] ?? null,
    };
  }
  if (parts.length === 2) {
    return { fullName: trimmed, surname: parts[0] ?? null, givenName: parts[1] ?? null, patronymic: null };
  }
  return { fullName: trimmed, surname: parts[0] ?? null, givenName: null, patronymic: null };
}

function normToken(s: string): string {
  return s.toLowerCase().replace(/ё/g, "е").trim();
}

function containsToken(text: string, token: string | null): boolean {
  if (!token) return false;
  const t = normToken(token);
  return normToken(text).includes(t);
}

/** Extracts patronymics mentioned in free text (lowercase stem). */
export function patronymicsInText(text: string): string[] {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  const re = new RegExp(PATRONYMIC_RE.source, "gi");
  while ((m = re.exec(text)) !== null) {
    if (m[2]) out.add(normToken(m[2]));
  }
  return [...out];
}

/**
 * True when the text clearly refers to a different person (other given name /
 * patronymic) while sharing the subject surname.
 */
export function isLikelyNamesake(text: string, subject: SubjectIdentity | null): boolean {
  if (!subject?.surname) return false;
  const hay = normToken(text);
  if (!containsToken(hay, subject.surname)) return false;

  const subjectPat = subject.patronymic ? normToken(subject.patronymic) : null;
  const mentioned = patronymicsInText(text);
  if (subjectPat && mentioned.length > 0) {
    return mentioned.some((p) => p !== subjectPat);
  }

  if (subject.givenName) {
    const given = normToken(subject.givenName);
    const surname = normToken(subject.surname);
    const re = new RegExp(
      `${surname}[\\s,.(—–-]+([а-яё]{3,})(?:\\s+[а-яё]{3,})?`,
      "i"
    );
    const m = hay.match(re);
    const captured = m?.[1] ? normToken(m[1]) : null;
    if (captured && captured !== given && captured !== surname && captured.length >= 4) {
      return true;
    }
  }
  return false;
}

/** Assesses how confidently a result refers to the audit subject. */
export function assessIdentityMatch(
  text: string,
  subject: SubjectIdentity | null
): IdentityConfidence {
  if (!subject?.fullName?.trim()) return "MEDIUM";
  if (isLikelyNamesake(text, subject)) return "LOW";

  const hay = normToken(text);
  const full = normToken(subject.fullName);
  if (full.length >= 5 && hay.includes(full)) return "HIGH";

  const hasSurname = containsToken(hay, subject.surname);
  const hasGiven = containsToken(hay, subject.givenName);
  const hasPat = subject.patronymic ? containsToken(hay, subject.patronymic) : false;

  if (hasSurname && hasGiven && hasPat) return "HIGH";
  if (hasSurname && hasGiven) return "MEDIUM";
  if (hasSurname || hasGiven) return "LOW";
  return "LOW";
}
