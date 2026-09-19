import {
  componentUniqueNameAliases,
  ownedComponentCount,
} from "../../../config/shared/componentNames.js";
import { setRootOf } from "./fullSets.js";
import {
  consumersOf,
  isReservablePart,
  partConsumerIndex,
  partDemandAliases,
  partsConsumedBy,
  type PartRow,
} from "./partConsumers.js";
import type { InventoryGroup, ItemDbEntry } from "../../types/inventory.js";

/** Every rule states a floor of copies that must stay in the account and the
 *  highest wins. Summing them instead would double one rule with another and
 *  could reserve more than the account holds. */
export type SafetyRuleId =
  | "lock"
  | "built"
  | "equipped"
  | "lastCopy"
  | "spare"
  | "pinnedGoal"
  | "unmasteredRecipe"
  | "setKeep";

type SafetyReasonKey =
  | "inventory.safety.reason.locked"
  | "inventory.safety.reason.builtEquipment"
  | "inventory.safety.reason.untradable"
  | "inventory.safety.reason.equipped"
  | "inventory.safety.reason.lastCopy"
  | "inventory.safety.reason.spare"
  | "inventory.safety.reason.pinnedGoal"
  | "inventory.safety.reason.unmasteredRecipe"
  | "inventory.safety.reason.setKeep";

export const SAFETY_REASON_KEYS: readonly SafetyReasonKey[] = [
  "inventory.safety.reason.locked",
  "inventory.safety.reason.builtEquipment",
  "inventory.safety.reason.untradable",
  "inventory.safety.reason.equipped",
  "inventory.safety.reason.lastCopy",
  "inventory.safety.reason.spare",
  "inventory.safety.reason.pinnedGoal",
  "inventory.safety.reason.unmasteredRecipe",
  "inventory.safety.reason.setKeep",
];

/** One build that claims copies of a row, with the path that leads to it. */
export interface SafetyClaim {
  /** uniqueNames from the row up to the unfinished item. Labels resolve at
   *  render, so no display string is stored. */
  chain: readonly string[];
  /** Copies of the row this one chain takes. */
  copies: number;
}

export interface SafetyReservation {
  rule: SafetyRuleId;
  /** Copies this rule alone insists on keeping. Floors compose by max, so this
   *  can exceed `reserved` when the account is short of what the rule wants. */
  quantity: number;
  /** True for the rule (or tied rules) that set `reserved`. */
  binding: boolean;
  reasonKey: SafetyReasonKey;
  params?: Readonly<Record<string, string | number>>;
  /** Set by `unmasteredRecipe`: what asks for the copies, one entry per build. */
  claims?: readonly SafetyClaim[];
}

export interface SafetyVerdict {
  total: number;
  /** Copies actually held back: the highest floor, clamped to `total`. */
  reserved: number;
  safe: number;
  reservations: readonly SafetyReservation[];
}

/** The inventory fields the engine reads. `ParsedItem` satisfies it structurally. */
/** What a badge or filter reads verdicts through; a plain Map satisfies it. */
export interface SafetyVerdictLookup {
  get(key: string): SafetyVerdict | undefined;
}

export interface SafetyItem {
  internalName: string;
  uniqueName?: string;
  amount?: number | null;
  inventoryGroup?: InventoryGroup;
  rank?: number;
  leveledUp?: boolean;
  equipped?: boolean;
  tradable?: boolean;
}

export interface InventorySafetySettings {
  /** Copies kept on every row that has no override. */
  spareDefault: number;
  /** Safety key -> copies to keep. Present-and-zero overrides the default. */
  spares: Readonly<Record<string, number>>;
  /** Safety keys the user marked never-list. */
  locks: readonly string[];
  /** Set root uniqueNames to keep one assembled set of. */
  setKeep: readonly string[];
}

export const DEFAULT_SAFETY_SETTINGS: InventorySafetySettings = Object.freeze({
  spareDefault: 0,
  spares: Object.freeze({}),
  locks: Object.freeze([]) as readonly string[],
  setKeep: Object.freeze([]) as readonly string[],
});

const SPARE_MAX = 999;
const KEY_LIST_MAX = 2000;

