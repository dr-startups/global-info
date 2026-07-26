import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: "@/server/prisma/client",
        replacement: path.resolve(root, "tests/mocks/prisma-client.ts"),
      },
      {
        find: "@",
        replacement: path.resolve(root, "src"),
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    testTimeout: 30_000,
    env: {
      NETWORK_CALLS: "0",
    },
  },
});
