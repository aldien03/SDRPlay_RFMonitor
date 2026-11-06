/**
 * Pure waterfall rasteriser. No DOM, no React.
 *
 * A waterfall row is turned into packed 32-bit pixels through a 256-entry
 * lookup table, instead of one canvas call and one colour string per cell.
 * Source frames can carry more bins than the canvas has pixels, so each pixel
 * takes the MAXIMUM of the bins it covers: a narrow spike never disappears.
 * Levels stay uncalibrated relative uint8 values.
 */

export const WATERFALL_STOPS: ReadonlyArray<{ level: number; rgb: [number, number, number] }> = [
  { level: 0.00, rgb: [4, 32, 84] },
  { level: 0.25, rgb: [0, 120, 190] },
  { level: 0.50, rgb: [0, 180, 130] },
  { level: 0.70, rgb: [180, 210, 0] },
  { level: 0.85, rgb: [255, 180, 0] },
  { level: 1.00, rgb: [255, 60, 30] },
];

/** Detector anomaly tint, matching the previous per-row overlay rgba(227, 22, 22, .32). */
export const ANOMALY_TINT = { rgb: [227, 22, 22] as [number, number, number], alpha: 0.32 };
/** Stronger tint used only for hatch stripes, so anomalies are not colour-only. */
export const ANOMALY_HATCH_ALPHA = 0.62;

export function waterfallRgb(value: number): [number, number, number] {
  const level = Math.max(0, Math.min(1, value / 255));
  let lower = WATERFALL_STOPS[0];
  let upper = WATERFALL_STOPS[WATERFALL_STOPS.length - 1];
  for (let index = 0; index < WATERFALL_STOPS.length - 1; index += 1) {
    if (level >= WATERFALL_STOPS[index].level && level <= WATERFALL_STOPS[index + 1].level) {
      lower = WATERFALL_STOPS[index];
      upper = WATERFALL_STOPS[index + 1];
      break;
    }
  }
  const span = upper.level - lower.level || 1;
  const t = (level - lower.level) / span;
  const mix = (from: number, to: number) => Math.round(from + (to - from) * t);
  return [mix(lower.rgb[0], upper.rgb[0]), mix(lower.rgb[1], upper.rgb[1]), mix(lower.rgb[2], upper.rgb[2])];
}

