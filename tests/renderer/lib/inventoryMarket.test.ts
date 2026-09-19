import { afterEach, describe, expect, it } from "vitest";

import {
  EVERYTHING_DEFAULT_SOURCES,
  EVERYTHING_SOURCES,
  buildBaseInventoryItems,
  buildInventoryViewItems,
  buildOrderLookups,
  getLookupByName,
  metricNeedsFromFilters,
  shouldHydrateMetrics,
  type InventoryBaseItem,
  type ItemMetrics,
} from "../../../src/lib/inventoryMarket.js";
import type { WfmOrder } from "../../../src/types/market.js";
import type { WfmItemsLookup } from "../../../src/types/ipc.js";
import type { ItemDbEntry } from "../../../src/types/inventory.js";
import { parseInventory } from "../../../src/lib/inventory.js";
import { gameRefKey } from "../../../src/lib/marketNaming.js";
import type { RelicDatabase } from "../../../src/types/relics.js";
import { setCachedPrice } from "../../../src/lib/wfm/priceCache.js";
import {
  clearOrderSummaryCache,
  setCachedOrderSummary,
} from "../../../src/lib/wfm/orderSummaryCache.js";
import {
  importMetaFromSnapshot,
  importSetCatalogFromSnapshotMeta,
  resolveSnapshotSetSlug,
} from "../../../src/lib/wfm/wfmItemMeta.js";

afterEach(() => {
  importSetCatalogFromSnapshotMeta({});
});

function snapshotSetMeta(slugs: string[]): Parameters<typeof importSetCatalogFromSnapshotMeta>[0] {
  const allSlugs = [...slugs, ...Array.from({ length: 200 }, (_, index) => `catalog_${index}_set`)];
  return Object.fromEntries(
    allSlugs.map((slug) => [
      slug,
      {
        slug,
        ducats: null,
        setRoot: true,
        thumb: null,
        icon: null,
        timestamp: Date.now(),
      },
    ]),
  );
}

function makeBaseItem(overrides: Partial<InventoryBaseItem> = {}): InventoryBaseItem {
  return {
    name: "Sample Item",
    internalName: "/Lotus/Upgrades/Mods/Sample",
    category: "mods",
    categoryLabel: "Mod",
    rank: 0,
    maxRank: 10,
    imageUrl: "https://cdn.warframestat.us/img/sample_local.jpg",
    isPrime: false,
    masteryReq: 0,
    vaulted: false,
    tradable: true,
    description: "",
    components: [],
    drops: [],
    wikiaUrl: null,
    inventoryGroup: "mods",
    partType: "normal",
    amount: 1,
    favorite: false,
    equipped: false,
    orderPlaced: false,
    completeSets: null,
    marketSlug: "sample_item",
    marketThumb: "https://warframe.market/static/assets/sample_market_thumb.png",
    subtype: null,
    ...overrides,
  };
}

