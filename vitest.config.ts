import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "profiling/**", ".agents/**"],
    // Starts the Postgres and Redis every file under tests/integration shares.
    globalSetup: ["tests/integration/support/global-setup.ts"],
    // Tests that need longer (chaos, slow pipelines) pass their own timeout.
    testTimeout: 30_000,
    // Long enough for a first-time container image pull.
    hookTimeout: 300_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "json-summary", "html"],
      include: ["src/**", "packages/*/src/**"],
      exclude: ["test-project/**", "tests/**", "vitest.config.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
