import { beforeAll, describe, expect, it, vi } from "vitest";

// None of these uniqueNames are in the bundled export.
const SHOCK_COILS = "/Lotus/Upgrades/Mods/Pistol/Event/Nightwave/NightwaveLasGooPistolAugmentMod";
const LITH_B12 = "/Lotus/Types/Game/Projections/T1VoidProjectionProteaIvaraVaultAGold";
const LITH_BASE = "/Lotus/Types/Game/Projections/T1VoidProjection";
const NEW_BLUEPRINT = "/Lotus/Types/Recipes/Components/SurgeEximusBallBlueprint";
const NEW_RESULT = "/Lotus/Types/Items/Gameplay/Eximus/SurgeEximusBall";

vi.mock("../../services/publicExportSource", () => ({
  loadOverlayFromDisk: () => null,
  refreshOverlayFromDE: async () => ({ changed: false }),
  getOverlay: () => ({
    exports: {
      ExportUpgrades: {
        [SHOCK_COILS]: {
          uniqueName: SHOCK_COILS,
          name: "Prototype Shock Coils",
          icon: "/Lotus/Interface/Cards/Images/Nightwave/NightwaveLasGooPistolAugmentMod.jpg",
        },
      },
      ExportResources: {
        [LITH_B12]: { uniqueName: LITH_B12, name: "Lith B12 Relic", parentName: LITH_BASE },
        [LITH_BASE]: { uniqueName: LITH_BASE, name: "Void Projection" },
        [NEW_RESULT]: { uniqueName: NEW_RESULT, name: "Surge Eximus Specter" },
      },
      ExportRecipes: {
        [NEW_BLUEPRINT]: {
          uniqueName: NEW_BLUEPRINT,
          resultType: NEW_RESULT,
          buildPrice: 5000,
          buildTime: 3600,
          num: 1,
          ingredients: [{ ItemType: "/Lotus/Types/Items/MiscItems/Circuits", ItemCount: 10 }],
        },
      },
    },
    images: null,
  }),
}));

import * as itemDb from "../../services/itemDatabase";

describe("itemDatabase DE overlay gap-fill", () => {
  beforeAll(() => {
    itemDb.buildDatabase();
  });

  it("names a mod the bundled package never shipped", () => {
    const mod = itemDb.lookupItem(SHOCK_COILS);

    expect(mod?.name).toBe("Prototype Shock Coils");
    expect(mod?.category).toBe("Mod");
    expect(mod?.nameIsFallback).toBeUndefined();
  });

  it("names a relic DE lists only under resources", () => {
    expect(itemDb.lookupItem(LITH_B12)?.name).toBe("Lith B12 Relic");
  });

  it("files a relic DE lists only under resources as a Relic", () => {
    expect(itemDb.lookupItem(LITH_B12)?.category).toBe("Relic");
  });

  it("leaves the projection base type a Resource", () => {
    expect(itemDb.lookupItem(LITH_BASE)?.category).toBe("Resource");
  });

  it("takes a recipe from the overlay without calling its blueprint a market offer", () => {
    const built = itemDb.lookupItem(NEW_RESULT);

    expect(built?.name).toBe("Surge Eximus Specter");
    expect(itemDb.getRendererLookup()[NEW_BLUEPRINT]?.buildsProduct).toBe(NEW_RESULT);
    expect(built?.marketBuyable).toBeUndefined();
  });
});
