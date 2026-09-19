export const NUM_BUFFS_ATTEN = [0, 1, 0.66000003, 0.5, 0.40000001, 0.34999999];

/** Curse-specific attenuation indexed by number of buffs (NOT curses). */
export const NUM_BUFFS_CURSE_ATTEN = [0, 1, 0.33000001, 0.5, 1.25, 1.5];

export const SPECIFIC_FIT_ATTEN = 1.5;
export const BASE_DRAIN = 10;

export const NON_PERCENTAGE_TAGS = new Set([
  "WeaponFactionDamageGrineer",
  "WeaponFactionDamageCorpus",
  "WeaponFactionDamageInfested",
  "WeaponMeleeFactionDamageGrineer",
  "WeaponMeleeFactionDamageCorpus",
  "WeaponMeleeFactionDamageInfested",
  "WeaponMeleeComboInitialBonusMod",
  "ComboDurationMod",
  "WeaponMeleeRangeIncMod",
  // Metres, like melee range - the card reads "+3.7 Punch Through", no percent.
  "WeaponPunctureDepthMod",
]);

/** Stats the card renders as the final factor (x1.05, x0.55), so every reader
 *  has to subtract the 1 before it sees the roll. */
export function isMultiplierTag(tag: string): boolean {
  if (!NON_PERCENTAGE_TAGS.has(tag)) return false;
  return tag.includes("FactionDamage") || tag === "WeaponMeleeComboInitialBonusMod";
}
