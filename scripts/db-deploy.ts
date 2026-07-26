/**
 * Накат миграций, переживающий схлопывание истории.
 *
 * `prisma migrate deploy` умеет ровно один случай: в базе применено то же, что
 * лежит в `prisma/migrations`. После того как двадцать шесть миграций схлопнули
 * в одну, на существующей базе он видит незнакомую начальную миграцию, пытается
 * её применить и падает:
 *
 *     P3018 ... type "CaseStatus" already exists
 *
 * Хуже, что неудачная попытка **записывается** в `_prisma_migrations` как
 * failed и блокирует все следующие деплои, пока её не разрешить руками. На
 * Railway это pre-deploy: руками там ничего не сделать, и деплой встаёт совсем.
 *
 * Здесь разбираются три случая:
 *
 * 1. **База пустая** — обычный `migrate deploy`.
 * 2. **Схема есть, записи о нашей начальной миграции нет** — база помечается
 *    как уже содержащая её (`migrate resolve --applied`), затем `deploy`.
 * 3. **Записана неудачная попытка** — она помечается откаченной
 *    (`--rolled-back`), дальше как случай 2.
 *
 * Пометить базу можно, только если её схема **действительно** совпадает с
 * ожидаемой: иначе это спрятало бы настоящее расхождение. Не совпало —
 * останавливаемся и называем, чего не хватает.
 *
 * Запуск: npm run db:deploy
 */

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { expectedTablesFromSchema } from "./db-schema-audit";

const MIGRATIONS_DIR = join(process.cwd(), "prisma", "migrations");

function prisma(...args: string[]): void {
  execFileSync("npx", ["prisma", ...args], { stdio: "inherit" });
}

/** Имя единственной (начальной) миграции в репозитории. */
export function initialMigrationName(dir = MIGRATIONS_DIR): string {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  if (names.length === 0) throw new Error("в prisma/migrations нет ни одной миграции");
  return names[0]!;
}

type HistoryRow = { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null };

async function main(): Promise<void> {
  const client = new PrismaClient();
  const initial = initialMigrationName();
  let liveTables: Set<string>;
  let history: HistoryRow[] = [];

  try {
    const tables = await client.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    liveTables = new Set(tables.map((t) => t.table_name));

    if (liveTables.has("_prisma_migrations")) {
      history = await client.$queryRaw<HistoryRow[]>`
        SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations
      `;
    }
  } catch (err) {
    // База недоступна — это не наш случай, пусть скажет сам prisma.
    console.error(
      "[db-deploy] не удалось прочитать состояние базы:",
      err instanceof Error ? err.message : err
    );
    await client.$disconnect();
    prisma("migrate", "deploy");
    return;
  }

  const schemaTables = new Set(
    [...liveTables].filter((t) => t !== "_prisma_migrations")
  );

  // Случай 1: база пустая — обычный путь.
  if (schemaTables.size === 0) {
    console.log("[db-deploy] база пустая — накатываю миграции");
    await client.$disconnect();
    prisma("migrate", "deploy");
    return;
  }

  const alreadyRecorded = history.some(
    (h) => h.migration_name === initial && h.finished_at !== null && h.rolled_back_at === null
  );
  if (alreadyRecorded) {
    console.log(`[db-deploy] начальная миграция ${initial} уже отмечена — накатываю остальные`);
    await client.$disconnect();
    prisma("migrate", "deploy");
    return;
  }

  // Схема есть, а нашей начальной миграции в истории нет. Пометить базу можно,
  // только если схема действительно та, которую эта миграция создаёт.
  const expected = expectedTablesFromSchema(
    readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8")
  );
  const missing = [...expected].filter((t) => !schemaTables.has(t)).sort();
  if (missing.length > 0) {
    await client.$disconnect();
    console.error(
      "[db-deploy] в базе есть таблицы, но не те, что описаны схемой — сам разметить её не могу.\n" +
        `Не хватает (${missing.length}): ${missing.join(", ")}\n` +
        "Разберитесь вручную: npm run db:audit"
    );
    process.exit(1);
  }

  const failed = history.filter(
    (h) => h.migration_name === initial && h.finished_at === null && h.rolled_back_at === null
  );
  if (failed.length > 0) {
    // Случай 3: прошлая попытка записана неудачной и блокирует всё дальше.
    console.log(`[db-deploy] снимаю запись о неудачной попытке ${initial}`);
    prisma("migrate", "resolve", "--rolled-back", initial);
  }

  console.log(
    `[db-deploy] схема на месте (${schemaTables.size} таблиц), истории нет — ` +
      `отмечаю ${initial} применённой`
  );
  await client.$disconnect();
  prisma("migrate", "resolve", "--applied", initial);
  prisma("migrate", "deploy");
}

if (process.argv[1]?.endsWith("db-deploy.ts")) {
  void main().catch((err) => {
    console.error("[db-deploy] отказ:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
