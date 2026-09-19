import { beforeAll, describe, expect, it } from "vitest";

import * as itemDb from "../../services/itemDatabase";

const KHORA_PRIME = "/Lotus/Powersuits/Khora/KhoraPrime";
const VENARI_PRIME = "/Lotus/Powersuits/Khora/Kavat/KhoraPrimeKavatPowerSuit";
const VENARI = "/Lotus/Powersuits/Khora/Kavat/KhoraKavatPowerSuit";

describe("itemDatabase companion vaulting", () => {
  beforeAll(() => {
    itemDb.buildDatabase();
  });

  it("Venari Prime follows Khora Prime's vaulted status (issue #49)", () => {
    const khoraPrime = itemDb.lookupItem(KHORA_PRIME);
    const venariPrime = itemDb.lookupItem(VENARI_PRIME);
    expect(khoraPrime).not.toBeNull();
    expect(venariPrime).not.toBeNull();
    // the inheritance is only observable while the parent frame is vaulted
    expect(khoraPrime?.vaulted).toBe(true);
    expect(venariPrime?.vaulted).toBe(true);
  });

  it("the regular Venari stays unvaulted like Khora", () => {
    expect(itemDb.lookupItem(VENARI)?.vaulted).toBe(false);
  });
});
