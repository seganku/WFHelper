import type { NativeImage } from "electron";

import { withScope } from "../../services/logger";
import { areOcrDebugDumpsEnabled } from "../../services/rewardScanDebug";
import { cropRectContent } from "../../services/rewardScannerImage";
import { recognizeRewardStripOnnx } from "../../services/rewardOcrOnnx";
import { findWeaponByLabelLine, type WeaponLabelMatch } from "../../services/rivenData";
import { paddleRecognizerAvailable, recognizePaddleCrops } from "../../services/rivenOcrOnnx";
import type { CaptureResult } from "../../services/screenCapture";
import { userDataPath } from "../../services/userDataPath";
import { rivenContentRect } from "./rivenScanImage";
import { loadSharp } from "../../services/sharpRuntime";

const log = withScope("rivenScan");

const FITS_IN_DUMP_KEEP = 6;

// Failed reads keep their crop; log rows alone are not reproducible.
function dumpFitsInCrop(label: string, crop: NativeImage): void {
  if (!areOcrDebugDumpsEnabled()) return;
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const dir = userDataPath("riven-scan-debug");
    fs.mkdirSync(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(dir, `${stamp}-fits-in-${label}.png`), crop.toPNG());

    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".png") && f.includes("Z-fits-in-"))
      .sort();
    for (const f of files.slice(0, Math.max(0, files.length - FITS_IN_DUMP_KEEP))) {
      fs.unlinkSync(path.join(dir, f));
    }
  } catch (err) {
    log.warn("[RivenScan] fits-in crop dump failed:", String(err));
  }
}

// The item plate can use either text polarity across Warframe UI themes.
const RIVEN_FITS_IN_NAME_CROP = { x: 0.78, y: 0.72, width: 0.21, height: 0.22 };
const RIVEN_FITS_IN_PANEL_CROP = { x: 0.7, y: 0.55, width: 0.3, height: 0.45 };
// Interface scales below 100% pull the plate toward screen center; this covers
// its position across the whole 50-100% slider range.
const RIVEN_FITS_IN_WIDE_CROP = { x: 0.58, y: 0.48, width: 0.42, height: 0.47 };

// Label text is ~20px at 1080p; the strip reader's row-height windows assume
// that scale, so the crop is normalized to it before recognition.
const REFERENCE_CONTENT_HEIGHT = 1080;

export type RivenWeaponSource = "" | "dialog" | "ocr" | "diorama" | "label";

/** Whether a fits-in label read replaces the current weapon. */
export function shouldApplyLabelWeapon(
  match: WeaponLabelMatch,
  currentName: string,
  currentSource: RivenWeaponSource,
  sameFamily: boolean,
): boolean {
  if (!currentName || currentName === "Riven") return true;
  if (match.name === currentName) return false;
  if (match.exact || sameFamily) return true;
  return currentSource === "ocr";
}

export async function readWeaponLabelFromPanelPng(
  png: Buffer,
  contentHeight: number,
  options: { invert?: boolean; upscale?: boolean; uiScale?: number; clahe?: boolean } = {},
): Promise<WeaponLabelMatch | null> {
  let normalized = png;
  // Interface scale shrinks text independently of resolution.
  const uiCorrection = 1 / Math.min(1, Math.max(0.5, options.uiScale ?? 1));
  const scale = (REFERENCE_CONTENT_HEIGHT / Math.max(1, contentHeight)) * uiCorrection;
  const resize = scale < 0.98 || uiCorrection > 1.02 || (options.upscale !== false && scale > 1.02);
  if (resize || options.invert || options.clahe) {
    const sharp = loadSharp();
    const meta = await sharp(png).metadata();
    const height = Math.max(1, Math.round((meta.height ?? 1) * scale));
    let pipeline = sharp(png);
    if (resize) {
      pipeline = pipeline.resize({ height, kernel: "lanczos3" });
    }
    // Equalization keeps low-luminance theme captions above the threshold.
    if (options.clahe) pipeline = pipeline.grayscale().clahe({ width: 64, height: 64 });
    if (options.invert) pipeline = pipeline.negate({ alpha: false });
    normalized = await pipeline.png().toBuffer();
  }

  const read = await recognizeRewardStripOnnx(normalized);
  if (!read || read.rows.length === 0) {
    log.info("[RivenScan] fits-in label: no legible rows");
    return null;
  }
  const match = findWeaponByLabelLine(read.rows.map((row) => row.text));
  const rowsLog = read.rows.map((row) => `"${row.text}"`).join(", ");
  log.info(
    `[RivenScan] fits-in label rows: ${rowsLog} -> ` +
      (match ? `${match.name}${match.exact ? "" : " (fuzzy)"}` : "no weapon"),
  );
  _lastReadRows = read.rows;
  return match;
}

