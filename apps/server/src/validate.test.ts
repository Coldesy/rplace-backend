import { describe, expect, it } from "vitest";
import { asPlaceMessage, validatePlace, type UserRow } from "./validate.js";

const alice: UserRow = {
  id: "11111111-1111-1111-1111-111111111111",
  display_name: "alice",
  banned: false,
};

const banned: UserRow = { ...alice, banned: true };

const basePlace = {
  type: "place" as const,
  placement_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  x: 0,
  y: 0,
  color_index: 1,
};

describe("validatePlace", () => {
  it("rejects unauthenticated and banned users", () => {
    expect(validatePlace(basePlace, undefined)).toBe("unauthenticated");
    expect(validatePlace(basePlace, banned)).toBe("banned");
  });

  it("rejects out of bounds, bad colors, and invalid ids", () => {
    expect(validatePlace({ ...basePlace, x: 50 }, alice)).toBe("oob");
    expect(validatePlace({ ...basePlace, color_index: 16 }, alice)).toBe("bad_color");
    expect(validatePlace({ ...basePlace, placement_id: "nope" }, alice)).toBe("invalid");
  });

  it("accepts a valid placement", () => {
    expect(validatePlace(basePlace, alice)).toBeNull();
  });
});

describe("asPlaceMessage", () => {
  it("requires numeric coordinates", () => {
    expect(asPlaceMessage({ type: "place", placement_id: "x" })).toBeNull();
    expect(asPlaceMessage({ ...basePlace })).toEqual(basePlace);
  });
});
