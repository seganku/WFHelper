import { VALUE_MIN_PLATINUM_PRESETS } from "../lib/inventory/valueTotals.js";
import { persistedBoolean, persistedPresetNumber } from "../lib/persistence.js";

export const hideFounderMasteryItems = persistedBoolean("wf_hide_founder_mastery_items", false);
export const hideFoundryClaims = persistedBoolean("wf_hide_foundry_claims", true);
export const autoFocusSearch = persistedBoolean("wf_auto_focus_search", false);
export const showMasteredBadges = persistedBoolean("wf_show_mastered_badges", true);
export const showOwnedParentBadges = persistedBoolean("wf_show_owned_parent_badges", true);
export const showVaultedBadges = persistedBoolean("wf_show_vaulted_badges", true);
export const inventoryValueAllTradables = persistedBoolean(
  "wf_inventory_value_all_tradables",
  false,
);
export const inventoryValueMinPlatinum = persistedPresetNumber(
  "wf_inventory_value_min_plat",
  VALUE_MIN_PLATINUM_PRESETS,
  0,
);
