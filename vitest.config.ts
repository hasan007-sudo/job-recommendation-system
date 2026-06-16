import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        // Fast, fully mocked unit tests — no Docker, no DB.
        test: {
          name: "unit",
          environment: "node",
          include: ["lib/__tests__/**/*.test.ts"],
          exclude: ["lib/__tests__/integration/**"],
        },
      },
      {
        // Integration tests against a throwaway pgvector Postgres (Docker required).
        // Opt-in: run with `bun run test:integration`.
        test: {
          name: "integration",
          environment: "node",
          include: ["lib/__tests__/integration/**/*.integration.test.ts"],
          globalSetup: ["lib/__tests__/integration/global-setup.ts"],
          setupFiles: ["lib/__tests__/integration/setup-env.ts"],
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
