import {
  componentUniqueNameAliases,
  ownedComponentCount,
} from "../../config/shared/componentNames.js";
import { fallbackNameFromUniqueName } from "../../config/shared/displayName.js";
import { mergeDuplicateIngredients } from "../../config/shared/recipeRows.js";
import { consumersOf, partConsumerIndex } from "./inventory/partConsumers.js";
import type { ItemDbEntry, RecipeData } from "../types/inventory.js";

export interface CraftingTreeNode {
  uniqueName: string;
  name: string;
  displayName?: string;
  imageUrl: string | null;
  count: number;
  owned: number;
  /** Copies actually crafted; a held blueprint counts in `owned` but not here. */
  built: number;
  missing: number;
  isCraftable: boolean;
  isBlueprintItem?: boolean;
  childrenHidden?: boolean;
  recipe: RecipeData | null;
  usedFor: Array<{
    uniqueName: string;
    name: string;
    displayName?: string;
    imageUrl: string | null;
  }>;
  children: CraftingTreeNode[];
}

interface CraftingTreeTally {
  uniqueName: string;
  name: string;
  displayName?: string;
  count: number;
  owned: number;
}

interface CraftingTreeSummary {
  totalCredits: number;
  minBuildTime: number;
  maxBuildTime: number;
  blueprints: CraftingTreeTally[];
  resources: CraftingTreeTally[];
}

const MAX_DEPTH = 5;

export const MAX_EXPAND_DEPTH = 3;

const LEAF_RESOURCE_PREFIXES = ["/Lotus/Types/Items/MiscItems/", "/Lotus/Types/Items/Research/"];

interface BuildContext {
  itemDb: Record<string, ItemDbEntry>;
  ownership: Map<string, number>;
  maxDepth: number;
}

export function buildCraftingTree(
  uniqueName: string,
  itemDb: Record<string, ItemDbEntry>,
  ownership: Map<string, number>,
): CraftingTreeNode | null {
  const item = itemDb[uniqueName];
  if (!item?.recipe) return null;

  return buildNode(
    { itemDb, ownership, maxDepth: MAX_DEPTH },
    uniqueName,
    1,
    item.recipe,
    0,
    findUsedFor(uniqueName, itemDb),
    new Set([uniqueName]),
    true,
  );
}

function isLeafResource(uniqueName: string): boolean {
  return LEAF_RESOURCE_PREFIXES.some((p) => uniqueName.startsWith(p));
}

/** Two spellings of one inventory pile - the game never hands out both. */
function isSameOwnedItem(a: string, b: string): boolean {
  return a === b || componentUniqueNameAliases(a).includes(b);
}

function isAncestor(ancestors: Iterable<string>, uniqueName: string): boolean {
  for (const ancestor of ancestors) {
    if (isSameOwnedItem(ancestor, uniqueName)) return true;
  }
  return false;
}

const materialNameCache = new WeakMap<Record<string, ItemDbEntry>, Map<string, string[]>>();

export function collectRecipeMaterialNames(
  uniqueName: string,
  itemDb: Record<string, ItemDbEntry>,
): string[] {
  let cache = materialNameCache.get(itemDb);
  if (!cache) {
    cache = new Map();
    materialNameCache.set(itemDb, cache);
  }
  const hit = cache.get(uniqueName);
  if (hit) return hit;

  const out = new Set<string>();
  walkMaterialNames(uniqueName, itemDb, 0, new Set(), out);
  const list = [...out];
  cache.set(uniqueName, list);
  return list;
}

function walkMaterialNames(
  uniqueName: string,
  itemDb: Record<string, ItemDbEntry>,
  depth: number,
  visited: Set<string>,
  out: Set<string>,
): void {
  if (depth > 4 || visited.has(uniqueName)) return;
  visited.add(uniqueName);
  const recipe = itemDb[uniqueName]?.recipe;
  if (!recipe) return;
  for (const ing of recipe.ingredients) {
    const name = itemDb[ing.uniqueName]?.name;
    if (name) out.add(name);
    if (!isLeafResource(ing.uniqueName)) {
      walkMaterialNames(ing.uniqueName, itemDb, depth + 1, visited, out);
    }
  }
}