export function waterfallColor(value: number): string {
  const [red, green, blue] = waterfallRgb(value);
  return `rgb(${red}, ${green}, ${blue})`;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Pack to the byte order ImageData uses (R, G, B, A in memory). */
export function packPixel(red: number, green: number, blue: number): number {
  return LITTLE_ENDIAN
    ? ((255 << 24) | (blue << 16) | (green << 8) | red) >>> 0
    : ((red << 24) | (green << 16) | (blue << 8) | 255) >>> 0;
}

export interface WaterfallPalette {
  /** Plain colour per level 0..255. */
  readonly plain: Uint32Array;
  /** Colour per level with the anomaly tint blended in. */
  readonly anomaly: Uint32Array;
  /** Stronger tint for hatch stripes. */
  readonly anomalyHatch: Uint32Array;
  /** Packed opaque background used for pixels no frame covers. */
  readonly background: number;
}

function blend(base: number, tint: number, alpha: number): number {
  return Math.round(base * (1 - alpha) + tint * alpha);
}

let cachedPalette: WaterfallPalette | undefined;

export function buildWaterfallPalette(): WaterfallPalette {
  if (cachedPalette) return cachedPalette;
  const plain = new Uint32Array(256);
  const anomaly = new Uint32Array(256);
  const anomalyHatch = new Uint32Array(256);
  const [tintRed, tintGreen, tintBlue] = ANOMALY_TINT.rgb;
  for (let level = 0; level < 256; level += 1) {
    const [red, green, blue] = waterfallRgb(level);
    plain[level] = packPixel(red, green, blue);
    anomaly[level] = packPixel(
      blend(red, tintRed, ANOMALY_TINT.alpha),
      blend(green, tintGreen, ANOMALY_TINT.alpha),
      blend(blue, tintBlue, ANOMALY_TINT.alpha),
    );
    anomalyHatch[level] = packPixel(
      blend(red, tintRed, ANOMALY_HATCH_ALPHA),
      blend(green, tintGreen, ANOMALY_HATCH_ALPHA),
      blend(blue, tintBlue, ANOMALY_HATCH_ALPHA),
    );
  }
  cachedPalette = { plain, anomaly, anomalyHatch, background: packPixel(6, 40, 93) };
  return cachedPalette;
}

export interface WaterfallRowInput {
  bins: ArrayLike<number>;
  /** Visible bin window [startBin, endBin) for THIS row, from its own tune. */
  startBin: number;
  endBin: number;
  widthPx: number;
  /** Detector anomaly ranges in bin indexes; may extend outside the window. */
  anomalyRanges?: ReadonlyArray<{ startBin: number; endBin: number }>;
  palette: WaterfallPalette;
  /** Row index used only to phase the hatch. */
  rowIndex?: number;
  /** Draw anomaly pixels as diagonal stripes of a stronger tint. */
  hatch?: boolean;
}

/** Bin interval [lo, hi) that pixel column `pixel` covers. Shared with the tests. */
export function pixelBinSpan(pixel: number, widthPx: number, startBin: number, endBin: number): { lo: number; hi: number } {
  const span = endBin - startBin;
  const lo = Math.min(endBin - 1, startBin + Math.floor((pixel * span) / widthPx));
  const rawHi = startBin + Math.ceil(((pixel + 1) * span) / widthPx);
  return { lo, hi: Math.min(endBin, Math.max(lo + 1, rawHi)) };
}

/**
 * Rasterise one row into `out` (length >= widthPx), or a new array. Returns the
 * row. A row with no usable bins is filled with the background colour.
 */
export function rasterizeRow(input: WaterfallRowInput, out?: Uint32Array): Uint32Array {
  const { bins, startBin, endBin, widthPx, anomalyRanges = [], palette, rowIndex = 0, hatch = false } = input;
  const row = out ?? new Uint32Array(Math.max(0, widthPx));
  const width = Math.min(Math.max(0, Math.floor(widthPx)), row.length);
  const span = endBin - startBin;
  if (width === 0) return row;
  if (span <= 0 || startBin < 0 || endBin > bins.length) {
    row.fill(palette.background, 0, width);
    return row;
  }
  const levels = new Uint8Array(width);
  for (let pixel = 0; pixel < width; pixel += 1) {
    const { lo, hi } = pixelBinSpan(pixel, width, startBin, endBin);
    let peak = 0;
    for (let index = lo; index < hi; index += 1) {
      const value = bins[index];
      if (value > peak) peak = value;
    }
    levels[pixel] = peak > 255 ? 255 : peak;
    row[pixel] = palette.plain[levels[pixel]];
  }
  for (const range of anomalyRanges) {
    if (range.endBin <= startBin || range.startBin >= endBin) continue;
    const clippedStart = Math.max(range.startBin, startBin);
    const clippedEnd = Math.min(range.endBin, endBin);
    const firstPixel = Math.max(0, Math.floor(((clippedStart - startBin) / span) * width));
    const lastPixel = Math.min(width, Math.max(firstPixel + 1, Math.ceil(((clippedEnd - startBin) / span) * width)));
    for (let pixel = firstPixel; pixel < lastPixel; pixel += 1) {
      const stripe = hatch && ((pixel + rowIndex) & 3) === 0;
      row[pixel] = (stripe ? palette.anomalyHatch : palette.anomaly)[levels[pixel]];
    }
  }
  return row;
}

/**
 * Copy rasterised rows (newest first) into a width x rowCapacity pixel buffer.
 * Rows beyond the supplied history keep the background colour.
 */
export function composeWaterfall(
  rows: ReadonlyArray<Uint32Array>,
  widthPx: number,
  rowCapacity: number,
  palette: WaterfallPalette,
  out?: Uint32Array,
): Uint32Array {
  const target = out && out.length >= widthPx * rowCapacity ? out : new Uint32Array(widthPx * rowCapacity);
  target.fill(palette.background, 0, widthPx * rowCapacity);
  const count = Math.min(rows.length, rowCapacity);
  for (let index = 0; index < count; index += 1) target.set(rows[index].subarray(0, widthPx), index * widthPx);
  return target;
}
