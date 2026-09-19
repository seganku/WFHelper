import { describe, expect, it } from "vitest";

import {
  MAX_EXPAND_DEPTH,
  applyCraftingTreeFilters,
  buildCraftingTree,
  buildPartState,
  builtPartCount,
  canExpandCraftingNode,
  computeCraftingSummary,
  expandCraftingNode,
  expandedChildAncestors,
  filterExpandedChildren,
  isRecipePartPath,
  partState,
} from "../../../src/lib/craftingTree.js";
import type { CraftingTreeNode } from "../../../src/lib/craftingTree.js";
import type { ItemDbEntry } from "../../../src/types/inventory.js";

function item(name: string, recipe?: ItemDbEntry["recipe"]): ItemDbEntry {
  return {
    name,
    uniqueName: `/items/${name}`,
    category: "Weapon",
    productCategory: "Pistols",
    imageUrl: null,
    isPrime: false,
    masteryReq: 0,
    vaulted: false,
    tradable: false,
    keywords: [],
    components: [],
    ...(recipe ? { recipe } : {}),
  };
}

describe("crafting tree", () => {
  it("merges duplicate recipe ingredients into one counted child", () => {
    const db: Record<string, ItemDbEntry> = {
      "/items/Akbolto": item("Akbolto", {
        blueprintUniqueName: "/blueprints/Akbolto",
        buildPrice: 20_000,
        buildTime: 43_200,
        num: 1,
        ingredients: [
          { uniqueName: "/items/Bolto", count: 1 },
          { uniqueName: "/items/Bolto", count: 1 },
          { uniqueName: "/resources/OrokinCell", count: 1 },
        ],
      }),
      "/items/Bolto": item("Bolto"),
      "/resources/OrokinCell": item("Orokin Cell"),
      "/blueprints/Akbolto": item("Akbolto Blueprint"),
    };

    const tree = buildCraftingTree("/items/Akbolto", db, new Map());

    const boltoChildren = tree?.children.filter((child) => child.uniqueName === "/items/Bolto");
    expect(boltoChildren).toHaveLength(1);
    expect(boltoChildren?.[0].count).toBe(2);
  });

  it("needs one blueprint total when the recipe blueprint is reusable", () => {
    const db: Record<string, ItemDbEntry> = {
      "/items/AkTwin": item("AkTwin", {
        blueprintUniqueName: "/blueprints/AkTwin",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: "/items/Solo", count: 2 }],
      }),
      "/items/Solo": item("Solo", {
        blueprintUniqueName: "/blueprints/Solo",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        reusableBlueprint: true,
        ingredients: [{ uniqueName: "/resources/OrokinCell", count: 1 }],
      }),
      "/resources/OrokinCell": item("Orokin Cell"),
      "/blueprints/AkTwin": item("AkTwin Blueprint"),
      "/blueprints/Solo": item("Solo Blueprint"),
    };

    const tree = buildCraftingTree("/items/AkTwin", db, new Map([["/blueprints/Solo", 1]]));
    const solo = tree?.children.find((child) => child.uniqueName === "/items/Solo");
    const soloBp = solo?.children.find((child) => child.uniqueName === "/blueprints/Solo");

    expect(solo?.count).toBe(2);
    expect(soloBp?.count).toBe(1);
    expect(soloBp?.missing).toBe(0);
    expect(soloBp?.isBlueprintItem).toBe(true);

    const akBp = tree?.children.find((child) => child.uniqueName === "/blueprints/AkTwin");
    expect(akBp?.count).toBe(1);
  });

  it("does not list a part component and its blueprint as two children", () => {
    const chassis = "/Lotus/Types/Recipes/WarframeRecipes/CalibanPrimeChassisComponent";
    const chassisBp = "/Lotus/Types/Recipes/WarframeRecipes/CalibanPrimeChassisBlueprint";
    const db: Record<string, ItemDbEntry> = {
      "/items/CalibanPrime": item("Caliban Prime", {
        blueprintUniqueName: "/blueprints/CalibanPrime",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: chassis, count: 1 }],
      }),
      [chassis]: item("Caliban Prime Chassis Blueprint", {
        blueprintUniqueName: chassisBp,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: "/resources/Rubedo", count: 1600 }],
      }),
      "/resources/Rubedo": item("Rubedo"),
      "/blueprints/CalibanPrime": item("Caliban Prime Blueprint"),
      [chassisBp]: item("Caliban Prime Chassis Blueprint"),
    };

    const tree = buildCraftingTree("/items/CalibanPrime", db, new Map([[chassisBp, 3]]));
    const chassisNode = tree?.children.find((child) => child.uniqueName === chassis);

    expect(chassisNode?.owned).toBe(3);
    expect(chassisNode?.children.map((child) => child.uniqueName)).toEqual(["/resources/Rubedo"]);
    expect(tree?.children.some((child) => child.uniqueName === "/blueprints/CalibanPrime")).toBe(
      true,
    );
  });

  it("stops recursive recipe cycles at the repeated ingredient", () => {
    const db: Record<string, ItemDbEntry> = {
      "/items/A": item("A", {
        blueprintUniqueName: "/blueprints/A",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: "/items/B", count: 1 }],
      }),
      "/items/B": item("B", {
        blueprintUniqueName: "/blueprints/B",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: "/items/A", count: 1 }],
      }),
      "/blueprints/A": item("A Blueprint"),
      "/blueprints/B": item("B Blueprint"),
    };

    const tree = buildCraftingTree("/items/A", db, new Map());
    const repeatedA = tree?.children
      .find((child) => child.uniqueName === "/items/B")
      ?.children.find((child) => child.uniqueName === "/items/A");

    expect(repeatedA?.recipe).toBeNull();
    expect(repeatedA?.children).toHaveLength(0);
  });

  it("scales ingredients by recipe runs when a run yields several units", () => {
    const db: Record<string, ItemDbEntry> = {
      "/items/Caliban": item("Caliban", {
        blueprintUniqueName: "/blueprints/Caliban",
        buildPrice: 25_000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: "/items/HespazymAlloy", count: 100 }],
      }),
      "/items/HespazymAlloy": item("Hespazym Alloy", {
        blueprintUniqueName: "/blueprints/HespazymAlloy",
        buildPrice: 200,
        buildTime: 60,
        num: 20,
        reusableBlueprint: true,
        ingredients: [
          { uniqueName: "/resources/Plastids", count: 300 },
          { uniqueName: "/items/Hesperon", count: 20 },
          { uniqueName: "/resources/Morphics", count: 2 },
        ],
      }),
      "/items/Hesperon": item("Hesperon"),
      "/resources/Plastids": item("Plastids"),
      "/resources/Morphics": item("Morphics"),
      "/blueprints/Caliban": item("Caliban Blueprint"),
      "/blueprints/HespazymAlloy": item("Hespazym Alloy Blueprint"),
    };

    const tree = buildCraftingTree("/items/Caliban", db, new Map());
    const alloy = tree?.children.find((child) => child.uniqueName === "/items/HespazymAlloy");
    const byName = (un: string) => alloy?.children.find((child) => child.uniqueName === un);

    expect(alloy?.count).toBe(100);
    expect(byName("/resources/Plastids")?.count).toBe(1500);
    expect(byName("/items/Hesperon")?.count).toBe(100);
    expect(byName("/resources/Morphics")?.count).toBe(10);
    expect(byName("/blueprints/HespazymAlloy")?.count).toBe(1);

    const summary = computeCraftingSummary(tree!);
    expect(summary.totalCredits).toBe(25_000 + 5 * 200);
    expect(summary.maxBuildTime).toBe(5 * 60);
  });

  it("needs one consumable blueprint per run, not per unit", () => {
    const db: Record<string, ItemDbEntry> = {
      "/items/Batch": item("Batch", {
        blueprintUniqueName: "/blueprints/Batch",
        buildPrice: 0,
        buildTime: 0,
        num: 10,
        ingredients: [{ uniqueName: "/resources/Plastids", count: 5 }],
      }),
      "/items/Parent": item("Parent", {
        blueprintUniqueName: "/blueprints/Parent",
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: "/items/Batch", count: 25 }],
      }),
      "/resources/Plastids": item("Plastids"),
      "/blueprints/Batch": item("Batch Blueprint"),
      "/blueprints/Parent": item("Parent Blueprint"),
    };

    const tree = buildCraftingTree("/items/Parent", db, new Map());
    const batch = tree?.children.find((child) => child.uniqueName === "/items/Batch");
    const batchBp = batch?.children.find((child) => child.uniqueName === "/blueprints/Batch");

    expect(batchBp?.count).toBe(3);
    expect(batch?.children.find((child) => child.uniqueName === "/resources/Plastids")?.count).toBe(
      15,
    );
  });
});