function buildNode(
  ctx: BuildContext,
  uniqueName: string,
  count: number,
  recipe: RecipeData | null,
  depth: number,
  usedFor: CraftingTreeNode["usedFor"] = [],
  ancestors: Set<string> = new Set(),
  ignoreLeafRule = false,
): CraftingTreeNode {
  const { itemDb, ownership } = ctx;
  const item = itemDb[uniqueName];
  const name = item?.name || fallbackNameFromUniqueName(uniqueName);
  const imageUrl = item?.imageUrl || null;
  const owned = ownedComponentCount(uniqueName, ownership);
  const missing = Math.max(0, count - owned);

  const effectiveRecipe = !ignoreLeafRule && isLeafResource(uniqueName) ? null : recipe;

  // A run of the recipe can yield several units (num), so costs scale with runs.
  const builds = effectiveRecipe
    ? Math.max(1, Math.ceil(count / Math.max(1, effectiveRecipe.num || 1)))
    : 0;

  const children: CraftingTreeNode[] = [];
  if (effectiveRecipe && depth < ctx.maxDepth) {
    // Blueprints are not listed as ingredients.
    if (
      effectiveRecipe.blueprintUniqueName &&
      !isSameOwnedItem(uniqueName, effectiveRecipe.blueprintUniqueName) &&
      !isAncestor(ancestors, effectiveRecipe.blueprintUniqueName)
    ) {
      const bpUn = effectiveRecipe.blueprintUniqueName;
      const bpItem = itemDb[bpUn];
      const bpOwned = ownedComponentCount(bpUn, ownership);
      const bpNeeded = effectiveRecipe.reusableBlueprint ? 1 : builds;
      children.push({
        uniqueName: bpUn,
        name: bpItem?.name || `${name} Blueprint`,
        ...(bpItem?.displayName ? { displayName: bpItem.displayName } : {}),
        imageUrl: bpItem?.imageUrl || null,
        count: bpNeeded,
        owned: bpOwned,
        built: bpOwned,
        missing: Math.max(0, bpNeeded - bpOwned),
        isCraftable: false,
        isBlueprintItem: true,
        recipe: null,
        usedFor: [],
        children: [],
      });
    }

    for (const ing of aggregateIngredients(effectiveRecipe.ingredients)) {
      const ingItem = itemDb[ing.uniqueName];
      const ingRecipe = ingItem?.recipe || null;
      const nextCount = ing.count * builds;
      if (ancestors.has(ing.uniqueName)) {
        children.push(buildNode(ctx, ing.uniqueName, nextCount, null, depth + 1));
        continue;
      }
      const nextAncestors = new Set(ancestors);
      nextAncestors.add(ing.uniqueName);
      children.push(
        buildNode(ctx, ing.uniqueName, nextCount, ingRecipe, depth + 1, [], nextAncestors),
      );
    }
  }

  return {
    uniqueName,
    name,
    ...(item?.displayName ? { displayName: item.displayName } : {}),
    imageUrl,
    count,
    owned,
    built: builtPartCount({ uniqueName, count }, ownership, itemDb),
    missing,
    isCraftable: effectiveRecipe !== null,
    recipe: effectiveRecipe,
    usedFor,
    children,
  };
}

function aggregateIngredients(ingredients: RecipeData["ingredients"]): RecipeData["ingredients"] {
  return mergeDuplicateIngredients(
    ingredients,
    (ingredient) => ingredient.count,
    (ingredient, count) => ({ ...ingredient, count }),
  );
}

interface ExpandableRecipe {
  productUniqueName: string;
  recipe: RecipeData;
}

