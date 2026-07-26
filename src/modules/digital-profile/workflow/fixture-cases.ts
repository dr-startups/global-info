/**
 * Фикстурные кейсы: их работу автоматика не возобновляет.
 *
 * Смоки оставляют после себя джобы и исполнения агентов в незавершённом
 * состоянии — это их нормальный след, а не потерянная работа. Подборка после
 * деплоя принимала этот след за работу, которую надо доделать, и на стенде с
 * настоящими ключами воркер молча отправлял **платные** задачи Arsenkin по
 * данным смока. Поймано на живом стенде: `arsenkin_set_ok` в логе, две задачи
 * за пять минут.
 *
 * Признак `Case.isFixture` в базе уже был — на него просто не смотрели в этом
 * месте. Правило собрано здесь одним куском, потому что путей возобновления два
 * (unified-джобы и исполнения CaseAgent), и починить один — починить половину.
 */

import type { PrismaClient } from "@prisma/client";

/** Кеш на один оборот подборки: за это время список фикстур не меняется. */
const CACHE_TTL_MS = 30_000;
let cache: { ids: ReadonlySet<string>; at: number } | null = null;

export function resetFixtureCaseCacheForTests(): void {
  cache = null;
}

/**
 * Идентификаторы фикстурных кейсов.
 *
 * При недоступности базы возвращается пустое множество: список работы для
 * возобновления тоже строится из базы, поэтому возобновлять всё равно будет
 * нечего, и притворяться, будто фикстур нет, безопаснее, чем блокировать
 * настоящие прогоны.
 */
export async function fixtureCaseIds(prisma?: PrismaClient): Promise<ReadonlySet<string>> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.ids;
  try {
    const client = prisma ?? (await import("@/server/prisma/client")).prisma;
    const rows = await client.case.findMany({
      where: { isFixture: true },
      select: { id: true },
    });
    const ids: ReadonlySet<string> = new Set(rows.map((r) => r.id));
    cache = { ids, at: now };
    return ids;
  } catch {
    return new Set();
  }
}

/** Удобная проверка одного кейса. */
export async function isFixtureCase(caseId: string, prisma?: PrismaClient): Promise<boolean> {
  return (await fixtureCaseIds(prisma)).has(caseId);
}
