import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Кнопку, поле формы и блок вопросов сайт рисует одним компонентом каждый.
 *
 * До шага 0076 классы кнопки были написаны в разметке в двух десятках мест, поле
 * заявки повторяло поле формы проверки, а вопросы — одну и ту же разметку на
 * главной, в `/voprosy` и в статьях. Правка вида такого элемента шла в несколько
 * файлов, и одно место легко было пропустить. Классы элемента живут в файле его
 * компонента — в остальном коде их нет.
 */

const root = process.cwd();
const COMPONENTS = join(root, "src/modules/site/components");

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(ts|tsx)$/u.test(name) ? [path] : [];
  });
}

const rel = (path: string) => relative(root, path).replace(/\\/gu, "/");
/** Комментарии не считаются: объяснение может назвать класс. */
const code = (path: string) =>
  readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:"'`])\/\/.*$/gmu, "$1");

const SITE_FILES = [...files(join(root, "src/app")), ...files(join(root, "src/modules/site"))];

const OWNERS = [
  {
    component: "Button.tsx",
    exports: ["Button", "ButtonLink"],
    classes: /(?<![\w-])site-btn(?:--[\w-]+|__[\w-]+)?(?![\w-])/gu,
  },
  { component: "Field.tsx", exports: ["TextField", "FieldError"], classes: /(?<![\w-])site-(?:input|error)(?![\w-])/gu },
  { component: "Faq.tsx", exports: ["Faq"], classes: /(?<![\w-])site-faq(?![\w-])/gu },
];

describe("кнопка, поле и блок вопросов — по компоненту", () => {
  it.each(OWNERS)("$component есть и экспортирует $exports", ({ component, exports }) => {
    const path = join(COMPONENTS, component);
    expect(existsSync(path), rel(path)).toBe(true);
    for (const name of exports) {
      expect(code(path), `${component}: ${name}`).toMatch(new RegExp(`export function ${name}\\(`, "u"));
    }
  });

  it.each(OWNERS)("классы $component не встречаются в других файлах сайта", ({ component, classes }) => {
    const owner = join(COMPONENTS, component);
    const found = SITE_FILES.filter((file) => file !== owner).flatMap((file) =>
      [...code(file).matchAll(classes)].map((m) => `${rel(file)}: ${m[0]}`)
    );
    expect(found).toEqual([]);
  });
});
