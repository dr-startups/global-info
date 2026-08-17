/**
 * Делегаты базы, которые читает подготовка отчёта, — один список на проект.
 *
 * `runCanonicalReportPrepare` принимает prisma структурным пересечением
 * `Partial<…>`-интерфейсов, поэтому забытый делегат — не ошибка типов, а тихая
 * ветка «данных нет»: артефакт пишется пустым, и отчёт заявляет, что скрининга
 * не было, а подтверждения аналитика не существует. Ровно так на шаге 0007
 * `complianceScreeningRun` был реализован, покрыт юнитом — и мёртв на каждом
 * живом прогоне. Поэтому список живёт здесь и только здесь, а вызывающие
 * получают его целиком.
 *
 * Без клиента подготовка **отказывает**, а не деградирует: данные лежат в той
 * же базе, что и сам кейс, «не смогли прочитать базу» — это наша авария.
 * Отказ ничего не теряет (артефакты прежнего прогона целы, у джобы отказ
 * ретраится), а отчёт, отрицающий выполненный скрининг, — ложное утверждение
 * банку.
 */

import {
  CanonicalPrepareBlockedError,
  type CanonicalPrepareInput,
} from "./canonical-report-prepare";

/** Ровно то, что подготовка отчёта берёт из базы, — и в типах тоже один ответ. */
export type PreparePrismaBundle = NonNullable<CanonicalPrepareInput["prisma"]>;

export const PREPARE_PRISMA_DELEGATES = [
  "searchResult",
  "searchSurfaceItem",
  "databaseProfile",
  "complianceScreeningRun",
  "riskFinding",
  "wikipediaCheck",
  "serpCapture",
] as const;

/** Отбор делегатов из клиента базы. Единственное место, где список записан. */
export function buildPreparePrismaBundle(client: PreparePrismaBundle): PreparePrismaBundle {
  return {
    searchResult: client.searchResult,
    searchSurfaceItem: client.searchSurfaceItem,
    databaseProfile: client.databaseProfile,
    complianceScreeningRun: client.complianceScreeningRun,
    riskFinding: client.riskFinding,
    wikipediaCheck: client.wikipediaCheck,
    serpCapture: client.serpCapture,
  };
}

async function importServerPrisma(): Promise<PreparePrismaBundle | null> {
  try {
    const mod = await import("@/server/prisma/client");
    return (mod.prisma as unknown as PreparePrismaBundle | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * Бандл для боевого вызова подготовки: переданный клиент сильнее серверного.
 *
 * Резолвер зовут только боевые пути. Внутрь `runCanonicalReportPrepare` он не
 * прячется намеренно: офлайн-смоки зовут подготовку напрямую под tsx, и
 * скрытый импорт серверного клиента потянул бы их к базе.
 */
export async function resolvePreparePrismaBundle(
  injected?: PreparePrismaBundle | null
): Promise<PreparePrismaBundle> {
  const client = injected ?? (await importServerPrisma());
  if (!client) {
    throw new CanonicalPrepareBlockedError(
      "PREPARE_DB_UNAVAILABLE",
      "клиент базы недоступен: подготовка отчёта без базы отрицала бы выполненный скрининг"
    );
  }
  // Делегат может отсутствовать у устаревшего сгенерированного клиента или
  // после переименования модели. Тип весь `Partial`, поэтому такой пробел —
  // не ошибка типов, а тихая ветка «данных нет»: она и называется вслух.
  const missing = PREPARE_PRISMA_DELEGATES.filter((name) => !client[name]);
  if (missing.length > 0) {
    throw new CanonicalPrepareBlockedError(
      "PREPARE_DB_UNAVAILABLE",
      `клиент базы без делегатов: ${missing.join(", ")}`
    );
  }
  return buildPreparePrismaBundle(client);
}
