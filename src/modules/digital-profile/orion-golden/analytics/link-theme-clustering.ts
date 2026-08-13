/**
 * Свести темы отдельных страниц в темы отчёта.
 *
 * Решение выносится по каждой странице, поэтому тема у каждой своя: на живом
 * прогоне 73 уникальные формулировки на 75 публикаций — «Биография Киркорова с
 * упоминанием скандалов», «Биография певца с описанием скандальных
 * инцидентов», «Биография и скандалы в карьере». Двенадцать способов сказать
 * одно и то же, каждый с количеством 1.
 *
 * Клиенту нужна не эта россыпь, а несколько тем с числами: в эталоне их пять —
 * 24, 21, 7, 4 и 2 публикации. Поэтому формулировки страниц группируются
 * вторым проходом, одним вызовом на отчёт.
 *
 * Правила, которые код держит сам, не полагаясь на модель:
 *
 * — **Ничего не теряется.** Формулировка, не попавшая ни в одну группу,
 *   остаётся собственной темой. Материал не может исчезнуть из отчёта потому,
 *   что модель забыла его упомянуть.
 * — **Ничего не двоится.** Страница входит ровно в одну тему, иначе суммы
 *   перестанут сходиться с числом нежелательных ссылок.
 * — **Порядок — по весу.** Сначала темы, где больше нежелательных публикаций:
 *   так же читается таблица тем в эталоне.
 */

import type { LinkVerdict, VerdictThemeSummary } from "../contracts/link-verdict";
import { callOpenAiStrictJson } from "../gpt/openai-json-client";

export const THEME_CLUSTER_TARGET_MIN = 3;
export const THEME_CLUSTER_TARGET_MAX = 7;

const SYSTEM_PROMPT = `Ты редактор отчёта о деловой репутации. Тебе дают список тем, каждая описывает одну публикацию о проверяемом лице.

Сгруппируй их в ${THEME_CLUSTER_TARGET_MIN}–${THEME_CLUSTER_TARGET_MAX} тем отчёта. Верни СТРОГО JSON:
{"groups": [{"theme": "<формулировка темы отчёта на русском, 8-90 знаков>", "members": [<номера входящих тем>]}]}

Правила:
1. Тема отчёта называет СУТЬ, а не жанр. Плохо: «Биографические материалы». Хорошо: «Скандалы и конфликты в публичной карьере».
2. Не смешивай разное: судебные сюжеты, санкции, бизнес-показатели, семья и нейтральная биография — это разные темы.
3. Каждый номер из списка должен попасть ровно в одну группу. Не пропускай номера и не повторяй их.
4. Формулируй так, чтобы тему можно было показать клиенту банка без правки.`;

type ThemeInput = { index: number; theme: string; count: number; adverseCount: number };

/** Темы страниц как их видит группировщик: без адресов и цитат. */
export function themesForClustering(verdicts: LinkVerdict[]): ThemeInput[] {
  const byTheme = new Map<string, ThemeInput>();
  for (const v of verdicts) {
    if (v.subjectMatch !== "subject") continue;
    const key = v.theme.trim();
    if (!key) continue;
    const row = byTheme.get(key) ?? { index: byTheme.size, theme: key, count: 0, adverseCount: 0 };
    row.count += 1;
    if (v.tone === "adverse") row.adverseCount += 1;
    byTheme.set(key, row);
  }
  return [...byTheme.values()].map((row, i) => ({ ...row, index: i }));
}

/**
 * Собрать темы отчёта из групп.
 *
 * Группировка применяется к уже посчитанным темам страниц, поэтому числа
 * складываются, а не пересчитываются: сумма нежелательных по темам отчёта
 * равна сумме по темам страниц и, значит, метрике выше.
 */
export function applyThemeGroups(input: {
  themes: ThemeInput[];
  groups: Array<{ theme: string; members: number[] }>;
  verdicts: LinkVerdict[];
}): VerdictThemeSummary[] {
  const themeByIndex = new Map(input.themes.map((t) => [t.index, t]));
  const claimed = new Set<number>();
  const out: VerdictThemeSummary[] = [];

  for (const group of input.groups) {
    const label = String(group.theme ?? "").trim();
    if (!label) continue;
    const members = (group.members ?? [])
      .map((n) => Number(n))
      .filter((n) => themeByIndex.has(n) && !claimed.has(n));
    if (members.length === 0) continue;
    for (const m of members) claimed.add(m);
    const memberThemes = new Set(members.map((m) => themeByIndex.get(m)!.theme));
    const examples = input.verdicts
      .filter((v) => v.subjectMatch === "subject" && memberThemes.has(v.theme.trim()))
      .sort((a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER))
      .slice(0, 5)
      .map((v) => ({ url: v.url, domain: v.domain, rank: v.rank }));
    out.push({
      theme: label.slice(0, 90),
      count: members.reduce((n, m) => n + themeByIndex.get(m)!.count, 0),
      adverseCount: members.reduce((n, m) => n + themeByIndex.get(m)!.adverseCount, 0),
      examples,
    });
  }

  // Неразобранное не исчезает: остаётся собственной темой.
  for (const t of input.themes) {
    if (claimed.has(t.index)) continue;
    const examples = input.verdicts
      .filter((v) => v.subjectMatch === "subject" && v.theme.trim() === t.theme)
      .slice(0, 5)
      .map((v) => ({ url: v.url, domain: v.domain, rank: v.rank }));
    out.push({ theme: t.theme, count: t.count, adverseCount: t.adverseCount, examples });
  }

  return out.sort(
    (a, b) =>
      b.adverseCount - a.adverseCount ||
      b.count - a.count ||
      a.theme.localeCompare(b.theme, "ru")
  );
}

/**
 * Сгруппировать темы страниц в темы отчёта.
 *
 * Отказ модели не ломает отчёт: темы остаются в том виде, в каком их
 * сформулировали по страницам. Отчёт станет дробным, но честным.
 */
export async function clusterVerdictThemes(
  verdicts: LinkVerdict[],
  deps: { call?: typeof callOpenAiStrictJson } = {}
): Promise<VerdictThemeSummary[]> {
  const themes = themesForClustering(verdicts);
  if (themes.length <= THEME_CLUSTER_TARGET_MAX) {
    return applyThemeGroups({ themes, groups: [], verdicts });
  }
  const call = deps.call ?? callOpenAiStrictJson;
  let groups: Array<{ theme: string; members: number[] }> = [];
  try {
    const raw = (await call({
      systemPrompt: SYSTEM_PROMPT,
      userPayload: {
        themes: themes.map((t) => ({ n: t.index, тема: t.theme, публикаций: t.count })),
      },
      maxOutputTokens: 1200,
    })) as { groups?: unknown };
    if (Array.isArray(raw?.groups)) {
      groups = raw.groups
        .filter((g): g is Record<string, unknown> => Boolean(g) && typeof g === "object")
        .map((g) => ({
          theme: String(g.theme ?? ""),
          members: Array.isArray(g.members) ? g.members.map((n) => Number(n)) : [],
        }));
    }
  } catch {
    groups = [];
  }
  return applyThemeGroups({ themes, groups, verdicts });
}