describe("inventoryMarket view mapping", () => {
  const nightwaveRef =
    "/Lotus/Upgrades/Mods/Pistol/Event/Nightwave/NightwaveLasGooPistolAugmentMod";
  const nightwaveCatalog: WfmItemsLookup = {
    [gameRefKey(nightwaveRef)]: {
      gameRef: nightwaveRef,
      item_name: "Prototype Shock Coils",
      url_name: "prototype_shock_coils",
      maxRank: 5,
    },
  };

  it("enriches an unknown inventory mod by gameRef without changing its ownership or key", () => {
    const parsed = parseInventory(
      { Upgrades: [{ ItemType: nightwaveRef, ItemCount: 1, Rank: 0 }] },
      {},
      new Set([gameRefKey(nightwaveRef)]),
    );
    const [mapped] = buildBaseInventoryItems(parsed, "mods", nightwaveCatalog, {}, {});
    expect(mapped).toMatchObject({
      name: "Prototype Shock Coils",
      maxRank: 5,
      rank: 0,
      amount: 1,
      marketSlug: "prototype_shock_coils",
      inventoryKey: parsed[0].inventoryKey,
      internalName: parsed[0].inventoryKey,
    });
    expect(parsed[0].name).toBe("Nightwave Las Goo Pistol Augment Mod");
    expect(mapped.nameIsFallback).toBeUndefined();
    expect(
      buildBaseInventoryItems(
        parseInventory({ Upgrades: [] }, {}, new Set([gameRefKey(nightwaveRef)])),
        "mods",
        nightwaveCatalog,
        {},
        {},
      ),
    ).toEqual([]);
  });

  it("repairs an item database fallback while retaining localized text and rank-split quantities", () => {
    const db: Record<string, ItemDbEntry> = {
      [nightwaveRef]: {
        name: "Nightwave Las Goo Pistol Augment Mod",
        nameIsFallback: true,
        displayName: "Prototyp-Schockspulen",
      },
    };
    const parsed = parseInventory(
      {
        Upgrades: [
          { ItemType: nightwaveRef, ItemCount: 2, Rank: 0 },
          { ItemType: nightwaveRef, ItemCount: 3, Rank: 5 },
        ],
      },
      db,
      new Set([gameRefKey(nightwaveRef)]),
    );
    const catalog: WfmItemsLookup = {
      [gameRefKey(nightwaveRef)]: {
        ...nightwaveCatalog[gameRefKey(nightwaveRef)],
        gameRef: nightwaveRef.toLowerCase(),
      },
      "nightwave las goo pistol augment mod": {
        url_name: "unrelated",
        item_name: "Nightwave Las Goo Pistol Augment Mod",
        maxRank: 10,
      },
    };
    const mapped = buildBaseInventoryItems(parsed, "mods", catalog, {}, {});
    expect(
      mapped.map(({ name, displayName, rank, maxRank, amount }) => ({
        name,
        displayName,
        rank,
        maxRank,
        amount,
      })),
    ).toEqual([
      {
        name: "Prototype Shock Coils",
        displayName: "Prototyp-Schockspulen",
        rank: 0,
        maxRank: 5,
        amount: 2,
      },
      {
        name: "Prototype Shock Coils",
        displayName: "Prototyp-Schockspulen",
        rank: 5,
        maxRank: 5,
        amount: 3,
      },
    ]);
    expect(mapped.map((item) => item.internalName)).toEqual(
      parsed.map((item) => item.inventoryKey),
    );
  });

  it("does not replace a generated name from a name-only market match", () => {
    const parsed = parseInventory({ Upgrades: [{ ItemType: nightwaveRef }] }, {});
    const [mapped] = buildBaseInventoryItems(
      parsed,
      "mods",
      {
        "nightwave las goo pistol augment mod": {
          url_name: "unrelated",
          item_name: "Nightwave Las Goo Pistol Augment Mod",
        },
      },
      {},
      {},
    );
    expect(mapped.name).toBe(parsed[0].name);
    expect(mapped.nameIsFallback).toBe(true);
  });

  it.each(["Prototype Shock Coils", "Nightwave Las Goo Pistol Augment Mod"])(
    "preserves the item database name %s and its localized display name",
    (name) => {
      const db: Record<string, ItemDbEntry> = {
        [nightwaveRef]: { name, displayName: "Prototyp-Schockspulen", tradable: true },
      };
      const parsed = parseInventory({ Upgrades: [{ ItemType: nightwaveRef }] }, db);
      const [mapped] = buildBaseInventoryItems(parsed, "mods", nightwaveCatalog, {}, {});
      expect(mapped.name).toBe(name);
      expect(mapped.displayName).toBe("Prototyp-Schockspulen");
      expect(mapped.maxRank).toBe(5);
    },
  );

  it.each([undefined, "/Lotus/Upgrades/Mods/Unrelated"])(
    "does not rename a fallback from an unverified gameRef %s",
    (gameRef) => {
      const parsed = parseInventory({ Upgrades: [{ ItemType: nightwaveRef }] }, {});
      const catalog: WfmItemsLookup = {
        [gameRefKey(nightwaveRef)]: {
          ...nightwaveCatalog[gameRefKey(nightwaveRef)],
          ...(gameRef ? { gameRef } : { gameRef: null }),
        },
      };
      const [mapped] = buildBaseInventoryItems(parsed, "mods", catalog, {}, {});
      expect(mapped.name).toBe(parsed[0].name);
      expect(mapped.maxRank).toBe(10);
    },
  );

  it("prefers market/thumb metadata for mods and arcanes", () => {
    const item = makeBaseItem();
    const metrics: Record<string, ItemMetrics> = {
      [item.internalName]: {
        platinum: 20,
        ducats: 45,
        slug: "sample_item",
        thumb: "https://warframe.market/static/assets/sample_meta_thumb.png",
        icon: "https://warframe.market/static/assets/sample_meta_icon.png",
        hasPrice: true,
        hasDucats: true,
        hasMeta: true,
      },
    };

    const [mapped] = buildInventoryViewItems([item], metrics);
    expect(mapped.displayImageUrl).toBe(
      "https://warframe.market/static/assets/sample_market_thumb.png",
    );
    expect(mapped.usesFallbackArt).toBe(false);
  });

  it("falls back to market thumb/meta icon when local icon is missing", () => {
    const item = makeBaseItem({ imageUrl: null, marketThumb: null });
    const metrics: Record<string, ItemMetrics> = {
      [item.internalName]: {
        platinum: null,
        ducats: null,
        slug: "sample_item",
        thumb: null,
        icon: "https://warframe.market/static/assets/sample_meta_icon.png",
        hasPrice: true,
        hasDucats: true,
        hasMeta: true,
      },
    };

    const [mapped] = buildInventoryViewItems([item], metrics);
    expect(mapped.displayImageUrl).toBe(
      "https://warframe.market/static/assets/sample_meta_icon.png",
    );
    expect(mapped.usesFallbackArt).toBe(false);
  });

  it("falls back to local item icon when market sources are unavailable", () => {
    const item = makeBaseItem({ marketThumb: null });
    const metrics: Record<string, ItemMetrics> = {
      [item.internalName]: {
        platinum: null,
        ducats: null,
        slug: "sample_item",
        thumb: null,
        icon: null,
        hasPrice: true,
        hasDucats: true,
        hasMeta: true,
      },
    };

    const [mapped] = buildInventoryViewItems([item], metrics);
    expect(mapped.displayImageUrl).toBe("https://cdn.warframestat.us/img/sample_local.jpg");
    expect(mapped.usesFallbackArt).toBe(true);
  });

  it("uses cached ranked order summaries when metrics are not yet hydrated", () => {
    clearOrderSummaryCache();
    const item = makeBaseItem({ marketSlug: "sample_item", maxRank: 10 });

    setCachedOrderSummary("sample_item", 0, { wts: 9, wtb: 4 });
    setCachedOrderSummary("sample_item", 10, { wts: 33, wtb: 21 });

    const [mapped] = buildInventoryViewItems([item], {});
    expect(mapped.wtsR0).toBe(9);
    expect(mapped.wtbR0).toBe(4);
    expect(mapped.wtsRmax).toBe(33);
    expect(mapped.wtbRmax).toBe(21);

    clearOrderSummaryCache();
  });

  it("marks only the matching rank row for ranked orders", () => {
    const r0 = makeBaseItem({ name: "Frost Jaw", rank: 0, marketSlug: "frost_jaw" });
    const r3 = makeBaseItem({ name: "Frost Jaw", rank: 3, marketSlug: "frost_jaw" });
    const { orderedNames, orderedSlugs } = buildOrderLookups({
      sell: [{ id: "o1", itemName: "Frost Jaw", itemUrlName: "frost_jaw", modRank: 0 } as WfmOrder],
      buy: [],
    });

    const rows = buildBaseInventoryItems([r0, r3], "mods", {}, orderedNames, orderedSlugs);
    expect(rows.map((row) => [row.rank, row.orderPlaced])).toEqual([
      [0, true],
      [3, false],
    ]);
  });

  it("never prices a built modular item off a same-name listing", () => {
    // warframe.market lists panzer_vulpaphyla, but the row is the pet the
    // player built and cannot trade.
    const build = makeBaseItem({
      name: "Panzer Vulpaphyla",
      internalName: "/Lotus/Types/Friendly/Pets/CreaturePets/ArmoredInfestedCatbrowPetPowerSuit",
      inventoryGroup: "equipment",
      category: "companions",
      categoryLabel: "Companion",
      tradable: false,
      marketSlug: null,
      modularParts: ["Adra Mutagen"],
    });
    const lookup = {
      "panzer vulpaphyla": {
        url_name: "panzer_vulpaphyla",
        item_name: "Panzer Vulpaphyla",
        thumb: null,
        icon: null,
        maxRank: 0,
        gameRef: null,
      },
    };
    const { orderedNames, orderedSlugs } = buildOrderLookups({ sell: [], buy: [] });

    const [row] = buildBaseInventoryItems([build], "equipment", lookup, orderedNames, orderedSlugs);
    expect(row.marketSlug).toBeNull();
  });

  it("keeps a hyphenated catalog slug so the order still matches", () => {
    // The Tektolyst arcanes are the only slugs warframe.market mints with
    // hyphens. Folding them to zid_an_asheir lost both the price and the badge.
    const gameRef = "/Lotus/Upgrades/CosmeticEnhancers/Antiques/StatusChanceOnUltimateHit";
    const arcane = makeBaseItem({
      name: "Zid-An Asheir",
      internalName: gameRef,
      inventoryGroup: "arcanes",
      category: "arcanes",
      categoryLabel: "Arcane",
      maxRank: 5,
      rank: 5,
      marketSlug: null,
    });
    const lookup = {
      [gameRef.toLowerCase()]: {
        url_name: "zid-an-asheir",
        item_name: "Zid-an Asheir",
        thumb: null,
        icon: null,
        maxRank: 5,
        gameRef,
      },
    };
    const { orderedNames, orderedSlugs } = buildOrderLookups({
      sell: [
        {
          id: "o1",
          itemName: "Zid-an Asheir",
          itemUrlName: "zid-an-asheir",
          modRank: 5,
        } as WfmOrder,
      ],
      buy: [],
    });

    const [row] = buildBaseInventoryItems([arcane], "arcanes", lookup, orderedNames, orderedSlugs);
    expect(row.marketSlug).toBe("zid-an-asheir");
    expect(row.orderPlaced).toBe(true);
  });

  it("marks every rank row for rank-less orders", () => {
    const r0 = makeBaseItem({ name: "Frost Jaw", rank: 0, marketSlug: "frost_jaw" });
    const r3 = makeBaseItem({ name: "Frost Jaw", rank: 3, marketSlug: "frost_jaw" });
    const { orderedNames, orderedSlugs } = buildOrderLookups({
      sell: [{ id: "o1", itemName: "Frost Jaw", itemUrlName: "frost_jaw" } as WfmOrder],
      buy: [],
    });

    const rows = buildBaseInventoryItems([r0, r3], "mods", {}, orderedNames, orderedSlugs);
    expect(rows.every((row) => row.orderPlaced)).toBe(true);
  });

  it("hydrates ducats by default on all-parts tab", () => {
    const needs = metricNeedsFromFilters(
      {
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
      },
      "all_parts",
    );

    expect(needs.price).toBe(true);
    expect(needs.ducats).toBe(true);
  });

  it("drops generated full-sets the catalog does not sell as a set", () => {
    const setItem = makeBaseItem({
      name: "Ayatan Amber Star Set",
      internalName: "/Lotus/Types/Items/FusionTreasures/OroFusexOrnamentB#set",
      inventoryGroup: "full_sets",
      category: "full_sets",
      categoryLabel: "Full Set",
      marketSlug: null,
    });

    const dropped = buildBaseInventoryItems(
      [setItem],
      "full_sets",
      { "soma prime set": { url_name: "soma_prime_set", item_name: "Soma Prime Set" } },
      {},
      {},
    );
    expect(dropped).toHaveLength(0);

    const kept = buildBaseInventoryItems(
      [setItem],
      "full_sets",
      {
        "ayatan amber star set": {
          url_name: "ayatan_amber_star_set",
          item_name: "Ayatan Amber Star Set",
          thumb: null,
          icon: null,
        },
      },
      {},
      {},
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].marketSlug).toBe("ayatan_amber_star_set");
  });

  it("keeps full sets listed when the market catalog never loaded", () => {
    const setItem = makeBaseItem({
      name: "Caliban Prime Set",
      internalName: "/Lotus/Powersuits/Sentient/CalibanPrime#set",
      inventoryGroup: "full_sets",
      category: "full_sets",
      categoryLabel: "Full Set",
      marketSlug: null,
    });

    const kept = buildBaseInventoryItems([setItem], "full_sets", {}, {}, {});

    expect(kept).toHaveLength(1);
    expect(kept[0].marketSlug).toBe("caliban_prime_set");
  });

  it("does not treat incomplete snapshot metadata as a deny list", () => {
    const incompleteMeta = snapshotSetMeta(["caliban_prime_set"]);
    for (const slug of Object.keys(incompleteMeta).slice(0, 2)) delete incompleteMeta[slug];

    expect(importSetCatalogFromSnapshotMeta(incompleteMeta)).toBe(0);
    expect(resolveSnapshotSetSlug(["seer_set"])).toBeUndefined();
  });

  it("uses the snapshot set catalog when the live catalog never loaded", () => {
    importSetCatalogFromSnapshotMeta(
      snapshotSetMeta(["caliban_prime_set", "silva_and_aegis_prime_set"]),
    );
    const caliban = makeBaseItem({
      name: "Caliban Prime Set",
      internalName: "/Lotus/Powersuits/Sentient/CalibanPrime#set",
      inventoryGroup: "full_sets",
      category: "full_sets",
      categoryLabel: "Full Set",
      marketSlug: null,
    });
    const seer = makeBaseItem({
      name: "Seer Set",
      internalName: "/Lotus/Weapons/Grineer/Pistols/GrineerPistol/GrnPistol#set",
      inventoryGroup: "full_sets",
      category: "full_sets",
      categoryLabel: "Full Set",
      marketSlug: null,
    });
    const silva = makeBaseItem({
      name: "Silva & Aegis Prime Set",
      internalName: "/Lotus/Weapons/Tenno/Melee/SwordsAndBoards/PrimeSilvaAegis#set",
      inventoryGroup: "full_sets",
      category: "full_sets",
      categoryLabel: "Full Set",
      marketSlug: null,
    });

    const kept = buildBaseInventoryItems([caliban, seer, silva], "full_sets", {}, {}, {});

    expect(kept.map((item) => [item.name, item.marketSlug])).toEqual([
      ["Caliban Prime Set", "caliban_prime_set"],
      ["Silva & Aegis Prime Set", "silva_and_aegis_prime_set"],
    ]);
  });

  it("applies snapshot membership to incomplete sets too", () => {
    importSetCatalogFromSnapshotMeta(snapshotSetMeta(["caliban_prime_set"]));
    const valid = makeBaseItem({
      name: "Caliban Prime Set",
      inventoryGroup: "incomplete_sets",
      category: "incomplete_sets",
      categoryLabel: "Incomplete Set",
    });
    const junk = makeBaseItem({
      name: "Seer Set",
      inventoryGroup: "incomplete_sets",
      category: "incomplete_sets",
      categoryLabel: "Incomplete Set",
    });

    const kept = buildBaseInventoryItems([valid, junk], "incomplete_sets", {}, {}, {});

    expect(kept.map((item) => item.name)).toEqual(["Caliban Prime Set"]);
  });

  it("drops all-parts entries without market mapping when tradability is unknown", () => {
    const unknownPart = makeBaseItem({
      name: "Broken War War Blade",
      internalName: "/Lotus/Types/Recipes/Weapons/WeaponParts/WarBlade",
      inventoryGroup: "all_parts",
      category: "all_parts",
      categoryLabel: "All Parts",
      tradable: false,
    });

    const mapped = buildBaseInventoryItems([unknownPart], "all_parts", {}, {}, {});
    expect(mapped).toHaveLength(0);
  });

  it("keeps explicit tradable all-parts entries even without direct lookup mapping", () => {
    const explicitTradablePart = makeBaseItem({
      name: "Some Tradable Part",
      internalName: "/Lotus/Types/Recipes/Weapons/WeaponParts/TestPart",
      inventoryGroup: "all_parts",
      category: "all_parts",
      categoryLabel: "All Parts",
      tradable: true,
    });

    const mapped = buildBaseInventoryItems([explicitTradablePart], "all_parts", {}, {}, {});
    expect(mapped).toHaveLength(1);
    expect(mapped[0].marketSlug).toBe("some_tradable_part");
  });

  it("matches helmet blueprint names against neuroptics lookup aliases", () => {
    const match = getLookupByName("Xaku Prime Helmet Blueprint", {
      "xaku prime neuroptics blueprint": {
        item_name: "Xaku Prime Neuroptics Blueprint",
        url_name: "xaku_prime_neuroptics_blueprint",
        thumb: null,
        icon: null,
      },
    });

    expect(match?.url_name).toBe("xaku_prime_neuroptics_blueprint");
  });

  it("matches component blueprint names against non-blueprint lookup aliases", () => {
    const match = getLookupByName("Nova Prime Chassis Blueprint", {
      "nova prime chassis": {
        item_name: "Nova Prime Chassis",
        url_name: "nova_prime_chassis",
        thumb: null,
        icon: null,
      },
    });

    expect(match?.url_name).toBe("nova_prime_chassis");
  });

  it("matches non-blueprint component names against blueprint lookup aliases", () => {
    const match = getLookupByName("Parallax Engines", {
      "parallax engines blueprint": {
        item_name: "Parallax Engines Blueprint",
        url_name: "parallax_engines_blueprint",
        thumb: null,
        icon: null,
      },
    });

    expect(match?.url_name).toBe("parallax_engines_blueprint");
  });

  it("matches hyphenated item names against space-normalized lookup aliases", () => {
    const match = getLookupByName("Riot-848 Stock Blueprint", {
      "riot 848 stock": {
        item_name: "Riot 848 Stock",
        url_name: "riot_848_stock",
        thumb: null,
        icon: null,
      },
    });

    expect(match?.url_name).toBe("riot_848_stock");
  });

  it("normalizes relic names and slugs using relic database mapping", () => {
    const relicItem = makeBaseItem({
      name: "Axi A1 Relic",
      internalName: "/Lotus/Types/Game/Projections/T4VoidProjectionEBronze",
      category: "relics",
      categoryLabel: "Relic",
      inventoryGroup: "relics",
      maxRank: 0,
      rank: 0,
    });

    const relicDb: RelicDatabase = {
      groups: {
        "Axi A1": {
          key: "Axi A1",
          name: "Axi A1",
          tier: "Axi",
          code: "A1",
          imageUrl: null,
          qualities: {},
        },
      },
      byUniqueName: {
        "/Lotus/Types/Game/Projections/T4VoidProjectionEBronze": {
          groupKey: "Axi A1",
          quality: "intact",
        },
      },
    };

    const [mapped] = buildBaseInventoryItems([relicItem], "relics", {}, {}, {}, relicDb);
    expect(mapped.name).toBe("Axi A1 Relic (Intact)");
    expect(mapped.subtype).toBe("intact");
    expect(mapped.marketSlug).toBe("axi_a1_relic");
  });

  it("keeps refinements apart: names, subtypes and order markers", () => {
    const relicDb: RelicDatabase = {
      groups: {
        "Axi A1": {
          key: "Axi A1",
          name: "Axi A1",
          tier: "Axi",
          code: "A1",
          imageUrl: null,
          qualities: {},
        },
      },
      byUniqueName: {
        "/Lotus/Types/Game/Projections/T4VoidProjectionEBronze": {
          groupKey: "Axi A1",
          quality: "intact",
        },
        "/Lotus/Types/Game/Projections/T4VoidProjectionEPlatinum": {
          groupKey: "Axi A1",
          quality: "radiant",
        },
      },
    };
    const rows = [
      makeBaseItem({
        name: "Axi A1 Relic",
        internalName: "/Lotus/Types/Game/Projections/T4VoidProjectionEBronze",
        category: "relics",
        categoryLabel: "Relic",
        inventoryGroup: "relics",
        maxRank: 0,
        rank: 0,
      }),
      makeBaseItem({
        name: "Axi A1 Relic (Radiant)",
        internalName: "/Lotus/Types/Game/Projections/T4VoidProjectionEPlatinum",
        category: "relics",
        categoryLabel: "Relic",
        inventoryGroup: "relics",
        maxRank: 0,
        rank: 0,
      }),
    ];

    const { orderedNames, orderedSlugs, orderedSubtypes } = buildOrderLookups({
      sell: [
        {
          id: "o1",
          orderType: "sell",
          platinum: 10,
          quantity: 1,
          visible: true,
          modRank: null,
          subtype: "radiant",
          itemId: null,
          itemName: "Axi A1 Relic",
          itemUrlName: "axi_a1_relic",
          itemThumb: null,
        },
      ],
      buy: [],
    });

    const mapped = buildBaseInventoryItems(
      rows,
      "relics",
      {},
      orderedNames,
      orderedSlugs,
      relicDb,
      orderedSubtypes,
    );
    expect(mapped.map((row) => row.name)).toEqual([
      "Axi A1 Relic (Intact)",
      "Axi A1 Relic (Radiant)",
    ]);
    // The radiant sell order marks only the radiant row.
    expect(mapped.map((row) => row.orderPlaced)).toEqual([false, true]);
  });

  it("sanitizes non-finite metric numbers to avoid NaN display values", () => {
    const item = makeBaseItem({
      inventoryGroup: "all_parts",
      category: "parts",
      categoryLabel: "Part",
      ducats: Number.NaN,
    });

    const metrics: Record<string, ItemMetrics> = {
      [item.internalName]: {
        platinum: Number.NaN,
        ducats: Number.NaN,
        slug: "sample_item",
        thumb: null,
        icon: null,
        hasPrice: true,
        hasDucats: true,
        hasMeta: true,
      },
    };

    const [mapped] = buildInventoryViewItems([item], metrics);
    expect(mapped.platinum).toBeNull();
    expect(mapped.ducats).toBeNull();
    expect(mapped.ducatonator).toBeNull();
  });

  it("uses WFM max rank metadata for mods/arcanes", () => {
    const item = makeBaseItem({ rank: 3, maxRank: 10, name: "Accelerated Blast" });
    const [mapped] = buildBaseInventoryItems(
      [item],
      "mods",
      {
        "accelerated blast": {
          url_name: "accelerated_blast",
          item_name: "Accelerated Blast",
          thumb: null,
          icon: null,
          maxRank: 3,
        },
      },
      {},
      {},
    );

    expect(mapped.maxRank).toBe(3);
    expect(mapped.rank).toBe(3);
  });

  it("reads cached ranked prices immediately when hydration metrics are empty", () => {
    const item = makeBaseItem({
      name: "Accelerated Blast",
      marketSlug: "accelerated_blast",
      rank: 3,
      maxRank: 3,
    });
    setCachedPrice("accelerated_blast:rank-v3:r3", 6);

    const [mapped] = buildInventoryViewItems([item], {});
    expect(mapped.platinum).toBe(6);
  });

  it("reads cached R0 and Rmax prices for ranked cards", () => {
    const item = makeBaseItem({
      name: "Serration",
      marketSlug: "serration",
      rank: 0,
      maxRank: 10,
    });
    setCachedPrice("serration:rank-v3:r0", 8);
    setCachedPrice("serration:rank-v3:r10", 82);

    const [mapped] = buildInventoryViewItems([item], {});
    expect(mapped.platinumR0).toBe(8);
    expect(mapped.platinumRmax).toBe(82);
    expect(mapped.platinum).toBe(8);
  });

  it("maps both R0 and Rmax prices for ranked cards", () => {
    const item = makeBaseItem({
      name: "Critical Delay",
      marketSlug: "critical_delay",
      rank: 0,
      maxRank: 10,
    });

    const metrics: Record<string, ItemMetrics> = {
      [item.internalName]: {
        platinum: null,
        platinumR0: 7,
        platinumRmax: 76,
        hasPriceR0: true,
        hasPriceRmax: true,
        ducats: null,
        slug: "critical_delay",
        thumb: null,
        icon: null,
        hasPrice: true,
        hasDucats: true,
        hasMeta: true,
      },
    };

    const [mapped] = buildInventoryViewItems([item], metrics);
    expect(mapped.platinumR0).toBe(7);
    expect(mapped.platinumRmax).toBe(76);
    expect(mapped.platinum).toBe(7);
  });

  it("builds one header card per mapped inventory item", () => {
    const viewItems = buildInventoryViewItems(
      [
        makeBaseItem({ internalName: "/Lotus/Upgrades/Mods/Test/A", amount: 250 }),
        makeBaseItem({ internalName: "/Lotus/Upgrades/Mods/Test/B", amount: 1 }),
      ],
      {},
    );
    expect(viewItems).toHaveLength(2);
  });

  it("resolves mod slug by gameRef mapping when name differs", () => {
    const item = makeBaseItem({
      name: "Primed Bane of Orokin",
      internalName: "/Lotus/Upgrades/Mods/Shotgun/Expert/WeaponShotgunFactionDamageCorruptedExpert",
      marketSlug: null,
    });

    const [mapped] = buildBaseInventoryItems(
      [item],
      "mods",
      {
        "/lotus/upgrades/mods/shotgun/expert/weaponshotgunfactiondamagecorruptedexpert": {
          url_name: "primed_cleanse_corrupted",
          item_name: "Primed Cleanse Orokin",
          gameRef: "/Lotus/Upgrades/Mods/Shotgun/Expert/WeaponShotgunFactionDamageCorruptedExpert",
          thumb: null,
          icon: null,
        },
      },
      {},
      {},
    );

    expect(mapped.marketSlug).toBe("primed_cleanse_corrupted");
    expect(mapped.name).toBe("Primed Bane of Orokin");
  });

  it("uses cached snapshot meta thumbnails for ranked items before hydration", () => {
    importMetaFromSnapshot({
      primed_continuity: {
        slug: "primed_continuity",
        ducats: null,
        setRoot: false,
        thumb: "https://warframe.market/static/assets/primed_continuity_thumb.png",
        icon: null,
        timestamp: Date.now(),
      },
    });

    const [mapped] = buildBaseInventoryItems(
      [
        makeBaseItem({
          name: "Primed Continuity",
          internalName: "/Lotus/Upgrades/Mods/PrimedContinuity",
          marketThumb: null,
          marketSlug: null,
        }),
      ],
      "mods",
      {
        "primed continuity": {
          url_name: "primed_continuity",
          item_name: "Primed Continuity",
          thumb: null,
          icon: null,
        },
      },
      {},
      {},
    );

    expect(mapped.marketThumb).toBe(
      "https://warframe.market/static/assets/primed_continuity_thumb.png",
    );
  });

  it("keeps untradable mods visible but without market indexing", () => {
    const item = makeBaseItem({
      name: "Amalgam Furax Body Count",
      tradable: false,
      internalName: "/Lotus/Upgrades/Mods/Custom/AmalgamFuraxBodyCount",
      marketSlug: null,
    });

    const [mapped] = buildBaseInventoryItems(
      [item],
      "mods",
      {
        "amalgam furax body count": {
          url_name: "amalgam_furax_body_count",
          item_name: "Amalgam Furax Body Count",
          thumb: null,
          icon: null,
        },
      },
      {},
      {},
    );

    expect(mapped.marketSlug).toBeNull();
    expect(shouldHydrateMetrics(mapped)).toBe(false);
  });

  it("hard-excludes veiled riven mods from ranked market indexing", () => {
    const item = makeBaseItem({
      name: "Pistol Riven Mod (Veiled)",
      internalName: "/Lotus/Upgrades/Mods/Randomized/Secondary/PistolRivenVeiled",
      marketSlug: null,
    });

    const [mapped] = buildBaseInventoryItems(
      [item],
      "mods",
      {
        "pistol riven mod (veiled)": {
          url_name: "pistol_riven_mod_(veiled)",
          item_name: "Pistol Riven Mod (Veiled)",
          thumb: null,
          icon: null,
        },
      },
      {},
      {},
    );

    expect(mapped.marketSlug).toBeNull();
    expect(shouldHydrateMetrics(mapped)).toBe(false);
  });

  it("hard-excludes blood for mods from ranked market indexing", () => {
    const item = makeBaseItem({
      name: "Blood For Energy",
      internalName: "/Lotus/Upgrades/Mods/DataSpike/Assassin/OnExecutionEnergyDropMod",
      marketSlug: null,
    });

    const [mapped] = buildBaseInventoryItems(
      [item],
      "mods",
      {
        "blood for energy": {
          url_name: "blood_for_energy",
          item_name: "Blood For Energy",
          thumb: null,
          icon: null,
        },
      },
      {},
      {},
    );

    expect(mapped.marketSlug).toBeNull();
    expect(shouldHydrateMetrics(mapped)).toBe(false);
  });
});

