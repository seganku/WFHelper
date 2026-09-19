import { describe, expect, it } from "vitest";

import {
  orderInventoryMatch,
  ownedCountForMarketOrder,
  planQuantitySync,
} from "../../../src/lib/marketOrderInventory.js";
import { applySharedFiltersAndSort } from "../../../src/lib/filters.js";
import type { SharedFiltersState } from "../../../src/types/filters.js";
import type { ItemDbEntry, ParsedItem } from "../../../src/types/inventory.js";
import type { WfmItemsLookup } from "../../../src/types/ipc.js";
import type { WfmOrder } from "../../../src/types/market.js";

const BASE_FILTERS: SharedFiltersState = {
  search: "",
  primeMode: "all",
  masteredMode: "all",
  sortBy: "name",
  sortDirection: "asc",
  orderPlaced: "all",
  mastered: "all",
  spares: "all",
  vaulted: "all",
  partType: "all",
  favorite: "all",
  minimumPlatinum: 0,
  minimumAmount: 0,
  equipped: "all",
  leveledUp: "all",
  subsumed: "all",
  foundryState: "all",
};

function order(overrides: Partial<WfmOrder>): WfmOrder {
  return {
    id: "0".repeat(24),
    orderType: "sell",
    platinum: 10,
    quantity: 1,
    visible: true,
    modRank: null,
    itemId: null,
    itemName: "Trinity Prime Chassis",
    itemUrlName: "trinity_prime_chassis",
    itemThumb: null,
    ...overrides,
  };
}

function parsedItem(overrides: Partial<ParsedItem>): ParsedItem {
  return {
    name: "Trinity Prime Chassis",
    amount: 3,
    ...overrides,
  } as ParsedItem;
}

describe("ownedCountForMarketOrder", () => {
  it("returns the inventory amount for a name match", () => {
    expect(ownedCountForMarketOrder(order({}), [parsedItem({})])).toBe(3);
  });

  it("falls back to the slug when display names differ", () => {
    const inventory = [parsedItem({ name: "Trinity Prime Chassis Blueprint" })];
    expect(ownedCountForMarketOrder(order({ itemName: "Chassis" }), inventory)).toBe(0);
    expect(
      ownedCountForMarketOrder(
        order({ itemUrlName: "trinity_prime_chassis_blueprint" }),
        inventory,
      ),
    ).toBe(3);
  });

  it("joins a renamed listing to the inventory through its game reference", () => {
    const gameRef = "/Lotus/Types/Keys/InfestedAladVQuest/AssassinateInfestedAladVKey";
    const wfmItems = {
      "mutalist alad v assassinate (key)": {
        url_name: "mutalist_alad_v_assassinate_key",
        gameRef,
      },
    };
    const inventory = [
      parsedItem({ name: "Mutalist Alad V Assassinate", internalName: gameRef, amount: 8 }),
    ];
    const listing = order({
      itemName: "Mutalist Alad V Assassinate (Key)",
      itemUrlName: "mutalist_alad_v_assassinate_key",
    });
    expect(ownedCountForMarketOrder(listing, inventory)).toBe(0);
    expect(ownedCountForMarketOrder(listing, inventory, wfmItems)).toBe(8);
  });

  it("returns 0 for items missing from the inventory", () => {
    expect(ownedCountForMarketOrder(order({ itemName: "Ash Prime Systems" }), [])).toBe(0);
  });

  it("counts flag-only ownership as 1", () => {
    const inventory = [
      parsedItem({ amount: undefined as unknown as number, currentlyOwned: true }),
    ];
    expect(ownedCountForMarketOrder(order({}), inventory)).toBe(1);
  });

  it("survives an inventory row whose name is not a string", () => {
    const inventory = [parsedItem({ name: 117 as unknown as string }), parsedItem({})];
    expect(ownedCountForMarketOrder(order({}), inventory)).toBe(3);
  });
});

describe("market order Owned sort", () => {
  it("ascending count surfaces owned-0 rows first and hides none", () => {
    const rows = [
      { name: "A", amount: 2, count: 5 },
      { name: "B", amount: 9, count: 0 },
      { name: "C", amount: 1, count: 2 },
    ];
    const sorted = applySharedFiltersAndSort(rows, {
      ...BASE_FILTERS,
      sortBy: "count",
      sortDirection: "asc",
    });
    expect(sorted.map((row) => row.name)).toEqual(["B", "C", "A"]);
  });
});

