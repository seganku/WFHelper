import { assertMainRendererSender, handleAuthorized } from "./ipcSecurity";
import ctx from "./context";
import * as rivenFingerprint from "../services/rivenFingerprint";
import * as rivenGrading from "../services/rivenGrading";
import * as wfmRivenSearch from "../services/wfmRivenSearch";
import * as rivenData from "../services/rivenData";
import * as rivenBestAttributes from "../services/rivenBestAttributes";
import { isMultiplierTag } from "../services/rivenConstants";
import { getRivenWeaponSlugs } from "../services/wfmRivenItems";
import { boundedInt, isObject, stringArray } from "./ipcValidators";
import { toFiniteNumber } from "../config/shared/numeric";
import { toNonEmptyString } from "../config/shared/stringValidation";
import { normalizeWfmSlugKey } from "../config/shared/wfm";
import { VARIANT_PREFIXES, VARIANT_SUFFIXES } from "../config/shared/weaponVariants";
import {
  polarityToWfm,
  tagToWfmUrlName,
  wfmUrlNameToTag,
} from "../config/shared/wfmRivenVocabulary";
import {
  RIVENS_GET,
  RIVENS_GET_WEAPON_NAMES,
  RIVENS_GET_STAT_OPTIONS,
  RIVENS_SEARCH_AUCTIONS,
  RIVENS_GET_BEST_ATTRIBUTES,
  RIVENS_GET_GOOD_ROLL,
  RIVENS_REFRESH_GOOD_ROLLS,
  RIVENS_GRADE_CONTRACTS,
  RIVENS_CREATE_AUCTION,
  RIVENS_UPDATE_AUCTION,
  RIVENS_DELETE_AUCTION,
} from "../config/shared/ipcChannels";

const MAX_AUCTION_STATS = 8;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_MIN_REPUTATION = 1_000_000;
const MAX_GRADED_CONTRACTS = 100;

interface ContractGradeStat {
  name: string;
  positive: boolean;
  value: number | null;
}

interface ContractGradeRequest {
  weaponName: string;
  modRank: number | null;
  stats: ContractGradeStat[];
}

interface ContractGrade {
  overallGrade: string;
  attributeGrade: string;
  stats: { grade: string; rollFloat: number }[];
}

interface ContractGradesResult {
  grades: (ContractGrade | null)[];
  sheetReady: boolean;
}

function parseContractGradeStat(value: unknown): ContractGradeStat | null {
  if (!isObject(value)) return null;
  const name = toNonEmptyString(value.name, 100);
  if (!name || typeof value.positive !== "boolean") return null;
  const numeric = value.value == null ? null : toFiniteNumber(value.value);
  if (value.value != null && numeric == null) return null;
  return { name, positive: value.positive, value: numeric };
}

function parseContractGradeRequest(value: unknown): ContractGradeRequest | null {
  if (!isObject(value)) return null;
  const weaponName = toNonEmptyString(value.weaponName, 120);
  if (!weaponName) return null;
  let modRank: number | null = null;
  if (value.modRank != null) {
    const rank = toFiniteNumber(value.modRank);
    if (
      rank == null ||
      !Number.isInteger(rank) ||
      rank < 0 ||
      rank > rivenGrading.MAX_RIVEN_MOD_RANK
    ) {
      return null;
    }
    modRank = rank;
  }
  const raw = value.stats;
  if (!Array.isArray(raw) || raw.length > MAX_AUCTION_STATS) return null;
  const stats: ContractGradeStat[] = [];
  for (const entry of raw) {
    const stat = parseContractGradeStat(entry);
    if (!stat) return null;
    stats.push(stat);
  }
  return { weaponName, modRank, stats };
}

// A contract names its weapon by WFM family slug, title-cased: "Silva And Aegis".
function resolveContractWeapon(name: string): string | null {
  if (rivenData.getWeaponDisposition(name) != null) return name;
  const slug = normalizeWfmSlugKey(name);
  return slug ? weaponNameForFamilySlug(slug) : null;
}

// WFM speaks url_names, but a seller's client may have sent a localized label.
function contractStatTag(name: string, isMelee: boolean): string | null {
  const key = name.toLowerCase().trim();
  return wfmUrlNameToTag(key, isMelee) ?? rivenData.statNameToTag(key.replace(/_/g, " "));
}

