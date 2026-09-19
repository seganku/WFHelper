// The vocabulary warframe.market keys riven auctions on. Attribute slugs do not
// follow display-name normalization, so they are listed rather than derived.
// Source: https://api.warframe.market/v1/riven/attributes

/** Game upgrade tag to WFM auction attribute url_name. */
export const TAG_TO_WFM_URL_NAME: Record<string, string> = {
  WeaponCritChanceMod: "critical_chance",
  WeaponCritDamageMod: "critical_damage",
  WeaponFireIterationsMod: "multishot",
  WeaponFireRateMod: "fire_rate_/_attack_speed",
  WeaponDamageAmountMod: "base_damage_/_melee_damage",
  WeaponReloadSpeedMod: "reload_speed",
  WeaponStunChanceMod: "status_chance",
  WeaponProcTimeMod: "status_duration",
  WeaponPunctureDepthMod: "punch_through",
  WeaponClipMaxMod: "magazine_capacity",
  WeaponAmmoMaxMod: "ammo_maximum",
  WeaponRecoilReductionMod: "recoil",
  WeaponZoomFovMod: "zoom",
  WeaponProjectileSpeedMod: "projectile_speed",
  WeaponImpactDamageMod: "impact_damage",
  WeaponArmorPiercingDamageMod: "puncture_damage",
  WeaponSlashDamageMod: "slash_damage",
  WeaponFreezeDamageMod: "cold_damage",
  WeaponFireDamageMod: "heat_damage",
  WeaponElectricityDamageMod: "electric_damage",
  WeaponToxinDamageMod: "toxin_damage",
  WeaponFactionDamageGrineer: "damage_vs_grineer",
  WeaponFactionDamageCorpus: "damage_vs_corpus",
  WeaponFactionDamageInfested: "damage_vs_infested",
  WeaponMeleeDamageMod: "base_damage_/_melee_damage",
  WeaponMeleeRangeIncMod: "range",
  ComboDurationMod: "combo_duration",
  SlideAttackCritChanceMod: "critical_chance_on_slide_attack",
  WeaponMeleeFinisherDamageMod: "finisher_damage",
  WeaponMeleeComboEfficiencyMod: "channeling_efficiency",
  WeaponMeleeComboInitialBonusMod: "channeling_damage",
  WeaponMeleeComboPointsOnHitMod: "chance_to_gain_combo_count",
  WeaponMeleeComboBonusOnHitMod: "chance_to_gain_extra_combo_count",
  WeaponMeleeFactionDamageGrineer: "damage_vs_grineer",
  WeaponMeleeFactionDamageCorpus: "damage_vs_corpus",
  WeaponMeleeFactionDamageInfested: "damage_vs_infested",
};

/** Resolves a game upgrade tag to its WFM attribute url_name. */
export function tagToWfmUrlName(tag: string): string | null {
  return TAG_TO_WFM_URL_NAME[tag] || null;
}

// WFM's "base_damage_/_melee_damage" url_name carries both damage tags.
const WFM_URL_NAME_TO_TAGS = new Map<string, string[]>();
for (const [tag, urlName] of Object.entries(TAG_TO_WFM_URL_NAME)) {
  WFM_URL_NAME_TO_TAGS.set(urlName, [...(WFM_URL_NAME_TO_TAGS.get(urlName) ?? []), tag]);
}

export function wfmUrlNameToTag(urlName: string, isMelee: boolean): string | null {
  const tags = WFM_URL_NAME_TO_TAGS.get(urlName);
  if (!tags) return null;
  return tags.find((tag) => tag.includes("Melee") === isMelee) ?? tags[0];
}

// The game spells polarity AP_ATTACK where WFM names it after the focus school.
// A riven only ever rolls AP_ATTACK, AP_DEFENSE or AP_TACTIC, so those three and
// the names WFM hands back are the whole vocabulary. Any other school is one the
// auction form rejects, so it must never reach a payload or a match.
const POLARITY_TO_WFM: Record<string, string> = {
  ap_attack: "madurai",
  madurai: "madurai",
  ap_defense: "vazarin",
  vazarin: "vazarin",
  ap_tactic: "naramon",
  naramon: "naramon",
};

/** Folds a polarity to the WFM vocabulary; null for anything WFM has no name for. */
export function polarityToWfm(value: string | null | undefined): string | null {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return POLARITY_TO_WFM[raw] ?? null;
}
