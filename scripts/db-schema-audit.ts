/**
 * Сверка живой базы со схемой Prisma. Только чтение — ничего не меняет.
 *
 * Нужна, чтобы увидеть мёртвые таблицы: за несколько итераций проекта в базе
 * оседают таблицы, которых в схеме уже нет, и заметить их иначе нечем —
 * `prisma migrate status` смотрит на список применённых миграций, а не на то,
 * что в базе на самом деле лежит.
 *
 * Запуск:
 *   npm run db:audit                     # текущая DATABASE_URL
 *   DATABASE_URL=<railway-url> npm run db:audit
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

/** Имена таблиц, которые ожидаются по схеме: @@map или имя модели. */
export function expectedTablesFromSchema(schema: string): Set<string> {
  const tables = new Set<string>();
  const modelRe = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gmu;
  for (const m of schema.matchAll(modelRe)) {
    const [, name, body] = m;
    const mapped = body!.match(/@@map\("([^"]+)"\)/u);
    tables.add(mapped ? mapped[1]! : name!);
  }
  return tables;
}

/** Служебные таблицы, которые в схеме не описаны и описаны быть не должны. */
const SYSTEM_TABLES = new Set(["_prisma_migrations"]);

async function main(): Promise<void> {
  const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
  const expected = expectedTablesFromSchema(schema);

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `;
    const live = new Set(rows.map((r) => r.table_name));

    const extra = [...live].filter((t) => !expected.has(t) && !SYSTEM_TABLES.has(t)).sort();
    const missing = [...expected].filter((t) => !live.has(t)).sort();

    console.log(`таблиц в схеме: ${expected.size}`);
    console.log(`таблиц в базе:  ${live.size} (включая служебные)`);
    console.log();

    if (extra.length === 0 && missing.length === 0) {
      console.log("Расхождений нет: база соответствует схеме.");
      return;
    }

    if (extra.length > 0) {
      console.log(`В базе есть, в схеме нет — ${extra.length} (мёртвые):`);
      for (const t of extra) {
        const count = await rowCount(prisma, t);
        console.log(`  ${t}${count === null ? "" : `  строк: ${count}`}`);
      }
      console.log();
      console.log("Удалять их следует миграцией, а не руками: тогда изменение");
      console.log("повторится на всех окружениях и останется в истории.");
      console.log();
    }
    if (missing.length > 0) {
      console.log(`В схеме есть, в базе нет — ${missing.length}:`);
      for (const t of missing) console.log(`  ${t}`);
      console.log();
      console.log("Скорее всего не накатаны миграции: npm run db:deploy");
    }
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

/** Число строк — чтобы было видно, пустая мёртвая таблица или с данными. */
async function rowCount(prisma: PrismaClient, table: string): Promise<number | null> {
  try {
    const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT COUNT(*)::bigint AS n FROM "${table.replace(/"/gu, '""')}"`
    );
    return Number(rows[0]?.n ?? 0);
  } catch {
    return null;
  }
}

if (process.argv[1]?.endsWith("db-schema-audit.ts")) {
  void main().catch((err) => {
    console.error("Сверка не выполнена:", err instanceof Error ? err.message : err);
    process.exit(2);
  });
}
