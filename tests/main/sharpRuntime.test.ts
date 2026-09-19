import { describe, expect, it } from "vitest";

import { sharpConcurrencyTarget } from "../../services/sharpRuntime";

describe("sharp concurrency", () => {
  it("bounds libvips at four threads on a large machine", () => {
    expect(sharpConcurrencyTarget(32)).toBe(4);
    expect(sharpConcurrencyTarget(12)).toBe(4);
  });

  it("halves a small cpu count instead of using the ceiling", () => {
    expect(sharpConcurrencyTarget(6)).toBe(3);
    expect(sharpConcurrencyTarget(4)).toBe(2);
  });

  it("never asks for fewer than one thread", () => {
    expect(sharpConcurrencyTarget(2)).toBe(1);
    expect(sharpConcurrencyTarget(1)).toBe(1);
    expect(sharpConcurrencyTarget(0)).toBe(1);
  });

  it("falls back to one when the cpu count does not read as a number", () => {
    expect(sharpConcurrencyTarget(Number.NaN)).toBe(1);
  });
});
