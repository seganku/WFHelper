import { describe, expect, it } from "vitest";

import { componentUniqueNameAliases } from "../../../../config/shared/componentNames.js";
import {
  componentParentOf,
  consumersOf,
  isCraftingResource,
  isReservablePart,
  partConsumerIndex,
  partDemandAliases,
  partsConsumedBy,
} from "../../../../src/lib/inventory/partConsumers.js";
import type { ItemDbEntry } from "../../../../src/types/inventory.js";

const BRONCO = "/Lotus/Weapons/Tenno/Pistol/BroncoPrime";
const AKBRONCO = "/Lotus/Weapons/Tenno/Akimbo/AkbroncoPrime";
const LINK = "/Lotus/Types/Recipes/Weapons/WeaponParts/AkbroncoPrimeLink";
const BLUEPRINT = "/Lotus/Types/Recipes/Weapons/AkbroncoPrimeBlueprint";
const CELL = "/Lotus/Types/Items/MiscItems/OrokinCell";
const CHROMA_SYSTEMS = "/Lotus/Types/Recipes/WarframeRecipes/ChromaSystemsBlueprint";
const SARYN_SYSTEMS = "/Lotus/Types/Recipes/WarframeRecipes/SarynSystemsBlueprint";
const PLASM = "/Lotus/Types/Gameplay/Zariman/Resources/LuaThraxPlasm";

function entry(
  components: Array<{ uniqueName: string; itemCount?: number }>,
  ingredients?: Array<{ uniqueName: string; count: number }>,
  extra: Partial<ItemDbEntry> = {},
): ItemDbEntry {
  return {
    name: "x",
    components,
    ...(ingredients ? { recipe: { buildPrice: 0, buildTime: 0, num: 1, ingredients } } : {}),
    ...extra,
  } as unknown as ItemDbEntry;
}

const db: Record<string, ItemDbEntry> = {
  [AKBRONCO]: entry([
    { uniqueName: BLUEPRINT },
    { uniqueName: BRONCO },
    { uniqueName: BRONCO },
    { uniqueName: LINK },
    { uniqueName: CELL, itemCount: 10 },
  ]),
  [BRONCO]: entry([{ uniqueName: BRONCO }], undefined, { masterable: true }),
  // Chroma's recipe eats another frame's part that its component list never names.
  [CHROMA_SYSTEMS]: entry(
    [{ uniqueName: CELL, itemCount: 1 }],
    [
      { uniqueName: SARYN_SYSTEMS, count: 1 },
      { uniqueName: CELL, count: 3 },
      { uniqueName: PLASM, count: 2 },
    ],
  ),
};

describe("partsConsumedBy", () => {
  it("sums doubled rows and drops the item itself", () => {
    const parts = partsConsumedBy(AKBRONCO, db[AKBRONCO]);
    expect(parts.map((part) => [part.uniqueName, part.itemCount])).toEqual([
      [BLUEPRINT, 1],
      [BRONCO, 2],
      [LINK, 1],
      [CELL, 10],
    ]);
    expect(partsConsumedBy(BRONCO, db[BRONCO])).toEqual([]);
  });

  it("joins recipe ingredients and lets the recipe count win", () => {
    const parts = partsConsumedBy(CHROMA_SYSTEMS, db[CHROMA_SYSTEMS]);
    expect(parts.map((part) => [part.uniqueName, part.itemCount])).toEqual([
      [CELL, 3],
      [SARYN_SYSTEMS, 1],
      [PLASM, 2],
    ]);
  });

  it("treats the two spellings of one part as one child", () => {
    const parent = "/Lotus/Powersuits/Nyx/NyxPrime";
    const chassis = "/Lotus/Types/Recipes/WarframeRecipes/NyxPrimeChassisComponent";
    const parts = partsConsumedBy(
      parent,
      entry(
        [{ uniqueName: chassis }],
        [{ uniqueName: `${chassis.replace(/Component$/, "Blueprint")}`, count: 1 }],
      ),
    );
    expect(parts).toEqual([{ uniqueName: chassis, itemCount: 1 }]);
  });
});

describe("partConsumerIndex", () => {
  it("answers under either spelling and counts a link once", () => {
    const index = partConsumerIndex(db);
    expect(consumersOf(index, LINK)).toEqual([{ parent: AKBRONCO, perBuild: 1 }]);
    expect(consumersOf(index, `${LINK}Blueprint`)).toEqual([{ parent: AKBRONCO, perBuild: 1 }]);
    expect(consumersOf(index, BRONCO)).toEqual([{ parent: AKBRONCO, perBuild: 2 }]);
    expect(consumersOf(index, SARYN_SYSTEMS)).toEqual([{ parent: CHROMA_SYSTEMS, perBuild: 1 }]);
    expect(consumersOf(index, "/Lotus/Nothing")).toEqual([]);
  });

  it("caches per item database identity", () => {
    expect(partConsumerIndex(db)).toBe(partConsumerIndex(db));
    expect(partConsumerIndex({ ...db })).not.toBe(partConsumerIndex(db));
  });
});

