import type { Bounds } from "./bounds.js";

export type UserView = {
  id: string;
  display_name: string;
  banned: boolean;
};

export type PixelUpdate = {
  seq: number;
  x: number;
  y: number;
  color_index: number;
  user_id: string;
};

export type PlaceRejectReason =
  | "unauthenticated"
  | "banned"
  | "oob"
  | "bad_color"
  | "invalid";

export type HelloMessage = {
  type: "hello";
  mock_user_id?: string;
  last_seq?: number;
};

export type PlaceMessage = {
  type: "place";
  placement_id: string;
  x: number;
  y: number;
  color_index: number;
};

export type ClientMessage = HelloMessage | PlaceMessage;

export type SnapshotMessage = {
  type: "snapshot";
  seq: number;
  bounds: Bounds;
  pixels: number[];
  you?: UserView;
};

export type PlaceOkMessage = {
  type: "place_ok";
  placement_id: string;
  seq: number;
  x: number;
  y: number;
  color_index: number;
};

export type PlaceDuplicateMessage = {
  type: "place_duplicate";
  placement_id: string;
  seq: number;
  x: number;
  y: number;
  color_index: number;
};

export type PlaceRejectMessage = {
  type: "place_reject";
  placement_id: string;
  reason: PlaceRejectReason;
};

export type PixelsMessage = {
  type: "pixels";
  from_seq: number;
  to_seq: number;
  updates: PixelUpdate[];
};

export type ResyncGapMessage = {
  type: "resync";
  mode: "gap";
  from_seq: number;
  to_seq: number;
  updates: PixelUpdate[];
  you?: UserView;
};

export type ResyncSnapshotMessage = {
  type: "resync";
  mode: "snapshot";
  seq: number;
  bounds: Bounds;
  pixels: number[];
  you?: UserView;
};

export type ErrorMessage = {
  type: "error";
  message: string;
};

export type ServerMessage =
  | SnapshotMessage
  | PlaceOkMessage
  | PlaceDuplicateMessage
  | PlaceRejectMessage
  | PixelsMessage
  | ResyncGapMessage
  | ResyncSnapshotMessage
  | ErrorMessage;

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
