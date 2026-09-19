import { componentUniqueNameAliases } from "../../../config/shared/componentNames.js";
import { mergeDuplicateIngredients } from "../../../config/shared/recipeRows.js";
import { getFullSetOverride } from "./fullSetOverrides.js";
import type { ItemDbEntry } from "../../types/inventory.js";

export interface PartRow {
  uniqueName?: string;
  itemCount?: number;
}

interface PartConsumer {
  /** Item database key of the build that consumes the part. */
  parent: string;
  /** Units of the part one build of the parent consumes. */
  perBuild: number;
}

/** Resources are consumed too, but they are never a part anyone builds or keeps. */
export function isCraftingResource(uniqueName: string): boolean {
  return /\/(MiscItems|Research)\//i.test(uniqueName);
}

/** A part the reservation engine may hold back: a recipe product or something built. */
export function isReservablePart(uniqueName: string, entry: ItemDbEntry | undefined): boolean {
  if (isCraftingResource(uniqueName)) return false;
  if (/\/Types\/Recipes\//i.test(uniqueName)) return true;
  return entry?.masterable === true || entry?.isBuildComponent === true;
}

function summedParts(rows: readonly PartRow[], root: string): PartRow[] {
  const parts = rows.filter(
    (row) => typeof row.uniqueName === "string" && row.uniqueName !== "" && row.uniqueName !== root,
  );
  return mergeDuplicateIngredients(
    parts,
    (row) => row.itemCount,
    (row, itemCount) => ({ ...row, itemCount }),
  );
}

function sameChild(a: PartRow, b: PartRow): boolean {
  const aliases = new Set(componentUniqueNameAliases(a.uniqueName ?? ""));
  return componentUniqueNameAliases(b.uniqueName ?? "").some((alias) => aliases.has(alias));
}

/** Override list, else the WFCD components, joined with DE's recipe ingredients:
 *  only the recipe knows Chroma eats Frost parts. The recipe count wins on a child
 *  both list. */
export function partsConsumedBy(root: string, entry: ItemDbEntry | undefined): PartRow[] {
  const override = getFullSetOverride(root);
  const fromComponents = summedParts(
    override ? override.components : Array.isArray(entry?.components) ? entry.components : [],
    root,
  );
  const fromRecipe = summedParts(
    (entry?.recipe?.ingredients ?? []).map((row) => ({
      uniqueName: row.uniqueName,
      itemCount: row.count,
    })),
    root,
  );
  if (fromRecipe.length === 0) return fromComponents;

  const merged = fromComponents.map((row) => {
    const recipeRow = fromRecipe.find((candidate) => sameChild(candidate, row));
    return recipeRow ? { ...row, itemCount: recipeRow.itemCount ?? 1 } : row;
  });
  for (const row of fromRecipe) {
    if (!fromComponents.some((existing) => sameChild(existing, row))) merged.push(row);
  }
  return merged;
}

const INDEX_CACHE = new WeakMap<
  Record<string, ItemDbEntry>,
  ReadonlyMap<string, readonly PartConsumer[]>
>();

/** Part alias -> the builds consuming it. Written under every alias because a
 *  set and the inventory spell a part differently. One index per item database. */
export function partConsumerIndex(
  itemDb: Record<string, ItemDbEntry>,
): ReadonlyMap<string, readonly PartConsumer[]> {
  const cached = INDEX_CACHE.get(itemDb);
  if (cached) return cached;

  const index = new Map<string, PartConsumer[]>();
  for (const [parent, entry] of Object.entries(itemDb)) {
    for (const part of partsConsumedBy(parent, entry)) {
      const link: PartConsumer = { parent, perBuild: part.itemCount ?? 1 };
      for (const alias of componentUniqueNameAliases(part.uniqueName ?? "")) {
        const links = index.get(alias);
        if (links) links.push(link);
        else index.set(alias, [link]);
      }
    }
  }
  INDEX_CACHE.set(itemDb, index);
  return index;
}

/** The item a build component belongs to, whichever spelling the caller holds.
 *  Whole weapons and resources also carry `componentOf`, so the flag gates it. */
export function componentParentOf(
  uniqueName: string,
  itemDb: Record<string, ItemDbEntry>,
): string | null {
  for (const alias of componentUniqueNameAliases(uniqueName)) {
    const entry = itemDb[alias];
    if (entry?.isBuildComponent === true && entry.componentOf) return entry.componentOf;
  }
  return null;
}

/** Spellings a part's demand can be recorded under. DE's export gives a few part
 *  blueprints a result type whose path shares no stem with them (Ambassador
 *  Receiver Blueprint builds CrpArSniperReceiver), and only the recipe names the
 *  product, so the stem aliases alone never reach those. */
export function partDemandAliases(
  uniqueName: string,
  itemDb: Record<string, ItemDbEntry>,
): string[] {
  const aliases = componentUniqueNameAliases(uniqueName);
  const resolved = new Set(aliases);
  for (const alias of aliases) {
    const product = itemDb[alias]?.buildsProduct;
    if (product === undefined || resolved.has(product)) continue;
    // Whole gear builds from a blueprint too; only a part shares a pile with one.
    if (componentParentOf(product, itemDb) === null) continue;
    for (const name of componentUniqueNameAliases(product)) resolved.add(name);
  }
  return [...resolved];
}

/** Consumers of one part across its alias spellings; a link counts once. */
export function consumersOf(
  index: ReadonlyMap<string, readonly PartConsumer[]>,
  uniqueName: string,
): PartConsumer[] {
  const links = new Set<PartConsumer>();
  for (const alias of componentUniqueNameAliases(uniqueName)) {
    for (const link of index.get(alias) ?? []) links.add(link);
  }
  return [...links];
}
