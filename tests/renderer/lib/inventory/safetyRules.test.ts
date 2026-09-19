import { describe, expect, it } from "vitest";

import { withoutFoundryPending } from "../../../../config/shared/foundryPending.js";
import { aggregateComponentOwnership } from "../../../../config/shared/componentOwnership.js";
import { ownedComponentCount } from "../../../../config/shared/componentNames.js";
import {
  DEFAULT_SAFETY_SETTINGS,
  SAFETY_REASON_KEYS,
  buildSafetyContext,
  normalizeSafetySettings,
  reserveUnitsToCopies,
  safeToList,
  safetyKeyFor,
  type InventorySafetySettings,
  type SafetyItem,
  type SafetyRuleId,
} from "../../../../src/lib/inventory/safetyRules.js";
import type { ItemDbEntry, ParsedItem } from "../../../../src/types/inventory.js";

const FRAME = "/Lotus/Powersuits/Volt/VoltPrime";
const CHASSIS_COMPONENT = "/Lotus/Types/Recipes/WarframeRecipes/VoltPrimeChassisComponent";
const CHASSIS_BLUEPRINT = "/Lotus/Types/Recipes/WarframeRecipes/VoltPrimeChassisBlueprint";
const NEUROPTICS = "/Lotus/Types/Recipes/WarframeRecipes/VoltPrimeNeuropticsComponent";
const WEAPON_PART = "/Lotus/Types/Recipes/Weapons/WeaponParts/AkbroncoPrimeLink";
const WEAPON_PART_BP = `${WEAPON_PART}Blueprint`;
const MOD = "/Lotus/Upgrades/Mods/Serration";
const FORMA_BP = "/Lotus/Types/Recipes/Components/FormaBlueprint";

const DB: Record<string, ItemDbEntry> = {
  [FRAME]: {
    name: "Volt Prime",
    masterable: true,
    isPrime: true,
    components: [
      { name: "Chassis", uniqueName: CHASSIS_COMPONENT, itemCount: 1 },
      { name: "Neuroptics", uniqueName: NEUROPTICS, itemCount: 2 },
    ],
  },
  [CHASSIS_COMPONENT]: { name: "Chassis", isBuildComponent: true, componentOf: FRAME },
  [NEUROPTICS]: { name: "Neuroptics", isBuildComponent: true, componentOf: FRAME },
  [MOD]: { name: "Serration", category: "Mods", tradable: true },
};

function context(overrides: Partial<Parameters<typeof buildSafetyContext>[0]> = {}) {
  return buildSafetyContext({
    itemDb: DB,
    masteredUniqueNames: new Set<string>(),
    pinnedRequirements: new Map<string, number>(),
    ...overrides,
  });
}

function row(item: Partial<SafetyItem> & { internalName: string }): SafetyItem {
  return item;
}

function ruleQuantity(
  reservations: readonly { rule: SafetyRuleId; quantity: number }[],
  rule: SafetyRuleId,
): number | undefined {
  return reservations.find((entry) => entry.rule === rule)?.quantity;
}

describe("safeToList floors", () => {
  it("keeps the last copy of a masterable item", () => {
    const verdict = safeToList(
      row({ internalName: FRAME, uniqueName: FRAME, amount: 1 }),
      context(),
    );
    expect(verdict).toMatchObject({ total: 1, reserved: 1, safe: 0 });
    expect(ruleQuantity(verdict.reservations, "lastCopy")).toBe(1);
  });

  it("leaves spare copies of a masterable item listable", () => {
    const verdict = safeToList(
      row({ internalName: FRAME, uniqueName: FRAME, amount: 3 }),
      context(),
    );
    expect(verdict).toMatchObject({ total: 3, reserved: 1, safe: 2 });
  });

  it("frees the last copy of a frame that is already mastered", () => {
    const verdict = safeToList(
      row({ internalName: FRAME, uniqueName: FRAME, amount: 1, inventoryGroup: "equipment" }),
      context({ masteredUniqueNames: new Set([FRAME]) }),
    );
    expect(verdict).toMatchObject({ total: 1, reserved: 0, safe: 1 });
    expect(verdict.reservations).toEqual([]);
  });

  it("keeps the last copy while no mastery data has arrived", () => {
    const verdict = safeToList(
      row({ internalName: FRAME, uniqueName: FRAME, amount: 1 }),
      buildSafetyContext({ itemDb: DB, pinnedRequirements: new Map<string, number>() }),
    );
    expect(ruleQuantity(verdict.reservations, "lastCopy")).toBe(1);
  });

  it("does not keep a last copy of a plain mod", () => {
    const verdict = safeToList(
      row({ internalName: MOD, uniqueName: MOD, amount: 4, inventoryGroup: "mods" }),
      context(),
    );
    expect(verdict).toMatchObject({ reserved: 0, safe: 4 });
    expect(verdict.reservations).toEqual([]);
  });

  it("keeps a last copy of any equipment row even without a db entry", () => {
    const verdict = safeToList(
      row({ internalName: "/Unknown/Gear", amount: 2, inventoryGroup: "equipment" }),
      context(),
    );
    expect(verdict).toMatchObject({ reserved: 1, safe: 1 });
  });
});

