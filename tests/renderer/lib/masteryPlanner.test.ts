import { describe, expect, it } from "vitest";

import { aggregateComponentOwnership } from "../../../config/shared/componentOwnership.js";
import { withoutFoundryPending } from "../../../config/shared/foundryPending.js";
import { resolveComponentPriceLookup } from "../../../src/lib/componentResolution.js";
import {
  buildMasteryPlan,
  groupPlannedItems,
  missingOnly,
  plannerModalTarget,
  plannerPartState,
  sortPlannedItems,
  unfinishedParts,
  type PlannedItem,
  type PlannerPin,
} from "../../../src/lib/masteryPlanner.js";
import { creditsRow } from "../../../src/lib/syndicates/rankup.js";
import type { ItemDbEntry } from "../../../src/types/inventory.js";
import type { WfmItemsLookup } from "../../../src/types/ipc.js";

const FERRITE = "/Lotus/Types/Items/MiscItems/Ferrite";
const PLASTIDS = "/Lotus/Types/Items/MiscItems/Plastids";

function entry(name: string, recipe?: ItemDbEntry["recipe"]): ItemDbEntry {
  return { name, imageUrl: null, ...(recipe ? { recipe } : {}) };
}

function pin(uniqueName: string, name: string, masteryXpRemaining = 0): PlannerPin {
  return { uniqueName, name, imageUrl: null, masteryXpRemaining };
}

function totalFor(
  plan: ReturnType<typeof buildMasteryPlan>,
  uniqueName: string,
): { needed: number; owned: number; missing: number } {
  const row = plan.totals.find((entryRow) => entryRow.uniqueName === uniqueName);
  if (!row) throw new Error(`no total for ${uniqueName}`);
  return { needed: row.needed, owned: row.owned, missing: row.missing };
}

describe("mastery planner aggregation", () => {
  it("sums one resource across two pins and measures it against the pool once", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 15_000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 3000 }],
      }),
      "/Lotus/Weapons/Beta": entry("Beta", {
        buildPrice: 5000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 2000 }],
      }),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha"), pin("/Lotus/Weapons/Beta", "Beta")],
      db,
      new Map([[FERRITE, 4000]]),
    );

    expect(plan.totals).toHaveLength(1);
    expect(totalFor(plan, FERRITE)).toEqual({ needed: 5000, owned: 4000, missing: 1000 });
    expect(plan.totalCredits).toBe(20_000);

    const rowFor = (index: number) =>
      plan.items[index].resources.find((row) => row.uniqueName === FERRITE);
    expect(rowFor(0)).toMatchObject({ needed: 3000, owned: 3000, missing: 0 });
    expect(rowFor(1)).toMatchObject({ needed: 2000, owned: 1000, missing: 1000 });
    const rowsOwned = plan.items.reduce(
      (sum, item) => sum + (item.resources.find((row) => row.uniqueName === FERRITE)?.owned ?? 0),
      0,
    );
    expect(rowsOwned).toBe(totalFor(plan, FERRITE).owned);
  });

  it("never lets one pile cover more than a pin actually needs", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 100 }],
      }),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha")],
      db,
      new Map([[FERRITE, 900]]),
    );

    expect(plan.items[0].resources[0]).toMatchObject({ needed: 100, owned: 100, missing: 0 });
    expect(totalFor(plan, FERRITE)).toEqual({ needed: 100, owned: 900, missing: 0 });
  });

  it("keeps distinct resources apart while merging the shared one", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [
          { uniqueName: FERRITE, count: 100 },
          { uniqueName: PLASTIDS, count: 50 },
        ],
      }),
      "/Lotus/Weapons/Beta": entry("Beta", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 25 }],
      }),
      [FERRITE]: entry("Ferrite"),
      [PLASTIDS]: entry("Plastids"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha"), pin("/Lotus/Weapons/Beta", "Beta")],
      db,
      new Map([[PLASTIDS, 80]]),
    );

    expect(totalFor(plan, FERRITE)).toEqual({ needed: 125, owned: 0, missing: 125 });
    expect(totalFor(plan, PLASTIDS)).toEqual({ needed: 50, owned: 80, missing: 0 });
  });

  it("allocates one owned part to a single pin instead of both", () => {
    const shared = "/Lotus/Types/Recipes/Components/FormaBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: shared, count: 1 }],
      }),
      "/Lotus/Weapons/Beta": entry("Beta", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: shared, count: 1 }],
      }),
      [shared]: entry("Forma Blueprint", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 150 }],
      }),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha"), pin("/Lotus/Weapons/Beta", "Beta")],
      db,
      new Map([[shared, 1]]),
    );

    expect(plan.items[0].resources).toHaveLength(0);
    expect(totalFor(plan, FERRITE)).toEqual({ needed: 150, owned: 0, missing: 150 });
  });
});

