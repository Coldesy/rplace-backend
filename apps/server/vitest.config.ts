import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    env: {
      DATABASE_URL: "postgres://rplace:rplace@localhost:5432/rplace",
      REDIS_URL: "redis://localhost:6379",
    },
  },
});