describe("spares", () => {
  const modRow = row({ internalName: MOD, uniqueName: MOD, amount: 5, inventoryGroup: "mods" });

  it("applies the global default", () => {
    const verdict = safeToList(modRow, context({ settings: settings({ spareDefault: 2 }) }));
    expect(verdict).toMatchObject({ reserved: 2, safe: 3 });
  });

  it("lets a per-item override win over the default", () => {
    const verdict = safeToList(
      modRow,
      context({ settings: settings({ spareDefault: 2, spares: { [MOD]: 4 } }) }),
    );
    expect(verdict).toMatchObject({ reserved: 4, safe: 1 });
  });

  it("honours a per-item override of zero", () => {
    const verdict = safeToList(
      modRow,
      context({ settings: settings({ spareDefault: 3, spares: { [MOD]: 0 } }) }),
    );
    expect(verdict).toMatchObject({ reserved: 0, safe: 5 });
  });

  it("keys the override off safetyKeyFor", () => {
    expect(safetyKeyFor(modRow)).toBe(MOD);
    expect(safetyKeyFor(row({ internalName: `${FRAME}#set` }))).toBe(`${FRAME}#set`);
  });
});

describe("equipped and built", () => {
  it("holds back one copy of an equipped stack, not the pile", () => {
    const verdict = safeToList(
      row({
        internalName: MOD,
        uniqueName: MOD,
        amount: 9,
        inventoryGroup: "mods",
        equipped: true,
      }),
      context(),
    );
    expect(verdict).toMatchObject({ reserved: 1, safe: 8 });
    expect(ruleQuantity(verdict.reservations, "equipped")).toBe(1);
  });

  it("blocks ranked equipment outright", () => {
    const verdict = safeToList(
      row({
        internalName: FRAME,
        uniqueName: FRAME,
        amount: 2,
        inventoryGroup: "equipment",
        rank: 5,
      }),
      context(),
    );
    expect(verdict).toMatchObject({ reserved: 2, safe: 0 });
    expect(verdict.reservations).toContainEqual(
      expect.objectContaining({
        rule: "built",
        reasonKey: "inventory.safety.reason.builtEquipment",
      }),
    );
  });

  it("blocks equipment that only carries a level signal", () => {
    const verdict = safeToList(
      row({
        internalName: FRAME,
        uniqueName: FRAME,
        amount: 1,
        inventoryGroup: "equipment",
        rank: 0,
        leveledUp: true,
      }),
      context(),
    );
    expect(verdict.safe).toBe(0);
  });

  it("leaves unranked equipment listable above the last copy", () => {
    const verdict = safeToList(
      row({
        internalName: FRAME,
        uniqueName: FRAME,
        amount: 3,
        inventoryGroup: "equipment",
        rank: 0,
        leveledUp: false,
      }),
      context(),
    );
    expect(verdict).toMatchObject({ reserved: 1, safe: 2 });
  });

  it("blocks an untradable row with its own reason", () => {
    const verdict = safeToList(
      row({
        internalName: MOD,
        uniqueName: MOD,
        amount: 4,
        inventoryGroup: "mods",
        tradable: false,
      }),
      context(),
    );
    expect(verdict).toMatchObject({ reserved: 4, safe: 0 });
    expect(verdict.reservations).toContainEqual(
      expect.objectContaining({ rule: "built", reasonKey: "inventory.safety.reason.untradable" }),
    );
  });
});

describe("locks", () => {
  it("reserves the whole pile", () => {
    const verdict = safeToList(
      row({ internalName: MOD, uniqueName: MOD, amount: 7, inventoryGroup: "mods" }),
      context({ settings: settings({ locks: [MOD] }) }),
    );
    expect(verdict).toMatchObject({ total: 7, reserved: 7, safe: 0 });
    expect(verdict.reservations).toContainEqual(
      expect.objectContaining({ rule: "lock", binding: true }),
    );
  });

  it("leaves other rows alone", () => {
    const verdict = safeToList(
      row({ internalName: CHASSIS_COMPONENT, uniqueName: CHASSIS_COMPONENT, amount: 2 }),
      context({ settings: settings({ locks: [MOD] }), masteredUniqueNames: new Set([FRAME]) }),
    );
    expect(verdict.safe).toBe(2);
    expect(verdict.reservations).toEqual([]);
  });
});

describe("pinned requirements", () => {
  it("reserves the pinned count", () => {
    const verdict = safeToList(
      row({ internalName: CHASSIS_COMPONENT, uniqueName: CHASSIS_COMPONENT, amount: 5 }),
      context({ pinnedRequirements: new Map([[CHASSIS_COMPONENT, 3]]) }),
    );
    expect(verdict).toMatchObject({ reserved: 3, safe: 2 });
    expect(ruleQuantity(verdict.reservations, "pinnedGoal")).toBe(3);
  });

  it("clamps reserved to what the account holds but keeps the raw ask", () => {
    const verdict = safeToList(
      row({ internalName: CHASSIS_COMPONENT, uniqueName: CHASSIS_COMPONENT, amount: 2 }),
      context({ pinnedRequirements: new Map([[CHASSIS_COMPONENT, 5]]) }),
    );
    expect(verdict).toMatchObject({ total: 2, reserved: 2, safe: 0 });
    expect(verdict.reservations).toContainEqual(
      expect.objectContaining({ rule: "pinnedGoal", quantity: 5, binding: true }),
    );
  });

  it("is degraded, not silently empty, when no pin data is supplied", () => {
    const ctx = buildSafetyContext({ itemDb: DB, masteredUniqueNames: new Set() });
    expect(ctx.degradedRules).toContain("pinnedGoal");
    expect(ctx.degradedRules).not.toContain("unmasteredRecipe");
  });
});

