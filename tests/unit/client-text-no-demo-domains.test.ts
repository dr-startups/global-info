import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isMockClientDomain } from "@/modules/digital-profile/services/composite-serp-merge";

/**
 * Демо-домены не должны доходить до клиента — нигде.
 *
 * Защита от них в проекте есть и называется defense-in-depth
 * (`tests/unit/mock-domain-guard.test.ts`), но закрывает две функции строк
 * источников. Домены попадают в клиентский текст ещё из полудюжины мест:
 * цитаты доказательств («…» — источник X), вывод по странице, наборы
 * представительных свидетельств. На золотом кейсе через них протекало 56
 * упоминаний `.example`.
 *
 * Проверять каждую точку по отдельности бессмысленно — их станет больше.
 * Здесь проверяется свойство готового текста целиком: что бы ни добавили выше
 * по течению, демо-домен до клиента не дойдёт.
 */

type Snapshot = {
  slides: Array<{
    slideKey: string;
    text: Record<string, string>;
    bullets?: string[];
    kpis?: string[];
    highlights?: string[];
    table?: { headers: string[]; rows: string[][] };
  }>;
};

const SNAPSHOT = join(
  process.cwd(),
  "fixtures",
  "golden-case",
  "client-text.baseline.json"
);

/**
 * Связный текст, который читает клиент.
 *
 * Таблица выдачи сюда не входит намеренно. Её колонка «Домен» показывает домен
 * самой строки результата — это не формулировка о субъекте, а перечень того,
 * что нашлось. Демо-строки в рабочем прогоне до отчёта не доходят: их отсекает
 * `isMockBaseRow` на входе. А золотой кейс по построению целиком собран на
 * `.example`-адресах, поэтому его таблица законно ими и заполнена.
 *
 * Проверяется именно текст: там демо-домену взяться неоткуда ни при каких
 * данных, и там он выглядит как утверждение об источнике.
 */
function clientLines(snap: Snapshot): Array<{ slideKey: string; line: string }> {
  const out: Array<{ slideKey: string; line: string }> = [];
  for (const s of snap.slides) {
    const parts = [
      ...Object.values(s.text ?? {}),
      ...(s.bullets ?? []),
      ...(s.kpis ?? []),
      ...(s.highlights ?? []),
    ];
    for (const line of parts) out.push({ slideKey: s.slideKey, line });
  }
  return out;
}

describe("клиентский текст не содержит демо-доменов", () => {
  const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;

  it("эталон не пуст — иначе проверка ничего не проверяет", () => {
    expect(snap.slides.length).toBeGreaterThan(10);
  });

  it("ни один домен из клиентского текста не помечен как демо", () => {
    // Домены выбираются из текста как есть, а затем судятся тем же
    // предикатом, что и рабочий фильтр: проверка не заводит своё определение
    // демо-домена, иначе она разойдётся с продуктом.
    const DOMAIN = /\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\b/giu;
    const leaks: string[] = [];
    for (const { slideKey, line } of clientLines(snap)) {
      for (const m of line.matchAll(DOMAIN)) {
        const domain = m[0];
        if (isMockClientDomain(domain)) {
          leaks.push(`${slideKey}: ${domain} — «${line.slice(0, 90)}…»`);
        }
      }
    }
    expect(leaks, `демо-домены дошли до клиента:\n${leaks.slice(0, 12).join("\n")}`).toEqual([]);
  });
});
