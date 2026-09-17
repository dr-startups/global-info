import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * В `site.css` нет классов, которых не рисует код сайта.
 *
 * Стили перенесены из утверждённого макета целиком, вместе с экраном токенов и
 * вариантами, которых экраны сайта не показывают. Файл подключается блокирующе и
 * задерживает первую отрисовку, поэтому мёртвое правило стоит посетителю времени;
 * вернуть нужное можно из макета.
 *
 * Класс считается используемым, если его имя целиком стоит в коде `src/app` или
 * `src/modules/site` (без комментариев). Поэтому код не собирает имя класса из
 * значения (`is-${tone}`): такое имя поиск не находит, и правило для него выглядело
 * бы мёртвым. Тон превращается в класс таблицей `Record<тон, класс>` — полноту
 * таблицы проверяет TypeScript. Первая версия теста перечисляла значения тонов сама и
 * пропустила тон `off` панели персоны: правило его строки было удалено как мёртвое.
 *
 * Мёртвое сочетание внутри живого селектора (`.site-btn.is-active`, когда кнопка не
 * получает `is-active`) тест не видит.
 */

const root = process.cwd();
const CSS = join(root, "src/app/(site)/site.css");

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/u.test(name) ? [path] : [];
  });
}

const rel = (path: string) => relative(root, path).replace(/\\/gu, "/");
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");

const sources = [...files(join(root, "src/app")), ...files(join(root, "src/modules/site"))].map((file) => ({
  file: rel(file),
  text: withoutComments(readFileSync(file, "utf8")),
}));
const source = sources.map((s) => s.text).join("\n");
const cssClasses = [
  ...new Set(
    [...readFileSync(CSS, "utf8").replace(/\/\*[\s\S]*?\*\//gu, "").matchAll(/\.((?:site|is)-[\w-]+)/gu)].map((m) => m[1]!)
  ),
].sort();

describe("site.css", () => {
  it("классы site-* и is-* нашлись", () => {
    expect(cssClasses.length).toBeGreaterThan(200);
  });

  it("код не собирает имя класса из значения", () => {
    const composed = sources.flatMap(({ file, text }) =>
      [...text.matchAll(/(?<![\w-])(?:site-[\w-]*-|is-)\$\{/gu)].map((m) => `${file}: ${m[0]}`)
    );
    expect(composed).toEqual([]);
  });

  it("каждый класс рисует код сайта", () => {
    const written = (name: string) => new RegExp(`(?<![\\w-])${escape(name)}(?![\\w-])`, "u").test(source);
    expect(cssClasses.filter((name) => !written(name))).toEqual([]);
  });
});
