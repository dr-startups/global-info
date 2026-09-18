/**
 * Многоточие внутри «ёлочек» — слова источника, а не оборванное предложение.
 *
 * Поисковик обрезает заголовок и ставит « ...»; `sidebarSafe` переписывал
 * любое многоточие на «. » — и внутри кавычек тоже: «Связанный с Россией
 * бизнесмен Сергей Глинка. »; (эталон-72, стр. 20 и 41). Остальные места
 * печатали тот же заголовок как есть — «…Глинка ...». Один ответ: обрезку
 * источника печатает составитель цитаты («…» к последнему слову), а правило
 * «панель без многоточий» действует вне кавычек.
 */

import { describe, expect, it } from "vitest";
import { quoteBody, sourceQuote } from "@/modules/digital-profile/orion-golden/client/client-quote";
import { sidebarSafe } from "@/modules/digital-profile/orion-golden/deck-sections/run-deck-build";
import { evaluateClientText } from "@/modules/digital-profile/orion-golden/client/load-client-text-contract";
import { highlightPhrase } from "@/modules/digital-profile/orion-golden/deck-sections/fragment-builders/shared";

const TITLE = "Связанный с Россией бизнесмен Сергей Глинка ...";

describe("многоточие внутри цитаты — слова источника", () => {
  it("Э1: обрезку заголовка печатает составитель цитаты — «…» к последнему слову", () => {
    expect(quoteBody(TITLE)).toBe("Связанный с Россией бизнесмен Сергей Глинка…");
    expect(quoteBody("Глинка Сергей … в реестре")).toBe("Глинка Сергей … в реестре");
    expect(sourceQuote(TITLE, " — x.com")).toBe("«Связанный с Россией бизнесмен Сергей Глинка…» — x.com");
  });

  it("Э2: sidebarSafe не трогает многоточие внутри кавычек, вне кавычек переписывает как прежде", () => {
    const quoted = "«Связанный с Россией бизнесмен Сергей Глинка…» — x.com: текст страницы в этом прогоне не проверялся.";
    expect(sidebarSafe(quoted)).toBe(quoted);
    expect(sidebarSafe("Итог не ясен... оценка предварительная.")).toBe("Итог не ясен. оценка предварительная.");
  });

  it("Э3: правило «панель без многоточий» действует вне кавычек", () => {
    const inside = evaluateClientText("«Заголовок источника…» — x.com: по заголовку в выдаче.", { surface: "sidebar" });
    expect(inside.issues.map((i) => i.code)).not.toContain("sidebar-ellipsis");
    const outside = evaluateClientText("Оценка… не завершена.", { surface: "sidebar" });
    expect(outside.issues.map((i) => i.code)).toContain("sidebar-ellipsis");
  });

  it("Э4: фраза о непрочитанной странице печатает заголовок с «…», без точки и пробела перед кавычкой", () => {
    const url = "https://x.com/rucriminalinfo/status/2008361452998914141?lang=ru";
    const out = highlightPhrase({
      row: { ref: "obs-1", url, domain: "x.com", themeTitle: "Криминальные / судебные материалы" },
      evidence: { "obs-1": { title: TITLE, url, domain: "x.com", snippet: "" } },
      finding: { theme: "Криминальные / судебные материалы" },
      budget: 240,
    } as never);
    const printed = [out.sidebar, out.full, out.block].join("\n");
    expect(printed).toContain("«Связанный с Россией бизнесмен Сергей Глинка…»");
    expect(printed).not.toContain(". »");
    expect(printed).not.toContain(" ...");
  });
});
