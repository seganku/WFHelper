import {
  componentUniqueNameAliases,
  ownedComponentCount,
} from "../../config/shared/componentNames.js";
import { mergeDuplicateIngredients } from "../../config/shared/recipeRows.js";
import { buildPartState, builtPartCount } from "./craftingTree.js";
import type { ComponentInfo, ItemDbEntry, ParsedItem } from "../types/inventory.js";
import type { WfmItemsLookup } from "../types/ipc.js";

interface ResolvedComponentPanel {
  comp: ComponentInfo;
  parentName: string;
}

interface PriceLookupPlan {
  name: string;
  isTradable: boolean;
  fallbackName?: string;
  fallbackTradable?: boolean;
}

export function buildItemNameIndex(itemDb: Record<string, ItemDbEntry>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [uniqueName, entry] of Object.entries(itemDb)) {
    if (entry.name) map.set(entry.name, uniqueName);
  }
  return map;
}

function withOwnership(
  comp: ComponentInfo,
  ownership: Map<string, number>,
  itemDb: Record<string, ItemDbEntry> | null,
  root: string | undefined,
): ComponentInfo {
  // `ownedCount` stays the folded pile every readiness rule counts on; `built`
  // is the display figure, which a held blueprint must not inflate.
  const count = ownedComponentCount(comp.uniqueName, ownership);
  const enriched: ComponentInfo = {
    ...comp,
    ownedCount: count,
    owned: count >= (comp.itemCount || 1),
  };
  if (!itemDb || !comp.uniqueName) return enriched;
  const part = { uniqueName: comp.uniqueName, count: comp.itemCount || 1 };
  enriched.built = builtPartCount(part, ownership, itemDb);
  enriched.blueprintHeld = buildPartState(part, ownership, itemDb, root) === "blueprint";
  return enriched;
}

/** Raw db components with ownership counts; doubled rows merge first. An item
 *  database also separates a part that is built from one you hold a blueprint for. */
export function enrichComponents(
  components: ComponentInfo[],
  ownership: Map<string, number>,
  itemDb: Record<string, ItemDbEntry> | null = null,
  root?: string,
): ComponentInfo[] {
  return mergeDuplicateIngredients(
    components,
    (comp) => comp.itemCount,
    (comp, itemCount) => ({ ...comp, itemCount }),
  ).map((comp) => withOwnership(comp, ownership, itemDb, root));
}

function fallbackComponent(
  uniqueName: string,
  db: ItemDbEntry,
  ownership: Map<string, number>,
  itemDb: Record<string, ItemDbEntry>,
): ComponentInfo {
  return withOwnership(
    {
      name: db.name || "Unknown Component",
      uniqueName,
      ...(db.tradable != null ? { tradable: db.tradable } : {}),
      itemCount: 1,
      drops: db.drops || [],
    },
    ownership,
    itemDb,
    undefined,
  );
}

export function resolveComponentByUniqueName(
  uniqueName: string,
  itemDb: Record<string, ItemDbEntry>,
  ownership: Map<string, number>,
): ResolvedComponentPanel | null {
  const db = itemDb[uniqueName];
  if (!db) return null;

  if (db.isBuildComponent && db.componentOf) {
    const parent = itemDb[db.componentOf];
    const enriched = enrichComponents(parent?.components || [], ownership, itemDb, db.componentOf);
    const aliases = componentUniqueNameAliases(uniqueName);
    const parentComp = enriched.find((comp) =>
      Boolean(comp.uniqueName && aliases.includes(comp.uniqueName)),
    );
    if (parentComp) {
      return { comp: parentComp, parentName: parent?.name || "" };
    }
  }

  return { comp: fallbackComponent(uniqueName, db, ownership, itemDb), parentName: "" };
}

export function resolveComponentByName(
  name: string,
  itemDb: Record<string, ItemDbEntry>,
  ownership: Map<string, number>,
  nameIndex: Map<string, string> = buildItemNameIndex(itemDb),
): ResolvedComponentPanel | null {
  const uniqueName = nameIndex.get(name);
  return uniqueName ? resolveComponentByUniqueName(uniqueName, itemDb, ownership) : null;
}

function stripSetSuffix(name: string): string {
  return name.replace(/\s+Set$/i, "");
}

export function resolveComponentLocation(dbEntry: ItemDbEntry | null | undefined): string {
  const description = dbEntry?.description || "";
  const locMatch = description.match(/Location:\s*(.+)/i);
  return locMatch ? locMatch[0] : "";
}

export function resolveComponentWikiFallback(
  comp: ComponentInfo,
  parentName: string,
  dbEntry: ItemDbEntry | null | undefined,
): string {
  if (dbEntry?.isBuildComponent && parentName) return stripSetSuffix(parentName);
  return dbEntry?.name || comp.name;
}

export function resolveComponentPriceLookup(
  comp: ComponentInfo,
  parentName: string,
  dbEntry: ItemDbEntry | null | undefined,
  lookup: WfmItemsLookup,
): PriceLookupPlan {
  const parentItemName = stripSetSuffix(parentName || "");
  const fullName = parentItemName ? `${parentItemName} ${comp.name}` : comp.name;
  const nameKey = fullName?.toLowerCase() || "";
  const directMatch = lookup[nameKey] || lookup[comp.name?.toLowerCase() || ""];
  const isTradable = Boolean(comp.tradable || directMatch);
  const shouldTryBlueprint = Boolean(
    dbEntry?.isBuildComponent && parentName && !nameKey.endsWith(" blueprint") && !directMatch,
  );

  if (shouldTryBlueprint) {
    return {
      name: `${fullName} Blueprint`,
      isTradable: true,
      fallbackName: fullName,
      fallbackTradable: isTradable,
    };
  }

  return { name: fullName, isTradable };
}

export function resolveItemPriceLookup(item: ParsedItem, lookup: WfmItemsLookup): PriceLookupPlan {
  const name = item.name;
  const nameKey = name.toLowerCase();
  const setName = `${name} Set`;
  const isTradable = Boolean(
    item.tradable || item.isPrime || lookup[nameKey] || lookup[setName.toLowerCase()],
  );
  return { name, isTradable };
}