const WEAPON = "/Lotus/Weapons/Tenno/LongGun/Sepulcrum";
const WEAPON_BP = "/Lotus/Types/Recipes/WeaponRecipes/SepulcrumBlueprint";
const RECEIVER = "/Lotus/Types/Recipes/WeaponRecipes/SepulcrumReceiverComponent";
const RECEIVER_BP = "/Lotus/Types/Recipes/WeaponRecipes/SepulcrumReceiverBlueprint";
const FORMA = "/Lotus/Types/Items/MiscItems/Forma";
const FORMA_BP = "/Lotus/Types/Recipes/Components/FormaBlueprint";
const ALLOY = "/Lotus/Types/Items/MiscItems/HespazymAlloy";
const ALLOY_BP = "/Lotus/Types/Recipes/Components/HespazymAlloyBlueprint";
const RUBEDO = "/Lotus/Types/Items/MiscItems/Rubedo";
const MORPHICS = "/Lotus/Types/Items/MiscItems/Morphic";

function expandableDb(): Record<string, ItemDbEntry> {
  return {
    [WEAPON]: item("Sepulcrum", {
      blueprintUniqueName: WEAPON_BP,
      buildPrice: 25_000,
      buildTime: 43_200,
      num: 1,
      ingredients: [
        { uniqueName: RECEIVER, count: 1 },
        { uniqueName: FORMA, count: 3 },
        { uniqueName: ALLOY, count: 100 },
      ],
    }),
    [RECEIVER]: item("Sepulcrum Receiver Blueprint", {
      blueprintUniqueName: RECEIVER_BP,
      buildPrice: 15_000,
      buildTime: 43_200,
      num: 1,
      ingredients: [{ uniqueName: RUBEDO, count: 1500 }],
    }),
    [FORMA]: item("Forma", {
      blueprintUniqueName: FORMA_BP,
      buildPrice: 0,
      buildTime: 86_400,
      num: 1,
      ingredients: [
        { uniqueName: MORPHICS, count: 1 },
        { uniqueName: RUBEDO, count: 500 },
      ],
    }),
    [ALLOY]: item("Hespazym Alloy", {
      blueprintUniqueName: ALLOY_BP,
      buildPrice: 200,
      buildTime: 60,
      num: 20,
      ingredients: [
        { uniqueName: RUBEDO, count: 300 },
        { uniqueName: MORPHICS, count: 2 },
      ],
    }),
    [RUBEDO]: item("Rubedo"),
    [MORPHICS]: item("Morphics"),
    [WEAPON_BP]: item("Sepulcrum Blueprint"),
    [RECEIVER_BP]: item("Sepulcrum Receiver Blueprint"),
    [FORMA_BP]: item("Forma Blueprint"),
    [ALLOY_BP]: item("Hespazym Alloy Blueprint"),
  };
}

