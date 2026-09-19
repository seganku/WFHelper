import { describe, expect, it } from "vitest";

import {
  buildMasteryRoadmap,
  componentMarketSlug,
  componentPartState,
  estimateMasteryPurchaseCost,
  masteryBuildReadiness,
  masteryCraftableCount,
  masteryPartCounts,
  masteryPartRows,
  type MasteryRoadmapSourceItem,
} from "../../../src/lib/masteryRoadmap.js";
import type { ComponentInfo, ItemDbEntry } from "../../../src/types/inventory.js";
import type { OwnedCounts, RelicDatabase, RelicReward } from "../../../src/types/relics.js";

function item(overrides: Partial<MasteryRoadmapSourceItem>): MasteryRoadmapSourceItem {
  return {
    name: "Item",
    internalName: "/Item",
    imageUrl: null,
    category: "Primary",
    categoryLabel: "Primary",
    status: "missing",
    rank: 0,
    maxRank: 30,
    isPrime: false,
    masteryReq: 0,
    vaulted: false,
    tradable: true,
    description: "",
    masteryXpRemaining: 3_000,
    platinum: null,
    estimatedCost: null,
    owned: false,
    foundryState: undefined,
    components: [],
    drops: [],
    wikiaUrl: null,
    ...overrides,
  };
}

function relicInventory(
  rewards: RelicReward[],
  count: number,
): { db: RelicDatabase; owned: OwnedCounts } {
  return {
    db: {
      groups: {
        "Lith T1": {
          key: "Lith T1",
          name: "Lith T1",
          tier: "Lith",
          code: "T1",
          imageUrl: null,
          qualities: { intact: { uniqueName: "/Relic", rewards } },
        },
      },
      byUniqueName: {},
    },
    owned: {
      "Lith T1": { intact: count, exceptional: 0, flawless: 0, radiant: 0 },
    },
  };
}

function reward(name: string, uniqueName: string, chance: number): RelicReward {
  return { name, uniqueName, chance, rarity: "Common", urlName: null, ducats: null };
}