function toCount(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

/** Item keys are DE paths, so a prototype name only ever arrives as junk. */
function isUsableKey(key: string): boolean {
  return Boolean(key) && key !== "__proto__" && key !== "constructor" && key !== "prototype";
}

function normalizeKeyList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  // Bound the scan too: a corrupt blob can be far longer than the entry cap.
  const limit = Math.min(value.length, KEY_LIST_MAX * 4);
  for (let index = 0; index < limit && seen.size < KEY_LIST_MAX; index += 1) {
    const entry: unknown = value[index];
    if (typeof entry === "string" && isUsableKey(entry)) seen.add(entry);
  }
  return [...seen];
}

function normalizeSpares(value: unknown): Readonly<Record<string, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const spares: Record<string, number> = {};
  let kept = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!isUsableKey(key) || typeof raw !== "number" || !Number.isFinite(raw)) continue;
    spares[key] = Math.min(SPARE_MAX, Math.max(0, Math.floor(raw)));
    if (++kept >= KEY_LIST_MAX) break;
  }
  return spares;
}

/** Anything the store read back becomes valid settings or the defaults. */
export function normalizeSafetySettings(raw: unknown): InventorySafetySettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_SAFETY_SETTINGS;
  const source = raw as Record<string, unknown>;
  return {
    spareDefault: Math.min(SPARE_MAX, toCount(source.spareDefault, 0)),
    spares: normalizeSpares(source.spares),
    locks: normalizeKeyList(source.locks),
    setKeep: normalizeKeyList(source.setKeep),
  };
}

interface SafetyContextInput {
  itemDb: Record<string, ItemDbEntry>;
  settings?: InventorySafetySettings;
  /** Mastered uniqueNames. Absent leaves the unmastered-recipe rule degraded. */
  masteredUniqueNames?: ReadonlySet<string>;
  /** uniqueName -> units pinned goals need kept. The pin store owns the walk
   *  from a goal to this flat map; the engine only reads it. */
  pinnedRequirements?: ReadonlyMap<string, number>;
  /** Owned copies per uniqueName with foundry-spent blueprints removed. Built
   *  gear counts here, so a weapon in the arsenal covers a recipe that eats it. */
  ownedCounts?: ReadonlyMap<string, number>;
  /** Gear the account still holds (`MasteryData.currentlyOwned`). Mastered and
   *  sold is not owned, so a mastery status can never stand in for this. */
  ownedUniqueNames?: ReadonlySet<string>;
  /** Products the foundry is building. The copy is paid for, so it settles a
   *  unit of demand exactly as an owned one does. */
  buildingUniqueNames?: ReadonlySet<string>;
}

/** One build behind a part's demand, before the units become copies. */
interface RecipeClaim {
  chain: string[];
  units: number;
}

export interface SafetyContext {
  readonly itemDb: Record<string, ItemDbEntry>;
  /** The ownership the demand walk ran on; empty when the caller passed none. */
  readonly ownedCounts: ReadonlyMap<string, number>;
  /** Mastered uniqueNames; empty without mastery data, which keeps the last-copy
   *  rule reserving rather than reading "unknown" as "already mastered". */
  readonly mastered: ReadonlySet<string>;
  readonly spareDefault: number;
  readonly spares: ReadonlyMap<string, number>;
  readonly locks: ReadonlySet<string>;
  readonly setKeepRoots: ReadonlySet<string>;
  readonly pinnedDemand: ReadonlyMap<string, number>;
  readonly unmasteredDemand: ReadonlyMap<string, number>;
  /** Part alias -> the builds behind its unmastered-recipe demand, in units. */
  readonly recipeClaims: ReadonlyMap<string, readonly RecipeClaim[]>;
  readonly setKeepDemand: ReadonlyMap<string, number>;
  /** Rules with no data to work with. They never fire, and the caller should say so. */
  readonly degradedRules: readonly SafetyRuleId[];
}

/** What a build consumes, minus crafting resources. */
export function reservableParts(itemDb: Record<string, ItemDbEntry>, root: string): PartRow[] {
  return partsConsumedBy(root, itemDb[root]).filter((part) => {
    const uniqueName = part.uniqueName ?? "";
    return isReservablePart(
      uniqueName,
      resolveDbEntry(itemDb, componentUniqueNameAliases(uniqueName)),
    );
  });
}