describe("built counts on tree nodes", () => {
  const PART = "/Lotus/Types/Recipes/WarframeRecipes/CalibanPrimeChassisComponent";
  const PART_BP = `${PART}Blueprint`;
  const FRAME = "/Lotus/Powersuits/Caliban/CalibanPrime";

  const db: Record<string, ItemDbEntry> = {
    [FRAME]: {
      name: "Caliban Prime",
      masterable: true,
      recipe: {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: PART, count: 1 }],
      },
    },
    [PART]: { name: "Chassis", isBuildComponent: true, componentOf: FRAME },
    [PART_BP]: { name: "Chassis Blueprint", buildsProduct: PART },
  };

  it("holds a part at built 0 while only its blueprint is owned", () => {
    const tree = buildCraftingTree(FRAME, db, new Map([[PART_BP, 1]]));
    const part = childOf(tree, PART);
    // The folded pile still reads one, which is what the readiness rules want.
    expect(part?.owned).toBe(1);
    expect(part?.built).toBe(0);
  });

  it("counts a part that really is built", () => {
    const tree = buildCraftingTree(FRAME, db, new Map([[PART, 1]]));
    expect(childOf(tree, PART)?.built).toBe(1);
  });
});

function childOf(node: CraftingTreeNode | null | undefined, uniqueName: string) {
  return node?.children.find((child) => child.uniqueName === uniqueName);
}

function looseNode(uniqueName: string, name: string): CraftingTreeNode {
  return {
    uniqueName,
    name,
    imageUrl: null,
    count: 1,
    owned: 0,
    built: 0,
    missing: 1,
    isCraftable: false,
    recipe: null,
    usedFor: [],
    children: [],
  };
}