// A blueprint entry never carries a recipe of its own, so it roots through buildsProduct.
function resolveExpandableRecipe(
  uniqueName: string,
  itemDb: Record<string, ItemDbEntry>,
): ExpandableRecipe | null {
  const entry = itemDb[uniqueName];
  if (!entry) return null;
  if (entry.recipe) return { productUniqueName: uniqueName, recipe: entry.recipe };
  const productUniqueName = entry.buildsProduct;
  const product = productUniqueName ? itemDb[productUniqueName] : null;
  if (productUniqueName && product?.recipe) {
    return { productUniqueName, recipe: product.recipe };
  }
  return null;
}

export function canExpandCraftingNode(
  node: CraftingTreeNode,
  itemDb: Record<string, ItemDbEntry>,
  ancestors: readonly string[],
): boolean {
  if (node.children.length > 0 || node.childrenHidden) return false;
  if (missingUnits(node) <= 0) return false;
  const resolved = resolveExpandableRecipe(node.uniqueName, itemDb);
  if (!resolved) return false;
  return !ancestors.some(
    (ancestor) =>
      isSameOwnedItem(ancestor, node.uniqueName) ||
      isSameOwnedItem(ancestor, resolved.productUniqueName),
  );
}

function missingUnits(node: CraftingTreeNode): number {
  return Math.max(0, node.count - node.owned);
}

export type PartState = "owned" | "blueprint" | "missing";

interface PartRef {
  uniqueName: string;
  count: number;
  isBlueprintItem?: boolean;
}

// Components and blueprints live under /Types/Recipes/; anything else is a raw material.
const RECIPE_PATH = /\/Types\/Recipes\//i;

export function isRecipePartPath(uniqueName: string): boolean {
  return RECIPE_PATH.test(uniqueName);
}

/** DE's export carries duplicate result types (two Sagek Prime recipes both produce
 *  the Barrel), so the recipe index alone can name the wrong blueprint. */
function blueprintKeysOf(part: PartRef, itemDb: Record<string, ItemDbEntry>): ReadonlySet<string> {
  const keys = new Set<string>();
  const blueprint = itemDb[part.uniqueName]?.recipe?.blueprintUniqueName;
  if (blueprint !== undefined && blueprint !== part.uniqueName) keys.add(blueprint);
  for (const alias of componentUniqueNameAliases(part.uniqueName)) {
    if (alias !== part.uniqueName && itemDb[alias]?.buildsProduct !== undefined) keys.add(alias);
  }
  return keys;
}

function builtCopies(
  uniqueName: string,
  ownership: ReadonlyMap<string, number>,
  blueprints: ReadonlySet<string>,
): number {
  let built = 0;
  for (const alias of componentUniqueNameAliases(uniqueName)) {
    if (blueprints.has(alias)) continue;
    built = Math.max(built, ownership.get(alias) || 0);
  }
  return built;
}

// Sets say ...Component or the bare part, the inventory holds ...Blueprint.
export function builtPartCount(
  part: PartRef,
  ownership: ReadonlyMap<string, number>,
  itemDb: Record<string, ItemDbEntry>,
): number {
  const entry = itemDb[part.uniqueName];
  if (part.isBlueprintItem === true || entry?.buildsProduct !== undefined) {
    return ownedComponentCount(part.uniqueName, ownership);
  }
  const blueprints = blueprintKeysOf(part, itemDb);
  return blueprints.size > 0
    ? builtCopies(part.uniqueName, ownership, blueprints)
    : ownedComponentCount(part.uniqueName, ownership);
}