/** Demand is written under every alias so a lookup by either spelling hits it. */
function addPartDemand(demand: Map<string, number>, parts: readonly PartRow[], sets: number): void {
  for (const part of parts) {
    const uniqueName = typeof part.uniqueName === "string" ? part.uniqueName : "";
    if (!uniqueName) continue;
    // Same reading of itemCount as fullSets.ts, so both consumers of one
    // component list agree that a missing or zero count still means one part.
    const required = toCount(part.itemCount, 1) || 1;
    const need = required * sets;
    if (need <= 0) continue;
    for (const alias of componentUniqueNameAliases(uniqueName)) {
      demand.set(alias, (demand.get(alias) ?? 0) + need);
    }
  }
}

/** Outstanding units of a build to crafts of it: a recipe yielding several per
 *  craft consumes its parts once for the whole batch. */
function craftsFor(units: number, entry: ItemDbEntry | undefined): number {
  if (units <= 0) return 0;
  const num = entry?.recipe?.num;
  if (typeof num === "number" && Number.isFinite(num) && num > 1) return Math.ceil(units / num);
  return units;
}

/** Units of a product to copies of the row that supplies them: crafts, except
 *  that a reusable blueprint covers any demand with one copy. */
export function reserveUnitsToCopies(units: number, entry: ItemDbEntry | undefined): number {
  if (units > 0 && entry?.reusableBlueprint === true) return 1;
  return craftsFor(units, entry);
}

function demandFor(demand: ReadonlyMap<string, number>, aliases: readonly string[]): number {
  let units = 0;
  for (const alias of aliases) units = Math.max(units, demand.get(alias) ?? 0);
  return units;
}

interface RecipeDemand {
  demand: Map<string, number>;
  claims: Map<string, RecipeClaim[]>;
}

/** Copies of every part still to produce, at any depth. A part is spare only
 *  once nothing above it is outstanding. */
function buildRecipeDemand(
  itemDb: Record<string, ItemDbEntry>,
  mastered: ReadonlySet<string>,
  ownedCounts: ReadonlyMap<string, number> | undefined,
  ownedUniqueNames: ReadonlySet<string> | undefined,
  buildingUniqueNames: ReadonlySet<string> | undefined,
): RecipeDemand {
  const index = partConsumerIndex(itemDb);
  const memo = new Map<string, number>();
  const open = new Set<string>();

  function isBuilding(uniqueName: string): boolean {
    if (!buildingUniqueNames) return false;
    for (const alias of componentUniqueNameAliases(uniqueName)) {
      if (buildingUniqueNames.has(alias)) return true;
    }
    return false;
  }

  // Inventory rows and the mastery flag describe the same copies, so they merge
  // by max; a copy in the foundry is not in either and adds one.
  function ownedOf(uniqueName: string): number {
    const rows = ownedCounts ? ownedComponentCount(uniqueName, ownedCounts) : 0;
    const held = ownedUniqueNames?.has(uniqueName) === true ? 1 : 0;
    return Math.max(rows, held) + (isBuilding(uniqueName) ? 1 : 0);
  }

  function masteryUnitsOf(uniqueName: string): number {
    return itemDb[uniqueName]?.masterable === true && !mastered.has(uniqueName) ? 1 : 0;
  }

  /** Copies still to build, and whether a cycle truncated the answer. A result
   *  that leaned on an open node is never memoized, or the cut would stick. */
  function outstanding(uniqueName: string): { units: number; cyclic: boolean } {
    const cached = memo.get(uniqueName);
    if (cached !== undefined) return { units: cached, cyclic: false };
    if (open.has(uniqueName)) return { units: 0, cyclic: true };

    open.add(uniqueName);
    let fromParents = 0;
    let cyclic = false;
    for (const link of consumersOf(index, uniqueName)) {
      const above = outstanding(link.parent);
      cyclic = cyclic || above.cyclic;
      fromParents += link.perBuild * craftsFor(above.units, itemDb[link.parent]);
    }
    open.delete(uniqueName);

    // Mastery is earned by ranking one copy, and a copy built for the parent can
    // be that copy, so the two floors compose by max rather than by sum.
    const units = Math.max(
      0,
      Math.max(masteryUnitsOf(uniqueName), fromParents) - ownedOf(uniqueName),
    );
    if (!cyclic) memo.set(uniqueName, units);
    return { units, cyclic };
  }

  /** The item driving this build: itself when its own mastery is missing,
   *  otherwise the parent asking for the most copies. */
  function drivingChain(uniqueName: string, seen: Set<string>): string[] {
    if (seen.has(uniqueName)) return [uniqueName];
    seen.add(uniqueName);
    let driver = "";
    let driverUnits = 0;
    for (const link of consumersOf(index, uniqueName)) {
      const units = link.perBuild * craftsFor(outstanding(link.parent).units, itemDb[link.parent]);
      if (units > driverUnits) {
        driverUnits = units;
        driver = link.parent;
      }
    }
    if (!driver || masteryUnitsOf(uniqueName) >= driverUnits) return [uniqueName];
    return [uniqueName, ...drivingChain(driver, seen)];
  }

  const demand = new Map<string, number>();
  const claims = new Map<string, RecipeClaim[]>();
  for (const [uniqueName, entry] of Object.entries(itemDb)) {
    const parts = reservableParts(itemDb, uniqueName);
    if (parts.length === 0) continue;
    const builds = craftsFor(outstanding(uniqueName).units, entry);
    if (builds <= 0) continue;
    addPartDemand(demand, parts, builds);

    const above = drivingChain(uniqueName, new Set());
    for (const part of parts) {
      const partUniqueName = typeof part.uniqueName === "string" ? part.uniqueName : "";
      if (!partUniqueName) continue;
      const units = (toCount(part.itemCount, 1) || 1) * builds;
      const claim: RecipeClaim = { chain: [partUniqueName, ...above], units };
      for (const alias of componentUniqueNameAliases(partUniqueName)) {
        const list = claims.get(alias);
        if (list) list.push(claim);
        else claims.set(alias, [claim]);
      }
    }
  }
  return { demand, claims };
}