describe("crafting tree expansion", () => {
  it("marks resource nodes with their own recipe as expandable, resources without one not", () => {
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const forma = childOf(tree, FORMA)!;
    const rubedo = childOf(childOf(tree, RECEIVER), RUBEDO)!;

    expect(forma.children).toHaveLength(0);
    expect(canExpandCraftingNode(forma, db, [WEAPON])).toBe(true);
    expect(canExpandCraftingNode(rubedo, db, [WEAPON, RECEIVER])).toBe(false);
  });

  it("gives no chevron to a node the tree already expanded", () => {
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const receiver = childOf(tree, RECEIVER)!;

    expect(receiver.children.length).toBeGreaterThan(0);
    expect(canExpandCraftingNode(receiver, db, [WEAPON])).toBe(false);
  });

  it("never expands a blueprint back into the item it hangs under", () => {
    const db = expandableDb();
    db[WEAPON_BP] = { ...db[WEAPON_BP], buildsProduct: WEAPON };
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const weaponBp = childOf(tree, WEAPON_BP)!;

    expect(weaponBp.isBlueprintItem).toBe(true);
    expect(canExpandCraftingNode(weaponBp, db, [WEAPON])).toBe(false);
    expect(expandCraftingNode(weaponBp, db, new Map(), [WEAPON])).toEqual([]);
  });

  it("roots a blueprint node through buildsProduct instead of its own entry", () => {
    const db = expandableDb();
    db[FORMA_BP] = { ...db[FORMA_BP], buildsProduct: FORMA };
    const loose: CraftingTreeNode = {
      uniqueName: FORMA_BP,
      name: "Forma Blueprint",
      imageUrl: null,
      count: 1,
      owned: 0,
      built: 0,
      missing: 1,
      isCraftable: false,
      recipe: null,
      usedFor: [],
      children: [],
    };

    expect(canExpandCraftingNode(loose, db, [WEAPON])).toBe(true);
    const children = expandCraftingNode(loose, db, new Map(), [WEAPON]);
    expect(children.map((child) => child.uniqueName).sort()).toEqual([MORPHICS, RUBEDO].sort());
    expect(db[FORMA_BP].recipe).toBeUndefined();
  });

  it("resolves the sub-recipe only when the node is expanded", () => {
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const forma = childOf(tree, FORMA)!;

    expect(forma.children).toHaveLength(0);
    expect(forma.recipe).toBeNull();

    const children = expandCraftingNode(forma, db, new Map(), [WEAPON]);
    expect(children.map((child) => child.uniqueName).sort()).toEqual(
      [FORMA_BP, MORPHICS, RUBEDO].sort(),
    );
    expect(forma.children).toHaveLength(0);
  });

  it("divides expanded requirements by the recipe yield", () => {
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const alloy = childOf(tree, ALLOY)!;

    expect(alloy.count).toBe(100);
    const children = expandCraftingNode(alloy, db, new Map(), [WEAPON]);
    const byName = (un: string) => children.find((child) => child.uniqueName === un);

    expect(byName(ALLOY_BP)?.count).toBe(5);
    expect(byName(RUBEDO)?.count).toBe(1500);
    expect(byName(MORPHICS)?.count).toBe(10);
  });

  it("lists a sub-blueprint once, under the alias the inventory holds", () => {
    const db = expandableDb();
    db[FORMA] = {
      ...db[FORMA],
      recipe: { ...db[FORMA].recipe!, blueprintUniqueName: FORMA_BP },
    };
    const tree = buildCraftingTree(WEAPON, db, new Map([[FORMA_BP, 2]]))!;
    const forma = childOf(tree, FORMA)!;

    const children = expandCraftingNode(forma, db, new Map([[FORMA_BP, 2]]), [WEAPON]);
    const blueprints = children.filter((child) => child.uniqueName === FORMA_BP);
    expect(blueprints).toHaveLength(1);
    expect(blueprints[0].owned).toBe(2);
    expect(blueprints[0].isBlueprintItem).toBe(true);
  });

  it("does not repeat a component and its blueprint alias in one expansion", () => {
    const db = expandableDb();
    const componentSpelling = "/Lotus/Types/Items/MiscItems/WidgetComponent";
    const blueprintSpelling = "/Lotus/Types/Items/MiscItems/WidgetBlueprint";
    db[WEAPON] = {
      ...db[WEAPON],
      recipe: {
        ...db[WEAPON].recipe!,
        ingredients: [{ uniqueName: componentSpelling, count: 1 }],
      },
    };
    db[componentSpelling] = item("Widget", {
      blueprintUniqueName: blueprintSpelling,
      buildPrice: 0,
      buildTime: 0,
      num: 1,
      ingredients: [{ uniqueName: RUBEDO, count: 10 }],
    });
    db[blueprintSpelling] = item("Widget Blueprint");

    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const widget = childOf(tree, componentSpelling)!;
    const children = expandCraftingNode(widget, db, new Map(), [WEAPON]);

    expect(children.map((child) => child.uniqueName)).toEqual([RUBEDO]);
  });

  it("shows the recipe of a resource opened as its own tree root", () => {
    const db = expandableDb();
    const tree = buildCraftingTree(FORMA, db, new Map())!;

    expect(tree.children.map((child) => child.uniqueName).sort()).toEqual(
      [FORMA_BP, MORPHICS, RUBEDO].sort(),
    );
    expect(tree.isCraftable).toBe(true);
  });

  it("expands one level per click so the depth cap can count them", () => {
    const chain = ["A", "B", "C", "D", "E"].map((id) => `/Lotus/Types/Items/MiscItems/Link${id}`);
    const db: Record<string, ItemDbEntry> = {
      [WEAPON]: item("Sepulcrum", {
        blueprintUniqueName: WEAPON_BP,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: chain[0], count: 1 }],
      }),
      [WEAPON_BP]: item("Sepulcrum Blueprint"),
    };
    chain.forEach((uniqueName, index) => {
      const next = chain[index + 1];
      db[uniqueName] = next
        ? item(`Link ${index}`, {
            blueprintUniqueName: `${uniqueName}Blueprint`,
            buildPrice: 0,
            buildTime: 0,
            num: 1,
            ingredients: [{ uniqueName: next, count: 1 }],
          })
        : item(`Link ${index}`);
      db[`${uniqueName}Blueprint`] = item(`Link ${index} Blueprint`);
    });

    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    let node = childOf(tree, chain[0])!;
    let ancestors = [WEAPON];
    let levels = 0;

    while (canExpandCraftingNode(node, db, ancestors) && levels < MAX_EXPAND_DEPTH) {
      const children = expandCraftingNode(node, db, new Map(), ancestors);
      expect(children.every((child) => child.children.length === 0)).toBe(true);
      ancestors = [...ancestors, node.uniqueName];
      node = children.find((child) => child.uniqueName === chain[levels + 1])!;
      levels += 1;
    }

    expect(MAX_EXPAND_DEPTH).toBe(3);
    expect(levels).toBe(3);
    expect(node.uniqueName).toBe(chain[3]);
    expect(canExpandCraftingNode(node, db, ancestors)).toBe(true);
  });
});