describe("buildMasteryRoadmap", () => {
  it("orders directly actionable items before Foundry actions", () => {
    const roadmap = buildMasteryRoadmap([
      item({ name: "Buildable", foundryState: "buildable" }),
      item({ name: "Claimable", foundryState: "claimable" }),
      item({ name: "Owned", status: "progress", owned: true }),
    ]);

    expect(roadmap.easy.map((entry) => entry.name)).toEqual(["Owned", "Claimable", "Buildable"]);
  });

  it("tells an ungilded modular build to gild before levelling", () => {
    const roadmap = buildMasteryRoadmap([
      item({ name: "Claimable", foundryState: "claimable" }),
      item({ name: "Mote Prism", status: "progress", owned: true, needsGilding: true }),
      item({ name: "Owned", status: "progress", owned: true }),
    ]);

    expect(roadmap.easy.map((entry) => [entry.name, entry.access])).toEqual([
      ["Owned", "owned"],
      ["Mote Prism", "gild"],
      ["Claimable", "claimable"],
    ]);
  });

  it("recommends claiming an item whose remaining parts all sit in the Foundry", () => {
    const roadmap = buildMasteryRoadmap([
      item({
        name: "Nekros",
        estimatedCost: 30,
        components: [
          { name: "Blueprint", itemCount: 1, ownedCount: 1, owned: true },
          { name: "Neuroptics", itemCount: 1, ownedCount: 0, building: true },
          { name: "Chassis", itemCount: 1, ownedCount: 0, building: true },
          { name: "Systems", itemCount: 1, ownedCount: 0, building: true },
          { name: "Orokin Cell", itemCount: 3, ownedCount: 3 },
        ],
      }),
    ]);

    expect(roadmap.easy.map((entry) => [entry.name, entry.access])).toEqual([
      ["Nekros", "foundryParts"],
    ]);
    expect(roadmap.platinum).toEqual([]);
  });

  it("does not call a set buildable while its parts are only held as blueprints", () => {
    const roadmap = buildMasteryRoadmap([
      item({
        name: "Baruuk",
        foundryState: "buildable",
        components: [
          { name: "Blueprint", itemCount: 1, ownedCount: 1, owned: true },
          { name: "Neuroptics", itemCount: 1, ownedCount: 1, owned: true, blueprintHeld: true },
          { name: "Chassis", itemCount: 1, ownedCount: 1, owned: true, blueprintHeld: true },
          { name: "Systems", itemCount: 1, ownedCount: 1, owned: true, blueprintHeld: true },
          { name: "Orokin Cell", itemCount: 3, ownedCount: 3, owned: true },
        ],
      }),
    ]);

    expect(roadmap.easy.map((entry) => [entry.name, entry.access])).toEqual([
      ["Baruuk", "craftParts"],
    ]);
  });

  it("still calls a set buildable once every part is built", () => {
    const roadmap = buildMasteryRoadmap([
      item({
        name: "Baruuk",
        foundryState: "buildable",
        components: [
          { name: "Blueprint", itemCount: 1, ownedCount: 1, owned: true },
          { name: "Neuroptics", itemCount: 1, ownedCount: 1, owned: true },
          { name: "Chassis", itemCount: 1, ownedCount: 1, owned: true },
          { name: "Systems", itemCount: 1, ownedCount: 1, owned: true },
        ],
      }),
    ]);

    expect(roadmap.easy.map((entry) => [entry.name, entry.access])).toEqual([
      ["Baruuk", "buildable"],
    ]);
  });

  it("keeps a set waiting on crafted parts between the Foundry and Market states", () => {
    const roadmap = buildMasteryRoadmap([
      item({
        name: "Mag",
        marketBuyable: true,
        marketCredits: 25_000,
        components: [{ name: "Blueprint", itemCount: 1, ownedCount: 0 }],
      }),
      item({
        name: "Baruuk",
        components: [
          { name: "Blueprint", itemCount: 1, ownedCount: 1, owned: true },
          { name: "Systems", itemCount: 1, ownedCount: 1, owned: true, blueprintHeld: true },
        ],
      }),
      item({
        name: "Nekros",
        components: [{ name: "Neuroptics", itemCount: 1, ownedCount: 0, building: true }],
      }),
    ]);

    expect(roadmap.easy.map((entry) => [entry.name, entry.access])).toEqual([
      ["Nekros", "foundryParts"],
      ["Baruuk", "craftParts"],
      ["Mag", "marketBlueprint"],
    ]);
  });

  it("keeps an item with a short build resource out of the Foundry recommendation", () => {
    const roadmap = buildMasteryRoadmap([
      item({
        name: "Nekros",
        components: [
          { name: "Neuroptics", itemCount: 1, ownedCount: 0, building: true },
          { name: "Orokin Cell", itemCount: 3, ownedCount: 1 },
        ],
      }),
    ]);

    expect(roadmap.easy).toEqual([]);
  });

  it("still skips a mastered item whose parts sit in the Foundry", () => {
    const roadmap = buildMasteryRoadmap([
      item({
        name: "Mastered",
        status: "mastered",
        components: [{ name: "Neuroptics", itemCount: 1, ownedCount: 0, building: true }],
      }),
    ]);

    expect(roadmap.easy).toEqual([]);
  });

  it("offers a Market blueprint after everything the Foundry can already finish", () => {
    const roadmap = buildMasteryRoadmap([
      item({
        name: "Mag",
        marketBuyable: true,
        marketCredits: 25_000,
        components: [{ name: "Blueprint", itemCount: 1, ownedCount: 0 }],
      }),
      item({ name: "Claimable", foundryState: "claimable" }),
      item({
        name: "Nekros",
        components: [{ name: "Neuroptics", itemCount: 1, ownedCount: 0, building: true }],
      }),
    ]);

    expect(roadmap.easy.map((entry) => [entry.name, entry.access])).toEqual([
      ["Claimable", "claimable"],
      ["Nekros", "foundryParts"],
      ["Mag", "marketBlueprint"],
    ]);
    expect(roadmap.easy[2].marketCredits).toBe(25_000);
  });

  it("leaves a Market item alone while a part other than the blueprint is missing", () => {
    const roadmap = buildMasteryRoadmap([
      item({
        name: "Mag",
        marketBuyable: true,
        marketCredits: 25_000,
        components: [
          { name: "Blueprint", itemCount: 1, ownedCount: 0 },
          { name: "Chassis", itemCount: 1, ownedCount: 0 },
        ],
      }),
    ]);

    expect(roadmap.easy).toEqual([]);
  });

  it("keeps a Market blueprint with no listed price", () => {
    const roadmap = buildMasteryRoadmap([
      item({
        name: "Unpriced",
        marketBuyable: true,
        components: [{ name: "Blueprint", itemCount: 1, ownedCount: 0 }],
      }),
    ]);

    expect(roadmap.easy.map((entry) => entry.access)).toEqual(["marketBlueprint"]);
    expect(roadmap.easy[0].marketCredits).toBeUndefined();
  });

  it("prefers an owned item over its Market blueprint", () => {
    const roadmap = buildMasteryRoadmap([
      item({ name: "Ash", status: "progress", owned: true, marketBuyable: true, marketCredits: 1 }),
    ]);

    expect(roadmap.easy.map((entry) => entry.access)).toEqual(["owned"]);
  });

  it("skips a mastered item that is still sold in the Market", () => {
    const roadmap = buildMasteryRoadmap([
      item({ name: "Mastered", status: "mastered", marketBuyable: true, marketCredits: 15_000 }),
    ]);

    expect(roadmap.easy).toEqual([]);
    expect(roadmap.relics).toEqual([]);
    expect(roadmap.platinum).toEqual([]);
  });

  it("carries the dojo research tag into every tab", () => {
    const { db, owned } = relicInventory([reward("Kompressa Part", "/Part", 100)], 1);
    const roadmap = buildMasteryRoadmap(
      [
        item({
          name: "Kompressa",
          dojoResearch: true,
          platinum: 20,
          estimatedCost: 20,
          components: [{ name: "Part", uniqueName: "/Part" }],
        }),
        item({ name: "Dera", dojoResearch: true, status: "progress", owned: true }),
      ],
      db,
      owned,
    );

    expect(roadmap.easy[0].dojoResearch).toBe(true);
    expect(roadmap.relics[0].dojoResearch).toBe(true);
    expect(roadmap.platinum[0].dojoResearch).toBe(true);
  });

  it("gives a Market blueprint that is also dojo research one access state and the tag", () => {
    const roadmap = buildMasteryRoadmap([
      item({
        name: "Both",
        marketBuyable: true,
        marketCredits: 30_000,
        dojoResearch: true,
        components: [{ name: "Blueprint", itemCount: 1, ownedCount: 0 }],
      }),
    ]);

    expect(roadmap.easy).toHaveLength(1);
    expect(roadmap.easy[0].access).toBe("marketBlueprint");
    expect(roadmap.easy[0].dojoResearch).toBe(true);
  });

  it("leaves an item DE does not sell out of the Market state", () => {
    const roadmap = buildMasteryRoadmap([item({ name: "Dread", dojoResearch: true })]);

    expect(roadmap.easy).toEqual([]);
  });

  it("carries the mastery requirement into every tab", () => {
    const { db, owned } = relicInventory([reward("Kompressa Part", "/Part", 100)], 1);
    const roadmap = buildMasteryRoadmap(
      [
        item({
          name: "Kompressa",
          masteryReq: 13,
          platinum: 20,
          estimatedCost: 20,
          components: [{ name: "Part", uniqueName: "/Part" }],
        }),
        item({ name: "Owned", masteryReq: 5, status: "progress", owned: true }),
      ],
      db,
      owned,
    );

    expect(roadmap.easy[0].masteryReq).toBe(5);
    expect(roadmap.relics[0].masteryReq).toBe(13);
    expect(roadmap.platinum[0].masteryReq).toBe(13);
  });

  it("ranks purchases by remaining XP per platinum", () => {
    const roadmap = buildMasteryRoadmap([
      item({ name: "Efficient", platinum: 10, estimatedCost: 10, masteryXpRemaining: 3_000 }),
      item({ name: "Expensive", platinum: 40, estimatedCost: 40, masteryXpRemaining: 6_000 }),
    ]);

    expect(roadmap.platinum.map((entry) => entry.name)).toEqual(["Efficient", "Expensive"]);
    expect(roadmap.platinum[0].xpPerPlatinum).toBe(300);
  });

  it("excludes mastered, unpriced, and already actionable items from purchases", () => {
    const roadmap = buildMasteryRoadmap([
      item({ name: "Mastered", status: "mastered", platinum: 5, estimatedCost: 5 }),
      item({ name: "Unpriced" }),
      item({ name: "Owned", owned: true, platinum: 5, estimatedCost: 5 }),
    ]);

    expect(roadmap.platinum).toEqual([]);
    expect(roadmap.easy.map((entry) => entry.name)).toEqual(["Owned"]);
  });

  it("does not treat sold partial-progress items as owned", () => {
    const roadmap = buildMasteryRoadmap([
      item({
        name: "Sold Partial",
        status: "progress",
        currentlyOwned: false,
        platinum: 10,
        estimatedCost: 10,
      }),
    ]);

    expect(roadmap.easy).toEqual([]);
    expect(roadmap.platinum.map((entry) => entry.name)).toEqual(["Sold Partial"]);
  });

  it("calculates the exact chance of getting every missing part from owned relics", () => {
    const { db, owned } = relicInventory(
      [reward("Item Part A", "/PartA", 50), reward("Item Part B", "/PartB", 50)],
      2,
    );
    const roadmap = buildMasteryRoadmap(
      [
        item({
          components: [
            { name: "Part A", uniqueName: "/PartA" },
            { name: "Part B", uniqueName: "/PartB" },
          ],
        }),
      ],
      db,
      owned,
    );

    expect(roadmap.relics).toHaveLength(1);
    expect(roadmap.relics[0].relicProbability).toBeCloseTo(0.5);
    expect(roadmap.relics[0].relevantRelicCount).toBe(2);
  });

  it("ignores owned parts and orders relic recommendations by completion chance", () => {
    const { db, owned } = relicInventory(
      [reward("Low Part", "/Low", 20), reward("High Part", "/High", 50)],
      1,
    );
    const roadmap = buildMasteryRoadmap(
      [
        item({ name: "Low", components: [{ name: "Part", uniqueName: "/Low" }] }),
        item({
          name: "High",
          components: [
            { name: "Already owned", uniqueName: "/Unavailable", owned: true },
            { name: "Part", uniqueName: "/High" },
          ],
        }),
      ],
      db,
      owned,
    );

    expect(roadmap.relics.map((entry) => entry.name)).toEqual(["High", "Low"]);
    expect(roadmap.relics.map((entry) => entry.relicProbability)).toEqual([0.5, 0.2]);
  });

  it("omits items when owned relics cannot supply every missing copy", () => {
    const { db, owned } = relicInventory([reward("Item Part", "/Part", 100)], 1);
    const roadmap = buildMasteryRoadmap(
      [item({ components: [{ name: "Part", uniqueName: "/Part", itemCount: 2 }] })],
      db,
      owned,
    );

    expect(roadmap.relics).toEqual([]);
  });

  it("matches parent-prefixed relic rewards when component paths are unavailable", () => {
    const { db, owned } = relicInventory([reward("Boar Prime Blueprint", "", 100)], 1);
    const roadmap = buildMasteryRoadmap(
      [item({ name: "Boar Prime", components: [{ name: "Blueprint" }] })],
      db,
      owned,
    );

    expect(roadmap.relics[0]?.relicProbability).toBe(1);
  });
});

