import type {
  FoundryBuildingItem,
  FoundryData,
  FoundryRecipeItem,
  ItemDbEntry,
  RawInventoryData,
  RecipeIngredient,
  Resource,
} from "../../types/inventory.js";
import {
  MODULAR_PART_PATH,
  PET_PART_PATH,
  isResourceItem,
  resolveItem,
} from "./itemClassification.js";

function parseCompletionDate(value: unknown): Date | null {
  if (!value) return null;
  if (typeof value === "string" || typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "object") {
    const dateValue =
      (value as { $date?: { $numberLong?: string } | string | number }).$date ?? value;
    if (typeof dateValue === "object" && dateValue !== null && "$numberLong" in dateValue) {
      const ms = Number((dateValue as { $numberLong: string }).$numberLong);
      if (Number.isFinite(ms)) return new Date(ms);
      return null;
    }
    const date = new Date(dateValue as string | number);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/** Canonical display order, shared by the Foundry tabs and the Full Sets chips. */
export const EQUIPMENT_CATEGORY_ORDER = [
  "Warframe",
  "Primary",
  "Secondary",
  "Melee",
  "Archwing",
  "Companion",
  "Appearance",
  "Gear",
  "Modular",
  "Misc",
];

// Exported because the Full Sets category chips bucket sets the same way.
// Component blueprints inherit their parent's category because their own raw
// category is Resource.
export function classifyForFoundry(
  productUn: string | null,
  blueprintUn: string,
  itemDb: Record<string, ItemDbEntry>,
): string {
  const productEntry = productUn ? itemDb[productUn] : null;
  const productCategory = String(productEntry?.productCategory ?? "").toLowerCase();
  const category = String(productEntry?.category ?? "").toLowerCase();

  const parentUn = productEntry?.componentOf;
  const parentEntry = parentUn ? itemDb[parentUn] : null;
  const parentCategory = String(parentEntry?.category ?? "").toLowerCase();
  const parentProductCategory = String(parentEntry?.productCategory ?? "").toLowerCase();

  const joinedPath = `${productUn ?? ""} ${parentUn ?? ""} ${blueprintUn}`.toLowerCase();

  // Moa parts sit under /Pets/ as well and belong to Modular, so this answers
  // before the pet path. Hound parts match only the pet path and stay Companion.
  if (MODULAR_PART_PATH.test(joinedPath)) return "Modular";

  // Pet parts (Infested critter mutagens etc.) carry PEP productCategory
  // "Pistols" which would wrongly bucket them as Secondary. Path wins.
  if (PET_PART_PATH.test(joinedPath)) return "Companion";

  // Before the Warframe branch: Archwing suits live under /Powersuits/ as well.
  if (
    productCategory === "spacesuits" ||
    productCategory === "spaceguns" ||
    productCategory === "spacemelee" ||
    parentProductCategory === "spacesuits" ||
    parentProductCategory === "spaceguns" ||
    parentProductCategory === "spacemelee" ||
    category.startsWith("arch") ||
    parentCategory.startsWith("arch") ||
    /\/(archwing|spacesuits|spaceguns|spacemelee)\//.test(joinedPath)
  )
    return "Archwing";

  if (
    productCategory === "suits" ||
    productCategory === "mechsuits" ||
    parentProductCategory === "suits" ||
    parentProductCategory === "mechsuits" ||
    category === "warframe" ||
    category === "warframes" ||
    parentCategory === "warframe" ||
    parentCategory === "warframes" ||
    /\/(warframerecipes|powersuits)\//.test(joinedPath)
  )
    return "Warframe";

  if (
    productCategory === "sentinels" ||
    productCategory === "kubrowpets" ||
    parentProductCategory === "sentinels" ||
    parentProductCategory === "kubrowpets" ||
    category === "companion" ||
    category === "sentinels" ||
    category === "pets" ||
    parentCategory === "companion"
  )
    return "Companion";

  // Weapon slot split uses productCategory since PEP's raw category is "Weapon".
  if (
    productCategory === "longguns" ||
    parentProductCategory === "longguns" ||
    category === "primary" ||
    parentCategory === "primary"
  )
    return "Primary";
  if (
    productCategory === "pistols" ||
    parentProductCategory === "pistols" ||
    category === "secondary" ||
    parentCategory === "secondary"
  )
    return "Secondary";
  if (
    productCategory === "melee" ||
    parentProductCategory === "melee" ||
    category === "melee" ||
    parentCategory === "melee"
  )
    return "Melee";

  if (category === "gear" || parentCategory === "gear" || /\/gear\//.test(joinedPath))
    return "Gear";
  if (category === "cosmetic" || category === "appearance" || /\/customs\//.test(joinedPath))
    return "Appearance";

  return "Misc";
}

export function parseFoundry(
  data: RawInventoryData,
  itemDb: Record<string, ItemDbEntry>,
): FoundryData {
  const building: FoundryData["building"] = [];
  const recipes: FoundryData["recipes"] = [];

  const blueprintToProduct = new Map<string, string>();
  const ingredientSet = new Set<string>();
  for (const [productUn, entry] of Object.entries(itemDb)) {
    const recipe = entry?.recipe;
    if (!recipe) continue;
    if (recipe.blueprintUniqueName) {
      blueprintToProduct.set(recipe.blueprintUniqueName, productUn);
    }
    for (const ing of recipe.ingredients || []) {
      if (ing?.uniqueName) ingredientSet.add(ing.uniqueName);
    }
  }

  /** Resolve the *product* being built from a blueprint ItemType, falling back
   *  to the recipe entry itself if we can't map it. */
  function resolveProduct(blueprintItemType: string): {
    name: string;
    imageUrl: string | null;
    displayName?: string;
    productUniqueName: string | null;
    category: string;
  } {
    const productUn = blueprintToProduct.get(blueprintItemType) ?? null;
    const category = classifyForFoundry(productUn, blueprintItemType, itemDb);
    if (productUn) {
      const resolved = resolveItem(productUn, itemDb);
      return {
        name: resolved.name,
        ...(resolved.displayName ? { displayName: resolved.displayName } : {}),
        imageUrl: resolved.imageUrl ?? null,
        productUniqueName: productUn,
        category,
      };
    }
    const resolved = resolveItem(blueprintItemType, itemDb);
    return {
      // Strip a trailing "Blueprint" word so the card reads like the product.
      name: resolved.name.replace(/\s+Blueprint\s*$/i, "").trim() || resolved.name,
      ...(resolved.displayName ? { displayName: resolved.displayName } : {}),
      imageUrl: resolved.imageUrl ?? null,
      productUniqueName: null,
      category,
    };
  }

  // Prefer the product recipe; unmapped standalone blueprints may carry their own.
  function resolveRecipeDetails(
    productUn: string | null,
    blueprintUn: string,
  ): { ingredients: RecipeIngredient[]; buildPrice: number; buildTime: number } {
    const src = (productUn && itemDb[productUn]?.recipe) || itemDb[blueprintUn]?.recipe || null;
    if (!src) return { ingredients: [], buildPrice: 0, buildTime: 0 };
    return {
      ingredients: src.ingredients ?? [],
      buildPrice: typeof src.buildPrice === "number" ? src.buildPrice : 0,
      buildTime: typeof src.buildTime === "number" ? src.buildTime : 0,
    };
  }

  for (const recipe of data.PendingRecipes || []) {
    if (!recipe?.ItemType) continue;
    const blueprintUn = recipe.ItemType;
    const product = resolveProduct(blueprintUn);
    const details = resolveRecipeDetails(product.productUniqueName, blueprintUn);
    building.push({
      name: product.name,
      ...(product.displayName ? { displayName: product.displayName } : {}),
      imageUrl: product.imageUrl,
      endDate: parseCompletionDate(recipe.CompletionDate),
      uniqueName: blueprintUn,
      productUniqueName: product.productUniqueName,
      category: product.category,
      ingredients: details.ingredients,
      buildPrice: details.buildPrice,
    });
  }

  for (const recipe of data.Recipes || []) {
    if (!recipe?.ItemType) continue;
    const blueprintUn = recipe.ItemType;
    const product = resolveProduct(blueprintUn);
    const productUn = product.productUniqueName;
    const details = resolveRecipeDetails(productUn, blueprintUn);
    recipes.push({
      name: product.name,
      ...(product.displayName ? { displayName: product.displayName } : {}),
      imageUrl: product.imageUrl,
      count: typeof recipe.ItemCount === "number" ? recipe.ItemCount : 1,
      uniqueName: blueprintUn,
      productUniqueName: productUn,
      isIngredient: productUn
        ? ingredientSet.has(productUn) && !itemDb[productUn]?.componentOf
        : false,
      category: product.category,
      ingredients: details.ingredients,
      buildPrice: details.buildPrice,
      buildTime: details.buildTime,
    });
  }

  return { building, recipes };
}

export function parseResources(
  data: RawInventoryData,
  itemDb: Record<string, ItemDbEntry>,
): Resource[] {
  const resources = (data.MiscItems || [])
    .map((item) => {
      const internalName = item.ItemType || "";
      const resolved = resolveItem(internalName, itemDb);
      const dbEntry = itemDb[internalName] || {};
      if (!isResourceItem(internalName, dbEntry, resolved)) return null;

      return {
        name: resolved.name,
        ...(resolved.displayName ? { displayName: resolved.displayName } : {}),
        imageUrl: resolved.imageUrl ?? null,
        internalName,
        count: typeof item.ItemCount === "number" ? item.ItemCount : 0,
      };
    })
    .filter((item): item is Resource => item != null);

  return resources.sort((a, b) => b.count - a.count);
}

// Depth covers frame -> aggregate -> part chains (Equinox is the deepest at 3).
const CHAIN_MAX_DEPTH = 4;

/** Blueprint rows whose whole crafting chain is craftable right now: every
 *  missing ingredient is either owned or has an owned blueprint plus enough
 *  resources, all drawn from one shared pool so neither resources nor blueprint
 *  copies can double-spend. */
export function chainBuildableBlueprints(
  recipes: FoundryRecipeItem[],
  owned: ReadonlyMap<string, number>,
  itemDb: Record<string, ItemDbEntry>,
): Set<string> {
  const recipeByProduct = new Map<string, FoundryRecipeItem>();
  for (const recipe of recipes) {
    if (recipe.count <= 0 || !recipe.productUniqueName) continue;
    if (!recipeByProduct.has(recipe.productUniqueName)) {
      recipeByProduct.set(recipe.productUniqueName, recipe);
    }
  }

  function satisfy(
    ingredients: RecipeIngredient[],
    multiplier: number,
    pool: Map<string, number>,
    blueprints: Map<string, number>,
    stack: Set<string>,
  ): boolean {
    for (const ing of ingredients) {
      const needed = ing.count * multiplier;
      const avail = pool.get(ing.uniqueName) ?? 0;
      const used = Math.min(avail, needed);
      if (used > 0) pool.set(ing.uniqueName, avail - used);
      const deficit = needed - used;
      if (deficit <= 0) continue;

      const sub = recipeByProduct.get(ing.uniqueName);
      if (!sub || sub.ingredients.length === 0) return false;
      if (stack.has(ing.uniqueName) || stack.size >= CHAIN_MAX_DEPTH) return false;
      const perBuild = itemDb[ing.uniqueName]?.recipe?.num || 1;
      const builds = Math.ceil(deficit / perBuild);
      // A run burns its blueprint unless DE marks it consumeOnUse=false, so N runs
      // of one part need N owned copies. The row count is the copies in hand.
      const bpUn = sub.uniqueName;
      const reusable =
        itemDb[ing.uniqueName]?.recipe?.reusableBlueprint === true ||
        (bpUn != null && itemDb[bpUn]?.reusableBlueprint === true);
      if (!reusable) {
        const copies = blueprints.get(ing.uniqueName) ?? sub.count;
        if (copies < builds) return false;
        blueprints.set(ing.uniqueName, copies - builds);
      }
      stack.add(ing.uniqueName);
      const ok = satisfy(sub.ingredients, builds, pool, blueprints, stack);
      stack.delete(ing.uniqueName);
      if (!ok) return false;
    }
    return true;
  }

  const result = new Set<string>();
  for (const recipe of recipes) {
    if (!recipe.uniqueName || recipe.count <= 0 || recipe.ingredients.length === 0) continue;
    const productUn = recipe.productUniqueName;
    // Loose parts stay hidden from the full-set view, so skip them here too.
    if (!productUn || itemDb[productUn]?.componentOf) continue;
    if (satisfy(recipe.ingredients, 1, new Map(owned), new Map(), new Set())) {
      result.add(recipe.uniqueName);
    }
  }
  return result;
}

/** Whether a foundry row can be started now: every ingredient in hand, or the
 *  whole chain craftable from owned blueprints. DE names an ingredient
 *  ...Component while the inventory holds the ...Blueprint it is built from, so
 *  the card status and the full-set filter must share this one predicate. */
export function isFoundryRecipeReady(
  recipe: Pick<FoundryRecipeItem, "uniqueName" | "ingredients">,
  owned: ReadonlyMap<string, number>,
  chainBuildable: ReadonlySet<string>,
): boolean {
  if (recipe.ingredients.length === 0) return false;
  const allOwned = recipe.ingredients.every((ing) => (owned.get(ing.uniqueName) ?? 0) >= ing.count);
  if (allOwned) return true;
  return recipe.uniqueName != null && chainBuildable.has(recipe.uniqueName);
}

/** uniqueNames sitting in the foundry, building or claimable: the product when the
 *  recipe resolved, else the blueprint itself so an alias lookup still finds it. */
export function foundryBuildProducts(foundry: FoundryData): Set<string> {
  const products = new Set<string>();
  for (const build of foundry.building) {
    const uniqueName = build.productUniqueName ?? build.uniqueName;
    if (uniqueName) products.add(uniqueName);
  }
  return products;
}

/** A finished build stays in the foundry, and keeps its parts spent, until the
 *  player claims it. */
export function isFoundryBuildClaimable(
  build: Pick<FoundryBuildingItem, "endDate">,
  nowMs: number,
): boolean {
  return build.endDate != null && build.endDate.getTime() <= nowMs;
}

/** The `foundryBuildProducts` subset that is finished and waiting to be claimed,
 *  keyed the same way so the same alias lookup finds it. */
export function foundryClaimableProducts(foundry: FoundryData, nowMs: number): Set<string> {
  const products = new Set<string>();
  for (const build of foundry.building) {
    if (!isFoundryBuildClaimable(build, nowMs)) continue;
    const uniqueName = build.productUniqueName ?? build.uniqueName;
    if (uniqueName) products.add(uniqueName);
  }
  return products;
}
