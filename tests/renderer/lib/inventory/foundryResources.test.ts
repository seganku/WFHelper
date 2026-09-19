import { describe, expect, it } from "vitest";

import {
  foundryClaimableProducts,
  isFoundryBuildClaimable,
} from "../../../../src/lib/inventory/foundryResources.js";
import type { FoundryBuildingItem, FoundryData } from "../../../../src/types/inventory.js";

const NOW = Date.UTC(2026, 0, 2, 12, 0, 0);

function building(overrides: Partial<FoundryBuildingItem>): FoundryBuildingItem {
  return {
    name: "Build",
    imageUrl: null,
    endDate: null,
    uniqueName: null,
    productUniqueName: null,
    category: "Misc",
    ingredients: [],
    buildPrice: 0,
    ...overrides,
  };
}

function foundry(builds: FoundryBuildingItem[]): FoundryData {
  return { building: builds, recipes: [] };
}

describe("isFoundryBuildClaimable", () => {
  it("claims a build whose end date has passed and not one still running", () => {
    expect(isFoundryBuildClaimable({ endDate: new Date(NOW - 1) }, NOW)).toBe(true);
    expect(isFoundryBuildClaimable({ endDate: new Date(NOW + 1) }, NOW)).toBe(false);
  });

  it("claims a build whose end date is exactly now", () => {
    expect(isFoundryBuildClaimable({ endDate: new Date(NOW) }, NOW)).toBe(true);
  });

  it("leaves a build without an end date running", () => {
    expect(isFoundryBuildClaimable({ endDate: null }, NOW)).toBe(false);
  });
});

describe("foundryClaimableProducts", () => {
  it("collects the finished products and skips the ones still building", () => {
    const products = foundryClaimableProducts(
      foundry([
        building({
          endDate: new Date(NOW - 60_000),
          uniqueName: "/Recipes/LexPrimeBlueprint",
          productUniqueName: "/W/LexPrime",
        }),
        building({
          endDate: new Date(NOW + 60_000),
          uniqueName: "/Recipes/SomaPrimeBlueprint",
          productUniqueName: "/W/SomaPrime",
        }),
      ]),
      NOW,
    );

    expect([...products]).toEqual(["/W/LexPrime"]);
  });

  it("falls back to the blueprint when the recipe did not resolve a product", () => {
    const products = foundryClaimableProducts(
      foundry([
        building({
          endDate: new Date(NOW - 1),
          uniqueName: "/Recipes/UnmappedThingBlueprint",
          productUniqueName: null,
        }),
      ]),
      NOW,
    );

    expect([...products]).toEqual(["/Recipes/UnmappedThingBlueprint"]);
  });

  it("skips a finished build that names nothing at all", () => {
    expect(
      foundryClaimableProducts(foundry([building({ endDate: new Date(NOW - 1) })]), NOW).size,
    ).toBe(0);
  });
});
