/**
 * Incident figure for exported evidence packages.
 *
 * A pure, deterministic renderer: it turns the already-exported frame slice into one SVG sheet
 * (spectrum against the learned baseline, a waterfall, and a per-row peak strip) plus the waterfall
 * as a PNG. Nothing here touches the filesystem. Levels are relative uncalibrated uint8 values.
 *
 * The figure is a DERIVED view. The raw frames and their hashes remain the evidence, and the figure
 * states that on its face. Gaps in time are drawn as gaps; nothing is interpolated.
 */
import { deflateSync } from "node:zlib";
import { frequencyTicks, plain, timeTicks, utc, xml } from "./chartKit";
import { ABOVE_USUAL_SPREADS, IncidentAnalysisCollector, renderAnalysisCharts, type AnalysisChartSet, type AnalysisStats, type BaselinePixels } from "./incidentAnalysis";
import { buildWaterfallPalette, packPixel, pixelBinSpan } from "../shared/waterfallRaster";

const MAX_WIDTH_PX = 1024;
const MAX_ROWS = 360;
const MIN_ROW_MS = 250;
const SIGMA_FROM_MAD = 1.4826;
const BASELINE_SIGMAS = 3;

export interface FigureFrame {
  timestampMs: number;
  bins: Uint8Array;
  startHz: number;
  endHz: number;
  analysisStartBin: number;
  analysisEndBin: number;
  /** Detector anomaly ranges for this frame, in this frame's bin indexes (half-open). */
  anomalyBinRanges?: ReadonlyArray<{ startBin: number; endBin: number }>;
}

export interface IncidentFigureInput {
  incidentId: string;
  label: string;
  rangeHz: [number, number];
  evidenceStrength: string;
  lifecycle: string;
  observed: string;
  /** First instant of the exported window, including the pre-incident history. */
  windowStartMs: number;
  windowEndMs: number;
  incidentStartMs: number;
  /** Cleared or last-seen time; the end of the incident proper. */
  incidentEndMs: number;
  baseline?: { median: Uint8Array; mad: Uint8Array };
  /** Hash of the exported frame index, so the figure names the data it was drawn from. */
  sourceFramesSha256?: string;
  /** Sorted frame timestamps, used only to size the waterfall rows. */
  frameTimestampsMs: readonly number[];
  /** When this picture was drawn. Shown on the figure, so a saved copy always states its age. */
  generatedAtMs: number;
  /** Operator verdict for the headline; defaults to "Suspected RF interference". */
  verdict?: string;
  /** The incident's alert level in normal variations, so analysis counts what the alert counted. */
  alertSigma?: number;
}

export interface IncidentFigureSummary {
  schemaVersion: 1;
  derived: true;
  framesUsed: number;
  framesExcludedRfConfiguration: number;
  framesBefore: number;
  framesDuring: number;
  framesAfter: number;
  widthPx: number;
  rows: number;
  rowSeconds: number;
  baselineIncluded: boolean;
  generatedAt: string;
  /** Text burned into the PNG, so the image is time stamped even when it is shared on its own. */
  pngCaption: string[];
  window: { startedAt: string; endedAt: string };
  incident: { startedAt: string; endedAt: string };
  analysisWindowHz?: [number, number];
  sourceFramesSha256?: string;
  levelScale: "relative-uncalibrated-uint8";
  /** Numbers and plain sentences for a report, drawn from the same frames. */
  analysis: AnalysisStats;
  findings: string[];
}

/** Data behind the report's spectrum and waterfall charts (same reduction as the figure). */
export interface IncidentFigureData {
  analysisStartHz: number;
  analysisEndHz: number;
  widthPx: number;
  rows: number;
  windowStartMs: number;
  windowEndMs: number;
  incidentStartMs: number;
  incidentEndMs: number;
  /** Waterfall pixels without caption, newest row first, contrast-stretched. */
  waterfallPngBase64: string;
  /** Relative levels mapped to the waterfall's darkest and brightest colours. */
  waterfallLevelRange: [number, number];
  before: Array<number | null>;
  during: Array<number | null>;
  strongest: Array<number | null>;
  usual?: number[];
  usualHigh?: number[];
  alertLevel?: number[];
  framesBefore: number;
  framesDuring: number;
  framesAfter: number;
}

export interface IncidentFigureResult {
  svg: string;
  /** Waterfall alone, with the time stamp burned into its pixels. */
  waterfallPng: Uint8Array;
  data: IncidentFigureData;
  /** Analysis charts: each as a standalone SVG, and all together on one sheet. */
  analysis: AnalysisChartSet;
  summary: IncidentFigureSummary;
}

/** Row duration so a normal inter-frame gap stays inside one row, but a real outage stays visible. */
export function chooseRowMs(timestampsMs: readonly number[], windowStartMs: number, windowEndMs: number): number {
  const duration = Math.max(1, windowEndMs - windowStartMs);
  const gaps: number[] = [];
  for (let index = 1; index < timestampsMs.length; index += 1) {
    const gap = timestampsMs[index] - timestampsMs[index - 1];
    if (gap > 0) gaps.push(gap);
  }
  gaps.sort((left, right) => left - right);
  const typical = gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * 0.98))] : MIN_ROW_MS;
  return Math.max(MIN_ROW_MS, typical * 1.5, duration / MAX_ROWS);
}