interface RecipeDemandCache {
  mastered: ReadonlySet<string>;
  ownedCounts: ReadonlyMap<string, number> | undefined;
  ownedUniqueNames: ReadonlySet<string> | undefined;
  buildingUniqueNames: ReadonlySet<string> | undefined;
  value: RecipeDemand;
}

// The walk ignores locks and spares, so editing either reuses the last result.
const RECIPE_DEMAND_CACHE = new WeakMap<Record<string, ItemDbEntry>, RecipeDemandCache>();

function cachedRecipeDemand(
  itemDb: Record<string, ItemDbEntry>,
  mastered: ReadonlySet<string>,
  ownedCounts: ReadonlyMap<string, number> | undefined,
  ownedUniqueNames: ReadonlySet<string> | undefined,
  buildingUniqueNames: ReadonlySet<string> | undefined,
): RecipeDemand {
  const hit = RECIPE_DEMAND_CACHE.get(itemDb);
  if (
    hit &&
    hit.mastered === mastered &&
    hit.ownedCounts === ownedCounts &&
    hit.ownedUniqueNames === ownedUniqueNames &&
    hit.buildingUniqueNames === buildingUniqueNames
  ) {
    return hit.value;
  }
  const value = buildRecipeDemand(
    itemDb,
    mastered,
    ownedCounts,
    ownedUniqueNames,
    buildingUniqueNames,
  );
  RECIPE_DEMAND_CACHE.set(itemDb, {
    mastered,
    ownedCounts,
    ownedUniqueNames,
    buildingUniqueNames,
    value,
  });
  return value;
}

function claimsFor(
  claims: ReadonlyMap<string, readonly RecipeClaim[]>,
  aliases: readonly string[],
): RecipeClaim[] {
  const found = new Set<RecipeClaim>();
  for (const alias of aliases) {
    for (const claim of claims.get(alias) ?? []) found.add(claim);
  }
  return [...found];
}

/** Claim copies out of the floor the demand already set, largest first, so the
 *  lines under a reservation always add up to the number beside it. */
function allocateClaims(
  claims: readonly RecipeClaim[],
  quantity: number,
  entry: ItemDbEntry | undefined,
): SafetyClaim[] {
  if (claims.length === 0 || quantity <= 0) return [];
  if (claims.length === 1) {
    const copies = Math.min(reserveUnitsToCopies(claims[0].units, entry), quantity);
    return copies > 0 ? [{ chain: claims[0].chain, copies }] : [];
  }
  const ordered = [...claims].sort((a, b) => b.units - a.units || a.chain.length - b.chain.length);
  const allocated: SafetyClaim[] = [];
  let remaining = quantity;
  for (const claim of ordered) {
    if (remaining <= 0) break;
    const copies = Math.min(reserveUnitsToCopies(claim.units, entry), remaining);
    if (copies <= 0) continue;
    allocated.push({ chain: claim.chain, copies });
    remaining -= copies;
  }
  return allocated;
}

