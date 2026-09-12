import { Pool } from "pg";
import { createRedis } from "./canvas-store.js";

export const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://rplace:rplace@localhost:5432/rplace";
export const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

export async function servicesAvailable(): Promise<boolean> {
  try {
    const probe = createRedis(REDIS_URL);
    await probe.connect();
    await probe.ping();
    probe.disconnect();
    const pg = new Pool({
      connectionString: DATABASE_URL,
      connectionTimeoutMillis: 400,
    });
    await pg.query("select 1");
    await pg.end();
    return true;
  } catch {
    console.warn("Skipping live tests: Redis/Postgres not reachable. Run docker compose up -d.");
    return false;
  }
}
