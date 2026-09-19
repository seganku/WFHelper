import { beforeAll, describe, expect, it, vi } from "vitest";

import * as itemDb from "../../services/itemDatabase";
import * as publicExportSource from "../../services/publicExportSource";
import { deriveGroup } from "../../src/lib/inventory/itemClassification";
import { partDemandAliases } from "../../src/lib/inventory/partConsumers";
import type { ItemDbEntry } from "../../src/types/inventory";

function aliasDb(keys: readonly string[]): Record<string, ItemDbEntry> {
  const lookup = itemDb.getRendererLookup();
  const db: Record<string, ItemDbEntry> = {};
  for (const key of keys) {
    const entry = lookup[key];
    if (!entry) continue;
    db[key] = {
      name: entry.name,
      isBuildComponent: entry.isBuildComponent,
      ...(entry.componentOf ? { componentOf: entry.componentOf } : {}),
      ...(entry.buildsProduct ? { buildsProduct: entry.buildsProduct } : {}),
    };
  }
  return db;
}

describe("itemDatabase WFCD alias enrichment", () => {
  beforeAll(() => {
    itemDb.buildDatabase();
  });

  it("maps generic blueprint names to canonical market-facing labels", () => {
    const aeolakBarrel = itemDb.lookupItem(
      "/Lotus/Types/Recipes/Weapons/WeaponParts/DuviriRifleBarrelBlueprint",
    );
    const ghoulsawBlade = itemDb.lookupItem(
      "/Lotus/Types/Recipes/Weapons/WeaponParts/GrnGhoulSawBladeBlueprint",
    );

    expect(aeolakBarrel?.name).toBe("Aeolak Barrel Blueprint");
    expect(ghoulsawBlade?.name).toBe("Ghoulsaw Blade Blueprint");
    expect(aeolakBarrel?.nameIsFallback).toBeUndefined();
    expect(ghoulsawBlade?.nameIsFallback).toBeUndefined();
  });

  it("keeps known tradable recipe entries tradable", () => {
    const innodemBlueprint = itemDb.lookupItem(
      "/Lotus/Types/Recipes/Weapons/Evolving/ZarimanDaggerWeaponBlueprint",
    );

    expect(innodemBlueprint?.name).toBe("Innodem Blueprint");
    expect(innodemBlueprint?.tradable).toBe(true);
  });

  it("resolves relic reward display names to the actual prime part entry", () => {
    const resolved = itemDb.lookupItemByNameOrSlug(
      "Akarius Prime Blueprint",
      "akarius_prime_blueprint",
    );

    expect(resolved?.uniqueName).toBe("/Lotus/Types/Recipes/Weapons/AkariusPrimeBlueprint");
    expect(resolved?.item.ducats).toBe(100);
    expect(resolved?.item.componentOf).toBe(
      "/Lotus/Weapons/Tenno/Pistols/PrimeAkarius/PrimeAkariusWeapon",
    );
  });

  it("links renamed part blueprints to their parent + product via resultType", () => {
    const receiverBp = itemDb.lookupItem(
      "/Lotus/Types/Recipes/Weapons/WeaponParts/AmbassadorReceiverBlueprint",
    );
    expect(receiverBp?.isBuildComponent).toBe(true);
    expect(receiverBp?.componentOf).toBe(
      "/Lotus/Weapons/Corpus/LongGuns/CrpArSniper/CrpArSniperRifle",
    );

    const lookup = itemDb.getRendererLookup();
    const rendererBp =
      lookup["/Lotus/Types/Recipes/Weapons/WeaponParts/AmbassadorReceiverBlueprint"];
    expect(rendererBp?.buildsProduct).toBe(
      "/Lotus/Types/Recipes/Weapons/WeaponParts/CrpArSniperReceiver",
    );
    expect(lookup[rendererBp?.buildsProduct || ""]?.recipe).toBeTruthy();
  });

  it("gives a renamed part blueprint the alias every recipe names it by", () => {
    const receiverBp = "/Lotus/Types/Recipes/Weapons/WeaponParts/AmbassadorReceiverBlueprint";
    const receiver = "/Lotus/Types/Recipes/Weapons/WeaponParts/CrpArSniperReceiver";
    const weaponBp = "/Lotus/Types/Recipes/Weapons/SagekPrimeBlueprint";
    const weapon = "/Lotus/Weapons/Grineer/Pistols/GrnOrokinPistol/GrnOrokinPistol";
    const db = aliasDb([receiverBp, receiver, weaponBp, weapon]);

    expect(Object.keys(db)).toHaveLength(4);
    expect(partDemandAliases(receiverBp, db)).toContain(receiver);
    expect(partDemandAliases(weaponBp, db)).not.toContain(weapon);
  });

  it("preserves unresolved weapon-part tradability as unknown for renderer heuristics", () => {
    const corufellHandle = itemDb.lookupItem(
      "/Lotus/Types/Recipes/Weapons/WeaponParts/GunScytheHandle",
    );

    expect(corufellHandle?.name).toBe("Corufell Handle");
    expect(corufellHandle?.tradable).toBeUndefined();
  });

  it("names blueprints whose crafted item loads after ExportRecipes", () => {
    const largeEnergy = itemDb.lookupItem(
      "/Lotus/Weapons/ClanTech/Energy/LargeHundredTeamEnergyBlueprint",
    );
    const mediumEnergy = itemDb.lookupItem(
      "/Lotus/Weapons/ClanTech/Energy/ClanTeamEnergyBlueprint",
    );

    expect(largeEnergy?.name).toBe("Squad Energy Restore (Large) Blueprint");
    expect(mediumEnergy?.name).toBe("Squad Energy Restore (Medium) Blueprint");
    expect(largeEnergy?.nameIsFallback).toBeUndefined();
    expect(mediumEnergy?.nameIsFallback).toBeUndefined();
  });

  it("names a part blueprint once when its component already reads Blueprint", () => {
    const chassis = itemDb.lookupItem(
      "/Lotus/Types/Recipes/WarframeRecipes/CalibanPrimeChassisBlueprint",
    );
    const systems = itemDb.lookupItem(
      "/Lotus/Types/Recipes/WarframeRecipes/CalibanPrimeSystemsBlueprint",
    );

    expect(chassis?.name).toBe("Caliban Prime Chassis Blueprint");
    expect(systems?.name).toBe("Caliban Prime Systems Blueprint");

    const doubled = Object.values(itemDb.getRendererLookup()).filter((entry) =>
      /blueprint blueprint$/i.test(entry.name || ""),
    );
    expect(doubled).toEqual([]);
  });

  it("keeps @wfcd comp names whose head overlaps the parent name", () => {
    const bonewidowPod = itemDb.lookupItem(
      "/Lotus/Types/Gameplay/InfestedMicroplanet/Resources/Mechs/ThanomechPartWeaponPodItem",
    );
    const cortegeBarrel = itemDb.lookupItem(
      "/Lotus/Types/Gameplay/InfestedMicroplanet/Resources/Mechs/ThanotechArchGunBarrelItem",
    );
    const mandachordBody = itemDb.lookupItem("/Lotus/Types/Keys/BardQuest/BardQuestSequencerPartA");
    const warBlade = itemDb.lookupItem("/Lotus/Types/Recipes/Weapons/WeaponParts/WarBlade");
    const decurionBarrel = itemDb.lookupItem(
      "/Lotus/Types/Recipes/Weapons/WeaponParts/ArchHeavyPistolsBarrel",
    );

    expect(bonewidowPod?.name).toBe("Bonewidow Weapon Pod");
    expect(cortegeBarrel?.name).toBe("Cortege Barrel");
    expect(mandachordBody?.name).toBe("Mandachord Body");
    expect(warBlade?.name).toBe("War Blade");
    expect(decurionBarrel?.name).toBe("Decurion Barrel");

    // standalone tradables that appear as comps of the buildable mech parts -
    // no word overlap with the parent, guarded by the standalone-item check
    const damagedPod = itemDb.lookupItem(
      "/Lotus/Types/Gameplay/InfestedMicroplanet/Resources/Mechs/DamagedMechPartSystemsItem",
    );
    const damagedWeaponBarrel = itemDb.lookupItem(
      "/Lotus/Types/Gameplay/InfestedMicroplanet/Resources/Mechs/DamagedMechWeaponBarrelItem",
    );

    expect(damagedPod?.name).toBe("Damaged Necramech Pod");
    expect(damagedWeaponBarrel?.name).toBe("Damaged Necramech Weapon Barrel");

    // scoped to component-derived entries: standalone items may legitimately
    // repeat words ("On-lyne: Yeah Yeah Baby Poster")
    const doubled = Object.values(itemDb.getRendererLookup()).filter(
      (entry) =>
        (entry.isBuildComponent || entry.componentOf) &&
        /\b(\w+(?: \w+){0,3}) \1\b/i.test(entry.name || ""),
    );
    expect(doubled).toEqual([]);
  });

  it("marks crafted Necramech parts tradable but not their Father blueprints", () => {
    const casingPath =
      "/Lotus/Types/Gameplay/InfestedMicroplanet/Resources/Mechs/NecromechPartChassisItem";
    const casing = itemDb.lookupItem(casingPath);
    const capsule = itemDb.lookupItem(
      "/Lotus/Types/Gameplay/InfestedMicroplanet/Resources/Mechs/ThanomechPartSystemsItem",
    );
    const morghaStock = itemDb.lookupItem(
      "/Lotus/Types/Gameplay/InfestedMicroplanet/Resources/Mechs/ThanotechGrenadeLauncherStockItem",
    );
    const casingBlueprint = itemDb.lookupItem(
      "/Lotus/Types/Recipes/DeimosRecipes/Mechs/NecromechPartChassisBlueprint",
    );

    expect(casing?.tradable).toBe(true);
    expect(
      casing &&
        deriveGroup(
          "MiscItems",
          casingPath,
          {
            name: casing.name,
            category: casing.category,
            type: casing.type,
            tradable: casing.tradable,
          },
          { name: casing.name, imageUrl: casing.imageUrl },
        ),
    ).toBe("all_parts");
    expect(capsule?.tradable).toBe(true);
    expect(morghaStock?.tradable).toBe(true);
    expect(casingBlueprint?.tradable).not.toBe(true);
  });

  it("carries @wfcd vault status onto prime parts and their blueprints", () => {
    const frame = itemDb.lookupItem("/Lotus/Powersuits/Wraith/SevagothPrime");
    const chassisBp = itemDb.lookupItem(
      "/Lotus/Types/Recipes/WarframeRecipes/SevagothPrimeChassisBlueprint",
    );
    const unvaulted = itemDb.lookupItem("/Lotus/Powersuits/Sentient/CalibanPrime");

    expect(frame?.vaulted).toBe(true);
    expect(chassisBp?.vaulted).toBe(true);
    expect(unvaulted?.vaulted).toBe(false);
  });

  it("mirrors browse.wf icons instead of exposing upstream URLs", () => {
    const boarPrime = itemDb.lookupItem("/Lotus/Weapons/Tenno/Shotgun/PrimeBoar");
    const boarBarrel = itemDb.lookupItem(
      "/Lotus/Types/Recipes/Weapons/WeaponParts/BoarPrimeBarrel",
    );

    expect(boarPrime?.imageUrl).toBe(
      "https://assets.wfhelper.com/icons/f79f9d2264f511aceb6c4358.png",
    );
    expect(boarBarrel?.imageUrl).toBe(
      "https://assets.wfhelper.com/icons/493b1285dd73868e5da6ca92.png",
    );
  });
});

