import { componentUniqueNameAliases } from "../../config/shared/componentNames.js";
import { getLookupByName } from "./inventoryMarket.js";
import { isReservablePart } from "./inventory/partConsumers.js";
import type { PartState } from "./craftingTree.js";
import type { ComponentInfo, ItemDbEntry, ParsedItem } from "../types/inventory.js";
import type { FoundryState } from "../types/filters.js";
import type { WfmItemsLookup } from "../types/ipc.js";
import type { OwnedCounts, RelicDatabase, RelicQuality, RelicReward } from "../types/relics.js";

type MasteryRoadmapAccess =
  | "owned"
  | "gild"
  | "claimable"
  | "building"
  | "buildable"
  | "foundryParts"
  | "craftParts"
  | "marketBlueprint";

interface MissingMasteryComponent {
  component: ComponentInfo;
  count: number;
}

interface OwnedRelicPool {
  count: number;
  rewards: RelicReward[];
}

interface RelicComponentMatcher {
  uniqueNames: Set<string>;
  names: Set<string>;
}

export interface MasteryRoadmapSourceItem extends ParsedItem {
  masteryXpRemaining: number;
  platinum: number | null;
  estimatedCost: number | null;
  owned: boolean;
  foundryState: FoundryState | undefined;
}

export interface MasteryRoadmapRecommendation extends MasteryRoadmapSourceItem {
  access: MasteryRoadmapAccess | "relics" | "platinum";
  xpPerPlatinum: number | null;
  relicProbability: number | null;
  relevantRelicCount: number;
}

// A set lists its part as ...Component while the market keys ...Blueprint, and a
// part named "Wings" is listed as "Odonata Prime Wings Blueprint": try every
// spelling the catalog can use before calling the part unpriced.
export function componentMarketSlug(
  itemName: string,
  component: Pick<ComponentInfo, "name" | "uniqueName">,
  lookup: WfmItemsLookup,
): string | null {
  if (component.uniqueName) {
    for (const alias of componentUniqueNameAliases(component.uniqueName)) {
      const hit = lookup[alias.toLowerCase()];
      if (hit?.url_name) return hit.url_name;
    }
  }
  const partName = component.name.trim();
  const parent = itemName.trim();
  const fullName = partName.toLowerCase().startsWith(parent.toLowerCase())
    ? partName
    : `${parent} ${partName}`;
  for (const candidate of [fullName, partName]) {
    const hit = getLookupByName(candidate, lookup);
    if (hit?.url_name) return hit.url_name;
  }
  return null;
}

function requiredComponentUnits(component: ComponentInfo): number {
  return Math.max(1, component.itemCount ?? 1);
}

function ownedComponentUnits(component: ComponentInfo): number {
  return component.owned === true
    ? requiredComponentUnits(component)
    : Math.max(0, component.ownedCount ?? 0);
}

export function isComponentHeld(component: ComponentInfo): boolean {
  return ownedComponentUnits(component) >= requiredComponentUnits(component);
}

// A set counts a held part blueprint as the part (one pile, two spellings).
export function componentPartState(component: ComponentInfo): PartState {
  if (!isComponentHeld(component)) return "missing";
  return component.blueprintHeld === true ? "blueprint" : "owned";
}

function missingMasteryComponents(components: ComponentInfo[]): MissingMasteryComponent[] {
  return components
    .map((component) => {
      const foundry = component.building ? 1 : 0;
      const count = requiredComponentUnits(component) - ownedComponentUnits(component) - foundry;
      return { component, count: Math.max(0, count) };
    })
    .filter((entry) => entry.count > 0);
}

export function estimateMasteryPurchaseCost(
  rootPrice: number | null,
  components: MasteryRoadmapSourceItem["components"],
  componentPrice: (component: MasteryRoadmapSourceItem["components"][number]) => number | null,
): number | null {
  if (components.length === 0) return rootPrice;

  const missing = missingMasteryComponents(components);
  if (missing.length === 0) return null;

  // An unpriced part means no estimate: quoting the full set for one missing
  // part reads as the part's price (issue #47).
  let componentTotal = 0;
  for (const entry of missing) {
    const price = componentPrice(entry.component);
    if (price == null || !Number.isFinite(price) || price <= 0) return null;
    componentTotal += price * entry.count;
  }

  if (rootPrice == null || !Number.isFinite(rootPrice) || rootPrice <= 0) return componentTotal;
  return Math.min(rootPrice, componentTotal);
}

export interface MasteryRoadmap {
  easy: MasteryRoadmapRecommendation[];
  relics: MasteryRoadmapRecommendation[];
  platinum: MasteryRoadmapRecommendation[];
}

const ACCESS_PRIORITY: Record<MasteryRoadmapAccess, number> = {
  owned: 0,
  gild: 1,
  claimable: 2,
  building: 3,
  buildable: 4,
  foundryParts: 5,
  craftParts: 6,
  // A Market blueprint is one credit purchase away, but the parts it needs are
  // still missing, so it ranks below everything the foundry can already finish.
  marketBlueprint: 7,
};

