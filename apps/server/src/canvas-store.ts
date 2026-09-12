import Redis from "ioredis";
import {
  DEFAULT_BOUNDS,
  DEFAULT_COLOR_INDEX,
  PIXEL_COUNT,
  coordToOffset,
  type PixelUpdate,
} from "@rplace/shared";
import {
  EVENT_STREAM_MAXLEN,
  IDEMPOTENCY_TTL_SECONDS,
  PLACE_PIXEL_LUA,
  REDIS_KEYS,
  idempotencyKey,
} from "./redis-keys.js";

export type RedisClient = Redis & {
  placePixel: (
    pixelsKey: string,
    seqKey: string,
    idempKey: string,
    eventsKey: string,
    offset: string,
    color: string,
    placementId: string,
    userId: string,
    x: string,
    y: string,
    ttl: string,
    maxlen: string,
  ) => Promise<string[]>;
};

export type AcceptedPlacement = {
  seq: number;
  x: number;
  y: number;
  color_index: number;
  user_id: string;
  placement_id: string;
  prev_color_index: number;
  stream_id: string;
};

export function createRedis(url: string): RedisClient {
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  redis.defineCommand("placePixel", {
    numberOfKeys: 4,
    lua: PLACE_PIXEL_LUA,
  });
  return redis as RedisClient;
}

export async function initLiveCanvas(redis: Redis): Promise<void> {
  const exists = await redis.exists(REDIS_KEYS.bounds);
  if (!exists) {
    await redis.set(REDIS_KEYS.bounds, JSON.stringify(DEFAULT_BOUNDS));
  }
  const seq = await redis.get(REDIS_KEYS.seq);
  if (seq === null) {
    await redis.set(REDIS_KEYS.seq, "0");
  }
}

export async function currentSeq(redis: Redis): Promise<number> {
  return Number((await redis.get(REDIS_KEYS.seq)) ?? 0);
}

export async function loadSnapshotPixels(redis: Redis): Promise<number[]> {
  const pixels = Array.from({ length: PIXEL_COUNT }, () => DEFAULT_COLOR_INDEX);
  const hash = await redis.hgetall(REDIS_KEYS.pixels);
  for (const [offset, color] of Object.entries(hash)) {
    const index = Number(offset);
    if (Number.isInteger(index) && index >= 0 && index < PIXEL_COUNT) {
      pixels[index] = Number(color);
    }
  }
  return pixels;
}

function parseResult(json: string): Omit<AcceptedPlacement, "stream_id"> {
  const value = JSON.parse(json) as Omit<AcceptedPlacement, "stream_id">;
  return value;
}

export async function applyPlacement(
  redis: RedisClient,
  input: {
    placement_id: string;
    user_id: string;
    x: number;
    y: number;
    color_index: number;
  },
): Promise<{ kind: "ok"; placement: AcceptedPlacement } | { kind: "duplicate"; placement: Omit<AcceptedPlacement, "stream_id" | "prev_color_index"> }> {
  const offset = String(coordToOffset(input.x, input.y));
  const reply = await redis.placePixel(
    REDIS_KEYS.pixels,
    REDIS_KEYS.seq,
    idempotencyKey(input.placement_id),
    REDIS_KEYS.events,
    offset,
    String(input.color_index),
    input.placement_id,
    input.user_id,
    String(input.x),
    String(input.y),
    String(IDEMPOTENCY_TTL_SECONDS),
    String(EVENT_STREAM_MAXLEN),
  );

  if (reply[0] === "duplicate") {
    const stored = parseResult(reply[1]);
    return {
      kind: "duplicate",
      placement: {
        seq: stored.seq,
        x: stored.x,
        y: stored.y,
        color_index: stored.color_index,
        user_id: stored.user_id,
        placement_id: stored.placement_id,
      },
    };
  }

  const stored = parseResult(reply[1]);
  return {
    kind: "ok",
    placement: {
      ...stored,
      stream_id: reply[2],
    },
  };
}

export async function compensatePlacement(
  redis: Redis,
  placement: AcceptedPlacement,
): Promise<void> {
  const offset = String(coordToOffset(placement.x, placement.y));
  if (placement.prev_color_index === DEFAULT_COLOR_INDEX) {
    await redis.hdel(REDIS_KEYS.pixels, offset);
  } else {
    await redis.hset(REDIS_KEYS.pixels, offset, String(placement.prev_color_index));
  }
  await redis.del(idempotencyKey(placement.placement_id));
  if (placement.stream_id) {
    await redis.xdel(REDIS_KEYS.events, placement.stream_id);
  }
}

export async function loadEventsAfter(redis: Redis, lastSeq: number): Promise<PixelUpdate[] | null> {
  const current = await currentSeq(redis);
  if (lastSeq > current) {
    return null;
  }
  if (lastSeq === current) {
    return [];
  }

  const entries = await redis.xrange(REDIS_KEYS.events, "-", "+");
  const updates: PixelUpdate[] = [];
  let minSeq = Infinity;

  for (const [, fields] of entries) {
    const map = toMap(fields);
    const payload = map.get("payload");
    if (!payload) {
      continue;
    }
    const parsed = JSON.parse(payload) as PixelUpdate;
    minSeq = Math.min(minSeq, parsed.seq);
    if (parsed.seq > lastSeq) {
      updates.push({
        seq: parsed.seq,
        x: parsed.x,
        y: parsed.y,
        color_index: parsed.color_index,
        user_id: parsed.user_id,
      });
    }
  }

  updates.sort((a, b) => a.seq - b.seq);

  if (lastSeq === 0 && updates.length === current) {
    return updates;
  }
  if (minSeq !== Infinity && minSeq > lastSeq + 1) {
    return null;
  }
  const expected = current - lastSeq;
  if (updates.length !== expected) {
    return null;
  }
  return updates;
}

function toMap(fields: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < fields.length; i += 2) {
    map.set(fields[i], fields[i + 1]);
  }
  return map;
}