describe("itemDatabase reusable blueprints", () => {
  const CELL_BP = "/Lotus/Types/Recipes/Components/OrokinCellResourceBlueprint";
  const FORMA_BP = "/Lotus/Types/Recipes/Components/FormaBlueprint";

  beforeAll(() => {
    itemDb.buildDatabase();
  });

  it("reads consumeOnUse straight off DE's export", () => {
    expect(itemDb.isReusableBlueprint(CELL_BP)).toBe(true);
    expect(itemDb.isReusableBlueprint(FORMA_BP)).toBe(false);
    expect(itemDb.isReusableBlueprint("/Lotus/Types/Nope")).toBe(false);
  });

  it("hands the flag to the renderer on the blueprint entry itself", () => {
    const lookup = itemDb.getRendererLookup();

    expect(lookup[CELL_BP]?.reusableBlueprint).toBe(true);
    expect(lookup[FORMA_BP]?.reusableBlueprint).toBeUndefined();
  });
});

describe("itemDatabase name and slug index", () => {
  const AKARIUS_BP = "/Lotus/Types/Recipes/Weapons/AkariusPrimeBlueprint";

  beforeAll(() => {
    itemDb.buildDatabase();
  });

  it("resolves from either half on its own", () => {
    expect(itemDb.lookupItemByNameOrSlug(null, "akarius_prime_blueprint")?.uniqueName).toBe(
      AKARIUS_BP,
    );
    expect(itemDb.lookupItemByNameOrSlug("Akarius Prime Blueprint", null)?.uniqueName).toBe(
      AKARIUS_BP,
    );
    expect(itemDb.lookupItemByNameOrSlug(null, null)).toBeNull();
    expect(itemDb.lookupItemByNameOrSlug("No Such Item", "no_such_item")).toBeNull();
  });

  it("rebuilds its index after the database is rebuilt", () => {
    itemDb.buildDatabase();

    expect(
      itemDb.lookupItemByNameOrSlug("Akarius Prime Blueprint", "akarius_prime_blueprint")
        ?.uniqueName,
    ).toBe(AKARIUS_BP);
  });

  // The fixture is deterministic, so a stale index still answers with the right
  // uniqueName. Only object identity separates it from the rebuilt database.
  it("hands back the rebuilt entry, not the one it indexed before", () => {
    itemDb.lookupItemByNameOrSlug("Akarius Prime Blueprint", null);
    itemDb.buildDatabase();

    const indexed = itemDb.lookupItemByNameOrSlug("Akarius Prime Blueprint", null);
    expect(indexed?.item).toBe(itemDb.lookupItem(AKARIUS_BP));
  });
});