const PART_REF = "/Lotus/Types/Recipes/Weapons/RubicoPrimeBlueprint";
const SCENE_REF = "/Lotus/Types/Items/MiscItems/PhotoboothTileSyndicateSimarisDerelictHub";
const GEM_REF = "/Lotus/Types/Items/Gems/Eidolon/RareGemACutAItem";

function catalog(gameRef: string, urlName = "trinity_prime_chassis"): WfmItemsLookup {
  return { [urlName]: { url_name: urlName, gameRef } };
}

function mod(name: string, rank: number): ParsedItem {
  return parsedItem({ name, rank, amount: 1, inventoryGroup: "mods" });
}

const FRAME_PART_BLUEPRINT = "/Lotus/Types/Recipes/WarframeRecipes/AtlasPrimeSystemsBlueprint";
const FRAME_PART_COMPONENT = "/Lotus/Types/Recipes/WarframeRecipes/AtlasPrimeSystemsComponent";

function framePartOrder(overrides: Partial<WfmOrder> = {}): WfmOrder {
  return order({
    itemName: "Atlas Prime Systems",
    itemUrlName: "atlas_prime_systems",
    ...overrides,
  });
}

const framePartCatalog = (): WfmItemsLookup => catalog(FRAME_PART_BLUEPRINT, "atlas_prime_systems");

const craftedPart = (amount: number): ParsedItem =>
  parsedItem({
    name: "Atlas Prime Systems",
    internalName: FRAME_PART_COMPONENT,
    tradable: false,
    amount,
  });

const tradableBlueprint = (amount: number): ParsedItem =>
  parsedItem({
    name: "Atlas Prime Systems Blueprint",
    internalName: FRAME_PART_BLUEPRINT,
    tradable: true,
    amount,
  });

function atragraphOrder(overrides: Partial<WfmOrder> = {}): WfmOrder {
  return order({
    itemName: "Spectral Serration",
    itemUrlName: "spectral_serration",
    subtype: "atragraph",
    modRank: 0,
    ...overrides,
  });
}