describe("unmastered recipe components", () => {
  it("reserves the parts an unmastered build needs", () => {
    const ctx = context({ masteredUniqueNames: new Set() });
    const chassis = safeToList(
      row({ internalName: CHASSIS_COMPONENT, uniqueName: CHASSIS_COMPONENT, amount: 3 }),
      ctx,
    );
    const neuroptics = safeToList(
      row({ internalName: NEUROPTICS, uniqueName: NEUROPTICS, amount: 5 }),
      ctx,
    );
    expect(chassis).toMatchObject({ reserved: 1, safe: 2 });
    expect(neuroptics).toMatchObject({ reserved: 2, safe: 3 });
  });

  it("releases the parts once the parent is mastered", () => {
    const ctx = context({ masteredUniqueNames: new Set([FRAME]) });
    const verdict = safeToList(
      row({ internalName: CHASSIS_COMPONENT, uniqueName: CHASSIS_COMPONENT, amount: 3 }),
      ctx,
    );
    expect(verdict).toMatchObject({ reserved: 0, safe: 3 });
  });

  it("stays degraded and inert without mastery data", () => {
    const ctx = buildSafetyContext({ itemDb: DB, pinnedRequirements: new Map() });
    expect(ctx.degradedRules).toEqual(["unmasteredRecipe"]);
    expect(
      safeToList(
        row({ internalName: CHASSIS_COMPONENT, uniqueName: CHASSIS_COMPONENT, amount: 3 }),
        ctx,
      ).safe,
    ).toBe(3);
  });
});

describe("recipes above the part", () => {
  const AKBRONCO = "/Lotus/Weapons/Tenno/Akimbo/PrimeAkimboShotGun";
  const BRONCO = "/Lotus/Weapons/Tenno/Pistol/BroncoPrime";
  const RECEIVER = "/Lotus/Types/Recipes/Weapons/WeaponParts/BroncoPrimeReceiver";
  const LINK = "/Lotus/Types/Recipes/Weapons/WeaponParts/AkbroncoPrimeLink";

  // DE lists the doubled ingredient as two entries, exactly as WFCD exports it.
  const CHAIN_DB: Record<string, ItemDbEntry> = {
    [AKBRONCO]: {
      name: "Akbronco Prime",
      masterable: true,
      components: [
        { name: "Link", uniqueName: LINK, itemCount: 1 },
        { name: "Bronco Prime", uniqueName: BRONCO, itemCount: 1 },
        { name: "Bronco Prime", uniqueName: BRONCO, itemCount: 1 },
      ],
    },
    [BRONCO]: {
      name: "Bronco Prime",
      masterable: true,
      components: [{ name: "Receiver", uniqueName: RECEIVER, itemCount: 1 }],
    },
    [RECEIVER]: { name: "Bronco Prime Receiver", isBuildComponent: true, componentOf: BRONCO },
  };

  function chainContext(overrides: Partial<Parameters<typeof buildSafetyContext>[0]> = {}) {
    return buildSafetyContext({
      itemDb: CHAIN_DB,
      masteredUniqueNames: new Set([BRONCO]),
      pinnedRequirements: new Map<string, number>(),
      ...overrides,
    });
  }

  const receiverRow = row({ internalName: RECEIVER, uniqueName: RECEIVER, amount: 3 });

  it("keeps a part claimed two levels up, past a mastered middle weapon", () => {
    const verdict = safeToList(receiverRow, chainContext());
    expect(verdict).toMatchObject({ total: 3, reserved: 2, safe: 1 });
  });

  it("names the whole chain that asks for the copies", () => {
    const claim = safeToList(receiverRow, chainContext()).reservations.find(
      (entry) => entry.rule === "unmasteredRecipe",
    )?.claims?.[0];
    expect(claim).toEqual({ chain: [RECEIVER, BRONCO, AKBRONCO], copies: 2 });
  });

  it("composes the middle weapon's own mastery with the demand above it by max", () => {
    // Summing would give three receivers; the copy ranked for mastery is one of the two.
    const verdict = safeToList(receiverRow, chainContext({ masteredUniqueNames: new Set() }));
    expect(verdict.reserved).toBe(2);
  });

  it("lets a built copy in the arsenal settle one unit of the demand", () => {
    const ownedCounts = aggregateComponentOwnership({ Pistols: [{ ItemType: BRONCO }] });
    expect(safeToList(receiverRow, chainContext({ ownedCounts })).reserved).toBe(1);
  });

  it("does not treat a mastered but sold weapon as owned", () => {
    const sold = chainContext({ ownedUniqueNames: new Set<string>() });
    expect(safeToList(receiverRow, sold).reserved).toBe(2);
    const held = chainContext({ ownedUniqueNames: new Set([BRONCO]) });
    expect(safeToList(receiverRow, held).reserved).toBe(1);
  });

  it("releases the part once nothing above it is outstanding", () => {
    const ctx = chainContext({ masteredUniqueNames: new Set([BRONCO, AKBRONCO]) });
    expect(safeToList(receiverRow, ctx)).toMatchObject({ reserved: 0, safe: 3 });
  });

  it("multiplies a doubled ingredient through the levels below it", () => {
    const doubled: Record<string, ItemDbEntry> = {
      ...CHAIN_DB,
      [BRONCO]: {
        ...CHAIN_DB[BRONCO],
        components: [{ name: "Receiver", uniqueName: RECEIVER, itemCount: 2 }],
      },
    };
    const ctx = buildSafetyContext({
      itemDb: doubled,
      masteredUniqueNames: new Set([BRONCO]),
      pinnedRequirements: new Map(),
    });
    expect(safeToList(row({ internalName: RECEIVER, amount: 9 }), ctx).reserved).toBe(4);
  });
});

