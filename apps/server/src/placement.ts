import type { Pool } from "pg";
import type { PlaceMessage, PlaceRejectReason } from "@rplace/shared";
import {
  applyPlacement,
  compensatePlacement,
  type RedisClient,
} from "./canvas-store.js";
import { getPixelLogByPlacement, insertPixelLog, isUniqueViolation } from "./db.js";
import { validatePlace, type UserRow } from "./validate.js";

export type PlaceResult =
  | {
      kind: "ok";
      placement_id: string;
      seq: number;
      x: number;
      y: number;
      color_index: number;
      user_id: string;
    }
  | {
      kind: "duplicate";
      placement_id: string;
      seq: number;
      x: number;
      y: number;
      color_index: number;
    }
  | { kind: "reject"; placement_id: string; reason: PlaceRejectReason };

export async function placePixel(
  redis: RedisClient,
  pool: Pool,
  user: UserRow | undefined,
  message: PlaceMessage,
): Promise<PlaceResult> {
  const reason = validatePlace(message, user);
  if (reason) {
    return { kind: "reject", placement_id: message.placement_id, reason };
  }
  if (!user) {
    return { kind: "reject", placement_id: message.placement_id, reason: "unauthenticated" };
  }

  const applied = await applyPlacement(redis, {
    placement_id: message.placement_id,
    user_id: user.id,
    x: message.x,
    y: message.y,
    color_index: message.color_index,
  });

  if (applied.kind === "duplicate") {
    return {
      kind: "duplicate",
      placement_id: applied.placement.placement_id,
      seq: applied.placement.seq,
      x: applied.placement.x,
      y: applied.placement.y,
      color_index: applied.placement.color_index,
    };
  }

  try {
    await insertPixelLog(pool, {
      seq: applied.placement.seq,
      placement_id: applied.placement.placement_id,
      user_id: applied.placement.user_id,
      x: applied.placement.x,
      y: applied.placement.y,
      color_index: applied.placement.color_index,
    });
  } catch (error) {
    await compensatePlacement(redis, applied.placement);
    if (isUniqueViolation(error)) {
      const existing = await getPixelLogByPlacement(pool, message.placement_id);
      if (existing) {
        return {
          kind: "duplicate",
          placement_id: existing.placement_id,
          seq: Number(existing.seq),
          x: existing.x,
          y: existing.y,
          color_index: existing.color_index,
        };
      }
    }
    throw error;
  }

  return {
    kind: "ok",
    placement_id: applied.placement.placement_id,
    seq: applied.placement.seq,
    x: applied.placement.x,
    y: applied.placement.y,
    color_index: applied.placement.color_index,
    user_id: applied.placement.user_id,
  };
}