describe("everything tab", () => {
  const NEUTRAL_FILTERS = {
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
  } as const;

  it("collects every category in one pass", () => {
    const mod = makeBaseItem({ internalName: "/Mods/A", inventoryGroup: "mods" });
    const relic = makeBaseItem({
      internalName: "/Relics/A",
      inventoryGroup: "relics",
      tradable: true,
    });
    const equipment = makeBaseItem({
      internalName: "/Weapons/A",
      inventoryGroup: "equipment",
      tradable: true,
    });

    const rows = buildBaseInventoryItems([mod, relic, equipment], "everything", {}, {}, {});

    expect(rows.map((row) => row.inventoryGroup).sort()).toEqual(["equipment", "mods", "relics"]);
  });

  it("leaves incomplete sets to the Full Sets toggle", () => {
    const mod = makeBaseItem({ internalName: "/Mods/A", inventoryGroup: "mods" });
    const partial = makeBaseItem({
      internalName: "/Sets/Partial",
      inventoryGroup: "incomplete_sets",
      marketSlug: "partial_set",
    });

    const rows = buildBaseInventoryItems([mod, partial], "everything", {}, {}, {});

    expect(rows.map((row) => row.internalName)).toEqual(["/Mods/A"]);
  });

  it("hydrates ducats and ranked orders because it mixes both", () => {
    const needs = metricNeedsFromFilters({ ...NEUTRAL_FILTERS }, "everything");

    expect(needs.ducats).toBe(true);
    expect(needs.orders).toBe(true);
  });

  it("defaults to every source except generated full sets", () => {
    expect(EVERYTHING_SOURCES).toContain("full_sets");
    expect(EVERYTHING_DEFAULT_SOURCES).not.toContain("full_sets");
    expect(EVERYTHING_DEFAULT_SOURCES.length).toBe(EVERYTHING_SOURCES.length - 1);
  });
});
