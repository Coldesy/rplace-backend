export {
  CANVAS_HEIGHT,
  CANVAS_WIDTH,
  DEFAULT_BOUNDS,
  DEFAULT_COLOR_INDEX,
  PIXEL_COUNT,
  X_MAX,
  X_MIN,
  Y_MAX,
  Y_MIN,
  coordToOffset,
  inBounds,
  offsetToCoord,
} from "./bounds.js";
export type { Bounds } from "./bounds.js";

export { PALETTE, PALETTE_SIZE, isValidColorIndex } from "./palette.js";

export {
  UUID_RE,
  isUuid,
} from "./protocol.js";
export type {
  ClientMessage,
  ErrorMessage,
  HelloMessage,
  PlaceDuplicateMessage,
  PlaceMessage,
  PlaceOkMessage,
  PlaceRejectMessage,
  PlaceRejectReason,
  PixelUpdate,
  PixelsMessage,
  ResyncGapMessage,
  ResyncSnapshotMessage,
  ServerMessage,
  SnapshotMessage,
  UserView,
} from "./protocol.js";
