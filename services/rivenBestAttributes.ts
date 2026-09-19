import {
  type GoodRollData,
  parseRivenGoodRollCsv,
  type RivenGoodRoll,
  type RivenGoodRollAttribute,
  RIVEN_GOOD_ROLL_TABS,
  RIVEN_GOOD_ROLLS_SHEET_ID,
} from "../config/shared/rivenGoodRolls";
import { withAbortTimeout } from "../config/shared/fetchWithTimeout";
import { statTagToDisplayName } from "../config/shared/rivenStatDisplayNames";
import { normalizeForSearch } from "../config/shared/textNormalize";
import { normalizeWfmSlugKey } from "../config/shared/wfm";
import { tagToWfmUrlName } from "../config/shared/wfmRivenVocabulary";
import { createJsonCache } from "./jsonCache";
import { withScope } from "./logger";
import { getRivenFamilySlug } from "./rivenData";

const log = withScope("rivenBestAttributes");

type GoodRollMap = Record<string, GoodRollData>;

interface CachePayload {
  updatedAt: string;
  data: GoodRollMap;
}

const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const REFETCH_COOLDOWN_MS = 10 * 60 * 1000;
const SHEET_FETCH_TIMEOUT_MS = 20_000;

// Affixes the sheet folds into the base row that VARIANT_PREFIXES leaves alone:
// warframe.market keys those variants as riven families of their own.
const SHEET_ONLY_PREFIXES = ["Coda ", "Dex ", "Mara ", "Carmine ", "Ceti ", "Prime "];

let goodRolls: GoodRollMap | null = null;
let goodRollsUpdatedAt: string | null = null;
let loadPromise: Promise<void> | null = null;
let lastFetchStartedAt = 0;
let familyKeys: Map<string, string> | null = null;

function setGoodRolls(data: GoodRollMap, updatedAt: string | null): void {
  goodRolls = data;
  goodRollsUpdatedAt = updatedAt;
  familyKeys = null;
}

interface BestAttributes {
  positives: string[];
  negatives: string[];
}

export type { GoodRollData };

function isGoodRollData(value: unknown): value is GoodRollData {
  if (!value || typeof value !== "object") return false;
  const data = value as GoodRollData;
  return Array.isArray(data.goodAttrs) && Array.isArray(data.acceptedBadAttrs);
}

const cache = createJsonCache<CachePayload>("riven-good-rolls-cache.json", (raw) => {
  const parsed = raw as Partial<CachePayload>;
  if (!parsed.updatedAt || !parsed.data || typeof parsed.data !== "object") return null;
  const data: GoodRollMap = {};
  for (const [name, value] of Object.entries(parsed.data)) {
    if (isGoodRollData(value)) data[name] = value;
  }
  return Object.keys(data).length > 0 ? { updatedAt: parsed.updatedAt, data } : null;
});

function loadCacheIfNeeded(): void {
  if (goodRolls) return;
  const cached = cache.read();
  if (cached) setGoodRolls(cached.data, cached.updatedAt);
}

function stripSheetOnlyPrefix(nameLc: string): string {
  for (const prefix of SHEET_ONLY_PREFIXES) {
    const affix = prefix.toLowerCase();
    if (nameLc.startsWith(affix)) return nameLc.slice(affix.length).trim();
  }
  return nameLc;
}

function familyKeyIndex(): Map<string, string> {
  if (familyKeys) return familyKeys;
  const index = new Map<string, string>();
  for (const key of Object.keys(goodRolls ?? {})) {
    const slug = normalizeWfmSlugKey(key.replace(/&/g, " and "));
    if (slug && !index.has(slug)) index.set(slug, key);
  }
  familyKeys = index;
  return index;
}

// The sheet rates one row per weapon family, so a variant only matches under the
// family name rivenData resolves for it.
function lookupName(weaponName: string): string | null {
  if (!weaponName) return null;
  loadCacheIfNeeded();
  if (!goodRolls) return null;
  const lc = normalizeForSearch(weaponName);
  if (goodRolls[lc]) return lc;
  const folded = stripSheetOnlyPrefix(lc);
  if (!folded) return null;
  if (folded !== lc && goodRolls[folded]) return folded;
  const slug = getRivenFamilySlug(folded);
  if (!slug) return null;
  return familyKeyIndex().get(slug) ?? null;
}

