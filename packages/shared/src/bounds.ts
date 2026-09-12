export const CANVAS_WIDTH = 100;
export const CANVAS_HEIGHT = 100;
export const X_MIN = -50;
export const Y_MIN = -50;
export const X_MAX = 49;
export const Y_MAX = 49;
export const PIXEL_COUNT = CANVAS_WIDTH * CANVAS_HEIGHT;
export const DEFAULT_COLOR_INDEX = 0;

export type Bounds = {
  width: number;
  height: number;
  origin: "center";
};

export const DEFAULT_BOUNDS: Bounds = {
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  origin: "center",
};

export function inBounds(x: number, y: number): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= X_MIN &&
    x <= X_MAX &&
    y >= Y_MIN &&
    y <= Y_MAX
  );
}

export function coordToOffset(x: number, y: number): number {
  return (y - Y_MIN) * CANVAS_WIDTH + (x - X_MIN);
}

export function offsetToCoord(offset: number): { x: number; y: number } {
  const x = (offset % CANVAS_WIDTH) + X_MIN;
  const y = Math.floor(offset / CANVAS_WIDTH) + Y_MIN;
  return { x, y };
}
