import { describe, expect, it } from "vitest";
import {
  CANVAS_WIDTH,
  PIXEL_COUNT,
  coordToOffset,
  inBounds,
  isValidColorIndex,
  offsetToCoord,
} from "./index.js";

describe("bounds", () => {
  it("maps the center-anchored 100x100 corners", () => {
    expect(coordToOffset(-50, -50)).toBe(0);
    expect(coordToOffset(49, -50)).toBe(CANVAS_WIDTH - 1);
    expect(coordToOffset(49, 49)).toBe(PIXEL_COUNT - 1);
    expect(offsetToCoord(0)).toEqual({ x: -50, y: -50 });
    expect(offsetToCoord(PIXEL_COUNT - 1)).toEqual({ x: 49, y: 49 });
  });

  it("rejects out of bounds coordinates", () => {
    expect(inBounds(-50, -50)).toBe(true);
    expect(inBounds(50, 0)).toBe(false);
    expect(inBounds(0.5, 0)).toBe(false);
  });
});

describe("palette", () => {
  it("accepts 0-15 only", () => {
    expect(isValidColorIndex(0)).toBe(true);
    expect(isValidColorIndex(15)).toBe(true);
    expect(isValidColorIndex(16)).toBe(false);
    expect(isValidColorIndex(-1)).toBe(false);
  });
});
