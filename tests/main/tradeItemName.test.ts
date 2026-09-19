import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../services/wfmCatalog", () => ({
  lookupByName: vi.fn(),
}));

import { parseTradedItemName } from "../../config/shared/tradeItemName";
import { lookupTradedCatalogItem } from "../../services/tradeItemName";
import * as wfmCatalog from "../../services/wfmCatalog";

const mockLookupByName = vi.mocked(wfmCatalog.lookupByName);

describe("parseTradedItemName", () => {
  it("leaves plain names untouched", () => {
    expect(parseTradedItemName("Ash Prime Chassis")).toEqual({
      baseName: "Ash Prime Chassis",
      rank: null,
      riven: null,
    });
  });

  it("strips the rank suffix off mods and arcanes", () => {
    expect(parseTradedItemName("Serration (RANK 10)")).toEqual({
      baseName: "Serration",
      rank: 10,
      riven: null,
    });
    expect(parseTradedItemName("Arcane Energize (RANK 0)")).toEqual({
      baseName: "Arcane Energize",
      rank: 0,
      riven: null,
    });
  });

  it("reads the rank whatever case the dialog wrote it in", () => {
    expect(parseTradedItemName("Magus Elevate (Rank 3)")).toEqual({
      baseName: "Magus Elevate",
      rank: 3,
      riven: null,
    });
  });

  it("reports no rank for a name that carries no suffix at all", () => {
    expect(parseTradedItemName("Arcane Energize")).toEqual({
      baseName: "Arcane Energize",
      rank: null,
      riven: null,
    });
  });

  it("splits an unveiled riven into weapon and roll name", () => {
    expect(parseTradedItemName("Rubico Visio-Critatis (RIVEN RANK 8)")).toEqual({
      baseName: "Rubico Visio-Critatis",
      rank: 8,
      riven: { weapon: "Rubico", suffix: "Visio-Critatis" },
    });
  });

  it("keeps multi-word weapon names on the weapon side", () => {
    expect(parseTradedItemName("Kuva Bramma Croni-Tempis (RIVEN RANK 0)").riven).toEqual({
      weapon: "Kuva Bramma",
      suffix: "Croni-Tempis",
    });
  });

  it("treats veiled rivens as ordinary market items", () => {
    expect(parseTradedItemName("Rifle Riven Mod (RIVEN RANK 0)").riven).toBeNull();
  });

  it("drops non-rank suffixes without inventing a rank", () => {
    expect(parseTradedItemName("Mortus Lungfish (A)")).toEqual({
      baseName: "Mortus Lungfish",
      rank: null,
      riven: null,
    });
  });

  it("keeps the name when the parens are the whole string", () => {
    expect(parseTradedItemName("(RANK 3)").baseName).toBe("(RANK 3)");
  });
});

describe("lookupTradedCatalogItem", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLookupByName.mockReturnValue(null);
  });

  it("looks the item up without its rank suffix", () => {
    lookupTradedCatalogItem("Primed Flow (RANK 10)");
    expect(mockLookupByName).toHaveBeenCalledWith("Primed Flow");
  });

  it("retries without the blueprint wording", () => {
    lookupTradedCatalogItem("Ash Prime Chassis Blueprint");
    expect(mockLookupByName).toHaveBeenNthCalledWith(1, "Ash Prime Chassis Blueprint");
    expect(mockLookupByName).toHaveBeenNthCalledWith(2, "Ash Prime Chassis");
  });
});