describe("mastery planner ownership rules", () => {
  it("does not count a blueprint the foundry already consumed", () => {
    const blueprint = "/Lotus/Types/Recipes/Weapons/AlphaBarrelBlueprint";
    const raw = {
      Recipes: [{ ItemType: blueprint, ItemCount: 1 }],
      PendingRecipes: [{ ItemType: blueprint }],
      MiscItems: [{ ItemType: FERRITE, ItemCount: 900 }],
    };
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: blueprint, count: 1 }],
      }),
      [blueprint]: entry("Alpha Barrel"),
      [FERRITE]: entry("Ferrite"),
    };

    const withPending = aggregateComponentOwnership(raw);
    const usable = withoutFoundryPending(raw);
    const afterPending = aggregateComponentOwnership(usable);

    const before = buildMasteryPlan([pin("/Lotus/Weapons/Alpha", "Alpha")], db, withPending);
    const after = buildMasteryPlan([pin("/Lotus/Weapons/Alpha", "Alpha")], db, afterPending);

    expect(before.items[0].components[0].owned).toBe(1);
    expect(before.items[0].craftableNow).toBe(true);
    expect(after.items[0].components[0].owned).toBe(0);
    expect(after.items[0].components[0].missing).toBe(1);
    expect(after.items[0].craftableNow).toBe(false);
  });

  it("counts a set component the inventory spells as a blueprint", () => {
    const setName = "/Lotus/Types/Recipes/Weapons/AlphaBarrelComponent";
    const held = "/Lotus/Types/Recipes/Weapons/AlphaBarrelBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: setName, count: 1 }],
      }),
      [setName]: entry("Alpha Barrel"),
    };

    const plan = buildMasteryPlan([pin("/Lotus/Weapons/Alpha", "Alpha")], db, new Map([[held, 1]]));

    expect(plan.items[0].components[0].owned).toBe(1);
    expect(plan.items[0].craftableNow).toBe(true);
    expect(plan.items[0].completeness).toBe(1);
  });

  it("reports no plan for a pin the item database cannot build", () => {
    const plan = buildMasteryPlan(
      [pin("/Lotus/Weapons/Ghost", "Ghost")],
      { "/Lotus/Weapons/Ghost": entry("Ghost") },
      new Map(),
    );

    expect(plan.items[0].hasRecipe).toBe(false);
    expect(plan.items[0].craftableNow).toBe(false);
    expect(plan.craftableCount).toBe(0);
  });

  it("leaves a set whose parts are only blueprints short of ready", () => {
    const chassis = "/Lotus/Types/Recipes/WarframeRecipes/AlphaChassisComponent";
    const chassisBp = "/Lotus/Types/Recipes/WarframeRecipes/AlphaChassisBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Powersuits/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: chassis, count: 1 }],
      }),
      [chassis]: {
        ...entry("Alpha Chassis", {
          blueprintUniqueName: chassisBp,
          buildPrice: 0,
          buildTime: 0,
          num: 1,
          ingredients: [{ uniqueName: FERRITE, count: 900 }],
        }),
        isBuildComponent: true,
      },
      [FERRITE]: entry("Ferrite"),
    };
    const planFor = (ownership: Map<string, number>) =>
      buildMasteryPlan([pin("/Lotus/Powersuits/Alpha", "Alpha")], db, ownership).items[0];

    const held = planFor(new Map([[chassisBp, 1]]));
    expect(held.components[0]).toMatchObject({
      owned: 1,
      missing: 0,
      built: 0,
      state: "blueprint",
    });
    expect(held.craftableNow).toBe(false);
    expect(held.completeness).toBe(0);

    const built = planFor(new Map([[chassis, 1]]));
    expect(built.components[0]).toMatchObject({ owned: 1, built: 1, state: "owned" });
    expect(built.craftableNow).toBe(true);
    expect(built.completeness).toBe(1);

    expect(planFor(new Map()).components[0]).toMatchObject({
      owned: 0,
      built: 0,
      missing: 1,
      state: "missing",
    });
  });

  it("keeps a raw material with its own recipe out of the blueprint state", () => {
    const reactor = "/Lotus/Types/Recipes/Components/OrokinReactor";
    const reactorBp = `${reactor}Blueprint`;
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: reactor, count: 1 }],
      }),
      [reactor]: entry("Orokin Reactor", {
        blueprintUniqueName: reactorBp,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 900 }],
      }),
      [reactorBp]: entry("Orokin Reactor Blueprint"),
      [FERRITE]: entry("Ferrite"),
    };

    const planned = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha")],
      db,
      new Map([[reactorBp, 1]]),
    ).items[0];

    expect(planned.components[0]).toMatchObject({
      uniqueName: reactor,
      missing: 0,
      state: "owned",
    });
    expect(unfinishedParts(planned.components)).toEqual([]);
  });

  it("stays ready when the only held blueprint is the item's own", () => {
    const frameBp = "/Lotus/Types/Recipes/WarframeRecipes/AlphaBlueprint";
    const chassis = "/Lotus/Types/Recipes/WarframeRecipes/AlphaChassisComponent";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Powersuits/Alpha": entry("Alpha", {
        blueprintUniqueName: frameBp,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: chassis, count: 1 }],
      }),
      [frameBp]: entry("Alpha Blueprint"),
      [chassis]: { ...entry("Alpha Chassis"), isBuildComponent: true },
    };

    const planned = buildMasteryPlan(
      [pin("/Lotus/Powersuits/Alpha", "Alpha")],
      db,
      new Map([
        [frameBp, 1],
        [chassis, 1],
      ]),
    ).items[0];

    expect(planned.components.map((comp) => comp.state)).toEqual(["blueprint", "owned"]);
    expect(planned.components.map(plannerPartState)).toEqual(["owned", "owned"]);
    expect(planned.craftableNow).toBe(true);
    expect(planned.completeness).toBe(1);
  });

  it("marks a held main blueprint as blueprint, not as done", () => {
    const frameBp = "/Lotus/Types/Recipes/WarframeRecipes/AlphaBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Powersuits/Alpha": entry("Alpha", {
        blueprintUniqueName: frameBp,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 100 }],
      }),
      [frameBp]: entry("Alpha Blueprint"),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Powersuits/Alpha", "Alpha")],
      db,
      new Map([[frameBp, 1]]),
    );
    const blueprint = plan.items[0].components.find((comp) => comp.uniqueName === frameBp);

    expect(blueprint).toMatchObject({
      isBlueprint: true,
      missing: 0,
      built: 1,
      state: "blueprint",
    });
  });
});