describe("masteryPartCounts", () => {
  const countOf = (components: ComponentInfo[]) =>
    masteryPartCounts(components.map(componentPartState));

  it("counts every part as owned when the set is fully built", () => {
    expect(
      countOf([
        { name: "Blueprint", itemCount: 1, ownedCount: 1, owned: true },
        { name: "Neuroptics", itemCount: 1, ownedCount: 1, owned: true },
        { name: "Chassis", itemCount: 1, ownedCount: 1, owned: true },
      ]),
    ).toEqual({ total: 3, built: 3, craftable: 0 });
  });

  it("splits parts held only as blueprints out of the owned count", () => {
    expect(
      countOf([
        { name: "Blueprint", itemCount: 1, ownedCount: 1, owned: true },
        { name: "Neuroptics", itemCount: 1, ownedCount: 1, owned: true, blueprintHeld: true },
        { name: "Chassis", itemCount: 1, ownedCount: 1, owned: true, blueprintHeld: true },
        { name: "Systems", itemCount: 1, ownedCount: 1, owned: true, blueprintHeld: true },
        { name: "Orokin Cell", itemCount: 3, ownedCount: 3 },
      ]),
    ).toEqual({ total: 5, built: 2, craftable: 3 });
  });

  it("leaves missing parts out of both counts", () => {
    expect(
      countOf([
        { name: "Blueprint", itemCount: 1, ownedCount: 1, owned: true },
        { name: "Barrel", itemCount: 2, ownedCount: 1 },
        { name: "Receiver", itemCount: 1, ownedCount: 0, building: true },
      ]),
    ).toEqual({ total: 3, built: 1, craftable: 0 });
  });

  it("reads a part covered by its count alone as held for the counts and the readiness", () => {
    const components: ComponentInfo[] = [
      { name: "Blueprint", itemCount: 1, ownedCount: 1 },
      { name: "Systems", itemCount: 1, ownedCount: 1, blueprintHeld: true },
    ];

    expect(countOf(components)).toEqual({ total: 2, built: 1, craftable: 1 });
    expect(masteryBuildReadiness(components)).toBe("craftParts");
    expect(
      masteryBuildReadiness([...components, { name: "Barrel", itemCount: 2, ownedCount: 1 }]),
    ).toBe(null);
  });
});