describe("orderInventoryMatch", () => {
  it("stays quiet while the inventory still backs the listing", () => {
    const match = orderInventoryMatch(order({}), [parsedItem({})], catalog(PART_REF), {});
    expect(match).toEqual({ state: "match" });
  });

  it("flags a sell order for something the inventory no longer holds", () => {
    expect(orderInventoryMatch(order({}), [], catalog(PART_REF), {})).toEqual({ state: "missing" });
  });

  it("treats a row that resolves to zero owned as missing", () => {
    const inventory = [parsedItem({ amount: 0 })];
    expect(orderInventoryMatch(order({}), inventory, catalog(PART_REF), {})).toEqual({
      state: "missing",
    });
  });

  it("never flags a buy order, which needs no stock", () => {
    const buy = order({ orderType: "buy" });
    expect(orderInventoryMatch(buy, [], catalog(PART_REF), {})).toEqual({ state: "match" });
  });

  it("never flags a captura scene, which the parser drops from inventory", () => {
    expect(orderInventoryMatch(order({}), [], catalog(SCENE_REF), {})).toEqual({ state: "match" });
  });

  it("never flags a resource, which the parser also drops", () => {
    const db: Record<string, ItemDbEntry> = { [GEM_REF]: { category: "Resource" } };
    expect(orderInventoryMatch(order({}), [], catalog(GEM_REF), db)).toEqual({ state: "match" });
  });

  it("stays quiet when the catalog cannot identify the listing at all", () => {
    expect(orderInventoryMatch(order({}), [], {}, {})).toEqual({ state: "match" });
  });

  const relicOrder = (subtype: string | null): WfmOrder =>
    order({
      itemName: "Axi A1 Relic",
      itemUrlName: "axi_a1_relic",
      subtype,
    });
  const RELIC_REF = "/Lotus/Types/Game/Projections/T4VoidProjectionEBronze";
  const relicCatalog = (): WfmItemsLookup => catalog(RELIC_REF, "axi_a1_relic");

  const relicRow = (metal: "Bronze" | "Silver" | "Gold" | "Platinum", amount: number): ParsedItem =>
    parsedItem({
      name: "Axi A1 Relic",
      internalName: `/Lotus/Types/Game/Projections/T4VoidProjectionE${metal}`,
      amount,
    });

  it("backs a refinement listing only with that refinement", () => {
    const radiantOwned = [relicRow("Platinum", 2)];
    expect(orderInventoryMatch(relicOrder("radiant"), radiantOwned, relicCatalog(), {})).toEqual({
      state: "match",
    });
    const intactOwned = [relicRow("Bronze", 4)];
    expect(orderInventoryMatch(relicOrder("radiant"), intactOwned, relicCatalog(), {})).toEqual({
      state: "missing",
    });
    expect(
      orderInventoryMatch(relicOrder("exceptional"), [relicRow("Silver", 1)], relicCatalog(), {}),
    ).toEqual({
      state: "match",
    });
  });

  it("matches an intact listing to the bronze projection", () => {
    const intactOwned = [relicRow("Bronze", 4)];
    expect(orderInventoryMatch(relicOrder("intact"), intactOwned, relicCatalog(), {})).toEqual({
      state: "match",
    });
    expect(
      orderInventoryMatch(relicOrder("intact"), [relicRow("Gold", 4)], relicCatalog(), {}),
    ).toEqual({
      state: "missing",
    });
  });

  it("still reads a quality-suffixed display name when no uniqueName is present", () => {
    const radiantOwned = [parsedItem({ name: "Axi A1 Relic (Radiant)", amount: 2 })];
    expect(orderInventoryMatch(relicOrder("radiant"), radiantOwned, relicCatalog(), {})).toEqual({
      state: "match",
    });
  });

  it("lets a subtype-less relic listing match any refinement", () => {
    const radiantOwned = [relicRow("Platinum", 1)];
    expect(orderInventoryMatch(relicOrder(null), radiantOwned, relicCatalog(), {})).toEqual({
      state: "match",
    });
  });

  it("backs a frame part listing with the blueprint alone, not the crafted part", () => {
    const inventory = [craftedPart(3), tradableBlueprint(1)];
    expect(
      orderInventoryMatch(framePartOrder({ quantity: 3 }), inventory, framePartCatalog(), {}),
    ).toEqual({ state: "partial", owned: 1, listed: 3 });
  });

  it("has no opinion on a mod variant the inventory cannot tell apart", () => {
    const inventory = [
      parsedItem({ name: "Spectral Serration", amount: 4, inventoryGroup: "mods" }),
    ];
    expect(
      orderInventoryMatch(atragraphOrder({ quantity: 9 }), inventory, catalog(PART_REF), {}),
    ).toEqual({ state: "match" });
  });

  it("still backs a regular mod listing from the inventory", () => {
    const inventory = [
      parsedItem({ name: "Spectral Serration", amount: 1, inventoryGroup: "mods" }),
    ];
    expect(
      orderInventoryMatch(
        atragraphOrder({ subtype: "regular", quantity: 4 }),
        inventory,
        catalog(PART_REF),
        {},
      ),
    ).toEqual({ state: "partial", owned: 1, listed: 4 });
  });

  it("flags a listing the inventory only partly backs", () => {
    const listing = order({ quantity: 10 });
    expect(
      orderInventoryMatch(listing, [parsedItem({ amount: 1 })], catalog(PART_REF), {}),
    ).toEqual({ state: "partial", owned: 1, listed: 10 });
  });

  it("sums the rows that back one listing before calling it short", () => {
    const listing = order({ quantity: 4 });
    const inventory = [parsedItem({ amount: 3 }), parsedItem({ amount: 1 })];
    expect(orderInventoryMatch(listing, inventory, catalog(PART_REF), {})).toEqual({
      state: "match",
    });
  });

  it("counts only the copies at the listed rank towards a ranked listing", () => {
    const listing = order({ itemName: "Serration", modRank: 10, quantity: 3 });
    const inventory = [mod("Serration", 0), mod("Serration", 10)];
    expect(orderInventoryMatch(listing, inventory, catalog(PART_REF), {})).toEqual({
      state: "partial",
      owned: 1,
      listed: 3,
    });
  });

  it("accepts a ranked listing backed by a copy at that rank", () => {
    const listing = order({ itemName: "Serration", modRank: 10 });
    const inventory = [mod("Serration", 0), mod("Serration", 10)];
    expect(orderInventoryMatch(listing, inventory, catalog(PART_REF), {})).toEqual({
      state: "match",
    });
  });

  it("reports the owned rank when no copy sits at the listed rank", () => {
    const listing = order({ itemName: "Serration", modRank: 10 });
    expect(orderInventoryMatch(listing, [mod("Serration", 5)], catalog(PART_REF), {})).toEqual({
      state: "rank-mismatch",
      ownedRank: 5,
    });
  });

  it("ignores rank for a group that does not carry one", () => {
    const listing = order({ modRank: 3 });
    const inventory = [parsedItem({ inventoryGroup: "all_parts", rank: 0 })];
    expect(orderInventoryMatch(listing, inventory, catalog(PART_REF), {})).toEqual({
      state: "match",
    });
  });
});