describe("mastery planner recipe walking", () => {
  it("rolls a sub-recipe down to its own leaf resources", () => {
    const chassis = "/Lotus/Types/Recipes/Warframes/AlphaChassisBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Powersuits/Alpha": entry("Alpha", {
        buildPrice: 25_000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: chassis, count: 1 }],
      }),
      [chassis]: entry("Alpha Chassis", {
        buildPrice: 15_000,
        buildTime: 0,
        num: 1,
        ingredients: [
          { uniqueName: FERRITE, count: 900 },
          { uniqueName: PLASTIDS, count: 220 },
        ],
      }),
      [FERRITE]: entry("Ferrite"),
      [PLASTIDS]: entry("Plastids"),
    };

    const plan = buildMasteryPlan([pin("/Lotus/Powersuits/Alpha", "Alpha")], db, new Map());

    expect(totalFor(plan, FERRITE).needed).toBe(900);
    expect(totalFor(plan, PLASTIDS).needed).toBe(220);
    expect(plan.totalCredits).toBe(40_000);
    expect(plan.totals.some((row) => row.uniqueName === chassis)).toBe(false);
    expect(plan.items[0].components[0].uniqueName).toBe(chassis);
  });

  it("stops recursing into a sub-recipe that is already owned", () => {
    const chassis = "/Lotus/Types/Recipes/Warframes/AlphaChassisBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Powersuits/Alpha": entry("Alpha", {
        buildPrice: 25_000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: chassis, count: 1 }],
      }),
      [chassis]: entry("Alpha Chassis", {
        buildPrice: 15_000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 900 }],
      }),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Powersuits/Alpha", "Alpha")],
      db,
      new Map([[chassis, 1]]),
    );

    expect(plan.totals).toHaveLength(0);
    expect(plan.totalCredits).toBe(25_000);
    expect(plan.items[0].craftableNow).toBe(true);
  });

  it("divides required runs by the recipe yield", () => {
    const widget = "/Lotus/Types/Recipes/Components/WidgetBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: widget, count: 4 }],
      }),
      [widget]: entry("Widget", {
        buildPrice: 1000,
        buildTime: 0,
        num: 2,
        ingredients: [{ uniqueName: FERRITE, count: 100 }],
      }),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan([pin("/Lotus/Weapons/Alpha", "Alpha")], db, new Map());

    expect(totalFor(plan, FERRITE).needed).toBe(200);
    expect(plan.totalCredits).toBe(2000);
  });

  it("scales the yield down by the copies already owned", () => {
    const widget = "/Lotus/Types/Recipes/Components/WidgetBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: widget, count: 4 }],
      }),
      [widget]: entry("Widget", {
        buildPrice: 1000,
        buildTime: 0,
        num: 2,
        ingredients: [{ uniqueName: FERRITE, count: 100 }],
      }),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha")],
      db,
      new Map([[widget, 2]]),
    );

    expect(totalFor(plan, FERRITE).needed).toBe(100);
    expect(plan.totalCredits).toBe(1000);
  });

  it("needs one reusable blueprint no matter how many runs a part takes", () => {
    const widget = "/Lotus/Types/Recipes/Components/Gizmo";
    const widgetBp = "/Lotus/Types/Recipes/Components/GizmoConstructionBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: widget, count: 3 }],
      }),
      [widget]: entry("Gizmo", {
        blueprintUniqueName: widgetBp,
        reusableBlueprint: true,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 10 }],
      }),
      [widgetBp]: entry("Gizmo Blueprint"),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha")],
      db,
      new Map([[widget, 1]]),
    );

    expect(totalFor(plan, FERRITE).needed).toBe(20);
    expect(totalFor(plan, widgetBp).needed).toBe(1);
  });

  it("keeps a root-level raw material out of the part chips", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 3000 }],
      }),
      [FERRITE]: entry("Ferrite"),
    };

    const short = buildMasteryPlan([pin("/Lotus/Weapons/Alpha", "Alpha")], db, new Map());
    const stocked = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha")],
      db,
      new Map([[FERRITE, 4000]]),
    );

    expect(short.items[0].components).toEqual([]);
    expect(short.items[0].resources.map((row) => row.uniqueName)).toEqual([FERRITE]);
    expect(short.items[0].completeness).toBe(0);
    expect(short.items[0].craftableNow).toBe(false);
    expect(stocked.items[0].completeness).toBe(1);
    expect(stocked.items[0].craftableNow).toBe(true);
  });

  it("subtracts an owned sub-blueprint from the need exactly once", () => {
    const widget = "/Lotus/Types/Recipes/Components/Gizmo";
    const widgetBp = "/Lotus/Types/Recipes/Components/GizmoConstructionBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: widget, count: 3 }],
      }),
      [widget]: entry("Gizmo", {
        blueprintUniqueName: widgetBp,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 10 }],
      }),
      [widgetBp]: entry("Gizmo Blueprint"),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha")],
      db,
      new Map([[widgetBp, 1]]),
    );

    const row = plan.items[0].resources.find((entryRow) => entryRow.uniqueName === widgetBp);
    expect(row).toMatchObject({ needed: 3, owned: 1, missing: 2 });
    expect(totalFor(plan, widgetBp)).toEqual({ needed: 3, owned: 1, missing: 2 });
  });

  it("needs one consumed blueprint per run of the part", () => {
    const widget = "/Lotus/Types/Recipes/Components/Gizmo";
    const widgetBp = "/Lotus/Types/Recipes/Components/GizmoConstructionBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: widget, count: 3 }],
      }),
      [widget]: entry("Gizmo", {
        blueprintUniqueName: widgetBp,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 10 }],
      }),
      [widgetBp]: entry("Gizmo Blueprint"),
      [FERRITE]: entry("Ferrite"),
    };

    const plan = buildMasteryPlan([pin("/Lotus/Weapons/Alpha", "Alpha")], db, new Map());

    expect(totalFor(plan, widgetBp).needed).toBe(3);
    expect(totalFor(plan, FERRITE).needed).toBe(30);
  });
});