describe("estimateMasteryPurchaseCost", () => {
  it("prices only the last missing part of a nearly complete set", () => {
    const components = [
      { name: "Blueprint", owned: true },
      { name: "Barrel", owned: false },
      { name: "Receiver", owned: true },
      { name: "Stock", owned: true },
    ];

    expect(
      estimateMasteryPurchaseCost(40, components, (component) =>
        component.name === "Barrel" ? 7 : null,
      ),
    ).toBe(7);
  });

  it("uses the cheaper of a complete set and all missing components", () => {
    const components = [
      { name: "Blueprint", itemCount: 1, ownedCount: 0 },
      { name: "Barrel", itemCount: 2, ownedCount: 1 },
      { name: "Receiver", itemCount: 1, owned: true },
    ];
    const prices = new Map([
      ["Blueprint", 8],
      ["Barrel", 5],
    ]);

    expect(
      estimateMasteryPurchaseCost(
        20,
        components,
        (component) => prices.get(component.name) ?? null,
      ),
    ).toBe(13);
    expect(
      estimateMasteryPurchaseCost(
        10,
        components,
        (component) => prices.get(component.name) ?? null,
      ),
    ).toBe(10);
  });

  it("finds a part's market slug through the parent name or a uniqueName alias", () => {
    const lookup = {
      "odonata prime wings blueprint": {
        url_name: "odonata_prime_wings_blueprint",
        item_name: "Odonata Prime Wings Blueprint",
      },
      "braton prime barrel": { url_name: "braton_prime_barrel", item_name: "Braton Prime Barrel" },
      "/lotus/types/recipes/weapons/akbroncoprimelinkblueprint": {
        url_name: "akbronco_prime_link",
        item_name: "Akbronco Prime Link",
      },
    };
    expect(componentMarketSlug("Odonata Prime", { name: "Wings" }, lookup)).toBe(
      "odonata_prime_wings_blueprint",
    );
    expect(componentMarketSlug("Braton Prime", { name: "Braton Prime Barrel" }, lookup)).toBe(
      "braton_prime_barrel",
    );
    expect(
      componentMarketSlug(
        "Akbronco Prime",
        { name: "Link", uniqueName: "/Lotus/Types/Recipes/Weapons/AkbroncoPrimeLink" },
        lookup,
      ),
    ).toBe("akbronco_prime_link");
    expect(componentMarketSlug("Nekros", { name: "Neuroptics" }, lookup)).toBeNull();
  });

  it("gives no estimate when a missing component has no price", () => {
    expect(
      estimateMasteryPurchaseCost(25, [{ name: "Unknown", owned: false }], () => null),
    ).toBeNull();
  });

  it("prices only missing copies when another copy is building", () => {
    expect(
      estimateMasteryPurchaseCost(
        20,
        [{ name: "Blade", itemCount: 2, ownedCount: 0, building: true }],
        () => 3,
      ),
    ).toBe(3);
  });
});

