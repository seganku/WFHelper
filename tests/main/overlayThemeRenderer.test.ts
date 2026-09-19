import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { OVERLAY_LAYOUT_KINDS, type OverlayLayoutKind } from "../../config/shared/overlayLayout";
import { overlayOpacityCssVar } from "../../config/shared/themeCssVars";
import {
  OVERLAY_OPACITY_MAX_PERCENT,
  OVERLAY_OPACITY_MIN_PERCENT,
  isOverlayOpacityPercent,
} from "../../config/shared/overlayOpacity";

interface OverlayThemeApi {
  bootstrapOverlayTheme: (
    getVars: () => Promise<Record<string, string>>,
    kind: OverlayLayoutKind,
  ) => void;
  applyThemeVars: (vars: Record<string, string>) => void;
}

function loadOverlayTheme(stored?: unknown) {
  const raw =
    stored === undefined ? null : typeof stored === "string" ? stored : JSON.stringify(stored);
  const values = new Map<string, string>();
  const window: { overlayTheme?: OverlayThemeApi } = {};
  runInNewContext(readFileSync("renderer/overlay-theme.js", "utf8"), {
    window,
    localStorage: { getItem: () => raw },
    document: {
      documentElement: {
        style: { setProperty: (key: string, value: string) => values.set(key, value) },
      },
    },
  });
  return { theme: window.overlayTheme!, values };
}

const storedEffects = {
  overlayOpacity: 0.9,
  overlayOpacityOverrides: Object.fromEntries(
    OVERLAY_LAYOUT_KINDS.map((kind, index) => [kind, (30 + index * 10) / 100]),
  ),
};

it.each(OVERLAY_LAYOUT_KINDS)(
  "applies %s opacity and restores inheritance on complete-map updates",
  async (kind) => {
    const { theme, values } = loadOverlayTheme();
    const incoming: Record<string, string> = {
      "--overlay-opacity": "90%",
      ...Object.fromEntries(
        OVERLAY_LAYOUT_KINDS.map((entry, index) => [
          overlayOpacityCssVar(entry),
          `${30 + index * 10}%`,
        ]),
      ),
    };
    theme.bootstrapOverlayTheme(async () => incoming, kind);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(values.get("--overlay-opacity-current")).toBe(incoming[overlayOpacityCssVar(kind)]);
    theme.applyThemeVars({ "--overlay-opacity": "70%" });
    expect(values.get("--overlay-opacity-current")).toBe("70%");
    theme.applyThemeVars({ "--bg-deep": "#000000" });
    expect(values.get("--overlay-opacity-current")).toBe("100%");
    theme.applyThemeVars({ [overlayOpacityCssVar(kind)]: "20%;opacity:0" });
    expect(values.get("--overlay-opacity-current")).toBe("100%");
  },
);

it.each(OVERLAY_LAYOUT_KINDS)(
  "paints the first %s frame at the stored opacity before the main process answers",
  async (kind) => {
    const index = OVERLAY_LAYOUT_KINDS.indexOf(kind);
    const { theme, values } = loadOverlayTheme({
      colors: { accent: "#3366ff" },
      effects: storedEffects,
    });
    let answer = (_vars: Record<string, string>) => {};
    theme.bootstrapOverlayTheme(
      () =>
        new Promise<Record<string, string>>((resolve) => {
          answer = resolve;
        }),
      kind,
    );
    expect(values.get("--overlay-opacity-current")).toBe(`${30 + index * 10}%`);
    expect(values.get("--accent")).toBe("#3366ff");
    await new Promise<void>((resolve) => setImmediate(resolve));
    answer({ "--overlay-opacity": "90%", [overlayOpacityCssVar(kind)]: "55%" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(values.get("--overlay-opacity-current")).toBe("55%");
  },
);

it("falls back to the stored shared opacity and rejects an invisible stored value", () => {
  const shared = loadOverlayTheme({ effects: { overlayOpacity: 0.45 } });
  shared.theme.bootstrapOverlayTheme(async () => ({}), "reward");
  expect(shared.values.get("--overlay-opacity-current")).toBe("45%");

  const tampered = loadOverlayTheme({
    effects: { overlayOpacity: 0.45, overlayOpacityOverrides: { reward: 0.01 } },
  });
  tampered.theme.bootstrapOverlayTheme(async () => ({}), "reward");
  expect(tampered.values.get("--overlay-opacity-current")).toBe("45%");

  const bothInvalid = loadOverlayTheme({
    effects: { overlayOpacity: 0.02, overlayOpacityOverrides: { reward: 0.01 } },
  });
  bothInvalid.theme.bootstrapOverlayTheme(async () => ({}), "reward");
  expect(bothInvalid.values.get("--overlay-opacity-current")).toBe("100%");

  const malformed = loadOverlayTheme("{not json");
  malformed.theme.bootstrapOverlayTheme(async () => ({}), "reward");
  expect(malformed.values.get("--overlay-opacity-current")).toBeUndefined();
});

it("bounds the overlay renderer at the same percentages the shared validator does", () => {
  const { theme, values } = loadOverlayTheme();
  theme.bootstrapOverlayTheme(async () => ({}), "reward");

  const current = (percent: number): string | undefined => {
    theme.applyThemeVars({ "--overlay-opacity": `${percent}%` });
    return values.get("--overlay-opacity-current");
  };

  expect(current(OVERLAY_OPACITY_MIN_PERCENT)).toBe(`${OVERLAY_OPACITY_MIN_PERCENT}%`);
  expect(current(OVERLAY_OPACITY_MAX_PERCENT)).toBe(`${OVERLAY_OPACITY_MAX_PERCENT}%`);
  expect(current(OVERLAY_OPACITY_MIN_PERCENT - 1)).toBe(`${OVERLAY_OPACITY_MAX_PERCENT}%`);
  expect(current(OVERLAY_OPACITY_MAX_PERCENT + 1)).toBe(`${OVERLAY_OPACITY_MAX_PERCENT}%`);

  expect(isOverlayOpacityPercent(`${OVERLAY_OPACITY_MIN_PERCENT}%`)).toBe(true);
  expect(isOverlayOpacityPercent(`${OVERLAY_OPACITY_MAX_PERCENT}%`)).toBe(true);
  expect(isOverlayOpacityPercent(`${OVERLAY_OPACITY_MIN_PERCENT - 1}%`)).toBe(false);
  expect(isOverlayOpacityPercent(`${OVERLAY_OPACITY_MAX_PERCENT + 1}%`)).toBe(false);
  expect(isOverlayOpacityPercent("50")).toBe(false);
});

it("prefers the global opacity over an out-of-range per-kind override", () => {
  const { theme, values } = loadOverlayTheme();
  theme.bootstrapOverlayTheme(async () => ({}), "reward");

  theme.applyThemeVars({
    "--overlay-opacity": "60%",
    [overlayOpacityCssVar("reward")]: `${OVERLAY_OPACITY_MIN_PERCENT - 1}%`,
  });
  expect(values.get("--overlay-opacity-current")).toBe("60%");
});
