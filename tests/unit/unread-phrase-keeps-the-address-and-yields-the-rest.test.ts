/**
 * Адрес не уступает: уступает объяснение вокруг него.
 *
 * Первая редакция этой починки сделала наоборот — не поместился в узкую
 * колонку, и адрес уходил **целиком**, а строке полагался лист-продолжение. На
 * снимке выдачи продолжение есть; на страницах изображений и подсказок его нет
 * по решению, записанному в §8, — и там материал снова оставался неназванным.
 * Замер на эталоне 72: девять фраз непрочитанной страницы, у двух адреса не
 * было (`p17_ru_images_4` — 183 знака, `p30_uae_images` — 191).
 *
 * Правило берётся у ветки прочитанной страницы, где оно уже записано словами:
 * «цитата уступает адресу — без адреса утверждение нечем проверить». Здесь
 * уступают, в названном порядке, домен (он повторён адресом), «оценка по
 * заголовку выдачи», хвост про находку и рубрика. Последним не уступает
 * никогда одно — «страница не читалась»: непрочитанная страница не должна
 * выглядеть проверенной.
 *
 * Так же умирает и край блокера: два материала одного издания под одной
 * рубрикой различаются адресом всегда, какой бы длины он ни был.
 */

import { describe, expect, it } from "vitest";
import { highlightPhrase } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";
import { SIDEBAR_HIGHLIGHT_BUDGET } from "@/modules/digital-profile/orion-golden/deck-sections/template-registry";
import type { ScopedEvidenceIndex } from "@/modules/digital-profile/orion-golden/deck-sections/scoped-input";
import type { VisibleAssetItem } from "@/modules/digital-profile/orion-golden/deck-sections/canonical-slots";

const RUBRIC = "Криминальные / судебные материалы";

/** Худший случай эталона 72: адрес в 183 знака на странице изображений. */
const LONG_A =
  "https://kompromat1.online/articles/364300-byvshij_partner_oligarhov_nahodjaschihsja_pod_sanktsijami_sergej_glinka_vydelil_16_mln_evro_na_priobretenie_moldavskogo_obekta_s_voennym_potentsialom";
/** Тот же издатель, тот же сюжет, другой материал — 191 знак. */
const LONG_B =
  "https://kompromat1.online/articles/364301-sergey_glinka_a_previous_associate_of_sanctioned_oligarchs_allocated_16_million_to_acquire_a_moldovan_facility_with_military_potential_purportedly_under";

function row(ref: string, url: string): VisibleAssetItem {
  return { ref, url, domain: new URL(url).hostname, adverse: true, themeTitle: RUBRIC };
}

function index(rows: VisibleAssetItem[]): ScopedEvidenceIndex {
  const out: ScopedEvidenceIndex = {};
  for (const r of rows) out[r.ref] = { url: r.url, domain: r.domain };
  return out;
}

const A = row("inventory:long-a", LONG_A);
const B = row("inventory:long-b", LONG_B);

describe("узкая колонка не теряет адрес даже на худшем случае", () => {
  it("адрес доезжает до боковой панели, а не только до полной формы", () => {
    const phrase = highlightPhrase({ row: A, evidence: index([A]) });
    expect(phrase.sidebar).toContain("kompromat1.online/articles/364300-byvshij_partner");
    expect(phrase.sidebarHasLink).toBe(true);
    expect(phrase.sidebar.length).toBeLessThanOrEqual(SIDEBAR_HIGHLIGHT_BUDGET);
  });

  it("непрочтение остаётся сказанным словами, что бы ни уступило", () => {
    const phrase = highlightPhrase({ row: A, evidence: index([A]) });
    // Последняя ступень лестницы начинает предложение с этих слов, поэтому
    // сверка регистронезависимая: важно, что непрочтение названо.
    expect(phrase.sidebar.toLowerCase()).toContain("не проверялся");
  });

  it("два длинных адреса одного издания под одной рубрикой различаются и в панели", () => {
    const evidence = index([A, B]);
    const first = highlightPhrase({ row: A, evidence });
    const second = highlightPhrase({ row: B, evidence });
    expect(first.sidebar).not.toBe(second.sidebar);
    expect(first.full).not.toBe(second.full);
  });

  it("уступает по порядку: сначала домен, который адрес и так называет", () => {
    // Адрес средней длины: домена рядом с ним уже нет, всё остальное на месте.
    // Длина подобрана так, что первая ступень уже не помещается, а вторая —
    // без повторённого домена — помещается.
    const mid = row(
      "inventory:mid",
      "https://kompromat1.online/articles/364300-byvshij-partner-oligarhov-sergej-glinka-vydelil-sredstva-fondu"
    );
    const phrase = highlightPhrase({ row: mid, evidence: index([mid]) });
    expect(phrase.sidebar).toContain("не проверялся");
    expect(phrase.sidebar).toContain("kompromat1.online/articles/364300-byvshij-partner-oligarhov");
    expect(phrase.sidebar.length).toBeLessThanOrEqual(SIDEBAR_HIGHLIGHT_BUDGET);
  });

  it("короткий адрес ничего не отнимает: фраза остаётся полной", () => {
    const short = row("inventory:short", "https://rupep.org/en/person/8095");
    const phrase = highlightPhrase({ row: short, evidence: index([short]) });
    expect(phrase.sidebar).toBe(phrase.full);
    expect(phrase.sidebarComplete).toBe(true);
    expect(phrase.sidebar).toContain(`${RUBRIC} — rupep.org: по заголовку и описанию в выдаче;`);
    expect(phrase.sidebar).toContain("(rupep.org/en/person/8095).");
  });

  it("строка без адреса ведёт себя как прежде", () => {
    const noUrl: VisibleAssetItem = { ...A, ref: "inventory:no-url", url: undefined };
    const phrase = highlightPhrase({
      row: noUrl,
      evidence: { "inventory:no-url": { domain: "kompromat1.online" } },
    });
    expect(phrase.sidebarComplete).toBe(true);
    expect(phrase.sidebarHasLink).toBe(false);
    expect(phrase.sidebar).toContain("не проверялся");
  });
});