describe("itemDatabase sentinel weapon vaulting", () => {
  beforeAll(() => {
    itemDb.buildDatabase();
  });

  it("gives a bundled prime sentinel weapon its sentinel's vault status", () => {
    const shade = itemDb.lookupItem(
      "/Lotus/Types/Sentinels/SentinelPowersuits/PrimeShadePowerSuit",
    );
    const burstLaser = itemDb.lookupItem(
      "/Lotus/Types/Sentinels/SentinelWeapons/PrimeBurstLaserPistol",
    );
    expect(shade?.vaulted).toBe(true);
    expect(burstLaser?.vaulted).toBe(true);
  });
});

describe("itemDatabase fallback name provenance", () => {
  it("carries missing-source provenance to the renderer without guessing from the name", () => {
    const unresolved = "/Lotus/Weapons/Test/UnresolvedExportName";
    const literal = "/Lotus/Weapons/Test/LiteralExportName";
    const overlay = vi.spyOn(publicExportSource, "getOverlay").mockReturnValue({
      exports: {
        ExportWeapons: {
          [unresolved]: { name: "/Lotus/Language/Test/NotInDictionary" },
          [literal]: { name: "Literal Export Name" },
        },
      },
      images: null,
    });
    try {
      itemDb.buildDatabase();
      expect(itemDb.lookupItem(unresolved)).toMatchObject({
        name: "Unresolved Export Name",
        nameIsFallback: true,
      });
      const renderer = itemDb.getRendererLookup();
      expect(renderer[unresolved].nameIsFallback).toBe(true);
      expect(renderer[literal].name).toBe("Literal Export Name");
      expect(renderer[literal].nameIsFallback).toBeUndefined();
    } finally {
      overlay.mockRestore();
      itemDb.buildDatabase();
    }
  });
});
