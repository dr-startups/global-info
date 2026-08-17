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
};