describe("expanded child ancestors", () => {
  it("adds the product a blueprint expansion roots through", () => {
    const db = expandableDb();
    db[FORMA_BP] = { ...db[FORMA_BP], buildsProduct: FORMA };
    const blueprint = looseNode(FORMA_BP, "Forma Blueprint");

    const path = expandedChildAncestors(blueprint, db, [WEAPON]);
    expect(path).toEqual([WEAPON, FORMA_BP, FORMA]);
    expect(canExpandCraftingNode(looseNode(FORMA, "Forma"), db, path)).toBe(false);
    expect(canExpandCraftingNode(blueprint, db, path)).toBe(false);
  });

  it("adds no product for a blueprint whose product carries no recipe", () => {
    const db = expandableDb();
    const trophy = "/Lotus/Types/Items/Decor/Trophy";
    db[trophy] = item("Trophy");
    db[WEAPON_BP] = { ...db[WEAPON_BP], buildsProduct: trophy };
    const blueprint = looseNode(WEAPON_BP, "Sepulcrum Blueprint");

    expect(expandCraftingNode(blueprint, db, new Map(), [WEAPON])).toEqual([]);
    expect(expandedChildAncestors(blueprint, db, [WEAPON])).toEqual([WEAPON, WEAPON_BP]);
  });

  it("lists a node that carries its own recipe once", () => {
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;

    expect(expandedChildAncestors(childOf(tree, FORMA)!, db, [WEAPON])).toEqual([WEAPON, FORMA]);
  });
});

describe("crafting tree expansion against owned copies", () => {
  it("expands only the copies the node still needs", () => {
    const owned = new Map([[FORMA, 1]]);
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, owned)!;
    const forma = childOf(tree, FORMA)!;

    expect(forma.count).toBe(3);
    expect(forma.owned).toBe(1);

    const children = expandCraftingNode(forma, db, owned, [WEAPON]);
    const byName = (un: string) => children.find((child) => child.uniqueName === un);

    expect(byName(RUBEDO)?.count).toBe(1000);
    expect(byName(MORPHICS)?.count).toBe(2);
    expect(byName(FORMA_BP)?.count).toBe(2);
  });

  it("gives a fully owned node no chevron and no bill", () => {
    const owned = new Map([[FORMA, 3]]);
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, owned)!;
    const forma = childOf(tree, FORMA)!;

    expect(canExpandCraftingNode(forma, db, [WEAPON])).toBe(false);
    expect(expandCraftingNode(forma, db, owned, [WEAPON])).toEqual([]);
  });
});