// ---- PNG -------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) chunk[4 + index] = type.charCodeAt(index);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** Encode an 8-bit RGBA image. `rgba` holds R,G,B,A bytes, row by row. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || rgba.length !== width * height * 4) {
    throw new Error("PNG dimensions do not match the pixel buffer");
  }
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let row = 0; row < height; row += 1) {
    raw[row * (stride + 1)] = 0;
    raw.set(rgba.subarray(row * stride, (row + 1) * stride), row * (stride + 1) + 1);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

// ---- Burned-in caption -----------------------------------------------------------------------

const GLYPHS: Record<string, string> = {
  "0": ".###./#...#/#..##/#.#.#/##..#/#...#/.###.",
  "1": "..#../.##../..#../..#../..#../..#../.###.",
  "2": ".###./#...#/....#/...#./..#../.#.../#####",
  "3": ".###./#...#/....#/..##./....#/#...#/.###.",
  "4": "...#./..##./.#.#./#..#./#####/...#./...#.",
  "5": "#####/#..../####./....#/....#/#...#/.###.",
  "6": "..##./.#.../#..../####./#...#/#...#/.###.",
  "7": "#####/....#/...#./..#../.#.../.#.../.#...",
  "8": ".###./#...#/#...#/.###./#...#/#...#/.###.",
  "9": ".###./#...#/#...#/.####/....#/...#./.##..",
  A: ".###./#...#/#...#/#####/#...#/#...#/#...#",
  B: "####./#...#/#...#/####./#...#/#...#/####.",
  C: ".###./#...#/#..../#..../#..../#...#/.###.",
  D: "####./#...#/#...#/#...#/#...#/#...#/####.",
  E: "#####/#..../#..../####./#..../#..../#####",
  F: "#####/#..../#..../####./#..../#..../#....",
  G: ".###./#...#/#..../#.###/#...#/#...#/.####",
  H: "#...#/#...#/#...#/#####/#...#/#...#/#...#",
  I: ".###./..#../..#../..#../..#../..#../.###.",
  J: "..###/...#./...#./...#./...#./#..#./.##..",
  K: "#...#/#..#./#.#../##.../#.#../#..#./#...#",
  L: "#..../#..../#..../#..../#..../#..../#####",
  M: "#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#",
  N: "#...#/##..#/#.#.#/#..##/#...#/#...#/#...#",
  O: ".###./#...#/#...#/#...#/#...#/#...#/.###.",
  P: "####./#...#/#...#/####./#..../#..../#....",
  Q: ".###./#...#/#...#/#...#/#.#.#/#..#./.##.#",
  R: "####./#...#/#...#/####./#.#../#..#./#...#",
  S: ".####/#..../#..../.###./....#/....#/####.",
  T: "#####/..#../..#../..#../..#../..#../..#..",
  U: "#...#/#...#/#...#/#...#/#...#/#...#/.###.",
  V: "#...#/#...#/#...#/#...#/#...#/.#.#./..#..",
  W: "#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#",
  X: "#...#/#...#/.#.#./..#../.#.#./#...#/#...#",
  Y: "#...#/#...#/.#.#./..#../..#../..#../..#..",
  Z: "#####/....#/...#./..#../.#.../#..../#####",
  "-": "...../...../...../#####/...../...../.....",
  ":": "...../..#../..#../...../..#../..#../.....",
  ".": "...../...../...../...../...../.##../.##..",
  ",": "...../...../...../...../.##../..#../.#...",
  "/": "....#/....#/...#./..#../.#.../#..../#....",
  "|": "..#../..#../..#../..#../..#../..#../..#..",
  "(": "...#./..#../.#.../.#.../.#.../..#../...#.",
  ")": ".#.../..#../...#./...#./...#./..#../.#...",
  "+": "...../..#../..#../#####/..#../..#../.....",
};

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;

/** Pure-ASCII, upper-case caption text, so it can be drawn with the built-in glyphs. */
export function captionText(value: string): string {
  return plain(value).toUpperCase().replace(/[^A-Z0-9 .,:/|()+-]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Draw caption lines, then the waterfall scaled up with nearest-neighbour, into one PNG. The caption
 * is part of the pixels, so the image keeps its time stamp when it is copied out of the package.
 */
export function composeCaptionedPng(
  pixels: Uint32Array,
  widthPx: number,
  rows: number,
  lines: readonly string[],
  captionColor = packPixel(255, 255, 255),
  backgroundColor = packPixel(20, 33, 54),
): Uint8Array {
  const scaleX = Math.max(1, Math.ceil(1024 / widthPx));
  const scaleY = Math.max(1, Math.floor(320 / rows));
  const imageWidth = widthPx * scaleX;
  const imageHeight = rows * scaleY;
  const textScale = 2;
  const advance = (GLYPH_WIDTH + 1) * textScale;
  const lineHeight = (GLYPH_HEIGHT + 3) * textScale;
  const totalWidth = Math.max(imageWidth, 1);
  const maxChars = Math.max(1, Math.floor((totalWidth - 2 * advance) / advance));
  // Wrap instead of cutting: the time stamp at the end of a long label must survive.
  const wrapped: string[] = [];
  for (const line of lines) {
    let current = "";
    for (const word of captionText(line).split(" ")) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxChars) current = candidate;
      else {
        if (current) wrapped.push(current);
        current = word.slice(0, maxChars);
      }
    }
    if (current) wrapped.push(current);
  }
  const captionHeight = wrapped.length * lineHeight + 2 * textScale;
  const out = new Uint32Array(totalWidth * (captionHeight + imageHeight)).fill(backgroundColor);
  wrapped.forEach((text, lineIndex) => {
    for (let index = 0; index < text.length; index += 1) {
      const glyph = GLYPHS[text[index]];
      if (!glyph) continue;
      glyph.split("/").forEach((rowBits, glyphRow) => {
        for (let column = 0; column < GLYPH_WIDTH; column += 1) {
          if (rowBits[column] !== "#") continue;
          for (let dy = 0; dy < textScale; dy += 1) {
            for (let dx = 0; dx < textScale; dx += 1) {
              const x = advance + index * advance + column * textScale + dx;
              const y = textScale + lineIndex * lineHeight + glyphRow * textScale + dy;
              if (x < totalWidth) out[y * totalWidth + x] = captionColor;
            }
          }
        }
      });
    }
  });
  for (let row = 0; row < imageHeight; row += 1) {
    const sourceRow = Math.floor(row / scaleY);
    for (let column = 0; column < imageWidth; column += 1) {
      out[(captionHeight + row) * totalWidth + column] = pixels[sourceRow * widthPx + Math.floor(column / scaleX)];
    }
  }
  return encodePng(totalWidth, captionHeight + imageHeight, new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
}

// ---- Rendering helpers -----------------------------------------------------------------------

function pixelRange(widthPx: number, binStart: number, binEnd: number, pixel: number): { lo: number; hi: number } {
  return pixelBinSpan(pixel, widthPx, binStart, binEnd);
}

// ---- Builder ---------------------------------------------------------------------------------

interface RfConfigurationKey {
  startHz: number;
  endHz: number;
  length: number;
  analysisStartBin: number;
  analysisEndBin: number;
}

export class IncidentFigureBuilder {
  private readonly rowMs: number;
  private readonly rows: number;
  private config?: RfConfigurationKey;
  private widthPx = 0;
  private rowPeak = new Uint8Array(0);
  private rowAnomaly = new Uint8Array(0);
  private rowFilled = new Uint8Array(0);
  private rowSum = new Float64Array(0);
  private rowCount = new Uint32Array(0);
  private duringPeak = new Uint8Array(0);
  private duringHistogram = new Uint32Array(0);
  private beforeHistogram = new Uint32Array(0);
  private duringFrames = 0;
  private beforeFrames = 0;
  private afterFrames = 0;
  private used = 0;
  private excluded = 0;
  private collector?: IncidentAnalysisCollector;
  private baselinePixels?: BaselinePixels;

  constructor(private readonly input: IncidentFigureInput) {
    const duration = Math.max(1, input.windowEndMs - input.windowStartMs);
    this.rowMs = chooseRowMs(input.frameTimestampsMs, input.windowStartMs, input.windowEndMs);
    this.rows = Math.max(1, Math.min(MAX_ROWS, Math.ceil(duration / this.rowMs)));
  }

  add(frame: FigureFrame): void {
    const analysisBins = frame.analysisEndBin - frame.analysisStartBin;
    if (
      analysisBins <= 0
      || frame.analysisStartBin < 0
      || frame.analysisEndBin > frame.bins.length
      || !(frame.timestampMs >= this.input.windowStartMs && frame.timestampMs <= this.input.windowEndMs)
    ) {
      this.excluded += 1;
      return;
    }
    const key: RfConfigurationKey = {
      startHz: frame.startHz,
      endHz: frame.endHz,
      length: frame.bins.length,
      analysisStartBin: frame.analysisStartBin,
      analysisEndBin: frame.analysisEndBin,
    };
    if (!this.config) {
      this.config = key;
      this.widthPx = Math.max(1, Math.min(MAX_WIDTH_PX, analysisBins));
      this.rowPeak = new Uint8Array(this.rows * this.widthPx);
      this.rowAnomaly = new Uint8Array(this.rows * this.widthPx);
      this.rowFilled = new Uint8Array(this.rows);
      this.rowSum = new Float64Array(this.rows);
      this.rowCount = new Uint32Array(this.rows);
      this.duringPeak = new Uint8Array(this.widthPx);
      this.duringHistogram = new Uint32Array(this.widthPx * 256);
      this.beforeHistogram = new Uint32Array(this.widthPx * 256);
      if (this.input.baseline && this.input.baseline.median.length === analysisBins) {
        const binCount = analysisBins;
        const median = new Float64Array(this.widthPx);
        const scale = new Float64Array(this.widthPx);
        for (let pixel = 0; pixel < this.widthPx; pixel += 1) {
          const { lo, hi } = pixelRange(this.widthPx, 0, binCount, pixel);
          let medianSum = 0;
          let spread = 0;
          for (let index = lo; index < hi; index += 1) {
            medianSum += this.input.baseline.median[index];
            spread = Math.max(spread, SIGMA_FROM_MAD * this.input.baseline.mad[index]);
          }
          median[pixel] = medianSum / (hi - lo);
          scale[pixel] = Math.max(1, spread);
        }
        this.baselinePixels = { median, scale };
      }
      this.collector = new IncidentAnalysisCollector({
        widthPx: this.widthPx,
        rows: this.rows,
        rowMs: this.rowMs,
        windowStartMs: this.input.windowStartMs,
        windowEndMs: this.input.windowEndMs,
        incidentStartMs: this.input.incidentStartMs,
        incidentEndMs: this.input.incidentEndMs,
        baseline: this.baselinePixels,
        alertSigma: this.input.alertSigma,
      });
    } else if (JSON.stringify(key) !== JSON.stringify(this.config)) {
      // A different RF setup cannot share axes with the rest of the figure.
      this.excluded += 1;
      return;
    }
    this.used += 1;
    const phase = frame.timestampMs < this.input.incidentStartMs ? "before"
      : frame.timestampMs <= this.input.incidentEndMs ? "during" : "after";
    if (phase === "before") this.beforeFrames += 1;
    else if (phase === "during") this.duringFrames += 1;
    else this.afterFrames += 1;

    const slot = Math.min(
      this.rows - 1,
      Math.max(0, Math.floor((frame.timestampMs - this.input.windowStartMs) / this.rowMs)),
    );
    // Newest first, like the live waterfall.
    const row = this.rows - 1 - slot;
    this.rowFilled[row] = 1;
    let frameSum = 0;
    const base = row * this.widthPx;
    const levels = new Uint8Array(this.widthPx);
    for (let pixel = 0; pixel < this.widthPx; pixel += 1) {
      const { lo, hi } = pixelRange(this.widthPx, frame.analysisStartBin, frame.analysisEndBin, pixel);
      let peak = 0;
      for (let index = lo; index < hi; index += 1) if (frame.bins[index] > peak) peak = frame.bins[index];
      levels[pixel] = peak;
      frameSum += peak;
      if (peak > this.rowPeak[base + pixel]) this.rowPeak[base + pixel] = peak;
      if (phase === "during") {
        if (peak > this.duringPeak[pixel]) this.duringPeak[pixel] = peak;
        this.duringHistogram[pixel * 256 + peak] += 1;
      } else if (phase === "before") {
        this.beforeHistogram[pixel * 256 + peak] += 1;
      }
    }
    // Detector-flagged bins of this frame, mapped onto the figure's pixel columns.
    const analysisSpan = frame.analysisEndBin - frame.analysisStartBin;
    for (const range of frame.anomalyBinRanges ?? []) {
      const start = Math.max(frame.analysisStartBin, range.startBin) - frame.analysisStartBin;
      const end = Math.min(frame.analysisEndBin, range.endBin) - frame.analysisStartBin;
      if (end <= start) continue;
      const firstPixel = Math.max(0, Math.floor((start / analysisSpan) * this.widthPx));
      const lastPixel = Math.min(this.widthPx, Math.ceil((end / analysisSpan) * this.widthPx));
      for (let pixel = firstPixel; pixel < lastPixel; pixel += 1) this.rowAnomaly[base + pixel] = 1;
    }
    this.rowSum[row] += frameSum / this.widthPx;
    this.rowCount[row] += 1;
    this.collector?.addFrame(levels, frame.timestampMs, phase, row);
  }

  finish(): IncidentFigureResult {
    const { input } = this;
    const config = this.config;
    const palette = buildWaterfallPalette();
    const widthPx = Math.max(1, this.widthPx);
    const rows = this.rows;
    const gapPixel = packPixel(43, 47, 54);

    // Contrast: map the recorded range (2nd to 98th percentile) onto the full
    // colour ramp, so a quiet band is not drawn as one uniform dark blue.
    const levelHistogram = new Uint32Array(256);
    let levelCount = 0;
    for (let row = 0; row < rows; row += 1) {
      if (!this.rowFilled[row]) continue;
      for (let pixel = 0; pixel < widthPx; pixel += 1) {
        levelHistogram[this.rowPeak[row * widthPx + pixel]] += 1;
        levelCount += 1;
      }
    }
    const percentile = (fraction: number) => {
      let seen = 0;
      for (let level = 0; level < 256; level += 1) {
        seen += levelHistogram[level];
        if (seen >= fraction * levelCount) return level;
      }
      return 255;
    };
    const stretchLow = levelCount ? percentile(0.02) : 0;
    const stretchHigh = levelCount ? Math.min(255, Math.max(stretchLow + 16, percentile(0.98))) : 255;
    const stretch = (level: number) => Math.max(0, Math.min(255, Math.round(((level - stretchLow) / Math.max(1, stretchHigh - stretchLow)) * 255)));
    // Waterfall pixels: one pixel per column and row, gaps in neutral grey, detector-flagged bins tinted red.
    const pixels = new Uint32Array(widthPx * rows).fill(gapPixel);
    if (config) {
      for (let row = 0; row < rows; row += 1) {
        if (!this.rowFilled[row]) continue;
        for (let pixel = 0; pixel < widthPx; pixel += 1) {
          const index = row * widthPx + pixel;
          const level = stretch(this.rowPeak[index]);
          pixels[index] = this.rowAnomaly[index] ? palette.anomaly[level] : palette.plain[level];
        }
      }
    }
    const rawPng = encodePng(widthPx, rows, new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength));

    // Frequency axis of the analysed window.
    const spanHz = config ? config.endHz - config.startHz : 0;
    const analysisStartHz = config ? config.startHz + (config.analysisStartBin / config.length) * spanHz : input.rangeHz[0];
    const analysisEndHz = config ? config.startHz + (config.analysisEndBin / config.length) * spanHz : input.rangeHz[1];

    const pngCaption = [
      `UTC ${utc(input.windowStartMs, true)} TO ${utc(input.windowEndMs, true)} | INCIDENT ${utc(input.incidentStartMs, true)} TO ${utc(input.incidentEndMs, true)}`,
      `${input.label} | ${(analysisStartHz / 1e6).toFixed(3)} TO ${(analysisEndHz / 1e6).toFixed(3)} MHZ | RELATIVE LEVELS | GENERATED ${utc(input.generatedAtMs, true)} UTC`,
    ];
    const waterfallPng = composeCaptionedPng(pixels, widthPx, rows, pngCaption);

    const median = (histogram: Uint32Array, pixel: number, count: number): number | undefined => {
      if (!count) return undefined;
      let seen = 0;
      for (let level = 0; level < 256; level += 1) {
        seen += histogram[pixel * 256 + level];
        if (seen * 2 >= count) return level;
      }
      return 255;
    };
    const duringMedian: Array<number | undefined> = [];
    const beforeMedian: Array<number | undefined> = [];
    for (let pixel = 0; pixel < widthPx; pixel += 1) {
      duringMedian.push(config ? median(this.duringHistogram, pixel, this.duringFrames) : undefined);
      beforeMedian.push(config ? median(this.beforeHistogram, pixel, this.beforeFrames) : undefined);
    }
    let baselineMedian: number[] | undefined;
    let baselineLow: number[] | undefined;
    let baselineHigh: number[] | undefined;
    if (this.baselinePixels) {
      baselineMedian = Array.from(this.baselinePixels.median);
      baselineLow = baselineMedian.map((value, pixel) => Math.max(0, value - ABOVE_USUAL_SPREADS * this.baselinePixels!.scale[pixel]));
      baselineHigh = baselineMedian.map((value, pixel) => Math.min(255, value + ABOVE_USUAL_SPREADS * this.baselinePixels!.scale[pixel]));
    }

    // ---- Layout --------------------------------------------------------------------------
    const left = 76;
    const plotWidth = MAX_WIDTH_PX;
    const gap = 14;
    const stripWidth = 150;
    const right = 24;
    const totalWidth = left + plotWidth + gap + stripWidth + right;
    const headerHeight = 156;
    const spectrumHeight = 230;
    const waterfallHeight = Math.max(200, Math.min(420, rows * 8));
    const axisPad = 34;
    const legendHeight = 62;
    const footerHeight = 102;
    const spectrumTop = headerHeight + 26;
    const waterfallTop = spectrumTop + spectrumHeight + axisPad + 34;
    const totalHeight = waterfallTop + waterfallHeight + axisPad + legendHeight + footerHeight;
    const longWindow = input.windowEndMs - input.windowStartMs > 20 * 3_600_000 || utc(input.windowStartMs, true).slice(0, 10) !== utc(input.windowEndMs, true).slice(0, 10);

    const xHz = (hz: number) => left + ((hz - analysisStartHz) / Math.max(1, analysisEndHz - analysisStartHz)) * plotWidth;
    const yLevel = (level: number) => spectrumTop + spectrumHeight - (level / 255) * spectrumHeight;
    const yTime = (ms: number) => waterfallTop + ((input.windowEndMs - ms) / Math.max(1, input.windowEndMs - input.windowStartMs)) * waterfallHeight;
    const xPixel = (pixel: number) => left + ((pixel + 0.5) / widthPx) * plotWidth;
    const out: string[] = [];
    const push = (value: string) => { out.push(value); };

    push(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${totalHeight}" viewBox="0 0 ${totalWidth} ${totalHeight}" font-family="Arial, Helvetica, sans-serif" role="img" aria-labelledby="figure-title figure-desc">`);
    push(`<title id="figure-title">RF incident figure: ${xml(plain(input.label))}</title>`);
    push(`<desc id="figure-desc">Relative, uncalibrated spectrum and waterfall for one incident. RF data can show interference, not intent.</desc>`);
    push(`<rect width="${totalWidth}" height="${totalHeight}" fill="#ffffff"/>`);

    // Header
    push(`<text x="${left}" y="34" font-size="22" font-weight="700" fill="#142536">${xml(plain(input.verdict ?? "Suspected RF interference"))}: ${xml(plain(input.label))}</text>`);
    const facts: Array<[string, string]> = [
      ["Frequency", `${(input.rangeHz[0] / 1e6).toFixed(3)} to ${(input.rangeHz[1] / 1e6).toFixed(3)} MHz`],
      ["Started (UTC)", utc(input.incidentStartMs, true)],
      ["Ended or last seen (UTC)", utc(input.incidentEndMs, true)],
      ["Evidence strength", input.evidenceStrength],
      ["Lifecycle", input.lifecycle],
      ["Incident", input.incidentId],
    ];
    facts.forEach(([name, value], index) => {
      const column = index % 3;
      const line = Math.floor(index / 3);
      const x = left + column * 360;
      const y = 62 + line * 40;
      push(`<text x="${x}" y="${y}" font-size="11" fill="#5a6876">${xml(name)}</text>`);
      push(`<text x="${x}" y="${y + 14}" font-size="13" fill="#142536">${xml(value)}</text>`);
    });
    push(`<text x="${left}" y="${headerHeight - 14}" font-size="12" fill="#142536">${xml(plain(input.observed).slice(0, 160))}</text>`);
    push(`<text x="${left + plotWidth + gap + stripWidth}" y="34" font-size="12" text-anchor="end" fill="#34536f">Figure generated (UTC) ${xml(utc(input.generatedAtMs, true))}</text>`);

    // Panel A: spectrum
    push(`<text x="${left}" y="${spectrumTop - 10}" font-size="14" font-weight="700" fill="#142536">Relative signal level across the analysed window</text>`);
    push(`<rect x="${left}" y="${spectrumTop}" width="${plotWidth}" height="${spectrumHeight}" fill="#f7f9fa" stroke="#cbd2d9"/>`);
    for (const level of [0, 64, 128, 192, 255]) {
      const y = yLevel(level);
      push(`<line x1="${left}" x2="${left + plotWidth}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#dfe4e9"/>`);
      push(`<text x="${left - 8}" y="${(y + 4).toFixed(1)}" font-size="10" text-anchor="end" fill="#5a6876">${level}</text>`);
    }
    push(`<text x="16" y="${spectrumTop + spectrumHeight / 2}" font-size="10" fill="#5a6876" transform="rotate(-90 16 ${spectrumTop + spectrumHeight / 2})" text-anchor="middle">Relative level (0 to 255)</text>`);
    const polyline = (values: ReadonlyArray<number | undefined>, stroke: string, width: number, dash?: string) => {
      const points = values.flatMap((value, pixel) => value === undefined ? [] : [`${xPixel(pixel).toFixed(1)},${yLevel(value).toFixed(1)}`]);
      if (points.length < 2) return;
      push(`<polyline fill="none" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ""} points="${points.join(" ")}"/>`);
    };
    if (baselineLow && baselineHigh && baselineMedian) {
      const upper = baselineHigh.map((value, pixel) => `${xPixel(pixel).toFixed(1)},${yLevel(value).toFixed(1)}`);
      const lower = baselineLow.map((value, pixel) => `${xPixel(pixel).toFixed(1)},${yLevel(value).toFixed(1)}`).reverse();
      push(`<polygon fill="#15963d" fill-opacity="0.16" stroke="none" points="${[...upper, ...lower].join(" ")}"/>`);
      polyline(baselineMedian, "#15963d", 1.5, "5 3");
    }
    polyline(beforeMedian, "#8793a0", 1.25);
    polyline(duringMedian, "#1766ae", 1.5);
    polyline(this.duringFrames ? Array.from(this.duringPeak) : [], "#df0b0b", 1.25);
    for (const hz of frequencyTicks(analysisStartHz, analysisEndHz, 8)) {
      const x = xHz(hz);
      push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${spectrumTop + spectrumHeight}" y2="${spectrumTop + spectrumHeight + 5}" stroke="#5a6876"/>`);
      push(`<text x="${x.toFixed(1)}" y="${spectrumTop + spectrumHeight + 18}" font-size="10" text-anchor="middle" fill="#5a6876">${(hz / 1e6).toFixed(3)}</text>`);
    }
    push(`<text x="${left + plotWidth}" y="${spectrumTop + spectrumHeight + 30}" font-size="10" text-anchor="end" fill="#5a6876">MHz</text>`);
    // Legend
    const legend: Array<[string, string, string | undefined]> = [
      ["During the incident: strongest level", "#df0b0b", undefined],
      ["During the incident: typical level", "#1766ae", undefined],
      ["Before the incident: typical level", "#8793a0", undefined],
      ["Learned normal level (shaded: usual range)", "#15963d", "5 3"],
    ];
    legend.forEach(([text, colour, dash], index) => {
      const x = left + index * 256;
      const y = spectrumTop + spectrumHeight + 30;
      push(`<line x1="${x}" x2="${x + 20}" y1="${y - 4}" y2="${y - 4}" stroke="${colour}" stroke-width="2"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`);
      push(`<text x="${x + 26}" y="${y}" font-size="10" fill="#142536">${xml(text)}</text>`);
    });
    if (!baselineMedian) {
      push(`<text x="${left + plotWidth - 6}" y="${spectrumTop + 16}" font-size="11" text-anchor="end" fill="#8a5a00">No learned normal level is available for this window in this package.</text>`);
    }
    if (!config) {
      push(`<text x="${left + plotWidth / 2}" y="${spectrumTop + spectrumHeight / 2}" font-size="14" text-anchor="middle" fill="#8a5a00">No frames were available to draw.</text>`);
    }

    // Panel B: waterfall, newest on top
    push(`<text x="${left}" y="${waterfallTop - 10}" font-size="14" font-weight="700" fill="#142536">Waterfall: newest at the top, UTC on the left</text>`);
    push(`<image x="${left}" y="${waterfallTop}" width="${plotWidth}" height="${waterfallHeight}" preserveAspectRatio="none" style="image-rendering:pixelated" href="data:image/png;base64,${Buffer.from(rawPng).toString("base64")}"/>`);
    push(`<rect x="${left}" y="${waterfallTop}" width="${plotWidth}" height="${waterfallHeight}" fill="none" stroke="#cbd2d9"/>`);
    for (const tick of timeTicks(input.windowStartMs, input.windowEndMs, 8)) {
      const y = yTime(tick);
      push(`<line x1="${left - 5}" x2="${left}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#5a6876"/>`);
      push(`<text x="${left - 8}" y="${(y + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="#5a6876">${xml(utc(tick, longWindow))}</text>`);
    }
    for (const hz of frequencyTicks(analysisStartHz, analysisEndHz, 8)) {
      const x = xHz(hz);
      push(`<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${waterfallTop}" y2="${waterfallTop + waterfallHeight}" stroke="#ffffff" stroke-opacity="0.22"/>`);
      push(`<text x="${x.toFixed(1)}" y="${waterfallTop + waterfallHeight + 16}" font-size="10" text-anchor="middle" fill="#5a6876">${(hz / 1e6).toFixed(3)}</text>`);
    }
    push(`<text x="${left + plotWidth}" y="${waterfallTop + waterfallHeight + 28}" font-size="10" text-anchor="end" fill="#5a6876">MHz</text>`);
    const marker = (ms: number, text: string) => {
      if (ms < input.windowStartMs || ms > input.windowEndMs) return;
      const y = yTime(ms);
      push(`<line x1="${left}" x2="${left + plotWidth + gap + stripWidth}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#df0b0b" stroke-width="1.5" stroke-dasharray="6 4"/>`);
      push(`<text x="${left + plotWidth - 4}" y="${(y - 4).toFixed(1)}" font-size="10.5" text-anchor="end" fill="#ffffff" stroke="#7a0000" stroke-width="3" paint-order="stroke" font-weight="700">${xml(text)}</text>`);
    };
    marker(input.incidentStartMs, `Incident start ${utc(input.incidentStartMs, longWindow)}`);
    marker(input.incidentEndMs, `Ended or last seen ${utc(input.incidentEndMs, longWindow)}`);

    // Strip: strongest level per row, same time axis
    const stripLeft = left + plotWidth + gap;
    push(`<text x="${stripLeft}" y="${waterfallTop - 10}" font-size="11" font-weight="700" fill="#142536">Strongest level per row</text>`);
    push(`<rect x="${stripLeft}" y="${waterfallTop}" width="${stripWidth}" height="${waterfallHeight}" fill="#f7f9fa" stroke="#cbd2d9"/>`);
    const rowHeight = waterfallHeight / rows;
    for (let row = 0; row < rows; row += 1) {
      if (!this.rowFilled[row]) continue;
      let peak = 0;
      for (let pixel = 0; pixel < widthPx; pixel += 1) if (this.rowPeak[row * widthPx + pixel] > peak) peak = this.rowPeak[row * widthPx + pixel];
      const slotStart = input.windowStartMs + (rows - 1 - row) * this.rowMs;
      const during = slotStart + this.rowMs >= input.incidentStartMs && slotStart <= input.incidentEndMs;
      push(`<rect x="${stripLeft}" y="${(waterfallTop + row * rowHeight).toFixed(2)}" width="${((peak / 255) * stripWidth).toFixed(1)}" height="${Math.max(0.6, rowHeight).toFixed(2)}" fill="${during ? "#df0b0b" : "#8793a0"}"/>`);
    }

    // Colour key
    const keyTop = waterfallTop + waterfallHeight + axisPad + 4;
    const gradientId = "quiet-to-strong";
    push(`<defs><linearGradient id="${gradientId}" x1="0" x2="1" y1="0" y2="0">${Array.from({ length: 9 }, (_, index) => {
      const colour = palette.plain[Math.round((index / 8) * 255)];
      const bytes = new Uint8Array(new Uint32Array([colour]).buffer);
      return `<stop offset="${index / 8}" stop-color="rgb(${bytes[0]},${bytes[1]},${bytes[2]})"/>`;
    }).join("")}</linearGradient></defs>`);
    push(`<rect x="${left}" y="${keyTop}" width="220" height="12" fill="url(#${gradientId})" stroke="#cbd2d9"/>`);
    push(`<text x="${left}" y="${keyTop + 26}" font-size="10" fill="#142536">Quiet (level ${stretchLow})</text>`);
    push(`<text x="${left + 220}" y="${keyTop + 26}" font-size="10" text-anchor="end" fill="#142536">Strong (level ${stretchHigh}, relative)</text>`);
    push(`<rect x="${left + 280}" y="${keyTop}" width="14" height="12" fill="rgb(43,47,54)"/>`);
    push(`<text x="${left + 300}" y="${keyTop + 10}" font-size="10" fill="#142536">No frames in this row (the receiver was tuned elsewhere or recording had a gap)</text>`);

    // Footer
    const footerTop = totalHeight - footerHeight + 10;
    const footer = [
      "RF data can show interference, not intent. Levels are relative and uncalibrated.",
      "This figure is a derived view. The recorded frames in this package and their SHA-256 sums are the evidence.",
      `Figure generated ${utc(input.generatedAtMs, true)} UTC. Data window ${utc(input.windowStartMs, true)} to ${utc(input.windowEndMs, true)} UTC.`,
      `Frames drawn: ${this.used} (before ${this.beforeFrames}, during ${this.duringFrames}, after ${this.afterFrames}).${this.excluded ? ` Left out: ${this.excluded} (outside the window or a different RF setup).` : ""} Each pixel shows the strongest bin it covers; each row shows the strongest value in about ${Math.max(1, Math.round(this.rowMs / 100) / 10)} s.`,
      input.sourceFramesSha256 ? `Drawn from spectrum/frames.jsonl, SHA-256 ${input.sourceFramesSha256}.` : "Drawn from spectrum/frames.jsonl in this package.",
    ];
    footer.forEach((line, index) => push(`<text x="${left}" y="${footerTop + index * 18}" font-size="10.5" fill="#34536f">${xml(line)}</text>`));
    push("</svg>");

    const summary: IncidentFigureSummary = {
      schemaVersion: 1,
      derived: true,
      framesUsed: this.used,
      framesExcludedRfConfiguration: this.excluded,
      framesBefore: this.beforeFrames,
      framesDuring: this.duringFrames,
      framesAfter: this.afterFrames,
      widthPx,
      rows,
      rowSeconds: Math.round(this.rowMs) / 1000,
      baselineIncluded: Boolean(baselineMedian),
      generatedAt: new Date(input.generatedAtMs).toISOString(),
      pngCaption,
      window: { startedAt: new Date(input.windowStartMs).toISOString(), endedAt: new Date(input.windowEndMs).toISOString() },
      incident: { startedAt: new Date(input.incidentStartMs).toISOString(), endedAt: new Date(input.incidentEndMs).toISOString() },
      ...(config ? { analysisWindowHz: [Math.round(analysisStartHz), Math.round(analysisEndHz)] as [number, number] } : {}),
      ...(input.sourceFramesSha256 ? { sourceFramesSha256: input.sourceFramesSha256 } : {}),
      levelScale: "relative-uncalibrated-uint8",
      analysis: undefined as unknown as AnalysisStats,
      findings: [],
    };
    const analysis = renderAnalysisCharts(
      this.collector?.finish(analysisStartHz, analysisEndHz) ?? new IncidentAnalysisCollector({
        widthPx,
        rows,
        rowMs: this.rowMs,
        windowStartMs: input.windowStartMs,
        windowEndMs: input.windowEndMs,
        incidentStartMs: input.incidentStartMs,
        incidentEndMs: input.incidentEndMs,
      }).finish(analysisStartHz, analysisEndHz),
      { label: input.label, incidentId: input.incidentId, generatedAtMs: input.generatedAtMs, alertSigma: input.alertSigma },
    );
    summary.analysis = analysis.stats;
    summary.findings = analysis.findings;
    const alertLevel = this.baselinePixels && input.alertSigma
      ? Array.from(this.baselinePixels.median, (value, pixel) => Math.min(255, value + input.alertSigma! * this.baselinePixels!.scale[pixel]))
      : undefined;
    const data: IncidentFigureData = {
      analysisStartHz,
      analysisEndHz,
      widthPx,
      rows,
      windowStartMs: input.windowStartMs,
      windowEndMs: input.windowEndMs,
      incidentStartMs: input.incidentStartMs,
      incidentEndMs: input.incidentEndMs,
      waterfallPngBase64: Buffer.from(rawPng).toString("base64"),
      waterfallLevelRange: [stretchLow, stretchHigh],
      before: beforeMedian.map((value) => value ?? null),
      during: duringMedian.map((value) => value ?? null),
      strongest: this.duringFrames ? Array.from(this.duringPeak) : new Array(widthPx).fill(null),
      ...(baselineMedian ? { usual: baselineMedian, usualHigh: baselineHigh } : {}),
      ...(alertLevel ? { alertLevel } : {}),
      framesBefore: this.beforeFrames,
      framesDuring: this.duringFrames,
      framesAfter: this.afterFrames,
    };
    return { svg: out.join("\n"), waterfallPng, analysis, summary, data };
  }
}
