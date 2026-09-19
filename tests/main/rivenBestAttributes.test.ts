import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../services/logger", () => ({
  withScope: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  ensureRivenGoodRollsLoaded,
  getGoodRolls,
  rivenGoodRollsAreCurrent,
  setRivenGoodRollsForTest,
  type GoodRollData,
} from "../../services/rivenBestAttributes";

// The 44bananas sheet keys one row per weapon family, always by the base name.
function row(mandatory: string): GoodRollData {
  return { goodAttrs: [{ mandatory: [mandatory], optional: [] }], acceptedBadAttrs: [] };
}

const SHEET: Record<string, GoodRollData> = {
  boltor: row("WeaponCritChanceMod"),
  hek: row("WeaponStunChanceMod"),
  bubonico: row("WeaponFireIterationsMod"),
  "laser rifle": row("WeaponCritDamageMod"),
  penta: row("WeaponDamageAmountMod"),
  lacera: row("WeaponMeleeDamageMod"),
  detron: row("WeaponFireRateMod"),
  nikana: row("WeaponMeleeRangeIncMod"),
  karak: row("WeaponReloadSpeedMod"),
  braton: row("WeaponClipMaxMod"),
  "telos akbolto": row("WeaponProcTimeMod"),
  akbolto: row("WeaponAmmoMaxMod"),
  bramma: row("WeaponImpactDamageMod"),
  gotva: row("WeaponSlashDamageMod"),
};

beforeEach(() => {
  // A null timestamp keeps the loader from treating the injected sheet as stale.
  setRivenGoodRollsForTest(SHEET, null);
});

describe("riven good-roll freshness", () => {
  it("does not settle on a sheet older than its refresh age", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    setRivenGoodRollsForTest(SHEET, eightDaysAgo);
    expect(rivenGoodRollsAreCurrent()).toBe(false);
    expect(getGoodRolls("Boltor")).toBe(SHEET.boltor);
  });

  it("settles on a sheet fetched within the refresh age", () => {
    setRivenGoodRollsForTest(SHEET, new Date(Date.now() - 60_000).toISOString());
    expect(rivenGoodRollsAreCurrent()).toBe(true);
  });

  it("reports an empty sheet as not current", () => {
    setRivenGoodRollsForTest({}, new Date().toISOString());
    expect(rivenGoodRollsAreCurrent()).toBe(false);
  });

  it("asks for nothing while the sheet is current", async () => {
    setRivenGoodRollsForTest(SHEET, new Date().toISOString());
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect(rivenGoodRollsAreCurrent()).toBe(true);
      await ensureRivenGoodRollsLoaded();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe("riven good-roll lookup", () => {
  it("reaches the base row through a syndicate prefix", () => {
    expect(getGoodRolls("Telos Boltor")).toBe(SHEET.boltor);
    expect(getGoodRolls("Vaykor Hek")).toBe(SHEET.hek);
    expect(getGoodRolls("Sancti Tigris")).toBeNull();
    expect(getGoodRolls("Secura Penta")).toBe(SHEET.penta);
    expect(getGoodRolls("Rakta Cernos")).toBeNull();
    expect(getGoodRolls("Synoid Heliocor")).toBeNull();
  });

  it("reaches the base row through the prefixes warframe.market keys separately", () => {
    expect(getGoodRolls("Coda Bubonico")).toBe(SHEET.bubonico);
    expect(getGoodRolls("Dex Nikana")).toBe(SHEET.nikana);
    expect(getGoodRolls("Mara Detron")).toBe(SHEET.detron);
    expect(getGoodRolls("Ceti Lacera")).toBe(SHEET.lacera);
    expect(getGoodRolls("Carmine Penta")).toBe(SHEET.penta);
    expect(getGoodRolls("Prime Laser Rifle")).toBe(SHEET["laser rifle"]);
  });

  it("keeps the affixes it already stripped", () => {
    expect(getGoodRolls("Boltor Prime")).toBe(SHEET.boltor);
    expect(getGoodRolls("Kuva Karak")).toBe(SHEET.karak);
    expect(getGoodRolls("MK1-Braton")).toBe(SHEET.braton);
    expect(getGoodRolls("Braton Vandal")).toBe(SHEET.braton);
  });

  it("keeps a variant off the row of a base weapon that was never made", () => {
    expect(getGoodRolls("Kuva Bramma")).toBeNull();
    expect(getGoodRolls("Gotva Prime")).toBeNull();
  });

  it("prefers the weapon's own row over its family's", () => {
    expect(getGoodRolls("Telos Akbolto")).toBe(SHEET["telos akbolto"]);
    expect(getGoodRolls("Akbolto Prime")).toBe(SHEET.akbolto);
  });

  it("answers null for a weapon the sheet does not rate", () => {
    expect(getGoodRolls("Haalvu")).toBeNull();
    expect(getGoodRolls("Wrath")).toBeNull();
    expect(getGoodRolls("")).toBeNull();
  });
});
