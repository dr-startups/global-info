/**
 * Offline stub so unit tests never open a real Prisma/DB connection.
 * NETWORK_CALLS=0; no live providers.
 */

/**
 * Делегаты те же, что перечисляет `prepare-prisma-bundle`: офлайновая заглушка
 * с половиной делегатов молча отдавала бы неполный бандл — ровно тот дефект,
 * который тот модуль и закрывает.
 */
export const prisma = {
  searchResult: {
    count: async () => 0,
    findMany: async () => [],
    // Ничего не пишет: тесту, которому важны записанные строки, положено
    // подменить этот делегат своим и вернуть его на место.
    createMany: async (args: { data: unknown[] }) => ({ count: args.data.length }),
  },
  searchSurfaceItem: {
    count: async () => 0,
  },
  databaseProfile: {
    findMany: async () => [],
  },
  complianceScreeningRun: {
    findMany: async () => [],
  },
  riskFinding: {
    findMany: async () => [],
  },
  wikipediaCheck: {
    findMany: async () => [],
  },
  serpCapture: {
    findMany: async () => [],
  },
  // Решения аналитика: офлайн их нет, и пустой список — честный ответ.
  reviewDecision: {
    findMany: async () => [],
    updateMany: async () => ({ count: 0 }),
    create: async (args: { data: Record<string, unknown> }) => args.data,
  },
};
