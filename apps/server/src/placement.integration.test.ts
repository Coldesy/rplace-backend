import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  applyPlacement,
  compensatePlacement,
  createRedis,
  currentSeq,
  initLiveCanvas,
  type RedisClient,
} from "./canvas-store.js";
import { placePixel } from "./placement.js";
import type { UserRow } from "./validate.js";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://rplace:rplace@localhost:5432/rplace";
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";

const alice: UserRow = {
  id: "11111111-1111-1111-1111-111111111111",
  display_name: "alice",
  banned: false,
};

let redis: RedisClient;
let pool: Pool;

async function waitForServices(): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 40; i += 1) {
    try {
      const probe = createRedis(REDIS_URL);
      await probe.connect();
      await probe.ping();
      probe.disconnect();
      const pg = new Pool({ connectionString: DATABASE_URL });
      await pg.query("select 1");
      await pg.end();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(
    `Redis/Postgres not available. Run docker compose up -d. Last error: ${String(lastError)}`,
  );
}

beforeAll(async () => {
  await waitForServices();
  redis = createRedis(REDIS_URL);
  await redis.connect();
  await initLiveCanvas(redis);
  pool = new Pool({ connectionString: DATABASE_URL });
});

afterAll(async () => {
  await pool?.end();
  redis?.disconnect();
});

describe("placement integration", () => {
  it("writes Redis then pixel_log and assigns a seq", async () => {
    const x = Math.floor(Math.random() * 100) - 50;
    const y = Math.floor(Math.random() * 100) - 50;
    const before = await currentSeq(redis);
    const result = await placePixel(redis, pool, alice, {
      type: "place",
      placement_id: randomUUID(),
      x,
      y,
      color_index: 5,
    });
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") {
      return;
    }
    expect(result.seq).toBeGreaterThan(before);
    const logged = await pool.query("SELECT seq FROM pixel_log WHERE seq = $1", [result.seq]);
    expect(logged.rowCount).toBe(1);
  });

  it("returns the original result for a repeated placement_id", async () => {
    const placement_id = randomUUID();
    const message = {
      type: "place" as const,
      placement_id,
      x: -2,
      y: 3,
      color_index: 6,
    };
    const first = await placePixel(redis, pool, alice, message);
    const second = await placePixel(redis, pool, alice, message);
    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("duplicate");
    if (first.kind === "ok" && second.kind === "duplicate") {
      expect(second.seq).toBe(first.seq);
      expect(second.color_index).toBe(first.color_index);
    }
  });

  it("compensates Redis when pixel_log insert cannot complete", async () => {
    const placement_id = randomUUID();
    const applied = await applyPlacement(redis, {
      placement_id,
      user_id: alice.id,
      x: 4,
      y: -4,
      color_index: 7,
    });
    expect(applied.kind).toBe("ok");
    if (applied.kind !== "ok") {
      return;
    }
    await compensatePlacement(redis, applied.placement);
    const existing = await redis.get(`idempotency:placement:${placement_id}`);
    expect(existing).toBeNull();
  });

  it("last write wins on the same coordinate with distinct seqs", async () => {
    const x = 8;
    const y = 8;
    const first = await placePixel(redis, pool, alice, {
      type: "place",
      placement_id: randomUUID(),
      x,
      y,
      color_index: 1,
    });
    const second = await placePixel(redis, pool, alice, {
      type: "place",
      placement_id: randomUUID(),
      x,
      y,
      color_index: 2,
    });
    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("ok");
    if (first.kind === "ok" && second.kind === "ok") {
      expect(second.seq).toBeGreaterThan(first.seq);
      expect(second.color_index).toBe(2);
    }
  });
});