describe("recipe demand identity", () => {
  const TOP = "/W/Top";
  const OTHER = "/W/Other";
  const MID = "/Lotus/Types/Recipes/Weapons/WeaponParts/MidComponent";
  const LEAF = "/Lotus/Types/Recipes/Weapons/WeaponParts/LeafComponent";

  it("counts one parent once however many spellings of the part it reaches", () => {
    // The index is written under every alias of MID, so an undeduped read would
    // see the same Top -> Mid link twice and double everything below it.
    const db: Record<string, ItemDbEntry> = {
      [TOP]: { name: "Top", masterable: true, components: [{ name: "Mid", uniqueName: MID }] },
      [MID]: { name: "Mid", components: [{ name: "Leaf", uniqueName: LEAF }] },
    };
    const ctx = buildSafetyContext({
      itemDb: db,
      masteredUniqueNames: new Set(),
      pinnedRequirements: new Map(),
    });
    expect(safeToList(row({ internalName: LEAF, amount: 4 }), ctx).reserved).toBe(1);
  });

  it("sums the demand of two different parents for one part", () => {
    const db: Record<string, ItemDbEntry> = {
      [TOP]: { name: "Top", masterable: true, components: [{ name: "Leaf", uniqueName: LEAF }] },
      [OTHER]: {
        name: "Other",
        masterable: true,
        components: [{ name: "Leaf", uniqueName: LEAF }],
      },
    };
    const ctx = buildSafetyContext({
      itemDb: db,
      masteredUniqueNames: new Set(),
      pinnedRequirements: new Map(),
    });
    const verdict = safeToList(row({ internalName: LEAF, amount: 5 }), ctx);
    expect(verdict.reserved).toBe(2);
    expect(
      verdict.reservations.find((entry) => entry.rule === "unmasteredRecipe")?.claims,
    ).toHaveLength(2);
  });

  it("settles on a demand instead of hanging when two recipes contain each other", () => {
    const db: Record<string, ItemDbEntry> = {
      [TOP]: { name: "Top", masterable: true, components: [{ name: "Other", uniqueName: OTHER }] },
      [OTHER]: {
        name: "Other",
        masterable: true,
        components: [
          { name: "Top", uniqueName: TOP },
          { name: "Leaf", uniqueName: LEAF },
        ],
      },
    };
    const ctx = buildSafetyContext({
      itemDb: db,
      masteredUniqueNames: new Set(),
      pinnedRequirements: new Map(),
    });
    expect(safeToList(row({ internalName: TOP, amount: 2 }), ctx).reserved).toBe(1);
    expect(safeToList(row({ internalName: OTHER, amount: 2 }), ctx).reserved).toBe(1);
    // The truncated branch must not be memoized, or the part under the cycle
    // would read back as unclaimed.
    expect(safeToList(row({ internalName: LEAF, amount: 2 }), ctx).reserved).toBe(1);
  });

  it("keeps one copy of a reusable blueprint however large the demand", () => {
    const db: Record<string, ItemDbEntry> = {
      [TOP]: {
        name: "Top",
        masterable: true,
        components: [{ name: "Leaf", uniqueName: LEAF, itemCount: 4 }],
      },
      [LEAF]: { name: "Leaf Blueprint", reusableBlueprint: true },
    };
    const ctx = buildSafetyContext({
      itemDb: db,
      masteredUniqueNames: new Set(),
      pinnedRequirements: new Map(),
    });
    expect(safeToList(row({ internalName: LEAF, amount: 3 }), ctx)).toMatchObject({
      reserved: 1,
      safe: 2,
    });
  });

  it("divides a multi-yield recipe's demand by what one craft returns", () => {
    const db: Record<string, ItemDbEntry> = {
      [TOP]: {
        name: "Top",
        masterable: true,
        components: [{ name: "Leaf", uniqueName: LEAF, itemCount: 6 }],
      },
      [LEAF]: {
        name: "Leaf Blueprint",
        recipe: { buildPrice: 0, buildTime: 0, num: 3, ingredients: [] },
      },
    };
    const ctx = buildSafetyContext({
      itemDb: db,
      masteredUniqueNames: new Set(),
      pinnedRequirements: new Map(),
    });
    expect(safeToList(row({ internalName: LEAF, amount: 5 }), ctx)).toMatchObject({
      reserved: 2,
      safe: 3,
    });
  });

  it("reuses the recipe walk when only the settings changed", () => {
    const db: Record<string, ItemDbEntry> = {
      [TOP]: { name: "Top", masterable: true, components: [{ name: "Leaf", uniqueName: LEAF }] },
    };
    const mastered = new Set<string>();
    const first = buildSafetyContext({ itemDb: db, masteredUniqueNames: mastered });
    const second = buildSafetyContext({
      itemDb: db,
      masteredUniqueNames: mastered,
      settings: settings({ spareDefault: 2 }),
    });
    expect(second.unmasteredDemand).toBe(first.unmasteredDemand);
    expect(second.recipeClaims).toBe(first.recipeClaims);

    const remastered = buildSafetyContext({ itemDb: db, masteredUniqueNames: new Set([TOP]) });
    expect(remastered.unmasteredDemand).not.toBe(first.unmasteredDemand);
  });

  it("counts a copy the foundry is building as one already owned", () => {
    const db: Record<string, ItemDbEntry> = {
      [TOP]: { name: "Top", masterable: true, components: [{ name: "Leaf", uniqueName: LEAF }] },
    };
    const building = buildSafetyContext({
      itemDb: db,
      masteredUniqueNames: new Set(),
      buildingUniqueNames: new Set([TOP]),
    });
    expect(safeToList(row({ internalName: LEAF, amount: 2 }), building).reserved).toBe(0);
  });

  it("converts a multi-yield parent's outstanding units into crafts", () => {
    const GRAND = "/W/Grand";
    const db: Record<string, ItemDbEntry> = {
      [GRAND]: {
        name: "Grand",
        masterable: true,
        components: [{ name: "Top", uniqueName: TOP, itemCount: 3 }],
      },
      [TOP]: {
        name: "Top",
        recipe: { buildPrice: 0, buildTime: 0, num: 2, ingredients: [] },
        components: [{ name: "Leaf", uniqueName: LEAF }],
      },
    };
    const ctx = buildSafetyContext({ itemDb: db, masteredUniqueNames: new Set() });
    // Three Tops outstanding, two per craft: two crafts, so two leaves.
    expect(safeToList(row({ internalName: LEAF, amount: 5 }), ctx).reserved).toBe(2);
  });

  it("leaves crafting resources out of the demand", () => {
    const CELL = "/Lotus/Types/Items/MiscItems/OrokinCell";
    const db: Record<string, ItemDbEntry> = {
      [TOP]: {
        name: "Top",
        masterable: true,
        components: [
          { name: "Leaf", uniqueName: LEAF },
          { name: "Orokin Cell", uniqueName: CELL, itemCount: 10 },
        ],
      },
    };
    const ctx = buildSafetyContext({ itemDb: db, masteredUniqueNames: new Set() });
    expect(safeToList(row({ internalName: CELL, amount: 30 }), ctx).reserved).toBe(0);
    expect(safeToList(row({ internalName: LEAF, amount: 3 }), ctx).reserved).toBe(1);
  });

  it("merges a doubled part into one claim that matches the reserved count", () => {
    const db: Record<string, ItemDbEntry> = {
      [TOP]: {
        name: "Top",
        masterable: true,
        components: [
          { name: "Leaf", uniqueName: LEAF },
          { name: "Leaf", uniqueName: LEAF },
        ],
      },
    };
    const ctx = buildSafetyContext({ itemDb: db, masteredUniqueNames: new Set() });
    const verdict = safeToList(row({ internalName: LEAF, amount: 5 }), ctx);
    expect(verdict.reserved).toBe(2);
    const claims = verdict.reservations.find((entry) => entry.rule === "unmasteredRecipe")?.claims;
    expect(claims).toEqual([{ chain: [LEAF, TOP], copies: 2 }]);
  });

  it("never lets the claims add up past the reserved count", () => {
    const db: Record<string, ItemDbEntry> = {
      [TOP]: { name: "Top", masterable: true, components: [{ name: "Leaf", uniqueName: LEAF }] },
      [OTHER]: {
        name: "Other",
        masterable: true,
        components: [{ name: "Leaf", uniqueName: LEAF }],
      },
      [LEAF]: {
        name: "Leaf Blueprint",
        recipe: { buildPrice: 0, buildTime: 0, num: 2, ingredients: [] },
      },
    };
    const ctx = buildSafetyContext({ itemDb: db, masteredUniqueNames: new Set() });
    const verdict = safeToList(row({ internalName: LEAF, amount: 4 }), ctx);
    // Two units of demand, two per craft: one copy covers both claims.
    expect(verdict.reserved).toBe(1);
    const claims = verdict.reservations.find((entry) => entry.rule === "unmasteredRecipe")?.claims;
    expect(claims).toHaveLength(1);
    expect(claims?.[0].copies).toBe(1);
  });

  it("walks a full-set override root the item database cannot rebuild", () => {
    const root = "/Lotus/Types/Items/Ships/InsectShip";
    const part = "/Lotus/Types/Recipes/LandingCraftRecipes/Mantys/MantysPowerCoreBlueprint";
    const ctx = buildSafetyContext({
      itemDb: { [root]: { name: "Mantis", masterable: true } },
      masteredUniqueNames: new Set(),
      pinnedRequirements: new Map(),
    });
    expect(safeToList(row({ internalName: part, amount: 2 }), ctx)).toMatchObject({
      reserved: 1,
      safe: 1,
    });
  });
});