interface StripRowLike {
  text: string;
  confidence: number;
  box?: { x: number; y: number; width: number; height: number };
}

// Rows of the last panel read; the caption band anchors on its heading.
let _lastReadRows: StripRowLike[] = [];

function findFitsInHeadingRow(rows: StripRowLike[]): StripRowLike | null {
  for (const row of rows) {
    if (!row.box) continue;
    const compact = row.text.toLowerCase().replace(/[^a-z]/g, "");
    if (compact.includes("tsin") || compact.includes("fitsi")) return row;
  }
  return null;
}

// Caption band below the heading, 1080p px per unit scale; measured on real captures.
const CAPTION_TOP_OFFSET = 110;
const CAPTION_HEIGHT = 60;
const CAPTION_HALF_WIDTH = 150;
const CAPTION_UPSCALE = 4;

// Caption center offset from screen center, 1080p px per unit scale.
const CAPTION_FIXED_OFFSET_X = 738;
const CAPTION_FIXED_OFFSET_Y = 366;
const CAPTION_FIXED_HALF_WIDTH = 85;
const CAPTION_FIXED_HALF_HEIGHT = 18;

/** OCR one raw band directly; thresholding loses the caption when a bright
 *  shard sits behind the plate. */
async function recognizeCaptionBand(
  wideCrop: NativeImage,
  rect: { x: number; y: number; width: number; height: number },
  label: string,
): Promise<WeaponLabelMatch | null> {
  if (!paddleRecognizerAvailable()) return null;
  const { width: w, height: h } = wideCrop.getSize();
  const x = Math.max(0, Math.round(rect.x));
  const y = Math.max(0, Math.round(rect.y));
  const width = Math.min(w - x, Math.round(rect.width));
  const height = Math.min(h - y, Math.round(rect.height));
  if (width < 24 || height < 10) return null;

  const sharp = loadSharp();
  const band = wideCrop.crop({ x, y, width, height });
  const { data, info } = await sharp(band.toPNG())
    .resize(width * CAPTION_UPSCALE, height * CAPTION_UPSCALE, { kernel: "lanczos3" })
    .normalise()
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const results = await recognizePaddleCrops([
    { data: data as Buffer, width: info.width as number, height: info.height as number },
  ]);
  const text = results[0]?.text?.trim() ?? "";
  const match = text ? findWeaponByLabelLine([text]) : null;
  log.info(
    `[RivenScan] fits-in caption ${label} (${width}x${height} at ${x},${y}): "${text}" -> ` +
      (match ? `${match.name}${match.exact ? "" : " (fuzzy)"}` : "no weapon"),
  );
  return match;
}

async function readCaptionUnderHeading(
  wideCrop: NativeImage,
  heading: StripRowLike,
  uiScale: number,
  contentHeight: number,
): Promise<WeaponLabelMatch | null> {
  if (!heading.box) return null;
  const { width: w, height: h } = wideCrop.getSize();
  const unit = (contentHeight / 1080) * Math.min(1, Math.max(0.5, uiScale));

  const centerX = (heading.box.x + heading.box.width / 2) * w;
  const headingBottom = (heading.box.y + heading.box.height) * h;
  return recognizeCaptionBand(
    wideCrop,
    {
      x: centerX - CAPTION_HALF_WIDTH * unit,
      y: headingBottom + CAPTION_TOP_OFFSET * unit,
      width: CAPTION_HALF_WIDTH * 2 * unit,
      height: CAPTION_HEIGHT * unit,
    },
    "band",
  );
}