function resolveDbEntry(
  itemDb: Record<string, ItemDbEntry>,
  aliases: readonly string[],
): ItemDbEntry | undefined {
  for (const alias of aliases) {
    const entry = itemDb[alias];
    if (entry) return entry;
  }
  return undefined;
}

/** Copies of `uniqueName` that unmastered builds still claim, whichever spelling
 *  the caller holds. Zero when nothing above it is outstanding. */
export function recipeCopiesFor(context: SafetyContext, uniqueName: string): number {
  const aliases = partDemandAliases(uniqueName, context.itemDb);
  return reserveUnitsToCopies(
    demandFor(context.unmasteredDemand, aliases),
    resolveDbEntry(context.itemDb, aliases),
  );
}

/** Identity locks and per-item spares are stored under. Synthetic set rows keep
 *  their `#set` internalName, so a kept set never collides with its root item. */
export function safetyKeyFor(item: SafetyItem): string {
  return item.uniqueName || item.internalName;
}

/** Precompute once per inventory generation; `safeToList` is then O(1) per row. */
export function buildSafetyContext(input: SafetyContextInput): SafetyContext {
  const itemDb = input.itemDb ?? {};
  const settings = normalizeSafetySettings(input.settings ?? DEFAULT_SAFETY_SETTINGS);
  const degradedRules: SafetyRuleId[] = [];

  const pinnedDemand = new Map<string, number>();
  if (input.pinnedRequirements) {
    for (const [uniqueName, count] of input.pinnedRequirements) {
      const units = toCount(count, 0);
      if (!uniqueName || units <= 0) continue;
      // Aliases of one pile carry the same figure, so max keeps a map that
      // already lists both spellings from double-counting it.
      for (const alias of componentUniqueNameAliases(uniqueName)) {
        pinnedDemand.set(alias, Math.max(pinnedDemand.get(alias) ?? 0, units));
      }
    }
  } else {
    degradedRules.push("pinnedGoal");
  }

  const mastered = input.masteredUniqueNames;
  if (!mastered) degradedRules.push("unmasteredRecipe");
  const recipe = mastered
    ? cachedRecipeDemand(
        itemDb,
        mastered,
        input.ownedCounts,
        input.ownedUniqueNames,
        input.buildingUniqueNames,
      )
    : { demand: new Map<string, number>(), claims: new Map<string, never[]>() };

  const setKeepRoots = new Set(settings.setKeep);
  const setKeepDemand = new Map<string, number>();
  for (const root of setKeepRoots) {
    addPartDemand(setKeepDemand, reservableParts(itemDb, root), 1);
  }

  return {
    itemDb,
    ownedCounts: input.ownedCounts ?? new Map(),
    mastered: mastered ?? new Set(),
    spareDefault: settings.spareDefault,
    spares: new Map(Object.entries(settings.spares)),
    locks: new Set(settings.locks),
    setKeepRoots,
    pinnedDemand,
    unmasteredDemand: recipe.demand,
    recipeClaims: recipe.claims,
    setKeepDemand,
    degradedRules,
  };
}

type SafetyFloor = Omit<SafetyReservation, "binding">;

function floor(
  rule: SafetyRuleId,
  quantity: number,
  reasonKey: SafetyReasonKey,
  params?: Readonly<Record<string, string | number>>,
): SafetyFloor {
  return params ? { rule, quantity, reasonKey, params } : { rule, quantity, reasonKey };
}

/** A set only sells whole, so it holds back the sets its most constrained part
 *  cannot cover, carrying that part's own reasons. */