function gradeContract(request: ContractGradeRequest): ContractGrade | null {
  const weapon = resolveContractWeapon(request.weaponName);
  if (!weapon) return null;
  const isMelee = rivenData.isMeleeWeapon(weapon);
  const stats = request.stats.map((stat) => {
    const tag = contractStatTag(stat.name, isMelee);
    return {
      name: tag ? rivenData.getStatDisplayName(tag, isMelee) : stat.name,
      positive: stat.positive,
      value: stat.value == null ? null : Math.abs(stat.value),
      multiplier: tag != null && isMultiplierTag(tag),
    };
  });
  const graded = rivenGrading.gradeRiven(weapon, stats, request.modRank);
  if (!graded) return null;
  return {
    overallGrade: graded.overallGrade,
    attributeGrade: graded.attributeGrade,
    stats: graded.stats.map((stat) => ({ grade: stat.grade, rollFloat: stat.rollFloat })),
  };
}

function auctionDescription(value: unknown): string | null {
  if (value == null) return "";
  if (typeof value !== "string" || value.length > MAX_DESCRIPTION_LENGTH) return null;
  return value.trim();
}

/** Absent means "no minimum", which WFM spells as 0. */
function auctionReputation(value: unknown): number | null {
  if (value == null) return 0;
  return boundedInt(value, 0, MAX_MIN_REPUTATION);
}

interface CreateAuctionStat {
  tag: string;
  value: number;
  positive: boolean;
  multiplier?: boolean;
}

function isCreateAuctionStat(value: unknown): value is CreateAuctionStat {
  if (!isObject(value)) return false;
  return (
    toNonEmptyString(value.tag, 100) != null &&
    toFiniteNumber(value.value) != null &&
    typeof value.positive === "boolean" &&
    (value.multiplier == null || typeof value.multiplier === "boolean")
  );
}

function weaponNameForFamilySlug(slug: string): string | null {
  if (!/^[a-z0-9_]+$/.test(slug)) return null;
  for (const name of rivenData.getAllRivenWeaponNames()) {
    if (rivenData.getRivenFamilySlug(name) === slug) return name;
  }
  return null;
}

function hasVariantAffix(name: string): boolean {
  const lc = name.toLowerCase();
  return (
    VARIANT_SUFFIXES.some((suffix) => lc.endsWith(suffix.toLowerCase())) ||
    VARIANT_PREFIXES.some((prefix) => lc.startsWith(prefix.toLowerCase()))
  );
}

async function rivenMarketWeaponNames(): Promise<string[]> {
  const names = rivenData.getAllRivenWeaponNames();
  const families = await getRivenWeaponSlugs();
  if (!families) return names;
  const byFamily = new Map<string, string>();
  for (const name of names) {
    const slug = rivenData.getRivenFamilySlug(name);
    if (!slug || !families.has(slug)) continue;
    const chosen = byFamily.get(slug);
    if (chosen && (!hasVariantAffix(chosen) || hasVariantAffix(name))) continue;
    byFamily.set(slug, name);
  }
  return [...byFamily.values()].sort((a, b) => a.localeCompare(b));
}