describe("complete-set keep flag", () => {
  const settingsWithKeep = settings({ setKeep: [FRAME] });

  it("reserves one assembled set on the set row", () => {
    const verdict = safeToList(
      row({ internalName: `${FRAME}#set`, amount: 3, inventoryGroup: "full_sets" }),
      context({ settings: settingsWithKeep }),
    );
    expect(verdict).toMatchObject({ reserved: 1, safe: 2 });
    expect(ruleQuantity(verdict.reservations, "setKeep")).toBe(1);
  });

  it("reserves each part at its set quantity", () => {
    const ctx = context({ settings: settingsWithKeep });
    expect(
      safeToList(row({ internalName: NEUROPTICS, uniqueName: NEUROPTICS, amount: 4 }), ctx),
    ).toMatchObject({ reserved: 2, safe: 2 });
  });

  it("does nothing without the flag", () => {
    const ctx = context({ masteredUniqueNames: new Set([FRAME]) });
    expect(
      safeToList(row({ internalName: `${FRAME}#set`, amount: 3, inventoryGroup: "full_sets" }), ctx)
        .safe,
    ).toBe(3);
  });
});

describe("full-set rows against their parts", () => {
  const setRow = row({ internalName: `${FRAME}#set`, amount: 2, inventoryGroup: "full_sets" });

  it("holds back the sets its most constrained part cannot cover", () => {
    const ctx = context({
      ownedCounts: new Map([
        [CHASSIS_COMPONENT, 2],
        [NEUROPTICS, 4],
      ]),
    });
    const chassis = safeToList(
      row({ internalName: CHASSIS_COMPONENT, uniqueName: CHASSIS_COMPONENT, amount: 2 }),
      ctx,
    );
    const neuroptics = safeToList(
      row({ internalName: NEUROPTICS, uniqueName: NEUROPTICS, amount: 4 }),
      ctx,
    );
    const set = safeToList(setRow, ctx);

    expect(chassis).toMatchObject({ reserved: 1, safe: 1 });
    expect(neuroptics).toMatchObject({ reserved: 2, safe: 2 });
    expect(set).toMatchObject({ total: 2, reserved: 1, safe: 1 });
    expect(ruleQuantity(set.reservations, "unmasteredRecipe")).toBe(1);
  });

  it("frees the whole set once nothing above its parts is outstanding", () => {
    const ctx = context({ masteredUniqueNames: new Set([FRAME]) });
    expect(safeToList(setRow, ctx)).toMatchObject({ reserved: 0, safe: 2 });
  });
});