describe("masteryPartRows", () => {
  const FRAME = "/Lotus/Powersuits/Caliban/CalibanPrime";
  const CHASSIS = "/Lotus/Types/Recipes/WarframeRecipes/CalibanPrimeChassisComponent";
  const FRAME_BP = "/Lotus/Types/Recipes/WarframeRecipes/CalibanPrimeBlueprint";
  const OROKIN_CELL = "/Lotus/Types/Items/MiscItems/OrokinCell";
  const SALVAGE = "/Lotus/Types/Items/MiscItems/Salvage";

  const db: Record<string, ItemDbEntry> = {
    [FRAME]: { name: "Caliban Prime", masterable: true },
    [CHASSIS]: { name: "Chassis", isBuildComponent: true, componentOf: FRAME },
    [FRAME_BP]: { name: "Blueprint", buildsProduct: FRAME },
    [OROKIN_CELL]: { name: "Orokin Cell" },
    [SALVAGE]: { name: "Salvage" },
  };

  it("drops raw materials so they cannot read as parts to craft", () => {
    const rows = masteryPartRows(
      [
        { uniqueName: FRAME_BP },
        { uniqueName: CHASSIS },
        { uniqueName: OROKIN_CELL },
        { uniqueName: SALVAGE },
      ],
      db,
    );

    expect(rows.map((row) => row.uniqueName)).toEqual([FRAME_BP, CHASSIS]);
  });

  it("leaves a resource-only recipe with no parts to tally", () => {
    const rows = masteryPartRows([{ uniqueName: OROKIN_CELL }, { uniqueName: SALVAGE }], db);
    expect(rows).toEqual([]);
  });

  it("counts only real parts as craftable, whatever state a resource reads", () => {
    const rows = [{ uniqueName: FRAME_BP }, { uniqueName: CHASSIS }, { uniqueName: OROKIN_CELL }];
    expect(masteryCraftableCount(rows, () => "blueprint", db)).toBe(2);
  });

  it("keeps every recipe row in the total so a missing resource still shows", () => {
    const rows: ComponentInfo[] = [
      { name: "Blueprint", uniqueName: FRAME_BP, ownedCount: 1, itemCount: 1 },
      { name: "Chassis", uniqueName: CHASSIS, ownedCount: 0, itemCount: 1 },
      { name: "Orokin Cell", uniqueName: OROKIN_CELL, ownedCount: 0, itemCount: 5 },
    ];
    expect(masteryPartCounts(rows.map(componentPartState)).total).toBe(3);
  });
});
