export const PALETTE = [
  "#ffffff",
  "#e4e4e4",
  "#888888",
  "#222222",
  "#ffa7d1",
  "#e50000",
  "#e59500",
  "#a06a42",
  "#e5d900",
  "#94e044",
  "#02be01",
  "#00d3dd",
  "#0083c7",
  "#0000ea",
  "#cf6ee4",
  "#820080",
] as const;

export const PALETTE_SIZE = PALETTE.length;

export function isValidColorIndex(colorIndex: number): boolean {
  return Number.isInteger(colorIndex) && colorIndex >= 0 && colorIndex < PALETTE_SIZE;
}