describe("renamed part blueprints", () => {
  const AMBASSADOR = "/Lotus/Weapons/Corpus/LongGuns/CrpArSniper/CrpArSniperRifle";
  const RECEIVER = "/Lotus/Types/Recipes/Weapons/WeaponParts/CrpArSniperReceiver";
  const RECEIVER_BP = "/Lotus/Types/Recipes/Weapons/WeaponParts/AmbassadorReceiverBlueprint";

  const renamedDb: Record<string, ItemDbEntry> = {
    [AMBASSADOR]: {
      name: "Ambassador",
      masterable: true,
      components: [{ name: "Receiver", uniqueName: RECEIVER, itemCount: 1 }],
    },
    [RECEIVER]: { name: "Ambassador Receiver", isBuildComponent: true, componentOf: AMBASSADOR },
    [RECEIVER_BP]: {
      name: "Ambassador Receiver Blueprint",
      isBuildComponent: true,
      componentOf: AMBASSADOR,
      buildsProduct: RECEIVER,
    },
  };

  const blueprintRow = row({
    internalName: RECEIVER_BP,
    uniqueName: RECEIVER_BP,
    amount: 2,
  });

  it("reserves a blueprint whose product shares no stem with it", () => {
    const ctx = buildSafetyContext({
      itemDb: renamedDb,
      masteredUniqueNames: new Set(),
      pinnedRequirements: new Map(),
    });
    expect(safeToList(blueprintRow, ctx)).toMatchObject({ total: 2, reserved: 1, safe: 1 });
  });

  it("releases it once the weapon is mastered", () => {
    const ctx = buildSafetyContext({
      itemDb: renamedDb,
      masteredUniqueNames: new Set([AMBASSADOR]),
      pinnedRequirements: new Map(),
    });
    expect(safeToList(blueprintRow, ctx)).toMatchObject({ reserved: 0, safe: 2 });
  });
});

describe("component identity aliases", () => {
  it("matches a Blueprint-form row against a Component-form set entry", () => {
    const ctx = context({ masteredUniqueNames: new Set() });
    const verdict = safeToList(
      row({ internalName: CHASSIS_BLUEPRINT, uniqueName: CHASSIS_BLUEPRINT, amount: 2 }),
      ctx,
    );
    expect(verdict).toMatchObject({ reserved: 1, safe: 1 });
  });

  it("matches a suffixed weapon-part row against the bare set entry", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/AkbroncoPrime": {
        name: "Akbronco Prime",
        masterable: true,
        components: [{ name: "Link", uniqueName: WEAPON_PART, itemCount: 1 }],
      },
    };
    const ctx = buildSafetyContext({
      itemDb: db,
      masteredUniqueNames: new Set(),
      pinnedRequirements: new Map(),
    });
    expect(
      safeToList(row({ internalName: WEAPON_PART_BP, uniqueName: WEAPON_PART_BP, amount: 2 }), ctx)
        .reserved,
    ).toBe(1);
  });

  it("agrees with ownedComponentCount about which pile a spelling names", () => {
    const owned = new Map([[CHASSIS_BLUEPRINT, 4]]);
    expect(ownedComponentCount(CHASSIS_COMPONENT, owned)).toBe(4);
  });
});

