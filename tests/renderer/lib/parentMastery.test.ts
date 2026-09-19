import { describe, expect, it } from "vitest";

import {
  attachPartMasteryFlags,
  buildPartMasteryResolver,
  itemMarksFor,
} from "../../../src/lib/parentMastery";
import type { SafetyVerdict } from "../../../src/lib/inventory/safetyRules";
import type { ItemDbEntry, MasteryData } from "../../../src/types/inventory";

const itemDb = {
  "/W/BratonPrime": {
    name: "Braton Prime",
    components: [{ name: "Barrel", uniqueName: "/W/BratonPrimeBarrel", itemCount: 1 }],
  },
  "/W/BratonPrimeBarrel": {
    name: "Braton Prime Barrel",
    isBuildComponent: true,
    componentOf: "/W/BratonPrime",
  },
  "/W/SomaPrime": {
    name: "Soma Prime",
    components: [{ name: "Stock", uniqueName: "/W/SomaPrimeStock", itemCount: 2 }],
  },
  "/W/SomaPrimeStock": {
    name: "Soma Prime Stock",
    isBuildComponent: true,
    componentOf: "/W/SomaPrime",
  },
  "/W/AnkyrosPrime": {
    name: "Ankyros Prime",
    components: [{ name: "Gauntlet", uniqueName: "/W/AnkyrosPrimeGauntlet", itemCount: 2 }],
  },
  "/W/AnkyrosPrimeGauntlet": {
    name: "Ankyros Prime Gauntlet",
    isBuildComponent: true,
    componentOf: "/W/AnkyrosPrime",
  },
  "/W/LexPrime": {
    name: "Lex Prime",
    components: [{ name: "Barrel", uniqueName: "/W/LexPrimeBarrel", itemCount: 1 }],
  },
  "/W/LexPrimeBarrel": {
    name: "Lex Prime Barrel",
    isBuildComponent: true,
    componentOf: "/W/LexPrime",
  },
  "/Types/Recipes/DayAspectComponent": {
    name: "Day Aspect",
    isBuildComponent: true,
  },
  "/Types/Recipes/DayAspectChassis": {
    name: "Day Aspect Chassis",
    isBuildComponent: true,
    componentOf: "/Types/Recipes/DayAspectComponent",
  },
} as unknown as Record<string, ItemDbEntry>;

const mastery = {
  items: [
    {
      name: "Braton Prime",
      uniqueName: "/W/BratonPrime",
      status: "mastered",
      currentlyOwned: true,
    },
    { name: "Soma Prime", uniqueName: "/W/SomaPrime", status: "progress", currentlyOwned: true },
    { name: "Ankyros Prime", uniqueName: "/W/AnkyrosPrime", status: "missing" },
    // Mastered and then sold: the mastery is banked, the weapon is gone.
    { name: "Lex Prime", uniqueName: "/W/LexPrime", status: "mastered", currentlyOwned: false },
  ],
} as unknown as MasteryData;

const resolve = buildPartMasteryResolver(itemDb, mastery);

describe("buildPartMasteryResolver", () => {
  it("marks a part of a mastered item yes and of an unmastered item no", () => {
    expect(
      resolve({ name: "Braton Prime Barrel", internalName: "/W/BratonPrimeBarrel" }).parentMastered,
    ).toBe(true);
    expect(
      resolve({ name: "Soma Prime Stock", internalName: "/W/SomaPrimeStock" }).parentMastered,
    ).toBe(false);
  });

  it("resolves blueprint-suffixed inventory keys through the alias", () => {
    expect(
      resolve({ name: "Soma Prime Stock", internalName: "/W/SomaPrimeStockBlueprint" })
        .parentMastered,
    ).toBe(false);
  });

  it("falls back to the display name when the key is unknown", () => {
    expect(
      resolve({ name: "Braton Prime Barrel", internalName: "/Unknown/Key" }).parentMastered,
    ).toBe(true);
  });

  it("resolves set rows through the base item", () => {
    expect(resolve({ name: "Braton Prime Set" }).parentMastered).toBe(true);
    expect(resolve({ name: "Soma Prime Set" }).parentMastered).toBe(false);
  });

  it("resolves a masterable row through itself", () => {
    expect(resolve({ name: "Soma Prime", internalName: "/W/SomaPrime" }).parentMastered).toBe(
      false,
    );
  });

  it("returns nothing for rows nothing masterable needs", () => {
    expect(resolve({ name: "Forma" })).toEqual({});
  });

  it("returns nothing without mastery data", () => {
    const cold = buildPartMasteryResolver(itemDb, null);
    expect(cold({ name: "Braton Prime Barrel", internalName: "/W/BratonPrimeBarrel" })).toEqual({});
  });

  it("reports a parent waiting in the foundry, and nothing for the other parts", () => {
    const claiming = buildPartMasteryResolver(itemDb, mastery, new Set(["/W/LexPrime"]));
    expect(claiming({ name: "Lex Prime Barrel", internalName: "/W/LexPrimeBarrel" })).toEqual({
      parentMastered: true,
      parentOwned: false,
      parentClaimable: true,
      component: true,
    });
    expect(
      claiming({ name: "Soma Prime Stock", internalName: "/W/SomaPrimeStock" }).parentClaimable,
    ).toBeUndefined();
  });

  it("matches a claimable parent across the Component and Blueprint spellings", () => {
    const claiming = buildPartMasteryResolver(
      itemDb,
      mastery,
      new Set(["/Types/Recipes/DayAspectBlueprint"]),
    );
    expect(
      claiming({ name: "Day Aspect Chassis", internalName: "/Types/Recipes/DayAspectChassis" }),
    ).toEqual({ parentClaimable: true, component: true });
  });

  it("reads a claimable parent on a set row too", () => {
    const claiming = buildPartMasteryResolver(itemDb, mastery, new Set(["/W/LexPrime"]));
    expect(claiming({ name: "Lex Prime Set" })).toEqual({
      parentMastered: true,
      parentOwned: false,
      parentClaimable: true,
    });
  });

  it("resolves the foundry alone when no mastery data has arrived", () => {
    const claiming = buildPartMasteryResolver(itemDb, null, new Set(["/W/LexPrime"]));
    expect(claiming({ name: "Lex Prime Barrel", internalName: "/W/LexPrimeBarrel" })).toEqual({
      parentClaimable: true,
      component: true,
    });
  });

  it("reports the build a part feeds as owned only while it is in the inventory", () => {
    expect(resolve({ name: "Braton Prime Barrel", internalName: "/W/BratonPrimeBarrel" })).toEqual({
      parentMastered: true,
      parentOwned: true,
      component: true,
    });
    expect(resolve({ name: "Lex Prime Barrel", internalName: "/W/LexPrimeBarrel" })).toEqual({
      parentMastered: true,
      parentOwned: false,
      component: true,
    });
    expect(resolve({ name: "Soma Prime Stock", internalName: "/W/SomaPrimeStock" })).toEqual({
      parentMastered: false,
      parentOwned: true,
      component: true,
    });
  });

  it("reads ownership on a set row too, since the set is not the built item", () => {
    expect(resolve({ name: "Lex Prime Set" })).toEqual({
      parentMastered: true,
      parentOwned: false,
    });
  });

  it("leaves the built row itself without an owned flag", () => {
    expect(resolve({ name: "Soma Prime", internalName: "/W/SomaPrime" })).toEqual({
      parentMastered: false,
    });
  });
});