describe("mastery planner detail targets", () => {
  const parent = "/Lotus/Weapons/BratonPrime";
  const receiver = "/Lotus/Types/Recipes/Weapons/BratonPrimeReceiver";
  const targetDb: Record<string, ItemDbEntry> = {
    [parent]: {
      name: "Braton Prime",
      components: [{ name: "Receiver", uniqueName: receiver, tradable: true, itemCount: 1 }],
    },
    [receiver]: {
      name: "Braton Prime Receiver",
      isBuildComponent: true,
      componentOf: parent,
      tradable: true,
    },
    [FERRITE]: { name: "Ferrite" },
  };
  const lookup: WfmItemsLookup = {
    "braton prime receiver": { url_name: "braton_prime_receiver" },
  };

  it("hands a part row the short component name and its parent", () => {
    const target = plannerModalTarget(
      { uniqueName: receiver, name: "Braton Prime Receiver", needed: 2, owned: 1, missing: 1 },
      targetDb,
    );

    expect(target.comp.name).toBe("Receiver");
    expect(target.parentName).toBe("Braton Prime");
    expect(target.comp).toMatchObject({ uniqueName: receiver, itemCount: 2, ownedCount: 1 });
    expect(target.comp.owned).toBe(false);
    expect(
      resolveComponentPriceLookup(target.comp, target.parentName, targetDb[receiver], lookup).name,
    ).toBe("Braton Prime Receiver");
  });

  it("hands a raw material no parent so its price key stays the resource name", () => {
    const target = plannerModalTarget(
      { uniqueName: FERRITE, name: "Ferrite", needed: 3000, owned: 900, missing: 2100 },
      targetDb,
    );

    expect(target.comp.name).toBe("Ferrite");
    expect(target.parentName).toBe("");
    expect(target.comp).toMatchObject({ uniqueName: FERRITE, itemCount: 3000, ownedCount: 900 });
    expect(resolveComponentPriceLookup(target.comp, "", targetDb[FERRITE], lookup).name).toBe(
      "Ferrite",
    );
  });

  it("falls back to the row itself when the item database has no entry", () => {
    const target = plannerModalTarget(
      { uniqueName: "/Lotus/Weapons/Ghost", name: "Ghost", needed: 1, owned: 1, missing: 0 },
      targetDb,
    );

    expect(target).toMatchObject({ parentName: "" });
    expect(target.comp).toMatchObject({ uniqueName: "/Lotus/Weapons/Ghost", name: "Ghost" });
    expect(target.comp.owned).toBe(true);
  });
});