function setPartFloors(item: SafetyItem, context: SafetyContext): readonly SafetyFloor[] {
  let quantity = 0;
  let reasons: readonly SafetyReservation[] = [];
  for (const part of reservableParts(context.itemDb, setRootOf(item.internalName))) {
    const uniqueName = typeof part.uniqueName === "string" ? part.uniqueName : "";
    if (!uniqueName) continue;
    const required = toCount(part.itemCount, 1) || 1;
    const verdict = safeToList(
      {
        internalName: uniqueName,
        uniqueName,
        amount: ownedComponentCount(uniqueName, context.ownedCounts),
      },
      context,
    );
    let kept = 0;
    for (const reservation of verdict.reservations) kept = Math.max(kept, reservation.quantity);
    const sets = Math.ceil(kept / required);
    if (sets > quantity) {
      quantity = sets;
      reasons = verdict.reservations;
    }
  }
  if (quantity <= 0) return [];
  return reasons
    .filter((reservation) => reservation.binding)
    .map((reservation) =>
      floor(
        reservation.rule,
        quantity,
        reservation.reasonKey,
        reservation.params ? { ...reservation.params, count: quantity } : undefined,
      ),
    );
}

export function safeToList(item: SafetyItem, context: SafetyContext): SafetyVerdict {
  const total = toCount(item.amount, 1);
  const key = safetyKeyFor(item);
  const aliases = partDemandAliases(key, context.itemDb);
  const entry = resolveDbEntry(context.itemDb, aliases);
  const floors: SafetyFloor[] = [];

  if (context.locks.has(key)) {
    floors.push(floor("lock", total, "inventory.safety.reason.locked"));
  }

  // Unranked gear still trades; the moment it gains a rank the game binds it.
  const builtEquipment =
    item.inventoryGroup === "equipment" && (toCount(item.rank, 0) > 0 || item.leveledUp === true);
  if (builtEquipment) {
    floors.push(floor("built", total, "inventory.safety.reason.builtEquipment"));
  } else if (item.tradable === false) {
    floors.push(floor("built", total, "inventory.safety.reason.untradable"));
  }

  if (item.equipped === true && total > 0) {
    // A row merges every copy of one rank and only the fitted instance is
    // pinned, so this protects one copy rather than the whole pile.
    floors.push(floor("equipped", 1, "inventory.safety.reason.equipped"));
  }

  const masterable = entry?.masterable === true || item.inventoryGroup === "equipment";
  // Mastery is permanent, so the last copy of something already mastered is free.
  const alreadyMastered = aliases.some((alias) => context.mastered.has(alias));
  if (masterable && !alreadyMastered && total > 0) {
    floors.push(floor("lastCopy", 1, "inventory.safety.reason.lastCopy"));
  }

  const spare = context.spares.get(key) ?? context.spareDefault;
  if (spare > 0) {
    floors.push(floor("spare", spare, "inventory.safety.reason.spare", { count: spare }));
  }

  const pinnedCopies = reserveUnitsToCopies(demandFor(context.pinnedDemand, aliases), entry);
  if (pinnedCopies > 0) {
    floors.push(
      floor("pinnedGoal", pinnedCopies, "inventory.safety.reason.pinnedGoal", {
        count: pinnedCopies,
      }),
    );
  }

  const recipeCopies = recipeCopiesFor(context, key);
  if (recipeCopies > 0) {
    const reservation = floor(
      "unmasteredRecipe",
      recipeCopies,
      "inventory.safety.reason.unmasteredRecipe",
      { count: recipeCopies },
    );
    const claims = allocateClaims(claimsFor(context.recipeClaims, aliases), recipeCopies, entry);
    floors.push(claims.length > 0 ? { ...reservation, claims } : reservation);
  }

  const keptSetRow =
    item.inventoryGroup === "full_sets" && context.setKeepRoots.has(setRootOf(item.internalName));
  const setCopies = Math.max(
    reserveUnitsToCopies(demandFor(context.setKeepDemand, aliases), entry),
    keptSetRow ? 1 : 0,
  );
  if (setCopies > 0) {
    floors.push(
      floor("setKeep", setCopies, "inventory.safety.reason.setKeep", { count: setCopies }),
    );
  }

  if (item.inventoryGroup === "full_sets") {
    for (const partFloor of setPartFloors(item, context)) {
      const at = floors.findIndex((candidate) => candidate.rule === partFloor.rule);
      if (at < 0) floors.push(partFloor);
      else if (partFloor.quantity > floors[at].quantity) floors[at] = partFloor;
    }
  }

  let highest = 0;
  for (const candidate of floors) highest = Math.max(highest, candidate.quantity);
  const reserved = Math.min(total, highest);

  return {
    total,
    reserved,
    safe: total - reserved,
    reservations: floors.map((candidate) => ({
      ...candidate,
      binding: candidate.quantity === highest,
    })),
  };
}
