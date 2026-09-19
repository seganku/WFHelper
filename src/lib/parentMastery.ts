import { componentUniqueNameAliases } from "../../config/shared/componentNames.js";
import { foundryClaimableProducts } from "./inventory/foundryResources.js";
import { componentParentOf } from "./inventory/partConsumers.js";
import type { SafetyVerdictLookup } from "./inventory/safetyRules.js";
import { buildMasteryLookup, inheritedMasteryFacts, normalizeLookupKey } from "./masteryLookup.js";
import type { MasteryFacts } from "./masteryLookup.js";
import type { FoundryData, ItemDbEntry, MasteryData } from "../types/inventory.js";

interface RowLike {
  name: string;
  internalName?: string;
  parentMastered?: boolean;
  parentOwned?: boolean;
  parentClaimable?: boolean;
  spare?: boolean;
}

interface PartMasteryFlags {
  parentMastered?: boolean;
  /** The build this row feeds is in the inventory now. Left unset on a built
   *  row: there the owned count is the answer. */
  parentOwned?: boolean;
  /** The build this row feeds is finished in the foundry and unclaimed. Unset
   *  rather than false, so a row keeps the shape the mastery pass gave it. */
  parentClaimable?: boolean;
  /** The row is a build component, the only kind the Spares filter is about. */
  component?: true;
}

type PartMasteryResolver = (row: RowLike) => PartMasteryFlags;

/** What the M, C and F badges show for a row. */
interface ItemMarks {
  mastered: boolean;
  crafted: boolean;
  foundry: boolean;
}

const NO_CLAIMABLE_PARENTS: ReadonlySet<string> = new Set();

export function itemMarksFor(flags: {
  parentMastered?: unknown;
  parentOwned?: unknown;
  parentClaimable?: unknown;
}): ItemMarks {
  const crafted = flags.parentOwned === true;
  return {
    mastered: flags.parentMastered === true,
    crafted,
    foundry: !crafted && flags.parentClaimable === true,
  };
}

function dbEntryFor(
  itemDb: Record<string, ItemDbEntry>,
  key: string | undefined,
): { uniqueName: string; entry: ItemDbEntry } | null {
  if (!key) return null;
  const candidates = [...componentUniqueNameAliases(key), key.replace(/Blueprint$/i, "")];
  for (const candidate of candidates) {
    const entry = itemDb[candidate];
    if (entry) return { uniqueName: candidate, entry };
  }
  return null;
}

/** Per-row parent-mastery flag. Unset means nothing masterable owns the row,
 * and the strict tri-state filter then skips it. */
export function buildPartMasteryResolver(
  itemDb: Record<string, ItemDbEntry>,
  mastery: MasteryData | null,
  claimableParents: ReadonlySet<string> = NO_CLAIMABLE_PARENTS,
): PartMasteryResolver {
  if ((mastery?.items ?? []).length === 0 && claimableParents.size === 0) return () => ({});
  const lookup = buildMasteryLookup(mastery);

  const nameIndex = new Map<string, string>();
  for (const [uniqueName, entry] of Object.entries(itemDb)) {
    const key = normalizeLookupKey(entry.name);
    if (key && !nameIndex.has(key)) nameIndex.set(key, uniqueName);
  }

  const claimable = (parent: string | undefined): boolean =>
    parent != null &&
    componentUniqueNameAliases(parent).some((alias) => claimableParents.has(alias));

  // A part and a set row both answer for the build they belong to, so both
  // flags describe that build and never the row itself.
  const partFlags = (
    facts: MasteryFacts | undefined,
    parent: string | undefined,
  ): PartMasteryFlags => ({
    ...(facts ? { parentMastered: facts.status === "mastered", parentOwned: facts.owned } : {}),
    ...(claimable(parent) ? { parentClaimable: true } : {}),
  });

  return (row) => {
    const setBase = /\sSet$/i.test(row.name) ? row.name.replace(/\s+Set$/i, "") : null;
    if (setBase) {
      return partFlags(
        inheritedMasteryFacts(lookup, itemDb, null, setBase),
        nameIndex.get(normalizeLookupKey(setBase)),
      );
    }

    const resolved =
      dbEntryFor(itemDb, row.internalName) ??
      dbEntryFor(itemDb, nameIndex.get(normalizeLookupKey(row.name)));
    const parent = resolved ? componentParentOf(resolved.uniqueName, itemDb) : null;
    if (parent) {
      return {
        ...partFlags(inheritedMasteryFacts(lookup, itemDb, parent, itemDb[parent]?.name), parent),
        component: true,
      };
    }
    const facts = inheritedMasteryFacts(
      lookup,
      itemDb,
      resolved?.uniqueName ?? row.internalName,
      row.name,
    );
    return facts ? { parentMastered: facts.status === "mastered" } : {};
  };
}

const RESOLVER_CACHE = new WeakMap<
  Record<string, ItemDbEntry>,
  { mastery: MasteryData | null; foundry: FoundryData | null; resolve: PartMasteryResolver }
>();

/** For per-row callers: building the resolver indexes the whole item database,
 *  which a card list must not repeat per card. */
export function sharedPartMasteryResolver(
  itemDb: Record<string, ItemDbEntry>,
  mastery: MasteryData | null,
  foundry: FoundryData | null = null,
): PartMasteryResolver {
  const cached = RESOLVER_CACHE.get(itemDb);
  if (cached && cached.mastery === mastery && cached.foundry === foundry) return cached.resolve;
  const resolve = buildPartMasteryResolver(
    itemDb,
    mastery,
    foundry ? foundryClaimableProducts(foundry, Date.now()) : NO_CLAIMABLE_PARENTS,
  );
  RESOLVER_CACHE.set(itemDb, { mastery, foundry, resolve });
  return resolve;
}

/** Takes a prebuilt resolver: it indexes the whole item database, so keep one
 * per itemDb/mastery pair. */
export function attachPartMasteryFlags<T extends RowLike>(
  rows: T[],
  resolve: PartMasteryResolver,
  verdicts?: SafetyVerdictLookup,
): T[] {
  return rows.map((row) => {
    const { component, ...flags } = resolve(row);
    const verdict = component && row.internalName ? verdicts?.get(row.internalName) : undefined;
    if (
      flags.parentMastered === undefined &&
      flags.parentClaimable === undefined &&
      verdict === undefined
    ) {
      return row;
    }
    return { ...row, ...flags, ...(verdict ? { spare: verdict.safe > 0 } : {}) };
  });
}
