import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: path.join(repoRoot, ".env") });

export type AppConfig = {
  databaseUrl: string;
  redisUrl: string;
  port: number;
  wsPath: string;
};

export function loadConfig(): AppConfig {
  return {
    databaseUrl: process.env.DATABASE_URL ?? "postgres://rplace:rplace@localhost:5432/rplace",
    redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
    port: Number(process.env.PORT ?? 3001),
    wsPath: process.env.WS_PATH ?? "/ws",
  };
}