export function masteryBuildReadiness(
  components: ComponentInfo[],
): "buildable" | "craftParts" | null {
  if (components.length === 0) return null;
  const states = components.map(componentPartState);
  if (states.some((state) => state === "missing")) return null;
  return states.some((state) => state === "blueprint") ? "craftParts" : "buildable";
}

/** The recipe rows that count as parts. Raw materials are farmed rather than
 *  crafted, so a weapon built straight from resources has no parts to tally. */
export function masteryPartRows<T extends { uniqueName?: string }>(
  rows: readonly T[],
  itemDb: Record<string, ItemDbEntry>,
): T[] {
  return rows.filter(
    (row) => row.uniqueName != null && isReservablePart(row.uniqueName, itemDb[row.uniqueName]),
  );
}

/** Rows you could put in the foundry right now. The total still counts every
 *  recipe row, because being short a resource is just as blocking, but a raw
 *  material is farmed rather than crafted so it never reads as craftable. */
export function masteryCraftableCount<T extends { uniqueName?: string }>(
  rows: readonly T[],
  stateOf: (row: T) => PartState,
  itemDb: Record<string, ItemDbEntry>,
): number {
  return masteryPartRows(rows, itemDb).filter((row) => stateOf(row) === "blueprint").length;
}

export function masteryPartCounts(states: readonly PartState[]): {
  total: number;
  built: number;
  craftable: number;
} {
  let built = 0;
  let craftable = 0;
  for (const state of states) {
    if (state === "blueprint") craftable += 1;
    else if (state === "owned") built += 1;
  }
  return { total: states.length, built, craftable };
}

// Parts in the foundry are neither owned nor missing, so relics and platinum
// read the set as complete. A foundry copy covers only one required unit.
function partsWaitingInFoundry(item: MasteryRoadmapSourceItem): boolean {
  if (item.components.length === 0) return false;
  if (!item.components.some((component) => component.building === true)) return false;
  return missingMasteryComponents(item.components).length === 0;
}

// Only counts as easy when the blueprint is the last thing missing; an item
// with unfarmed parts stays in the relic/platinum lists where they get priced.
function marketBlueprintFinishesIt(item: MasteryRoadmapSourceItem): boolean {
  if (!item.marketBuyable) return false;
  const missing = missingMasteryComponents(item.components);
  if (missing.length === 0) return false;
  return missing.every((entry) => /\bblueprint$/i.test(entry.component.name.trim()));
}

function easyAccess(item: MasteryRoadmapSourceItem): MasteryRoadmapAccess | null {
  // A max-rank ungilded amp reads "level it" otherwise, which is what the player just did.
  if (item.needsGilding) return "gild";
  if (item.owned || item.currentlyOwned) return "owned";
  if (item.foundryState === "claimable") return "claimable";
  if (item.foundryState === "building") return "building";
  const readiness = masteryBuildReadiness(item.components);
  if (item.foundryState === "buildable" && readiness !== "craftParts") return "buildable";
  if (partsWaitingInFoundry(item)) return "foundryParts";
  if (readiness === "craftParts") return "craftParts";
  if (marketBlueprintFinishesIt(item)) return "marketBlueprint";
  return null;
}

function normalizePartName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/(?:^|\s)blueprint$/, "")
    .trim();
}

function componentMatcher(
  item: MasteryRoadmapSourceItem,
  component: ComponentInfo,
): RelicComponentMatcher {
  const uniqueNames = new Set(
    component.uniqueName
      ? componentUniqueNameAliases(component.uniqueName).map((name) => name.toLowerCase())
      : [],
  );
  const itemName = normalizePartName(item.name);
  const componentName = normalizePartName(component.name);
  const fullName = componentName.startsWith(itemName)
    ? componentName
    : `${itemName} ${componentName}`.trim();
  return { uniqueNames, names: new Set([fullName]) };
}

function matchingComponentIndex(reward: RelicReward, matchers: RelicComponentMatcher[]): number {
  const uniqueName = reward.uniqueName?.toLowerCase() || "";
  if (uniqueName) {
    const byUniqueName = matchers.findIndex((matcher) => matcher.uniqueNames.has(uniqueName));
    if (byUniqueName >= 0) return byUniqueName;
  }

  const rewardName = normalizePartName(reward.name);
  return matchers.findIndex((matcher) => matcher.names.has(rewardName));
}

function buildOwnedRelicPools(
  relicDb: RelicDatabase | null,
  ownedCounts: OwnedCounts,
): OwnedRelicPool[] {
  if (!relicDb) return [];
  const pools: OwnedRelicPool[] = [];
  for (const [groupKey, qualities] of Object.entries(ownedCounts)) {
    const group = relicDb.groups[groupKey];
    if (!group) continue;
    for (const [quality, rawCount] of Object.entries(qualities) as Array<[RelicQuality, number]>) {
      const count = Math.max(0, Math.floor(rawCount));
      const rewards = group.qualities[quality]?.rewards || [];
      if (count > 0 && rewards.length > 0) pools.push({ count, rewards });
    }
  }
  return pools;
}

