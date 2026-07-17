/**
 * Subject-agnostic Wikipedia identity classifier.
 *
 * Given a Wikipedia row (title/url/snippet) and the current subject's display
 * name, decide whether the page is the subject, a namesake/family/disambiguation
 * page, or absent. Everything is derived from the passed `subjectName` — there
 * are NO subject-specific literals, so this works for any subject.
 *
 * Example: a family/clan/disambiguation page for the subject's surname resolves
 * to WRONG_SUBJECT; an article carrying the subject's full name resolves to
 * EXACT_SUBJECT.
 */

export type WikipediaSubjectStatus = "EXACT_SUBJECT" | "WRONG_SUBJECT" | "AMBIGUOUS" | "ABSENT";

export function classifyWikipediaHit(input: {
  title: string;
  url?: string;
  snippet?: string;
  subjectName: string;
}): { status: WikipediaSubjectStatus; reason: string } {
  const title = String(input.title ?? "").trim();
  const url = String(input.url ?? "").trim();
  const snippet = String(input.snippet ?? "").trim();
  const blob = `${title} ${snippet} ${url}`;
  if (!title && !url) return { status: "ABSENT", reason: "no-wikipedia-row" };
  if (/отсутств|not\s+found|no\s+article|не\s+найден|page not found|страница не найдена/i.test(blob)) {
    return { status: "ABSENT", reason: "explicit-absent" };
  }
  if (url && !/wikipedia\.org/i.test(url) && !/статья найдена|article found|exists/i.test(blob)) {
    return { status: "ABSENT", reason: "non-wikipedia-url" };
  }

  const parts = input.subjectName.trim().split(/\s+/).filter(Boolean);
  const surname = parts[0] ?? "";
  const given = parts[1] ?? "";
  const patronymic = parts[2] ?? "";
  const surnameRe = surname
    ? new RegExp(surname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    : null;
  const givenRe = given
    ? new RegExp(given.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    : null;
  const patronymicRe = patronymic
    ? new RegExp(patronymic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
    : null;

  // Family / clan / disambiguation / list pages — never the subject profile
  if (
    /\((?:дворянский\s+род|род|семья|family|disambiguation|значения|фамилия)\)/i.test(title) ||
    /дворянский\s+род|список\s+однофамильц|disambiguation|значения\)/i.test(blob) ||
    /\/wiki\/[^/\s]*(?:_(?:family|clan|disambiguation)|_\(фамилия\)|_\(род\))/i.test(url)
  ) {
    return { status: "WRONG_SUBJECT", reason: "family-or-disambiguation-page" };
  }

  // Same surname but a different given name + an artistic/historical role in the
  // title → a famous namesake, not the subject.
  if (surnameRe?.test(title) && givenRe && !givenRe.test(title) && !givenRe.test(snippet)) {
    if (
      /композитор|писатель|поэт|художник|генерал|княз|граф|musician|composer|painter|poet/i.test(blob) ||
      /\([^)]{2,40}\)/.test(title)
    ) {
      return { status: "WRONG_SUBJECT", reason: "namesake-with-different-identity" };
    }
  }

  const hasSurname = Boolean(surnameRe?.test(title) || surnameRe?.test(url));
  const hasGiven = Boolean(givenRe?.test(title) || givenRe?.test(snippet) || givenRe?.test(url));
  const hasPatronymic = Boolean(
    patronymicRe && (patronymicRe.test(title) || patronymicRe.test(snippet) || patronymicRe.test(url))
  );

  // Same surname+given but a different patronymic in the title → wrong person
  if (hasSurname && hasGiven && patronymicRe && !hasPatronymic) {
    if (/[А-ЯЁA-Z][а-яёa-z]+(?:ович|евич|ич|овна|евна)/u.test(title)) {
      return { status: "WRONG_SUBJECT", reason: "different-patronymic" };
    }
  }

  if (
    hasSurname &&
    hasGiven &&
    (hasPatronymic || /предпринимател|бизнесмен|бизнес|миллионер|oligarch/i.test(blob))
  ) {
    return { status: "EXACT_SUBJECT", reason: "fio-or-role-match" };
  }
  if (hasSurname && hasGiven) {
    return { status: "EXACT_SUBJECT", reason: "surname-given-match" };
  }
  if (hasSurname && !hasGiven) {
    return { status: "AMBIGUOUS", reason: "surname-only" };
  }
  if (url && /wikipedia\.org/i.test(url)) {
    return { status: "AMBIGUOUS", reason: "wikipedia-url-weak-name-match" };
  }
  return { status: "ABSENT", reason: "unclassified" };
}