function register(): void {
  handleAuthorized(RIVENS_GET, assertMainRendererSender, async () => {
    if (!ctx.currentInventoryData) {
      return { unveiled: [], veiled: [], veiledUnseen: [] };
    }

    await rivenBestAttributes.ensureRivenGoodRollsLoaded();
    return rivenFingerprint.decodeAllRivens(ctx.currentInventoryData);
  });

  handleAuthorized(
    RIVENS_GET_WEAPON_NAMES,
    assertMainRendererSender,
    (_event, rivenMarketOnly: unknown) =>
      rivenMarketOnly === true ? rivenMarketWeaponNames() : rivenData.getAllRivenWeaponNames(),
  );

  handleAuthorized(RIVENS_GET_STAT_OPTIONS, assertMainRendererSender, () =>
    rivenData.getRivenStatOptions(),
  );

  handleAuthorized(
    RIVENS_SEARCH_AUCTIONS,
    assertMainRendererSender,
    async (_event, weaponName: unknown, positiveWfmNames: unknown, negativeWfmNames: unknown) => {
      const weapon = toNonEmptyString(weaponName, 120);
      if (!weapon) return [];
      const slug = rivenData.getRivenFamilySlug(weapon);
      if (!slug) return [];

      const posArr = stringArray(positiveWfmNames, MAX_AUCTION_STATS, 100);
      const negArr = stringArray(negativeWfmNames, MAX_AUCTION_STATS, 100);

      return wfmRivenSearch.searchSimilarRivens(slug, {
        limit: 2000,
        positiveStats: posArr.length > 0 ? posArr : undefined,
        negativeStats: negArr.length > 0 ? negArr : undefined,
      });
    },
  );

  handleAuthorized(
    RIVENS_GET_BEST_ATTRIBUTES,
    assertMainRendererSender,
    async (_event, weaponName: unknown) => {
      const weapon = toNonEmptyString(weaponName, 120);
      await rivenBestAttributes.ensureRivenGoodRollsLoaded();
      return {
        attributes: weapon
          ? rivenBestAttributes.getBestAttributes(weapon, rivenData.isMeleeWeapon(weapon))
          : null,
        updatedAt: rivenBestAttributes.getRivenGoodRollsUpdatedAt(),
      };
    },
  );

  handleAuthorized(
    RIVENS_GET_GOOD_ROLL,
    assertMainRendererSender,
    async (_event, weaponName: unknown) => {
      const weapon = toNonEmptyString(weaponName, 120);
      if (!weapon) return null;
      await rivenBestAttributes.ensureRivenGoodRollsLoaded();
      const detail = rivenBestAttributes.getGoodRollDetail(weapon, rivenData.isMeleeWeapon(weapon));
      if (detail) return detail;
      // WFM slugs spell the ampersand out ("silva_and_aegis"), so the sheet's name never matches.
      const bySlug = weaponNameForFamilySlug(weapon);
      return bySlug
        ? rivenBestAttributes.getGoodRollDetail(bySlug, rivenData.isMeleeWeapon(bySlug))
        : null;
    },
  );

  handleAuthorized(
    RIVENS_REFRESH_GOOD_ROLLS,
    assertMainRendererSender,
    async (_event, weaponName: unknown) => {
      await rivenBestAttributes.ensureRivenGoodRollsLoaded(true);
      const updatedAt = rivenBestAttributes.getRivenGoodRollsUpdatedAt();
      const weapon = toNonEmptyString(weaponName, 120);
      const attributes = weapon
        ? rivenBestAttributes.getBestAttributes(weapon, rivenData.isMeleeWeapon(weapon))
        : null;
      return { attributes, updatedAt };
    },
  );

  handleAuthorized(
    RIVENS_GRADE_CONTRACTS,
    assertMainRendererSender,
    async (_event, payload: unknown): Promise<ContractGradesResult> => {
      const sheetReady = rivenBestAttributes.rivenGoodRollsAreCurrent();
      if (!Array.isArray(payload) || payload.length > MAX_GRADED_CONTRACTS) {
        return { grades: [], sheetReady };
      }
      const requests = payload.map(parseContractGradeRequest);
      if (requests.some((request) => request != null)) {
        void rivenBestAttributes.ensureRivenGoodRollsLoaded();
      }
      return {
        grades: requests.map((request) => (request ? gradeContract(request) : null)),
        sheetReady,
      };
    },
  );

  handleAuthorized(
    RIVENS_CREATE_AUCTION,
    assertMainRendererSender,
    async (_event, payload: unknown) => {
      if (!isObject(payload)) return { ok: false, error: "Invalid payload" };
      const {
        weaponName,
        rivenName,
        stats,
        rerolls,
        masteryReq,
        polarity,
        modRank,
        buyoutPrice,
        startingPrice,
        minReputation,
        isPrivate,
        description,
      } = payload;
      const weapon = toNonEmptyString(weaponName, 120);
      if (!weapon) return { ok: false, error: "Invalid weapon name" };
      if (!Array.isArray(stats) || stats.length === 0 || stats.length > MAX_AUCTION_STATS)
        return { ok: false, error: "No stats provided" };
      if (!stats.every(isCreateAuctionStat)) return { ok: false, error: "Invalid stats payload" };
      const price = boundedInt(startingPrice, 1, 10_000_000);
      if (price == null) return { ok: false, error: "Invalid price" };
      const reputation = auctionReputation(minReputation);
      if (reputation == null) return { ok: false, error: "Invalid minimum reputation" };
      const descriptionValue = auctionDescription(description);
      if (descriptionValue == null) return { ok: false, error: "Invalid description" };

      const slug = rivenData.getRivenFamilySlug(weapon);
      if (!slug) return { ok: false, error: "Unknown weapon" };

      const attributes = stats.map((s) => {
        const urlName = tagToWfmUrlName(String(s.tag));
        // WFM preserves displayed signs, including negative recoil buffs and positive curses.
        const value = toFiniteNumber(s.value) ?? 0;
        return {
          url_name: urlName || String(s.tag),
          value,
          positive: s.positive !== false,
        };
      });

      // WFM rejects an unknown polarity, so an absent value defaults instead of erroring.
      const wfmPolarity = polarityToWfm(toNonEmptyString(polarity, 32)) ?? "madurai";

      // WFM expects only the generated suffix portion of the riven name in lowercase
      // (e.g. "croni-visican"), NOT the full "Angstrum Croni-visican".
      const rivenSuffix = (() => {
        const rn = toNonEmptyString(rivenName, 120) ?? weapon;
        const prefix = weapon + " ";
        const suffix = rn.startsWith(prefix) ? rn.slice(prefix.length) : rn;
        return suffix.toLowerCase();
      })();

      return wfmRivenSearch.createRivenAuction({
        weaponSlug: slug,
        rivenName: rivenSuffix,
        attributes,
        rerolls: boundedInt(rerolls, 0, 10_000) ?? 0,
        masteryLevel: boundedInt(masteryReq, 0, 99) ?? 0,
        polarity: wfmPolarity,
        modRank: boundedInt(modRank, 0, 20) ?? 0,
        buyoutPrice: boundedInt(buyoutPrice, 1, 10_000_000),
        startingPrice: price,
        minReputation: reputation,
        isPrivate: isPrivate === true,
        description: descriptionValue,
      });
    },
  );

  handleAuthorized(
    RIVENS_UPDATE_AUCTION,
    assertMainRendererSender,
    async (_event, payload: unknown) => {
      if (!isObject(payload)) return { ok: false, error: "Invalid payload" };
      const {
        auctionId,
        buyoutPrice,
        startingPrice,
        minReputation,
        isPrivate,
        description,
        visible,
      } = payload;
      const id = toNonEmptyString(auctionId, 64);
      if (!id || !/^[a-zA-Z0-9]+$/.test(id)) {
        return { ok: false, error: "Invalid auction id" };
      }
      // Null is a direct sell, which never had an opening bid.
      const price = startingPrice == null ? null : boundedInt(startingPrice, 1, 10_000_000);
      if (startingPrice != null && price == null) {
        return { ok: false, error: "Invalid price" };
      }
      if (typeof visible !== "boolean" && typeof isPrivate !== "boolean") {
        return { ok: false, error: "Invalid visibility" };
      }
      const buyout = buyoutPrice == null ? null : boundedInt(buyoutPrice, 1, 10_000_000);
      if (buyoutPrice != null && buyout == null) {
        return { ok: false, error: "Invalid buyout price" };
      }
      const reputation = auctionReputation(minReputation);
      if (reputation == null) return { ok: false, error: "Invalid minimum reputation" };
      const descriptionValue = auctionDescription(description);
      if (descriptionValue == null) return { ok: false, error: "Invalid description" };

      return wfmRivenSearch.updateRivenAuction({
        auctionId: id,
        buyoutPrice: buyout,
        startingPrice: price,
        minReputation: reputation,
        description: descriptionValue,
        ...(typeof isPrivate === "boolean" ? { isPrivate } : {}),
        ...(typeof visible === "boolean" ? { visible } : {}),
      });
    },
  );

  handleAuthorized(
    RIVENS_DELETE_AUCTION,
    assertMainRendererSender,
    async (_event, payload: unknown) => {
      if (!isObject(payload)) return { ok: false, error: "Invalid payload" };
      const id = toNonEmptyString(payload.auctionId, 64);
      if (!id || !/^[a-zA-Z0-9]+$/.test(id)) {
        return { ok: false, error: "Invalid auction id" };
      }
      return wfmRivenSearch.deleteRivenAuction(id);
    },
  );
}

export { register, rivenMarketWeaponNames };