describe("isCraftingResource / isReservablePart", () => {
  it("flags resource and research paths only", () => {
    expect(isCraftingResource(CELL)).toBe(true);
    expect(isCraftingResource("/Lotus/Types/Items/Research/DojoColors/x")).toBe(true);
    expect(isCraftingResource(LINK)).toBe(false);
  });

  it("reserves recipe products and built gear, never gathered resources", () => {
    expect(isReservablePart(LINK, undefined)).toBe(true);
    expect(isReservablePart(SARYN_SYSTEMS, undefined)).toBe(true);
    expect(isReservablePart(BRONCO, db[BRONCO])).toBe(true);
    expect(isReservablePart(CELL, undefined)).toBe(false);
    expect(isReservablePart(PLASM, undefined)).toBe(false);
    expect(isReservablePart("/Lotus/Types/Items/Gems/Solaris/x", undefined)).toBe(false);
  });
});

describe("partDemandAliases", () => {
  const AMBASSADOR = "/Lotus/Weapons/Corpus/LongGuns/CrpArSniper/CrpArSniperRifle";
  const RECEIVER = "/Lotus/Types/Recipes/Weapons/WeaponParts/CrpArSniperReceiver";
  const RECEIVER_BP = "/Lotus/Types/Recipes/Weapons/WeaponParts/AmbassadorReceiverBlueprint";
  const SAGEK = "/Lotus/Weapons/Grineer/Pistols/GrnOrokinPistol/GrnOrokinPistol";
  const SAGEK_BP = "/Lotus/Types/Recipes/Weapons/SagekPrimeBlueprint";

  const renamed: Record<string, ItemDbEntry> = {
    [AMBASSADOR]: entry([{ uniqueName: RECEIVER }], undefined, { masterable: true }),
    [RECEIVER]: { name: "Ambassador Receiver", isBuildComponent: true, componentOf: AMBASSADOR },
    [RECEIVER_BP]: {
      name: "Ambassador Receiver Blueprint",
      isBuildComponent: true,
      componentOf: AMBASSADOR,
      buildsProduct: RECEIVER,
    },
    [SAGEK]: { name: "Sagek Prime", masterable: true },
    [SAGEK_BP]: {
      name: "Sagek Prime Blueprint",
      isBuildComponent: true,
      componentOf: SAGEK,
      buildsProduct: SAGEK,
    },
  };

  it("reaches the part a renamed blueprint builds", () => {
    const aliases = partDemandAliases(RECEIVER_BP, renamed);
    expect(aliases).toContain(RECEIVER_BP);
    expect(aliases).toContain(RECEIVER);
  });

  it("keeps whole gear out of its own blueprint's aliases", () => {
    expect(partDemandAliases(SAGEK_BP, renamed)).not.toContain(SAGEK);
  });

  it("falls back to the stem aliases for a name the database does not carry", () => {
    expect(partDemandAliases(LINK, renamed)).toEqual(componentUniqueNameAliases(LINK));
  });
});

describe("componentParentOf", () => {
  it("finds the parent under either spelling and null for whole items", () => {
    const chassis = "/Lotus/Types/Recipes/WarframeRecipes/NyxPrimeChassisComponent";
    const parent = "/Lotus/Powersuits/Nyx/NyxPrime";
    const withParent: Record<string, ItemDbEntry> = {
      [chassis]: { name: "Nyx Prime Chassis", isBuildComponent: true, componentOf: parent },
      [parent]: entry([{ uniqueName: chassis }]),
    };
    expect(componentParentOf(chassis, withParent)).toBe(parent);
    expect(componentParentOf(chassis.replace(/Component$/, "Blueprint"), withParent)).toBe(parent);
    expect(componentParentOf(parent, withParent)).toBeNull();
  });

  it("ignores componentOf on a whole weapon or resource that is no build component", () => {
    const lex = "/Lotus/Weapons/Tenno/Pistol/PrimeLex";
    const aklex = "/Lotus/Weapons/Tenno/Pistol/PrimeAkLex";
    const db: Record<string, ItemDbEntry> = {
      [lex]: { name: "Lex Prime", masterable: true, componentOf: aklex },
      [aklex]: entry([{ uniqueName: lex, itemCount: 2 }]),
    };
    expect(componentParentOf(lex, db)).toBeNull();
  });
});