function calculateOwnedRelicCompletion(
  item: MasteryRoadmapSourceItem,
  pools: OwnedRelicPool[],
): { probability: number; relicCount: number } | null {
  const missing = missingMasteryComponents(item.components);
  if (missing.length === 0 || pools.length === 0) return null;

  const matchers = missing.map((entry) => componentMatcher(item, entry.component));
  const relevantPools: Array<{ count: number; chances: number[] }> = [];
  const obtainable = new Array(missing.length).fill(false) as boolean[];
  let relicCount = 0;

  for (const pool of pools) {
    const chances = new Array(missing.length).fill(0) as number[];
    for (const reward of pool.rewards) {
      const index = matchingComponentIndex(reward, matchers);
      if (index < 0) continue;
      const chance = Math.max(0, Math.min(1, reward.chance / 100));
      chances[index] += chance;
    }
    const total = chances.reduce((sum, chance) => sum + chance, 0);
    if (total <= 0) continue;
    if (total > 1) {
      for (let index = 0; index < chances.length; index++) chances[index] /= total;
    }
    for (let index = 0; index < chances.length; index++) {
      if (chances[index] > 0) obtainable[index] = true;
    }
    relevantPools.push({ count: pool.count, chances });
    relicCount += pool.count;
  }

  if (obtainable.some((value) => !value)) return null;

  const multipliers: number[] = [];
  let stateCount = 1;
  for (const entry of missing) {
    multipliers.push(stateCount);
    stateCount *= entry.count + 1;
  }

  // One relic yields one reward, so keep a capped joint distribution instead
  // of treating each missing component as an independent event.
  let current = new Float64Array(stateCount);
  current[0] = 1;
  for (const pool of relevantPools) {
    const awardedChance = pool.chances.reduce((sum, chance) => sum + chance, 0);
    for (let copy = 0; copy < pool.count; copy++) {
      const next = new Float64Array(stateCount);
      for (let state = 0; state < stateCount; state++) {
        const probability = current[state];
        if (probability === 0) continue;
        next[state] += probability * Math.max(0, 1 - awardedChance);
        for (let index = 0; index < pool.chances.length; index++) {
          const chance = pool.chances[index];
          if (chance === 0) continue;
          const multiplier = multipliers[index];
          const progress = Math.floor(state / multiplier) % (missing[index].count + 1);
          const nextState = progress < missing[index].count ? state + multiplier : state;
          next[nextState] += probability * chance;
        }
      }
      current = next;
    }
  }

  const probability = Math.max(0, Math.min(1, current[stateCount - 1]));
  return probability > 0 ? { probability, relicCount } : null;
}

export function buildMasteryRoadmap(
  items: MasteryRoadmapSourceItem[],
  relicDb: RelicDatabase | null = null,
  ownedCounts: OwnedCounts = {},
): MasteryRoadmap {
  const easy: MasteryRoadmapRecommendation[] = [];
  const relics: MasteryRoadmapRecommendation[] = [];
  const platinum: MasteryRoadmapRecommendation[] = [];
  const ownedRelicPools = buildOwnedRelicPools(relicDb, ownedCounts);

  for (const item of items) {
    if (item.status === "mastered" || item.masteryXpRemaining <= 0) continue;

    const access = easyAccess(item);
    if (access) {
      easy.push({
        ...item,
        access,
        xpPerPlatinum: null,
        relicProbability: null,
        relevantRelicCount: 0,
      });
      continue;
    }

    const relicPlan = calculateOwnedRelicCompletion(item, ownedRelicPools);
    if (relicPlan) {
      relics.push({
        ...item,
        access: "relics",
        xpPerPlatinum: null,
        relicProbability: relicPlan.probability,
        relevantRelicCount: relicPlan.relicCount,
      });
    }

    if (
      typeof item.estimatedCost === "number" &&
      Number.isFinite(item.estimatedCost) &&
      item.estimatedCost > 0
    ) {
      platinum.push({
        ...item,
        access: "platinum",
        xpPerPlatinum: item.masteryXpRemaining / item.estimatedCost,
        relicProbability: null,
        relevantRelicCount: 0,
      });
    }
  }

  easy.sort(
    (a, b) =>
      ACCESS_PRIORITY[a.access as MasteryRoadmapAccess] -
        ACCESS_PRIORITY[b.access as MasteryRoadmapAccess] ||
      b.masteryXpRemaining - a.masteryXpRemaining ||
      a.name.localeCompare(b.name),
  );
  relics.sort(
    (a, b) =>
      (b.relicProbability ?? 0) - (a.relicProbability ?? 0) ||
      b.masteryXpRemaining - a.masteryXpRemaining ||
      a.name.localeCompare(b.name),
  );
  platinum.sort(
    (a, b) =>
      (b.xpPerPlatinum ?? 0) - (a.xpPerPlatinum ?? 0) ||
      (a.estimatedCost ?? Number.POSITIVE_INFINITY) -
        (b.estimatedCost ?? Number.POSITIVE_INFINITY) ||
      a.name.localeCompare(b.name),
  );

  return { easy, relics, platinum };
}