describe("mastery planner sorting", () => {
  function plannedItem(overrides: Partial<PlannedItem> & { name: string }): PlannedItem {
    return {
      uniqueName: `/Lotus/${overrides.name}`,
      imageUrl: null,
      masteryXpRemaining: 0,
      hasRecipe: true,
      components: [],
      resources: [],
      credits: 0,
      completeness: 0,
      craftableNow: false,
      ...overrides,
    };
  }

  const label = (item: PlannedItem): string => item.displayName || item.name;

  it("floats craftable items above every other sort key", () => {
    const items = [
      plannedItem({ name: "Zeta", masteryXpRemaining: 6000, completeness: 0.2 }),
      plannedItem({ name: "Alpha", masteryXpRemaining: 100, craftableNow: true }),
    ];

    expect(sortPlannedItems(items, "mastery_xp", label).map((item) => item.name)).toEqual([
      "Alpha",
      "Zeta",
    ]);
    expect(sortPlannedItems(items, "completeness", label).map((item) => item.name)).toEqual([
      "Alpha",
      "Zeta",
    ]);
  });

  it("orders by mastery gain, completeness and name inside a group", () => {
    const items = [
      plannedItem({ name: "Beta", masteryXpRemaining: 3000, completeness: 0.1 }),
      plannedItem({ name: "Alpha", masteryXpRemaining: 9000, completeness: 0.9 }),
      plannedItem({ name: "Gamma", masteryXpRemaining: 3000, completeness: 0.5 }),
    ];

    expect(sortPlannedItems(items, "mastery_xp", label).map((item) => item.name)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    expect(sortPlannedItems(items, "completeness", label).map((item) => item.name)).toEqual([
      "Alpha",
      "Gamma",
      "Beta",
    ]);
    expect(sortPlannedItems(items, "name", label).map((item) => item.name)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
  });

  it("splits the sorted list into a craftable and a remaining group", () => {
    const items = [
      plannedItem({ name: "Zeta", masteryXpRemaining: 6000 }),
      plannedItem({ name: "Alpha", masteryXpRemaining: 100, craftableNow: true }),
      plannedItem({ name: "Beta", masteryXpRemaining: 900, craftableNow: true }),
      plannedItem({ name: "Gamma", craftableNow: true, hasRecipe: false }),
    ];

    const groups = groupPlannedItems(items, "mastery_xp", label);

    expect(groups.craftable.map((item) => item.name)).toEqual(["Beta", "Alpha"]);
    expect(groups.remaining.map((item) => item.name)).toEqual(["Zeta", "Gamma"]);
  });
});

describe("mastery planner missing filter", () => {
  it("keeps only the rows that still need something, in the order given", () => {
    const rows = [
      { uniqueName: "a", missing: 5 },
      { uniqueName: "b", missing: 0 },
      { uniqueName: "c", missing: 2 },
    ];

    expect(missingOnly(rows).map((row) => row.uniqueName)).toEqual(["a", "c"]);
    expect(missingOnly([{ uniqueName: "b", missing: 0 }])).toEqual([]);
  });

  it("keeps a covered part listed while only its blueprint is held", () => {
    const rows = [
      { uniqueName: "built", missing: 0, state: "owned" as const },
      { uniqueName: "held", missing: 0, state: "blueprint" as const },
      { uniqueName: "short", missing: 1, state: "blueprint" as const },
      { uniqueName: "gone", missing: 1, state: "missing" as const },
    ];

    expect(unfinishedParts(rows).map((row) => row.uniqueName)).toEqual(["held", "short", "gone"]);
  });
});

describe("mastery planner credits row", () => {
  it("measures the summed build cost against the account balance", () => {
    const db: Record<string, ItemDbEntry> = {
      "/Lotus/Weapons/Alpha": entry("Alpha", {
        buildPrice: 15_000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 10 }],
      }),
      "/Lotus/Weapons/Beta": entry("Beta", {
        buildPrice: 5000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: FERRITE, count: 10 }],
      }),
      [FERRITE]: entry("Ferrite"),
    };
    const built = buildMasteryPlan(
      [pin("/Lotus/Weapons/Alpha", "Alpha"), pin("/Lotus/Weapons/Beta", "Beta")],
      db,
      new Map(),
    );

    expect(creditsRow(built.totalCredits, { RegularCredits: 12_000 })).toEqual({
      needed: 20_000,
      owned: 12_000,
      missing: 8000,
    });
  });

  it("treats a missing or unreadable balance as zero owned", () => {
    expect(creditsRow(70_000, null)).toEqual({
      needed: 70_000,
      owned: 0,
      missing: 70_000,
    });
    expect(creditsRow(70_000, {})).toEqual({
      needed: 70_000,
      owned: 0,
      missing: 70_000,
    });
    expect(creditsRow(70_000, { RegularCredits: "nope" }).owned).toBe(0);
  });

  it("unwraps a boxed balance and covers a paid-for plan", () => {
    expect(creditsRow(70_000, { RegularCredits: { $numberLong: "90000" } })).toEqual({
      needed: 70_000,
      owned: 90_000,
      missing: 0,
    });
  });
});
