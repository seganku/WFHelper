import type { ThemeColors, ThemeEffects, ThemeSettings } from "../../types/theme.js";
import { THEME_COLOR_CSS_MAP, THEME_EFFECT_CSS_MAP } from "../../types/theme.js";
import { BASE_FONT_SIZE_PX } from "../../config/themeDefaults.js";
import { autoAdjustTextColor, WCAG_AA_NORMAL } from "./contrastUtils.js";
import { OVERLAY_LAYOUT_KINDS } from "../../../config/shared/overlayLayout.js";
import { overlayOpacityCssVar } from "../../../config/shared/themeCssVars.js";

export function applyTheme(settings: ThemeSettings): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  const colors = resolveColors(settings);

  for (const [key, cssVar] of Object.entries(THEME_COLOR_CSS_MAP)) {
    const value = colors[key as keyof ThemeColors];
    if (value) {
      root.style.setProperty(cssVar, value);
    }
  }

  const accent = colors.accent;
  root.style.setProperty("--accent-glow", accentGlowColor(accent));

  applyEffectTokens(root, settings.effects);

  const scale = settings.fontSizes.globalScale;
  root.style.setProperty("--font-global-size", `${BASE_FONT_SIZE_PX * scale}px`);

  if (settings.fontSizes.headingSize != null) {
    root.style.setProperty("--font-heading-size", `${settings.fontSizes.headingSize}rem`);
  } else {
    root.style.removeProperty("--font-heading-size");
  }
  if (settings.fontSizes.bodySize != null) {
    root.style.setProperty("--font-body-size", `${settings.fontSizes.bodySize}rem`);
  } else {
    root.style.removeProperty("--font-body-size");
  }
  if (settings.fontSizes.smallSize != null) {
    root.style.setProperty("--font-small-size", `${settings.fontSizes.smallSize}rem`);
  } else {
    root.style.removeProperty("--font-small-size");
  }
}

function applyEffectTokens(root: HTMLElement, effects: ThemeEffects): void {
  const radii = resolveRadii(effects.cornerStyle);
  for (const [key, value] of Object.entries(radii)) {
    root.style.setProperty(THEME_EFFECT_CSS_MAP[key as keyof typeof radii], value);
  }

  const surface = resolveSurfaceTokens(effects);
  root.style.setProperty(THEME_EFFECT_CSS_MAP.panelBg, surface.panelBg);
  root.style.setProperty(THEME_EFFECT_CSS_MAP.panelBorder, surface.panelBorder);
  root.style.setProperty(THEME_EFFECT_CSS_MAP.panelShadow, surface.panelShadow);
  root.style.setProperty(THEME_EFFECT_CSS_MAP.controlBg, surface.controlBg);
  root.style.setProperty(THEME_EFFECT_CSS_MAP.controlBorder, surface.controlBorder);
  root.style.setProperty(THEME_EFFECT_CSS_MAP.backdropBlur, surface.backdropBlur);
  root.style.setProperty(THEME_EFFECT_CSS_MAP.modalBg, surface.modalBg);
  root.style.setProperty(
    THEME_EFFECT_CSS_MAP.overlayOpacity,
    `${Math.round(effects.overlayOpacity * 100)}%`,
  );
  for (const kind of OVERLAY_LAYOUT_KINDS) {
    const opacity = effects.overlayOpacityOverrides?.[kind] ?? effects.overlayOpacity;
    root.style.setProperty(overlayOpacityCssVar(kind), `${Math.round(opacity * 100)}%`);
  }
}

function resolveRadii(
  cornerStyle: ThemeEffects["cornerStyle"],
): Record<"radiusSm" | "radiusMd" | "radiusLg" | "radiusXl", string> {
  if (cornerStyle === "sharp") {
    return {
      radiusSm: "0px",
      radiusMd: "0px",
      radiusLg: "0px",
      radiusXl: "0px",
    };
  }

  if (cornerStyle === "round") {
    return {
      radiusSm: "0.55rem",
      radiusMd: "0.8rem",
      radiusLg: "1.05rem",
      radiusXl: "1.35rem",
    };
  }

  return {
    radiusSm: "0.28rem",
    radiusMd: "0.42rem",
    radiusLg: "0.62rem",
    radiusXl: "0.78rem",
  };
}

function resolveSurfaceTokens(effects: ThemeEffects): {
  panelBg: string;
  panelBorder: string;
  panelShadow: string;
  controlBg: string;
  controlBorder: string;
  backdropBlur: string;
  modalBg: string;
} {
  if (effects.surfaceStyle === "minimal") {
    return {
      panelBg: "transparent",
      panelBorder: "transparent",
      panelShadow: "none",
      controlBg: "var(--bg-surface)",
      controlBorder: "var(--border)",
      backdropBlur: "none",
      modalBg: "var(--bg-surface)",
    };
  }

  if (effects.surfaceStyle === "border") {
    return {
      panelBg: "transparent",
      panelBorder: "var(--border)",
      panelShadow: "none",
      controlBg: "transparent",
      controlBorder: "var(--border)",
      backdropBlur: "none",
      modalBg: "var(--bg-surface)",
    };
  }

  if (effects.glass) {
    return {
      panelBg: "color-mix(in srgb, var(--bg-surface) 76%, transparent)",
      panelBorder: "color-mix(in srgb, var(--border-strong) 82%, transparent)",
      panelShadow: "none",
      controlBg: "color-mix(in srgb, var(--bg-raised) 72%, transparent)",
      controlBorder: "color-mix(in srgb, var(--border) 90%, transparent)",
      backdropBlur: `blur(${effects.glassBlurPx}px)`,
      modalBg: "color-mix(in srgb, var(--bg-surface) 82%, transparent)",
    };
  }

  return {
    panelBg: "var(--bg-surface)",
    panelBorder: "var(--border)",
    panelShadow: "none",
    controlBg: "var(--bg-raised)",
    controlBorder: "var(--border)",
    backdropBlur: "none",
    modalBg: "var(--bg-surface)",
  };
}

export function contrastSafeColors(source: ThemeColors): ThemeColors {
  const colors = { ...source };
  const bg = colors.bgBase;
  colors.textPrimary = autoAdjustTextColor(colors.textPrimary, bg, WCAG_AA_NORMAL);
  colors.textSecondary = autoAdjustTextColor(colors.textSecondary, bg, WCAG_AA_NORMAL);
  colors.textMuted = autoAdjustTextColor(colors.textMuted, bg, 3.0);
  colors.textHeading = autoAdjustTextColor(colors.textHeading, bg, WCAG_AA_NORMAL);
  colors.textBody = autoAdjustTextColor(colors.textBody, bg, WCAG_AA_NORMAL);
  return colors;
}

function resolveColors(settings: ThemeSettings): ThemeColors {
  if (settings.contrastSafeMode) return contrastSafeColors(settings.colors);
  return { ...settings.colors };
}

export function accentGlowColor(hex: string): string {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) return "rgba(212, 168, 67, 0.15)";
  const r = parseInt(match[1], 16);
  const g = parseInt(match[2], 16);
  const b = parseInt(match[3], 16);
  return `rgba(${r}, ${g}, ${b}, 0.15)`;
}
