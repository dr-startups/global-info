import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Доказательство называется тем, чем оно является.
 *
 * Совпадение из комплаенс-базы — результат поиска по имени: у него нет
 * заголовка, автора и адреса, и по правилам продукта оно идёт аналитику как
 * PENDING. Вопрос из блока «люди также спрашивают» — строка поисковой выдачи.
 * Пока и то и другое шло под общей формулировкой «найдены конкретные
 * материалы», резюме приписывало проверяемому лицу чужое имя из базы
 * («Найдены конкретные материалы, в том числе «Johan Holmstrom»» при субъекте
 * Anders Holmström) и выдавало вопрос читателя за найденный материал.
 *
 * Проверяется готовый клиентский текст, а не отдельная функция: формулировка
 * собирается в нескольких местах, и важно, что до клиента доходит именно
 * честная.
 */

type Snapshot = {
  slides: Array<{ slideKey: string; text: Record<string, string>; bullets?: string[] }>;
};

const SNAPSHOT = join(process.cwd(), "fixtures", "golden-case", "client-text.baseline.json");

function clientLines(): string[] {
  const snap = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Snapshot;
  const out: string[] = [];
  for (const s of snap.slides) out.push(...Object.values(s.text ?? {}), ...(s.bullets ?? []));
  return out;
}

describe("доказательство названо тем, чем является", () => {
  const lines = clientLines();

  it("эталон не пуст — иначе проверка ничего не проверяет", () => {
    expect(lines.length).toBeGreaterThan(50);
  });

  it("совпадение из базы не подаётся как найденный материал", () => {
    // Имя из комплаенс-базы золотого кейса. Оно вправе быть в отчёте, но
    // только названным по своей природе.
    const mentions = lines.filter((l) => l.includes("Johan Holmstrom"));
    expect(mentions.length).toBeGreaterThan(0);
    for (const line of mentions) {
      const idx = line.indexOf("Johan Holmstrom");
      const before = line.slice(0, idx);
      expect(
        before,
        `имя из базы подано как найденный материал: «${line.slice(0, 160)}»`
      ).not.toMatch(/найдены конкретные материалы[^.]*$/iu);
    }
  });

  it("совпадение из базы названо совпадением и не выдаётся за факт", () => {
    const stated = lines.find((l) => /есть совпадение по имени/u.test(l));
    expect(stated, "ожидалась формулировка про совпадение по имени").toBeTruthy();
    expect(stated!).toMatch(/В базе .+ есть совпадение по имени/u);
    expect(stated!).toMatch(/требует проверки и фактом не является/u);
  });

  it("вопрос из выдачи не подаётся как публикация", () => {
    const questions = lines.filter((l) => /«[^»]+\?»/u.test(l));
    expect(questions.length).toBeGreaterThan(0);
    for (const line of questions) {
      const m = line.match(/(.{0,60})«[^»]+\?»/u);
      expect(
        m?.[1] ?? "",
        `вопрос подан как найденный материал: «${line.slice(0, 160)}»`
      ).not.toMatch(/найдены конкретные материалы[^.]*$/iu);
    }
  });
});
