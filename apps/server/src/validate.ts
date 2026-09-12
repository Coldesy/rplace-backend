import {
  inBounds,
  isUuid,
  isValidColorIndex,
  type PlaceMessage,
  type PlaceRejectReason,
} from "@rplace/shared";

export type UserRow = {
  id: string;
  display_name: string;
  banned: boolean;
};

export function validatePlace(
  message: PlaceMessage,
  user: UserRow | undefined,
): PlaceRejectReason | null {
  if (!user) {
    return "unauthenticated";
  }
  if (user.banned) {
    return "banned";
  }
  if (!isUuid(message.placement_id)) {
    return "invalid";
  }
  if (!inBounds(message.x, message.y)) {
    return "oob";
  }
  if (!isValidColorIndex(message.color_index)) {
    return "bad_color";
  }
  return null;
}

export function parseClientJson(raw: string): { type: string; [key: string]: unknown } | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object" || typeof (value as { type?: unknown }).type !== "string") {
      return null;
    }
    return value as { type: string; [key: string]: unknown };
  } catch {
    return null;
  }
}

export function asPlaceMessage(value: { type: string; [key: string]: unknown }): PlaceMessage | null {
  if (value.type !== "place") {
    return null;
  }
  if (typeof value.placement_id !== "string") {
    return null;
  }
  if (typeof value.x !== "number" || typeof value.y !== "number" || typeof value.color_index !== "number") {
    return null;
  }
  return {
    type: "place",
    placement_id: value.placement_id,
    x: value.x,
    y: value.y,
    color_index: value.color_index,
  };
}