async function fetchSheet(): Promise<GoodRollMap> {
  const next: GoodRollMap = {};
  for (const { gid, klass } of RIVEN_GOOD_ROLL_TABS) {
    const url = `https://docs.google.com/spreadsheets/d/${RIVEN_GOOD_ROLLS_SHEET_ID}/export?format=csv&gid=${gid}`;
    const csv = await withAbortTimeout(SHEET_FETCH_TIMEOUT_MS, async (signal) => {
      const response = await fetch(url, { redirect: "follow", signal });
      if (!response.ok) throw new Error(`gid=${gid}: HTTP ${response.status}`);
      return response.text();
    });
    for (const entry of parseRivenGoodRollCsv(csv, klass)) {
      if (!next[entry.name]) {
        next[entry.name] = {
          goodAttrs: entry.goodAttrs,
          acceptedBadAttrs: entry.acceptedBadAttrs,
        };
      }
    }
  }
  return next;
}

function hasSheet(): boolean {
  return goodRolls != null && Object.keys(goodRolls).length > 0;
}

function sheetIsStale(): boolean {
  if (!goodRollsUpdatedAt) return false;
  const ageMs = Date.now() - Date.parse(goodRollsUpdatedAt);
  return !Number.isFinite(ageMs) || ageMs > CACHE_MAX_AGE_MS;
}

async function refreshSheet(): Promise<void> {
  try {
    const fresh = await fetchSheet();
    const updatedAt = new Date().toISOString();
    setGoodRolls(fresh, updatedAt);
    cache.write({ updatedAt, data: fresh });
    log.info(`Loaded ${Object.keys(fresh).length} riven good-roll rows from Google Sheet`);
  } catch (err) {
    const cached = cache.read();
    if (cached) {
      setGoodRolls(cached.data, cached.updatedAt);
      const ageMs = Date.now() - Date.parse(cached.updatedAt);
      const staleNote = Number.isFinite(ageMs) && ageMs > CACHE_MAX_AGE_MS ? " (stale)" : "";
      log.warn(`Using cached riven good-rolls data${staleNote}`, err);
    } else if (!hasSheet()) {
      setGoodRolls({}, null);
      log.warn("No riven good-rolls data available", err);
    } else {
      log.warn("Riven good-rolls refresh failed, keeping the loaded sheet", err);
    }
  } finally {
    loadPromise = null;
  }
}

export function rivenGoodRollsAreCurrent(): boolean {
  loadCacheIfNeeded();
  return hasSheet() && !sheetIsStale();
}

export async function ensureRivenGoodRollsLoaded(force = false): Promise<void> {
  loadCacheIfNeeded();
  const loaded = hasSheet();
  if (loaded && !force && !sheetIsStale()) return;
  const waits = force || !loaded;
  if (loadPromise) return waits ? loadPromise : undefined;
  if (!force && Date.now() - lastFetchStartedAt < REFETCH_COOLDOWN_MS) return;

  lastFetchStartedAt = Date.now();
  loadPromise = refreshSheet();
  return waits ? loadPromise : undefined;
}

export function setRivenGoodRollsForTest(data: GoodRollMap, updatedAt: string | null = null): void {
  setGoodRolls(data, updatedAt);
  loadPromise = null;
  lastFetchStartedAt = 0;
}

export function getRivenGoodRollsUpdatedAt(): string | null {
  loadCacheIfNeeded();
  return goodRollsUpdatedAt;
}

export function getGoodRolls(weaponName: string): GoodRollData | null {
  const key = lookupName(weaponName);
  return key && goodRolls ? goodRolls[key] : null;
}

function toAttribute(tag: string, isMelee: boolean): RivenGoodRollAttribute {
  return {
    tag,
    wfmUrlName: tagToWfmUrlName(tag),
    displayName: statTagToDisplayName(tag, isMelee),
  };
}

export function getGoodRollDetail(weaponName: string, isMelee = false): RivenGoodRoll | null {
  const data = getGoodRolls(weaponName);
  if (!data) return null;
  return {
    groups: data.goodAttrs.map((roll) => ({
      mandatory: roll.mandatory.map((tag) => toAttribute(tag, isMelee)),
      optional: roll.optional.map((tag) => toAttribute(tag, isMelee)),
    })),
    acceptedNegatives: data.acceptedBadAttrs.map((tag) => toAttribute(tag, isMelee)),
    updatedAt: goodRollsUpdatedAt,
  };
}

export function getBestAttributes(weaponName: string, isMelee = false): BestAttributes | null {
  const data = getGoodRolls(weaponName);
  if (!data) return null;

  const seen = new Set<string>();
  const positives: string[] = [];
  for (const roll of data.goodAttrs) {
    for (const tag of roll.mandatory) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      positives.push(statTagToDisplayName(tag, isMelee));
    }
  }
  for (const roll of data.goodAttrs) {
    for (const tag of roll.optional) {
      if (seen.has(tag)) continue;
      seen.add(tag);
      positives.push(statTagToDisplayName(tag, isMelee));
    }
  }
  const negatives = data.acceptedBadAttrs.map((tag) => statTagToDisplayName(tag, isMelee));
  return { positives, negatives };
}