/** No heading anchor: the plate is fixed on screen, band from center offset. */
async function readCaptionAtFixedPosition(
  wideCrop: NativeImage,
  uiScale: number,
  content: { width: number; height: number },
): Promise<WeaponLabelMatch | null> {
  const unit = (content.height / 1080) * Math.min(1, Math.max(0.5, uiScale));
  const cropOriginX = RIVEN_FITS_IN_WIDE_CROP.x * content.width;
  const cropOriginY = RIVEN_FITS_IN_WIDE_CROP.y * content.height;
  const centerX = content.width / 2 + CAPTION_FIXED_OFFSET_X * unit - cropOriginX;
  const centerY = content.height / 2 + CAPTION_FIXED_OFFSET_Y * unit - cropOriginY;
  const halfW = (CAPTION_FIXED_HALF_WIDTH + 20) * unit;
  const halfH = (CAPTION_FIXED_HALF_HEIGHT + 8) * unit;
  return recognizeCaptionBand(
    wideCrop,
    { x: centerX - halfW, y: centerY - halfH, width: halfW * 2, height: halfH * 2 },
    "fixed",
  );
}

/** Reads the linked weapon variant off the FITS IN panel of a full capture. */
export async function readFitsInWeapon(
  image: NativeImage,
  sourceType?: CaptureResult["sourceType"],
): Promise<WeaponLabelMatch | null> {
  const content = rivenContentRect(image, sourceType);
  const nameCrop = cropRectContent(image, RIVEN_FITS_IN_NAME_CROP, content);
  const { width, height } = nameCrop.getSize();
  if (width < 48 || height < 48) return null;

  const namePng = nameCrop.toPNG();
  const normal = await readWeaponLabelFromPanelPng(namePng, content.height, { upscale: false });
  if (normal) return normal;
  const inverted = await readWeaponLabelFromPanelPng(namePng, content.height, {
    invert: true,
    upscale: false,
  });
  if (inverted) return inverted;

  const panelCrop = cropRectContent(image, RIVEN_FITS_IN_PANEL_CROP, content);
  const panel = await readWeaponLabelFromPanelPng(panelCrop.toPNG(), content.height);
  if (!panel) dumpFitsInCrop("panel", panelCrop);
  return panel;
}

/** Sub-100% scales: the plate sits nearer screen center at 1/scale size. */
export async function readFitsInWeaponSmallUi(
  image: NativeImage,
  uiScale: number,
  sourceType?: CaptureResult["sourceType"],
): Promise<WeaponLabelMatch | null> {
  const content = rivenContentRect(image, sourceType);
  const wideCrop = cropRectContent(image, RIVEN_FITS_IN_WIDE_CROP, content);
  const { width, height } = wideCrop.getSize();
  if (width < 48 || height < 48) return null;

  const widePng = wideCrop.toPNG();
  _lastReadRows = [];
  const normal = await readWeaponLabelFromPanelPng(widePng, content.height, { uiScale });
  if (normal) return normal;
  const plainRows = _lastReadRows;
  _lastReadRows = [];
  const equalized = await readWeaponLabelFromPanelPng(widePng, content.height, {
    clahe: true,
    uiScale,
  });
  if (equalized) return equalized;

  const heading = findFitsInHeadingRow(_lastReadRows) ?? findFitsInHeadingRow(plainRows);
  if (heading) {
    const fromCaption = await readCaptionUnderHeading(wideCrop, heading, uiScale, content.height);
    if (fromCaption) return fromCaption;
  }
  const fromFixed = await readCaptionAtFixedPosition(wideCrop, uiScale, content);
  if (fromFixed) return fromFixed;

  const inverted = await readWeaponLabelFromPanelPng(widePng, content.height, {
    invert: true,
    uiScale,
  });
  if (!inverted) dumpFitsInCrop("wide", wideCrop);
  return inverted;
}
