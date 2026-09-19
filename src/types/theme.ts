import type { ViewName } from "./views.js";
import type { OverlayLayoutKind } from "../../config/shared/overlayLayout.js";

export interface ThemeBaseColors {
  bgDeep: string;
  bgBase: string;
  bgSurface: string;
  bgRaised: string;
  bgHover: string;
  accent: string;
  accentDim: string;
  accentBright: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  border: string;
  borderStrong: string;
  gradeS: string;
  gradeA: string;
  gradeB: string;
  gradeC: string;
  gradeD: string;
  gradeF: string;
  gradeDefault: string;
}

export interface ThemeDerivedColors {
  textHeading: string;
  textBody: string;
  textLink: string;
  textOnAccent: string;
  textPositive: string;
  textNegative: string;
  successDim: string;
  successBg: string;
  warningDim: string;
  warningBg: string;
  dangerDim: string;
  dangerBg: string;
  infoDim: string;
  infoBg: string;
  surfacePanel: string;
  surfacePanelBorder: string;
  surfaceCard: string;
  surfaceHover: string;
  surfaceSelected: string;
  surfaceInput: string;
  surfaceTooltip: string;
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
  chart6: string;
  chartAxis: string;
  relicLith: string;
  relicMeso: string;
  relicNeo: string;
  relicAxi: string;
  relicRequiem: string;
  rivenPip: string;
  rivenReroll: string;
}

export interface ThemeColors extends ThemeBaseColors, ThemeDerivedColors {}

export interface ThemeFontSizes {
  globalScale: number;
  /** Optional per-category overrides (rem values) */
  headingSize?: number;
  bodySize?: number;
  smallSize?: number;
}

/** `globalScale` is never stored here: rem resolves against the root. */
export interface ViewThemeOverride {
  colors?: Partial<ThemeBaseColors>;
  fontSizes?: Partial<ThemeFontSizes>;
}

export type ThemeCornerStyle = "sharp" | "soft" | "round";
export type ThemeSurfaceStyle = "full" | "border" | "minimal";
export type RelicCardStyle = "ornate" | "plain";

export interface ThemeEffects {
  cornerStyle: ThemeCornerStyle;
  surfaceStyle: ThemeSurfaceStyle;
  glass: boolean;
  glassBlurPx: number;
  overlayOpacity: number;
  overlayOpacityOverrides?: Partial<Record<OverlayLayoutKind, number>>;
  relicCardStyle: RelicCardStyle;
}

export interface ThemeBranding {
  logoDataUrl: string | null;
  appName: string | null;
}

export interface CustomThemePreset {
  id: string;
  label: string;
  colors: ThemeColors;
  fontSizes: ThemeFontSizes;
  effects: ThemeEffects;
}

export interface ThemeSettings {
  version: 1;
  activePreset: string;
  colors: ThemeColors;
  fontSizes: ThemeFontSizes;
  effects: ThemeEffects;
  customThemes: CustomThemePreset[];
  branding: ThemeBranding;
  contrastSafeMode: boolean;
  /** Legacy: read at load, folded into `viewOverrides`, then left empty. Kept so
      old saves still migrate. */
  viewAccents: Partial<Record<ViewName, string>>;
  viewOverrides: Partial<Record<ViewName, ViewThemeOverride>>;
}

export const THEME_COLOR_CSS_MAP: Record<keyof ThemeColors, string> = {
  bgDeep: "--bg-deep",
  bgBase: "--bg-base",
  bgSurface: "--bg-surface",
  bgRaised: "--bg-raised",
  bgHover: "--bg-hover",
  accent: "--accent",
  accentDim: "--accent-dim",
  accentBright: "--accent-bright",
  textPrimary: "--text-primary",
  textSecondary: "--text-secondary",
  textMuted: "--text-muted",
  success: "--success",
  warning: "--warning",
  danger: "--danger",
  info: "--info",
  border: "--border",
  borderStrong: "--border-strong",
  gradeS: "--grade-s",
  gradeA: "--grade-a",
  gradeB: "--grade-b",
  gradeC: "--grade-c",
  gradeD: "--grade-d",
  gradeF: "--grade-f",
  gradeDefault: "--grade-default",
  textHeading: "--text-heading",
  textBody: "--text-body",
  textLink: "--text-link",
  textOnAccent: "--text-on-accent",
  textPositive: "--text-positive",
  textNegative: "--text-negative",
  successDim: "--success-dim",
  successBg: "--success-bg",
  warningDim: "--warning-dim",
  warningBg: "--warning-bg",
  dangerDim: "--danger-dim",
  dangerBg: "--danger-bg",
  infoDim: "--info-dim",
  infoBg: "--info-bg",
  surfacePanel: "--surface-panel",
  surfacePanelBorder: "--surface-panel-border",
  surfaceCard: "--surface-card",
  surfaceHover: "--surface-hover",
  surfaceSelected: "--surface-selected",
  surfaceInput: "--surface-input",
  surfaceTooltip: "--surface-tooltip",
  chart1: "--chart-1",
  chart2: "--chart-2",
  chart3: "--chart-3",
  chart4: "--chart-4",
  chart5: "--chart-5",
  chart6: "--chart-6",
  chartAxis: "--chart-axis",
  relicLith: "--relic-lith",
  relicMeso: "--relic-meso",
  relicNeo: "--relic-neo",
  relicAxi: "--relic-axi",
  relicRequiem: "--relic-requiem",
  rivenPip: "--riven-pip",
  rivenReroll: "--riven-reroll",
} as const;

export const THEME_EFFECT_CSS_MAP = {
  radiusSm: "--radius-sm",
  radiusMd: "--radius-md",
  radiusLg: "--radius-lg",
  radiusXl: "--radius-xl",
  panelBg: "--ui-panel-bg",
  panelBorder: "--ui-panel-border",
  panelShadow: "--ui-panel-shadow",
  modalBg: "--ui-modal-bg",
  controlBg: "--ui-control-bg",
  controlBorder: "--ui-control-border",
  backdropBlur: "--ui-backdrop-blur",
  overlayOpacity: "--overlay-opacity",
} as const;