export function partState(
  part: PartRef,
  ownership: ReadonlyMap<string, number>,
  itemDb: Record<string, ItemDbEntry>,
): PartState {
  const entry = itemDb[part.uniqueName];
  const product = entry?.buildsProduct;
  if (part.isBlueprintItem === true || product !== undefined) {
    const built =
      product === undefined
        ? 0
        : builtCopies(
            product,
            ownership,
            blueprintKeysOf({ ...part, uniqueName: product }, itemDb),
          );
    if (built >= part.count) return "owned";
    return ownedComponentCount(part.uniqueName, ownership) > 0 ? "blueprint" : "missing";
  }
  if (builtPartCount(part, ownership, itemDb) >= part.count) return "owned";
  for (const blueprint of blueprintKeysOf(part, itemDb)) {
    if ((ownership.get(blueprint) || 0) > 0) return "blueprint";
  }
  return "missing";
}

// Raw materials (Forma, Orokin Reactor) carry recipes of their own, so only a build
// component can be held as a blueprint instead of as the part.
export function buildPartState(
  part: PartRef,
  ownership: ReadonlyMap<string, number>,
  itemDb: Record<string, ItemDbEntry>,
  root?: string,
): PartState {
  const state = partState(part, ownership, itemDb);
  if (state !== "blueprint") return state;
  const entry = itemDb[part.uniqueName];
  // `root`'s own blueprint is not a part to go and craft: holding it is owning
  // it, or a weapon with no parts would report itself as one part still to build.
  const product = entry?.buildsProduct;
  const ownBlueprint =
    root !== undefined && product !== undefined && isSameOwnedItem(product, root);
  if (!ownBlueprint && (part.isBlueprintItem === true || entry?.isBuildComponent === true)) {
    return state;
  }
  return ownedComponentCount(part.uniqueName, ownership) >= part.count ? "owned" : "missing";
}

export function expandedChildAncestors(
  node: CraftingTreeNode,
  itemDb: Record<string, ItemDbEntry>,
  ancestors: readonly string[],
): string[] {
  const product = resolveExpandableRecipe(node.uniqueName, itemDb)?.productUniqueName;
  const path = [...ancestors, node.uniqueName];
  if (product && product !== node.uniqueName) path.push(product);
  return path;
}

export function expandCraftingNode(
  node: CraftingTreeNode,
  itemDb: Record<string, ItemDbEntry>,
  ownership: Map<string, number>,
  ancestors: readonly string[],
): CraftingTreeNode[] {
  if (!canExpandCraftingNode(node, itemDb, ancestors)) return [];
  const resolved = resolveExpandableRecipe(node.uniqueName, itemDb);
  if (!resolved) return [];

  const nextAncestors = new Set(expandedChildAncestors(node, itemDb, ancestors));
  return buildNode(
    { itemDb, ownership, maxDepth: 1 },
    resolved.productUniqueName,
    missingUnits(node),
    resolved.recipe,
    0,
    [],
    nextAncestors,
    true,
  ).children;
}

export interface CraftingTreeFilters {
  hideCompleted: boolean;
  hideBlueprints: boolean;
}

function withFilteredChildren(
  node: CraftingTreeNode,
  children: CraftingTreeNode[],
): CraftingTreeNode {
  const hidden = node.childrenHidden === true || children.length < node.children.length;
  return { ...node, children, ...(hidden ? { childrenHidden: true } : {}) };
}

function stripBlueprints(node: CraftingTreeNode): CraftingTreeNode {
  const children = node.children.filter((child) => !child.isBlueprintItem).map(stripBlueprints);
  return withFilteredChildren(node, children);
}

function filterCompleted(node: CraftingTreeNode, isRoot: boolean): CraftingTreeNode | null {
  if (node.owned >= node.count && node.children.length === 0) return null;
  const children = node.children
    .map((child) => filterCompleted(child, false))
    .filter((child): child is CraftingTreeNode => child !== null);
  if (isRoot) return withFilteredChildren(node, children);
  if (node.owned >= node.count && children.length === 0) return null;
  return withFilteredChildren(node, children);
}

export function applyCraftingTreeFilters(
  root: CraftingTreeNode,
  filters: CraftingTreeFilters,
): CraftingTreeNode | null {
  let result: CraftingTreeNode | null = filters.hideBlueprints ? stripBlueprints(root) : root;
  if (filters.hideCompleted && result) result = filterCompleted(result, true);
  return result;
}