function arcane(rank: number, amount: number): ParsedItem {
  return parsedItem({ name: "Arcane Energize", rank, amount, inventoryGroup: "arcanes" });
}

function arcaneOrder(overrides: Partial<WfmOrder>): WfmOrder {
  return order({
    itemName: "Arcane Energize",
    itemUrlName: "arcane_energize",
    ...overrides,
  });
}

describe("planQuantitySync", () => {
  it("moves a listing to the owned count", () => {
    const listing = order({ quantity: 1 });
    expect(planQuantitySync([listing], [parsedItem({ amount: 3 })])).toEqual({
      updates: [{ order: listing, quantity: 3 }],
      unchanged: 0,
      unbacked: 0,
      belowPerTrade: 0,
    });
  });

  it("counts a listing already at the owned count as unchanged", () => {
    const listing = order({ quantity: 3 });
    expect(planQuantitySync([listing], [parsedItem({ amount: 3 })])).toEqual({
      updates: [],
      unchanged: 1,
      unbacked: 0,
      belowPerTrade: 0,
    });
  });

  it("never zeroes a listing the inventory cannot prove", () => {
    const listing = order({ itemName: "Ash Prime Systems", quantity: 4 });
    expect(planQuantitySync([listing], [])).toEqual({
      updates: [],
      unchanged: 0,
      unbacked: 1,
      belowPerTrade: 0,
    });
  });

  it("leaves buy orders out of the plan entirely", () => {
    const listing = order({ orderType: "buy", quantity: 1 });
    expect(planQuantitySync([listing], [parsedItem({ amount: 3 })])).toEqual({
      updates: [],
      unchanged: 0,
      unbacked: 0,
      belowPerTrade: 0,
    });
  });

  it("counts only the copies at the listed rank for a ranked arcane", () => {
    const listing = arcaneOrder({ modRank: 3, quantity: 1 });
    expect(planQuantitySync([listing], [arcane(0, 7), arcane(3, 4)])).toEqual({
      updates: [{ order: listing, quantity: 4 }],
      unchanged: 0,
      unbacked: 0,
      belowPerTrade: 0,
    });
  });

  it("treats a rank nothing sits at as unbacked rather than zero", () => {
    const listing = arcaneOrder({ modRank: 5, quantity: 2 });
    expect(planQuantitySync([listing], [arcane(0, 7)])).toEqual({
      updates: [],
      unchanged: 0,
      unbacked: 1,
      belowPerTrade: 0,
    });
  });

  it("skips a bulk listing the owned count would drop below its own perTrade", () => {
    const listing = order({ quantity: 12, perTrade: 6 });
    expect(planQuantitySync([listing], [parsedItem({ amount: 3 })])).toEqual({
      updates: [],
      unchanged: 0,
      unbacked: 0,
      belowPerTrade: 1,
    });
  });

  it("still lowers a bulk listing to a quantity its perTrade allows", () => {
    const listing = order({ quantity: 12, perTrade: 3 });
    expect(planQuantitySync([listing], [parsedItem({ amount: 3 })])).toEqual({
      updates: [{ order: listing, quantity: 3 }],
      unchanged: 0,
      unbacked: 0,
      belowPerTrade: 0,
    });
  });

  it("ignores a perTrade above the listed quantity, as warframe.market clamps it", () => {
    const listing = order({ quantity: 2, perTrade: 9 });
    expect(planQuantitySync([listing], [parsedItem({ amount: 3 })])).toEqual({
      updates: [{ order: listing, quantity: 3 }],
      unchanged: 0,
      unbacked: 0,
      belowPerTrade: 0,
    });
  });

  it("never plans a quantity under the listing's perTrade", () => {
    const listings = [
      order({ id: "a".repeat(24), quantity: 12, perTrade: 6 }),
      order({ id: "b".repeat(24), quantity: 12, perTrade: 2 }),
    ];
    const plan = planQuantitySync(listings, [parsedItem({ amount: 3 })]);
    for (const update of plan.updates) {
      expect(update.quantity).toBeGreaterThanOrEqual(update.order.perTrade ?? 1);
    }
    expect(plan.updates).toHaveLength(1);
    expect(plan.belowPerTrade).toBe(1);
  });

  it("sums the rows that back one unranked listing", () => {
    const listing = order({ quantity: 2 });
    const inventory = [parsedItem({ amount: 3 }), parsedItem({ amount: 1 })];
    expect(planQuantitySync([listing], inventory)).toEqual({
      updates: [{ order: listing, quantity: 4 }],
      unchanged: 0,
      unbacked: 0,
      belowPerTrade: 0,
    });
  });

  it("still counts the only row it has when the catalog files it elsewhere", () => {
    const listing = framePartOrder({ quantity: 1 });
    const inventory = [craftedPart(4)];
    expect(planQuantitySync([listing], inventory, framePartCatalog())).toEqual({
      updates: [{ order: listing, quantity: 4 }],
      unchanged: 0,
      unbacked: 0,
      belowPerTrade: 0,
    });
  });

  it("sends the tradable blueprint count, not the crafted parts beside it", () => {
    const listing = framePartOrder({ quantity: 1 });
    const inventory = [craftedPart(3), tradableBlueprint(1)];
    expect(planQuantitySync([listing], inventory, framePartCatalog())).toEqual({
      updates: [],
      unchanged: 1,
      unbacked: 0,
      belowPerTrade: 0,
    });
  });

  it("leaves an Atragraph listing alone rather than counting ordinary copies", () => {
    const listing = atragraphOrder({ quantity: 1 });
    const inventory = [
      parsedItem({ name: "Spectral Serration", amount: 4, inventoryGroup: "mods" }),
    ];
    expect(planQuantitySync([listing], inventory)).toEqual({
      updates: [],
      unchanged: 0,
      unbacked: 0,
      belowPerTrade: 0,
    });
  });

  it("keeps a listing the inventory cannot model out of the no-copies count", () => {
    const atragraph = atragraphOrder({ id: "4".repeat(24), quantity: 1 });
    const missing = order({
      id: "5".repeat(24),
      itemName: "Ash Prime Systems",
      itemUrlName: "ash_prime_systems",
      quantity: 2,
    });
    const inventory = [
      parsedItem({ name: "Spectral Serration", amount: 4, inventoryGroup: "mods" }),
    ];
    expect(planQuantitySync([atragraph, missing], inventory)).toEqual({
      updates: [],
      unchanged: 0,
      unbacked: 1,
      belowPerTrade: 0,
    });
  });

  it("reports each bucket across a mixed selection", () => {
    const grow = order({ id: "1".repeat(24), quantity: 1 });
    const steady = arcaneOrder({ id: "2".repeat(24), modRank: 3, quantity: 4 });
    const unknown = order({
      id: "3".repeat(24),
      itemName: "Ash Prime Systems",
      itemUrlName: "ash_prime_systems",
    });
    const inventory = [parsedItem({ amount: 3 }), arcane(3, 4)];
    expect(planQuantitySync([grow, steady, unknown], inventory)).toEqual({
      updates: [{ order: grow, quantity: 3 }],
      unchanged: 1,
      unbacked: 1,
      belowPerTrade: 0,
    });
  });
});