describe("recipe yield", () => {
  const yieldingDb: Record<string, ItemDbEntry> = {
    [FORMA_BP]: {
      name: "Forma Blueprint",
      recipe: { buildPrice: 0, buildTime: 0, num: 3, ingredients: [] },
    },
  };

  it("divides required units by what one craft yields", () => {
    expect(reserveUnitsToCopies(3, yieldingDb[FORMA_BP])).toBe(1);
    expect(reserveUnitsToCopies(4, yieldingDb[FORMA_BP])).toBe(2);
    const ctx = buildSafetyContext({
      itemDb: yieldingDb,
      masteredUniqueNames: new Set(),
      pinnedRequirements: new Map([[FORMA_BP, 6]]),
    });
    expect(
      safeToList(row({ internalName: FORMA_BP, uniqueName: FORMA_BP, amount: 5 }), ctx),
    ).toMatchObject({ reserved: 2, safe: 3 });
  });

  it("reserves exactly one copy of a reusable blueprint", () => {
    const db: Record<string, ItemDbEntry> = {
      [FORMA_BP]: { name: "Forma Blueprint", reusableBlueprint: true },
    };
    const ctx = buildSafetyContext({
      itemDb: db,
      masteredUniqueNames: new Set(),
      pinnedRequirements: new Map([[FORMA_BP, 9]]),
    });
    expect(
      safeToList(row({ internalName: FORMA_BP, uniqueName: FORMA_BP, amount: 4 }), ctx),
    ).toMatchObject({ reserved: 1, safe: 3 });
  });

  it("leaves a single-yield recipe alone", () => {
    expect(
      reserveUnitsToCopies(3, { recipe: { buildPrice: 0, buildTime: 0, num: 1, ingredients: [] } }),
    ).toBe(3);
    expect(reserveUnitsToCopies(0, undefined)).toBe(0);
  });
});

describe("foundry-pending totals", () => {
  // The engine reads counts the caller already ran through withoutFoundryPending,
  // so a blueprint handed to the foundry must not read back as listable stock.
  const raw = {
    MiscItems: [],
    Recipes: [{ ItemType: CHASSIS_BLUEPRINT, ItemCount: 3 }],
    PendingRecipes: [{ ItemType: CHASSIS_BLUEPRINT }, { ItemType: CHASSIS_BLUEPRINT }],
  };

  it("follows the reduced count once foundry claims are subtracted", () => {
    const usable = withoutFoundryPending(raw);
    const owned = aggregateComponentOwnership(usable);
    const amount = ownedComponentCount(CHASSIS_COMPONENT, owned);
    expect(amount).toBe(1);

    const ctx = context({ masteredUniqueNames: new Set() });
    expect(
      safeToList(
        row({ internalName: CHASSIS_BLUEPRINT, uniqueName: CHASSIS_BLUEPRINT, amount }),
        ctx,
      ),
    ).toMatchObject({ total: 1, reserved: 1, safe: 0 });
  });

  it("would have called one copy listable on the raw count", () => {
    const owned = aggregateComponentOwnership(raw);
    const ctx = context({ masteredUniqueNames: new Set() });
    expect(
      safeToList(
        row({
          internalName: CHASSIS_BLUEPRINT,
          uniqueName: CHASSIS_BLUEPRINT,
          amount: ownedComponentCount(CHASSIS_COMPONENT, owned),
        }),
        ctx,
      ).safe,
    ).toBe(2);
  });
});