describe("crafting tree filters", () => {
  const PART = "/Lotus/Types/Recipes/WeaponRecipes/WidgetComponent";
  const PART_BP = "/Lotus/Types/Recipes/WeaponRecipes/WidgetSubBlueprint";

  function blueprintOnlyDb(): Record<string, ItemDbEntry> {
    return {
      [WEAPON]: item("Sepulcrum", {
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: PART, count: 1 }],
      }),
      [PART]: item("Widget", {
        blueprintUniqueName: PART_BP,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [],
      }),
      [PART_BP]: item("Widget Blueprint"),
    };
  }

  it("gives no chevron to a node whose children a filter removed", () => {
    const db = blueprintOnlyDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    expect(childOf(tree, PART)?.children.map((child) => child.uniqueName)).toEqual([PART_BP]);

    const filtered = applyCraftingTreeFilters(tree, {
      hideCompleted: false,
      hideBlueprints: true,
    })!;
    const part = childOf(filtered, PART)!;

    expect(part.children).toHaveLength(0);
    expect(part.childrenHidden).toBe(true);
    expect(canExpandCraftingNode(part, db, [WEAPON])).toBe(false);
  });

  it("keeps a node expandable when the filter removed nothing", () => {
    const db = blueprintOnlyDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const filtered = applyCraftingTreeFilters(tree, {
      hideCompleted: false,
      hideBlueprints: false,
    })!;

    expect(childOf(filtered, PART)?.childrenHidden).toBeUndefined();
  });

  it("hides blueprints in a lazily expanded level too", () => {
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, new Map())!;
    const children = expandCraftingNode(childOf(tree, FORMA)!, db, new Map(), [WEAPON]);

    expect(children.some((child) => child.uniqueName === FORMA_BP)).toBe(true);
    const shown = filterExpandedChildren(children, {
      hideCompleted: false,
      hideBlueprints: true,
    });
    expect(shown.map((child) => child.uniqueName).sort()).toEqual([MORPHICS, RUBEDO].sort());
  });

  it("hides completed rows in a lazily expanded level too", () => {
    const owned = new Map([[RUBEDO, 5000]]);
    const db = expandableDb();
    const tree = buildCraftingTree(WEAPON, db, owned)!;
    const children = expandCraftingNode(childOf(tree, FORMA)!, db, owned, [WEAPON]);

    const shown = filterExpandedChildren(children, {
      hideCompleted: true,
      hideBlueprints: false,
    });
    expect(shown.some((child) => child.uniqueName === RUBEDO)).toBe(false);
    expect(shown.some((child) => child.uniqueName === MORPHICS)).toBe(true);
  });
});

