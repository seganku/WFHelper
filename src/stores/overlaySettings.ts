import { get, writable } from "svelte/store";
import { OVERLAY_SETTINGS_DEFAULTS } from "../../config/runtime/overlaySettings.js";
import { invoke } from "../lib/ipc.js";
import { log } from "../lib/log.js";
import type { OverlaySettings } from "../types/ipc.js";

export const OVERLAY_DEFAULTS: OverlaySettings = {
  ...OVERLAY_SETTINGS_DEFAULTS,
  cycleAlerts: { ...OVERLAY_SETTINGS_DEFAULTS.cycleAlerts },
  fissureAlerts: [...OVERLAY_SETTINGS_DEFAULTS.fissureAlerts],
  overlayWindowBounds: { ...OVERLAY_SETTINGS_DEFAULTS.overlayWindowBounds },
};

export const overlaySettings = writable<OverlaySettings>({
  ...OVERLAY_DEFAULTS,
});

export const overlaySettingsLoaded = writable<boolean>(false);

/** Interface scale detected from EE.cfg; null when the manual slider applies.
 *  Seeded by SettingsView and pushed by main whenever the game saves its config. */
export const detectedWarframeUiScale = writable<number | null>(null);

/** Apply a saved settings response to the stores. Call after ipc.setOverlaySettings / getOverlaySettings. */
export function applyOverlaySettingsResponse(saved: OverlaySettings): void {
  overlaySettings.set({
    ...OVERLAY_DEFAULTS,
    ...saved,
    overlayWindowBounds: {
      ...OVERLAY_DEFAULTS.overlayWindowBounds,
      ...(saved.overlayWindowBounds || {}),
    },
  });
  overlaySettingsLoaded.set(true);
}

let _hydration: Promise<void> | null = null;

/** Pull the saved settings in once per window. Views mount lazily, so whichever
 *  one opens first would otherwise render defaults over what the user saved. */
export function ensureOverlaySettingsLoaded(): Promise<void> {
  if (get(overlaySettingsLoaded)) return Promise.resolve();
  _hydration ??= invoke("getOverlaySettings")
    .then((loaded) => {
      if (loaded) applyOverlaySettingsResponse(loaded);
    })
    .catch((error: unknown) => {
      // Drop the cached promise so a later view can retry the load.
      _hydration = null;
      log.error("[Settings] loading overlay settings failed:", error);
    });
  return _hydration;
}