describe("normalizeSafetySettings", () => {
  it("degrades malformed input to the defaults", () => {
    for (const bad of [null, undefined, 7, "nope", [], { spares: 5, locks: "x" }]) {
      expect(normalizeSafetySettings(bad)).toMatchObject({
        spareDefault: 0,
        spares: {},
        locks: [],
        setKeep: [],
      });
    }
  });

  it("drops junk entries and clamps counts", () => {
    expect(
      normalizeSafetySettings({
        spareDefault: -4,
        spares: { [MOD]: 2.7, bad: "x", "": 3, other: Number.NaN },
        locks: [MOD, MOD, 5, "", FRAME],
        setKeep: [FRAME],
      }),
    ).toEqual({
      spareDefault: 0,
      spares: { [MOD]: 2 },
      locks: [MOD, FRAME],
      setKeep: [FRAME],
    });
  });

  it("caps an absurd spare default", () => {
    expect(normalizeSafetySettings({ spareDefault: 1e9 }).spareDefault).toBe(999);
  });

  it("drops prototype key names rather than letting them through", () => {
    const settings = normalizeSafetySettings(
      JSON.parse('{"spares":{"__proto__":4,"constructor":2},"locks":["__proto__"]}'),
    );
    expect(settings.spares).toEqual({});
    expect(settings.locks).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("treats a set part with a zero itemCount as one part, like fullSets", () => {
    const db: Record<string, ItemDbEntry> = {
      [FRAME]: {
        name: "Volt Prime",
        masterable: true,
        components: [{ name: "Chassis", uniqueName: CHASSIS_COMPONENT, itemCount: 0 }],
      },
    };
    const ctx = buildSafetyContext({
      itemDb: db,
      masteredUniqueNames: new Set(),
      pinnedRequirements: new Map(),
    });
    expect(
      safeToList(
        row({ internalName: CHASSIS_COMPONENT, uniqueName: CHASSIS_COMPONENT, amount: 3 }),
        ctx,
      ),
    ).toMatchObject({ reserved: 1, safe: 2 });
  });

  it("is idempotent over its own output", () => {
    const once = normalizeSafetySettings({ spareDefault: 2, locks: [MOD] });
    expect(normalizeSafetySettings(once)).toEqual(once);
    expect(normalizeSafetySettings(DEFAULT_SAFETY_SETTINGS)).toEqual(DEFAULT_SAFETY_SETTINGS);
  });
});

describe("verdict shape", () => {
  it("never reserves more than the row holds and marks the binding rule", () => {
    const verdict = safeToList(
      row({ internalName: FRAME, uniqueName: FRAME, amount: 4, inventoryGroup: "equipment" }),
      context({ settings: settings({ spareDefault: 2 }) }),
    );
    expect(verdict.reserved).toBe(2);
    expect(verdict.safe).toBe(verdict.total - verdict.reserved);
    expect(
      verdict.reservations.filter((entry) => entry.binding).map((entry) => entry.rule),
    ).toEqual(["spare"]);
  });

  it("marks every rule that ties for the highest floor", () => {
    const verdict = safeToList(
      row({
        internalName: MOD,
        uniqueName: MOD,
        amount: 4,
        inventoryGroup: "mods",
        equipped: true,
      }),
      context({ settings: settings({ spareDefault: 1 }) }),
    );
    expect(verdict.reserved).toBe(1);
    expect(
      verdict.reservations.filter((entry) => entry.binding).map((entry) => entry.rule),
    ).toEqual(["equipped", "spare"]);
  });

  it("treats a row with no amount as a single copy", () => {
    const ctx = context({ masteredUniqueNames: new Set([FRAME]) });
    expect(safeToList(row({ internalName: MOD, uniqueName: MOD }), ctx)).toMatchObject({
      total: 1,
      reserved: 0,
      safe: 1,
    });
    expect(safeToList(row({ internalName: MOD, uniqueName: MOD, amount: null }), ctx).total).toBe(
      1,
    );
  });

  it("clamps a nonsense amount instead of producing a negative verdict", () => {
    const ctx = context({ masteredUniqueNames: new Set([FRAME]) });
    for (const amount of [-5, Number.NaN, Number.POSITIVE_INFINITY, 2.7]) {
      const verdict = safeToList(
        row({ internalName: MOD, uniqueName: MOD, amount }),
        context({ settings: settings({ spareDefault: 3 }), masteredUniqueNames: new Set([FRAME]) }),
      );
      expect(verdict.total).toBeGreaterThanOrEqual(0);
      expect(verdict.reserved).toBeLessThanOrEqual(verdict.total);
      expect(verdict.safe).toBe(verdict.total - verdict.reserved);
    }
    expect(safeToList(row({ internalName: MOD, uniqueName: MOD, amount: 2.7 }), ctx).total).toBe(2);
  });

  it("only emits reason keys the dictionary handoff lists", () => {
    const ctx = context({
      settings: settings({ locks: [MOD] }),
      masteredUniqueNames: new Set(),
      pinnedRequirements: new Map([[CHASSIS_COMPONENT, 2]]),
    });
    const rows: SafetyItem[] = [
      row({
        internalName: MOD,
        uniqueName: MOD,
        amount: 3,
        inventoryGroup: "mods",
        equipped: true,
      }),
      row({
        internalName: FRAME,
        uniqueName: FRAME,
        amount: 1,
        inventoryGroup: "equipment",
        rank: 3,
      }),
      row({ internalName: CHASSIS_COMPONENT, uniqueName: CHASSIS_COMPONENT, amount: 4 }),
    ];
    for (const entry of rows) {
      for (const reservation of safeToList(entry, ctx).reservations) {
        expect(SAFETY_REASON_KEYS).toContain(reservation.reasonKey);
      }
    }
  });

  it("treats a ParsedItem as a SafetyItem without adaptation", () => {
    const parsed: ParsedItem = {
      name: "Serration",
      internalName: MOD,
      uniqueName: MOD,
      category: "mods",
      categoryLabel: "Mod",
      rank: 0,
      maxRank: 10,
      imageUrl: null,
      isPrime: false,
      masteryReq: 0,
      vaulted: false,
      tradable: true,
      description: "",
      components: [],
      drops: [],
      wikiaUrl: null,
      amount: 6,
      inventoryGroup: "mods",
    };
    expect(safeToList(parsed, context({ settings: settings({ spareDefault: 1 }) }))).toMatchObject({
      total: 6,
      reserved: 1,
      safe: 5,
    });
  });
});

function settings(overrides: Partial<InventorySafetySettings>): InventorySafetySettings {
  return { ...DEFAULT_SAFETY_SETTINGS, ...overrides };
}