describe("part state", () => {
  const FRAME = "/Lotus/Powersuits/Dragon/Dragon";
  const FRAME_BP = "/Lotus/Types/Recipes/WarframeRecipes/ChromaBlueprint";
  const CHASSIS = "/Lotus/Types/Recipes/WarframeRecipes/ChromaChassisComponent";
  const CHASSIS_BP = "/Lotus/Types/Recipes/WarframeRecipes/ChromaChassisBlueprint";
  const BARREL = "/Lotus/Types/Recipes/Weapons/WeaponParts/CrpArSniperBarrel";
  const BARREL_BP = "/Lotus/Types/Recipes/Weapons/WeaponParts/AmbassadorBarrelBlueprint";
  const PRIME_PART = "/Lotus/Types/Recipes/Weapons/WeaponParts/BoarPrimeReceiver";
  const SET_PART = "/Lotus/Types/Recipes/WarframeRecipes/WispPrimeSystemsBlueprint";
  const SET_PART_HELD = "/Lotus/Types/Recipes/WarframeRecipes/WispPrimeSystemsComponent";

  function partDb(): Record<string, ItemDbEntry> {
    return {
      [FRAME]: item("Chroma", {
        blueprintUniqueName: FRAME_BP,
        buildPrice: 25_000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: CHASSIS, count: 1 }],
      }),
      [FRAME_BP]: { ...item("Chroma Blueprint"), buildsProduct: FRAME },
      [CHASSIS]: item("Chroma Chassis", {
        blueprintUniqueName: CHASSIS_BP,
        buildPrice: 15_000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: RUBEDO, count: 900 }],
      }),
      [CHASSIS_BP]: { ...item("Chroma Chassis Blueprint"), buildsProduct: CHASSIS },
      [BARREL]: item("Ambassador Barrel", {
        blueprintUniqueName: BARREL_BP,
        buildPrice: 15_000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: MORPHICS, count: 1 }],
      }),
      [BARREL_BP]: { ...item("Ambassador Barrel Blueprint"), buildsProduct: BARREL },
      [PRIME_PART]: item("Boar Prime Receiver"),
      [SET_PART]: item("Wisp Prime Systems Blueprint"),
      [RUBEDO]: item("Rubedo"),
      [MORPHICS]: item("Morphics"),
    };
  }

  const part = (uniqueName: string, count = 1) => ({ uniqueName, count });

  it("reads a built part as owned, a held blueprint as blueprint, nothing as missing", () => {
    const db = partDb();

    expect(partState(part(CHASSIS), new Map([[CHASSIS, 1]]), db)).toBe("owned");
    expect(partState(part(CHASSIS), new Map([[CHASSIS_BP, 1]]), db)).toBe("blueprint");
    expect(partState(part(CHASSIS), new Map(), db)).toBe("missing");
  });

  it("marks the blueprint without touching the alias-folded count", () => {
    const db = partDb();
    const owned = new Map([[CHASSIS_BP, 1]]);
    const chassis = childOf(buildCraftingTree(FRAME, db, owned), CHASSIS)!;

    expect(chassis.owned).toBe(1);
    expect(chassis.missing).toBe(0);
    expect(partState(chassis, owned, db)).toBe("blueprint");
  });

  it("finds a blueprint whose name is no spelling of the part", () => {
    const db = partDb();

    expect(partState(part(BARREL), new Map([[BARREL_BP, 1]]), db)).toBe("blueprint");
    expect(partState(part(BARREL), new Map([[BARREL, 1]]), db)).toBe("owned");
    expect(partState(part(BARREL), new Map(), db)).toBe("missing");
  });

  it("needs the built pile to cover the whole count", () => {
    const db = partDb();
    const short = new Map([
      [CHASSIS, 1],
      [CHASSIS_BP, 1],
    ]);

    expect(partState(part(CHASSIS, 2), short, db)).toBe("blueprint");
    expect(partState(part(CHASSIS, 2), new Map([[CHASSIS, 2]]), db)).toBe("owned");
  });

  it("marks a held blueprint item as blueprint until its product exists", () => {
    const db = partDb();
    const frameBp = childOf(buildCraftingTree(FRAME, db, new Map()), FRAME_BP)!;
    expect(frameBp.isBlueprintItem).toBe(true);

    expect(partState(frameBp, new Map(), db)).toBe("missing");
    expect(partState(frameBp, new Map([[FRAME_BP, 1]]), db)).toBe("blueprint");
    expect(
      partState(
        frameBp,
        new Map([
          [FRAME_BP, 1],
          [FRAME, 1],
        ]),
        db,
      ),
    ).toBe("owned");
  });

  it("needs the built pile to cover a blueprint row's whole count", () => {
    const db = partDb();
    const row = { uniqueName: FRAME_BP, count: 3, isBlueprintItem: true };

    expect(
      partState(
        row,
        new Map([
          [FRAME_BP, 3],
          [FRAME, 1],
        ]),
        db,
      ),
    ).toBe("blueprint");
    expect(
      partState(
        row,
        new Map([
          [FRAME_BP, 3],
          [FRAME, 3],
        ]),
        db,
      ),
    ).toBe("owned");
  });

  it("keeps a blueprint row whose product is its own alias out of the owned state", () => {
    const db = partDb();
    const row = { uniqueName: CHASSIS_BP, count: 1 };
    const flagged = { ...row, isBlueprintItem: true };

    expect(partState(row, new Map([[CHASSIS_BP, 1]]), db)).toBe("blueprint");
    expect(partState(flagged, new Map([[CHASSIS_BP, 1]]), db)).toBe("blueprint");
    expect(partState(row, new Map([[CHASSIS, 1]]), db)).toBe("owned");
    expect(partState(row, new Map(), db)).toBe("missing");
  });

  it("counts built copies without the blueprint spelling", () => {
    const db = partDb();

    expect(builtPartCount(part(CHASSIS), new Map([[CHASSIS_BP, 1]]), db)).toBe(0);
    expect(builtPartCount(part(CHASSIS), new Map([[CHASSIS, 2]]), db)).toBe(2);
    expect(builtPartCount(part(BARREL), new Map([[BARREL_BP, 3]]), db)).toBe(0);
    expect(
      builtPartCount({ ...part(FRAME_BP), isBlueprintItem: true }, new Map([[FRAME_BP, 1]]), db),
    ).toBe(1);
    expect(builtPartCount(part(SET_PART), new Map([[SET_PART_HELD, 1]]), db)).toBe(1);
  });

  it("reads the held blueprint when the recipe index names another one", () => {
    const SAGEK_BARREL = "/Lotus/Types/Recipes/Weapons/WeaponParts/SagekPrimeBarrel";
    const SAGEK_BARREL_BP = `${SAGEK_BARREL}Blueprint`;
    const SAGEK_STOCK_BP = "/Lotus/Types/Recipes/Weapons/WeaponParts/SagekPrimeStockBlueprint";
    const db: Record<string, ItemDbEntry> = {
      ...partDb(),
      [SAGEK_BARREL]: item("Sagek Prime Barrel", {
        blueprintUniqueName: SAGEK_STOCK_BP,
        buildPrice: 15_000,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: MORPHICS, count: 1 }],
      }),
      [SAGEK_BARREL_BP]: { ...item("Sagek Prime Barrel Blueprint"), buildsProduct: SAGEK_BARREL },
      [SAGEK_STOCK_BP]: { ...item("Sagek Prime Stock Blueprint"), buildsProduct: SAGEK_BARREL },
    };

    expect(builtPartCount(part(SAGEK_BARREL), new Map([[SAGEK_BARREL_BP, 1]]), db)).toBe(0);
    expect(partState(part(SAGEK_BARREL), new Map([[SAGEK_BARREL_BP, 1]]), db)).toBe("blueprint");
    expect(partState(part(SAGEK_BARREL), new Map([[SAGEK_STOCK_BP, 1]]), db)).toBe("blueprint");
    expect(partState(part(SAGEK_BARREL), new Map([[SAGEK_BARREL, 1]]), db)).toBe("owned");
  });

  it("keeps raw materials outside the part path rule", () => {
    expect(isRecipePartPath(CHASSIS)).toBe(true);
    expect(isRecipePartPath(PRIME_PART)).toBe(true);
    expect(isRecipePartPath(RUBEDO)).toBe(false);
  });

  it("owns a part with no recipe under either spelling of its pile", () => {
    const db = partDb();

    expect(partState(part(SET_PART), new Map([[SET_PART_HELD, 1]]), db)).toBe("owned");
    expect(partState(part(PRIME_PART), new Map([[`${PRIME_PART}Blueprint`, 1]]), db)).toBe("owned");
    expect(partState(part(PRIME_PART), new Map(), db)).toBe("missing");
  });

  it("gives the blueprint state to build components only", () => {
    const REACTOR = "/Lotus/Types/Recipes/Components/OrokinReactor";
    const REACTOR_BP = `${REACTOR}Blueprint`;
    const db: Record<string, ItemDbEntry> = {
      ...partDb(),
      [REACTOR]: item("Orokin Reactor", {
        blueprintUniqueName: REACTOR_BP,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: RUBEDO, count: 900 }],
      }),
      [REACTOR_BP]: { ...item("Orokin Reactor Blueprint"), buildsProduct: REACTOR },
    };
    db[CHASSIS] = { ...db[CHASSIS], isBuildComponent: true };
    const heldReactor = new Map([[REACTOR_BP, 1]]);

    expect(partState(part(REACTOR), heldReactor, db)).toBe("blueprint");
    expect(buildPartState(part(REACTOR), heldReactor, db)).toBe("owned");
    expect(buildPartState(part(REACTOR, 2), heldReactor, db)).toBe("missing");
    expect(buildPartState(part(CHASSIS), new Map([[CHASSIS_BP, 1]]), db)).toBe("blueprint");
    expect(
      buildPartState({ ...part(FRAME_BP), isBlueprintItem: true }, new Map([[FRAME_BP, 1]]), db),
    ).toBe("blueprint");
  });

  it("owns the recipe's own blueprint instead of listing it as one to craft", () => {
    const WEAPON = "/Lotus/Weapons/Tenno/Melee/Machete";
    const WEAPON_BP = "/Lotus/Types/Recipes/Weapons/MacheteBlueprint";
    const db: Record<string, ItemDbEntry> = {
      ...partDb(),
      [WEAPON]: item("Machete", {
        blueprintUniqueName: WEAPON_BP,
        buildPrice: 0,
        buildTime: 0,
        num: 1,
        ingredients: [{ uniqueName: RUBEDO, count: 900 }],
      }),
      // The item-database heuristic marks anything under /Types/Recipes/ a part.
      [WEAPON_BP]: {
        ...item("Blueprint"),
        buildsProduct: WEAPON,
        isBuildComponent: true,
      },
    };
    db[CHASSIS] = { ...db[CHASSIS], isBuildComponent: true };
    const held = new Map([[WEAPON_BP, 1]]);

    expect(buildPartState(part(WEAPON_BP), held, db, WEAPON)).toBe("owned");
    // Without the root it cannot tell, and keeps the old answer.
    expect(buildPartState(part(WEAPON_BP), held, db)).toBe("blueprint");
    // A real part's blueprint is still something to go and craft.
    expect(buildPartState(part(CHASSIS), new Map([[CHASSIS_BP, 1]]), db, FRAME)).toBe("blueprint");
  });
});