export function filterExpandedChildren(
  children: readonly CraftingTreeNode[],
  filters: CraftingTreeFilters,
): CraftingTreeNode[] {
  let out = [...children];
  if (filters.hideBlueprints) {
    out = out.filter((child) => !child.isBlueprintItem).map(stripBlueprints);
  }
  if (filters.hideCompleted) {
    out = out
      .map((child) => filterCompleted(child, false))
      .filter((child): child is CraftingTreeNode => child !== null);
  }
  return out;
}

function findUsedFor(
  uniqueName: string,
  itemDb: Record<string, ItemDbEntry>,
): CraftingTreeNode["usedFor"] {
  const seen = new Set<string>();
  const matches: CraftingTreeNode["usedFor"] = [];

  for (const { parent } of consumersOf(partConsumerIndex(itemDb), uniqueName)) {
    if (seen.has(parent)) continue;
    seen.add(parent);
    const entry = itemDb[parent];
    matches.push({
      uniqueName: parent,
      name: entry?.name || fallbackNameFromUniqueName(parent),
      ...(entry?.displayName ? { displayName: entry.displayName } : {}),
      imageUrl: entry?.imageUrl || null,
    });
  }

  matches.sort((a, b) => a.name.localeCompare(b.name));
  return matches;
}

export function computeCraftingSummary(tree: CraftingTreeNode): CraftingTreeSummary {
  let totalCredits = 0;
  let minBuildTime = 0;
  let maxBuildTime = 0;
  const blueprintMap = new Map<string, Omit<CraftingTreeTally, "uniqueName">>();
  const resourceMap = new Map<string, Omit<CraftingTreeTally, "uniqueName">>();

  function walk(node: CraftingTreeNode, depth: number): number {
    let subtreeTime = 0;
    if (node.recipe) {
      // One recipe cannot run twice in parallel, so repeat runs stack sequentially.
      const runs = Math.max(1, Math.ceil(node.count / Math.max(1, node.recipe.num || 1)));
      totalCredits += node.recipe.buildPrice * runs;
      subtreeTime = node.recipe.buildTime * runs;
    }

    if (node.children.length === 0 && !node.isCraftable) {
      const existing = resourceMap.get(node.uniqueName);
      if (existing) {
        existing.count += node.count;
      } else {
        resourceMap.set(node.uniqueName, {
          name: node.name,
          ...(node.displayName ? { displayName: node.displayName } : {}),
          count: node.count,
          owned: node.owned,
        });
      }
    } else {
      if (depth > 0 && node.isCraftable) {
        const existing = blueprintMap.get(node.uniqueName);
        if (existing) {
          existing.count += node.count;
        } else {
          blueprintMap.set(node.uniqueName, {
            name: node.name,
            ...(node.displayName ? { displayName: node.displayName } : {}),
            count: node.count,
            owned: node.owned,
          });
        }
      }

      let maxChildTime = 0;
      let totalChildTime = 0;
      for (const child of node.children) {
        const childTime = walk(child, depth + 1);
        maxChildTime = Math.max(maxChildTime, childTime);
        totalChildTime += childTime;
      }
      if (depth === 0) {
        minBuildTime = subtreeTime + maxChildTime;
        maxBuildTime = subtreeTime + totalChildTime;
      } else {
        subtreeTime += maxChildTime;
      }
    }

    return subtreeTime;
  }

  walk(tree, 0);
  return {
    totalCredits,
    minBuildTime,
    maxBuildTime,
    blueprints: Array.from(blueprintMap.entries()).map(([uniqueName, r]) => ({
      uniqueName,
      ...r,
    })),
    resources: Array.from(resourceMap.entries()).map(([uniqueName, r]) => ({
      uniqueName,
      ...r,
    })),
  };
}