describe("itemMarksFor", () => {
  it("shows M for a mastered parent and C only while it is owned", () => {
    expect(itemMarksFor({ parentMastered: true, parentOwned: true })).toEqual({
      mastered: true,
      crafted: true,
      foundry: false,
    });
    expect(itemMarksFor({ parentMastered: true, parentOwned: false })).toEqual({
      mastered: true,
      crafted: false,
      foundry: false,
    });
    expect(itemMarksFor({ parentMastered: false, parentOwned: true })).toEqual({
      mastered: false,
      crafted: true,
      foundry: false,
    });
  });

  it("shows F for a parent waiting in the foundry", () => {
    expect(itemMarksFor({ parentMastered: true, parentClaimable: true })).toEqual({
      mastered: true,
      crafted: false,
      foundry: true,
    });
  });

  it("lets C win over F, since the built parent is the stronger answer", () => {
    expect(itemMarksFor({ parentOwned: true, parentClaimable: true })).toEqual({
      mastered: false,
      crafted: true,
      foundry: false,
    });
  });

  it("shows nothing for a row no mastery pass stamped", () => {
    expect(itemMarksFor({})).toEqual({ mastered: false, crafted: false, foundry: false });
  });
});

describe("attachPartMasteryFlags", () => {
  interface Row {
    name: string;
    internalName?: string;
    parentMastered?: boolean;
    spare?: boolean;
  }

  const rows: Row[] = [
    { name: "Braton Prime Barrel", internalName: "/W/BratonPrimeBarrel" },
    { name: "Ankyros Prime Gauntlet", internalName: "/W/AnkyrosPrimeGauntlet" },
    { name: "Forma" },
  ];

  it("stamps resolvable rows and leaves the rest untouched", () => {
    const [barrel, , forma] = attachPartMasteryFlags(rows, resolve);
    expect(barrel.parentMastered).toBe(true);
    expect(barrel.spare).toBeUndefined();
    expect(forma).toBe(rows[2]);
  });

  it("reads spare off the safety verdict, so the filter follows the badge", () => {
    const verdicts = new Map<string, SafetyVerdict>([
      ["/W/BratonPrimeBarrel", { total: 4, reserved: 0, safe: 4, reservations: [] }],
      ["/W/AnkyrosPrimeGauntlet", { total: 2, reserved: 2, safe: 0, reservations: [] }],
    ]);
    const [barrel, gauntlet, forma] = attachPartMasteryFlags(rows, resolve, verdicts);
    expect(barrel.spare).toBe(true);
    expect(gauntlet.spare).toBe(false);
    expect(gauntlet.parentMastered).toBe(false);
    // No verdict and no masterable owner leaves both filters skipping the row.
    expect(forma).toBe(rows[2]);
  });

  it("leaves spare unset on rows that are not build components", () => {
    const withForma: Row[] = [{ name: "Forma", internalName: "/W/Forma" }];
    const verdicts = new Map<string, SafetyVerdict>([
      ["/W/Forma", { total: 9, reserved: 1, safe: 8, reservations: [] }],
    ]);
    const [forma] = attachPartMasteryFlags(withForma, resolve, verdicts);
    expect(forma.spare).toBeUndefined();
  });
});
