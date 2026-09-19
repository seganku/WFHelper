export const OVERLAY_OPACITY_MIN = 0.3;
export const OVERLAY_OPACITY_MAX = 1;
export const OVERLAY_OPACITY_MIN_PERCENT = Math.round(OVERLAY_OPACITY_MIN * 100);
export const OVERLAY_OPACITY_MAX_PERCENT = Math.round(OVERLAY_OPACITY_MAX * 100);

const OVERLAY_OPACITY_PERCENT_RE = /^(\d{1,3})%$/;

export function isOverlayOpacityPercent(value: string): boolean {
  const match = OVERLAY_OPACITY_PERCENT_RE.exec(value);
  if (!match) return false;
  const percent = Number(match[1]);
  return percent >= OVERLAY_OPACITY_MIN_PERCENT && percent <= OVERLAY_OPACITY_MAX_PERCENT;
}
