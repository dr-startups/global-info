import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initialMigrationName } from "../../scripts/db-deploy";
import { expectedTablesFromSchema } from "../../scripts/db-schema-audit";

/**
 * Pre-deploy на Railway обязан пережить схлопывание истории миграций.
 *
 * `prisma migrate deploy` умеет ровно один случай: в базе применено то же, что
 * лежит в `prisma/migrations`. После схлопывания двадцати шести миграций в одну
 * он на существующей базе видит незнакомую начальную миграцию, пытается её
 * применить и падает — воспроизведено:
 *
 *     P3018 ... type "CaseStatus" already exists
 *
 * Хуже, что неудачная попытка записывается в `_prisma_migrations` и блокирует
 * все следующие деплои. На Railway это pre-deploy, руками там не вмешаться.
 */

describe("накат миграций после схлопывания истории", () => {
  it("начальная миграция определяется по имени, а не задана строкой", () => {
    // Захардкоженное имя разъехалось бы с каталогом при первом же переименовании.
    const dir = mkdtempSync(join(tmpdir(), "mig-"));
    mkdirSync(join(dir, "20990101000000_later"));
    mkdirSync(join(dir, "20260625104420_init"));
    expect(initialMigrationName(dir)).toBe("20260625104420_init");
  });

  it("пустой каталог миграций — это отказ, а не тишина", () => {
    const dir = mkdtempSync(join(tmpdir(), "mig-empty-"));
    expect(() => initialMigrationName(dir)).toThrow(/нет ни одной миграции/u);
  });

  it("в репозитории ровно одна миграция, и скрипт её знает", () => {
    expect(initialMigrationName()).toBe("20260625104420_init");
  });

  it("разбираются все три состояния базы и есть защита от расхождения", () => {
    const src = readFileSync(join(process.cwd(), "scripts/db-deploy.ts"), "utf8");
    // 1) пустая база, 2) схема без истории, 3) записана неудачная попытка
    expect(src).toMatch(/schemaTables\.size === 0/u);
    expect(src).toMatch(/migrate", "resolve", "--applied"/u);
    expect(src).toMatch(/migrate", "resolve", "--rolled-back"/u);
    // Разметить базу можно, только если схема действительно та: иначе это
    // спрятало бы настоящее расхождение.
    expect(src).toMatch(/missing\.length > 0/u);
    expect(src).toMatch(/process\.exit\(1\)/u);
  });

  it("pre-deploy на Railway идёт через этот скрипт", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["db:deploy"]).toBe("tsx scripts/db-deploy.ts");

    const railway = JSON.parse(readFileSync(join(process.cwd(), "railway.app.json"), "utf8")) as {
      deploy: { preDeployCommand: string };
    };
    expect(railway.deploy.preDeployCommand).toBe("npm run db:deploy");
  });

  it("ожидаемые таблицы читаются из схемы, а не перечислены руками", () => {
    const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
    const tables = expectedTablesFromSchema(schema);
    expect(tables.size).toBeGreaterThan(25);
    expect(tables.has("dp_workflow_steps")).toBe(true);
    expect(tables.has("_prisma_migrations")).toBe(false);
  });
});
