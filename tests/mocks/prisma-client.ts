/**
 * Offline stub so unit tests never open a real Prisma/DB connection.
 * NETWORK_CALLS=0; no live providers.
 */

export const prisma = {
  searchResult: {
    count: async () => 0,
  },
  searchSurfaceItem: {
    count: async () => 0,
  },
};
