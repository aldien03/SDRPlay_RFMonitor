/**
 * Analysis numbers and charts for one incident, drawn from the same recorded frames and learned
 * baseline as the overview figure. Pure and deterministic. Levels are relative and uncalibrated.
 *
 * "Above usual" means: a pixel's strongest level is more than three usual spreads above the learned
 * typical level for that pixel (usual spread = 1.4826 x the learned MAD, at least 1).
 */
import { buildWaterfallPalette, waterfallRgb } from "../shared/waterfallRaster";
import { frequencyTicks, plain, timeTicks, utc, xml } from "./chartKit";
import { frequencyAxisTicks, levelRange, numericTicks, timeAxisTicks, type ChartPoint, type ChartSpec } from "./report/chartSpec";
import { chartToSvg } from "./report/svgChart";
import { REPORT_COLORS } from "./report/theme";

/** Fewer frames than this before the incident make "before" comparisons weak. */
export const MIN_COMPARISON_FRAMES = 10;

export const ABOVE_USUAL_SPREADS = 3;

export interface BaselinePixels {
  /** Learned typical level per pixel. */
  median: Float64Array;
  /** Usual spread per pixel (1.4826 x MAD, at least 1). */
  scale: Float64Array;
}

export interface AnalysisData {
  windowStartMs: number;
  windowEndMs: number;
  incidentStartMs: number;
  incidentEndMs: number;
  rowMs: number;
  rows: number;
  widthPx: number;
  analysisStartHz: number;
  analysisEndHz: number;
  rowFilled: Uint8Array;
  rowPeakLevel: Uint8Array;
  rowPeakPixel: Int16Array;
  /** Typical level per row: the mean over frames of the mean over pixels. */
  rowTypical: Float32Array;
  /** Strongest excess over the learned level, in usual spreads; -1 when not computed. */
  rowExcess: Float32Array;
  /** Largest share of the band that was above usual in any frame of the row, 0 to 1. */
  rowAboveShare: Float32Array;
  hasBaseline: boolean;
  learnedTypical?: number;
  learnedHigh?: number;
  learnedLow?: number;
  /** Percent of frames in which each pixel was above usual. */
  aboveDuringPct: Float32Array;
  aboveBeforePct: Float32Array;
  /** The incident's alert level in normal variations, when known. */
  alertSigma?: number;
  /** Percent of frames in which each pixel was above the alert level. */
  aboveAlertDuringPct?: Float32Array;
  aboveAlertBeforePct?: Float32Array;
  framesDuringAnyAboveAlert: number;
  alertShareSum: number;
  alertShareMax: number;
  framesDuring: number;
  framesBefore: number;
  framesAfter: number;
  framesDuringAnyAbove: number;
  strongest: { level: number; pixel: number; atMs: number } | undefined;
  typicalBefore?: number;
  typicalDuring?: number;
  typicalAfter?: number;
  peakPixelCountsDuring: Uint32Array;
  shareAboveSum: number;
  shareAboveMax: number;
  maxExcess?: number;
}

export interface AnalysisStats {
  incidentSeconds: number;
  framesBefore: number;
  framesDuring: number;
  framesAfter: number;
  strongestLevel?: number;
  strongestMHz?: number;
  strongestAt?: string;
  typicalBefore?: number;
  typicalDuring?: number;
  learnedTypical?: number;
  maxExcessSpreads?: number;
  duringFramesAboveUsualPct?: number;
  typicalBandAboveUsualPct?: number;
  maxBandAboveUsualPct?: number;
  mostFrequentPeakMHz?: number;
  peakStaysWithinKHz?: number;
  peakStablePct?: number;
  peakSpreadKHz?: number;
  windowCentreMHz: number;
  peakAtWindowCentre: boolean;
  alertSigma?: number;
  duringFramesAboveAlertPct?: number;
  typicalBandAboveAlertPct?: number;
  maxBandAboveAlertPct?: number;
  fewFramesBefore?: boolean;
}

export class IncidentAnalysisCollector {
  private readonly rowFilled: Uint8Array;
  private readonly rowPeakLevel: Uint8Array;
  private readonly rowPeakPixel: Int16Array;
  private readonly rowTypicalSum: Float64Array;
  private readonly rowCount: Uint32Array;
  private readonly rowExcess: Float32Array;
  private readonly rowAboveShare: Float32Array;
  private readonly aboveDuring: Uint32Array;
  private readonly aboveBefore: Uint32Array;
  private readonly aboveAlertDuring: Uint32Array;
  private readonly aboveAlertBefore: Uint32Array;
  private framesDuringAnyAboveAlert = 0;
  private alertShareSum = 0;
  private alertShareMax = 0;
  private readonly peakPixelCountsDuring: Uint32Array;
  private framesDuring = 0;
  private framesBefore = 0;
  private framesAfter = 0;
  private framesDuringAnyAbove = 0;
  private beforeSum = 0;
  private duringSum = 0;
  private afterSum = 0;
  private shareAboveSum = 0;
  private shareAboveMax = 0;
  private maxExcess: number | undefined;
  private strongest: AnalysisData["strongest"];

  constructor(
    private readonly options: {
      widthPx: number;
      rows: number;
      rowMs: number;
      windowStartMs: number;
      windowEndMs: number;
      incidentStartMs: number;
      incidentEndMs: number;
      baseline?: BaselinePixels;
      alertSigma?: number;
    },
  ) {
    const { widthPx, rows } = options;
    this.rowFilled = new Uint8Array(rows);
    this.rowPeakLevel = new Uint8Array(rows);
    this.rowPeakPixel = new Int16Array(rows).fill(-1);
    this.rowTypicalSum = new Float64Array(rows);
    this.rowCount = new Uint32Array(rows);
    this.rowExcess = new Float32Array(rows).fill(-1);
    this.rowAboveShare = new Float32Array(rows);
    this.aboveDuring = new Uint32Array(widthPx);
    this.aboveBefore = new Uint32Array(widthPx);
    this.aboveAlertDuring = new Uint32Array(widthPx);
    this.aboveAlertBefore = new Uint32Array(widthPx);
    this.peakPixelCountsDuring = new Uint32Array(widthPx);
  }

  addFrame(levels: Uint8Array, timestampMs: number, phase: "before" | "during" | "after", row: number): void {
    const { widthPx, baseline } = this.options;
    let peak = 0;
    let peakPixel = 0;
    let sum = 0;
    let above = 0;
    let aboveAlert = 0;
    const alertSigma = this.options.alertSigma;
    let excess = -Infinity;
    for (let pixel = 0; pixel < widthPx; pixel += 1) {
      const level = levels[pixel];
      sum += level;
      if (level > peak) {
        peak = level;
        peakPixel = pixel;
      }
      if (baseline) {
        const spreads = (level - baseline.median[pixel]) / baseline.scale[pixel];
        if (spreads > excess) excess = spreads;
        if (spreads > ABOVE_USUAL_SPREADS) {
          above += 1;
          if (phase === "during") this.aboveDuring[pixel] += 1;
          else if (phase === "before") this.aboveBefore[pixel] += 1;
        }
        if (alertSigma !== undefined && spreads >= alertSigma) {
          aboveAlert += 1;
          if (phase === "during") this.aboveAlertDuring[pixel] += 1;
          else if (phase === "before") this.aboveAlertBefore[pixel] += 1;
        }
      }
    }
    const typical = sum / widthPx;
    this.rowFilled[row] = 1;
    if (peak >= this.rowPeakLevel[row] || this.rowPeakPixel[row] < 0) {
      this.rowPeakLevel[row] = peak;
      this.rowPeakPixel[row] = peakPixel;
    }
    this.rowTypicalSum[row] += typical;
    this.rowCount[row] += 1;
    if (baseline) {
      if (excess > this.rowExcess[row]) this.rowExcess[row] = excess;
      const share = above / widthPx;
      if (share > this.rowAboveShare[row]) this.rowAboveShare[row] = share;
    }
    if (phase === "before") {
      this.framesBefore += 1;
      this.beforeSum += typical;
    } else if (phase === "after") {
      this.framesAfter += 1;
      this.afterSum += typical;
    } else {
      this.framesDuring += 1;
      this.duringSum += typical;
      this.peakPixelCountsDuring[peakPixel] += 1;
      if (!this.strongest || peak > this.strongest.level) this.strongest = { level: peak, pixel: peakPixel, atMs: timestampMs };
      if (baseline) {
        const share = above / widthPx;
        this.shareAboveSum += share;
        this.shareAboveMax = Math.max(this.shareAboveMax, share);
        if (above > 0) this.framesDuringAnyAbove += 1;
        if (this.maxExcess === undefined || excess > this.maxExcess) this.maxExcess = excess;
        if (alertSigma !== undefined) {
          const alertShare = aboveAlert / widthPx;
          this.alertShareSum += alertShare;
          this.alertShareMax = Math.max(this.alertShareMax, alertShare);
          if (aboveAlert > 0) this.framesDuringAnyAboveAlert += 1;
        }
      }
    }
  }

  finish(analysisStartHz: number, analysisEndHz: number): AnalysisData {
    const { widthPx, rows, baseline } = this.options;
    const typicalRows = new Float32Array(rows);
    for (let row = 0; row < rows; row += 1) typicalRows[row] = this.rowCount[row] ? this.rowTypicalSum[row] / this.rowCount[row] : 0;
    const percent = (counts: Uint32Array, frames: number) => Float32Array.from(counts, (count) => (frames ? (100 * count) / frames : 0));
    let learnedTypical: number | undefined;
    let learnedHigh: number | undefined;
    let learnedLow: number | undefined;
    if (baseline) {
      let median = 0;
      let high = 0;
      let low = 0;
      for (let pixel = 0; pixel < widthPx; pixel += 1) {
        median += baseline.median[pixel];
        high += baseline.median[pixel] + ABOVE_USUAL_SPREADS * baseline.scale[pixel];
        low += Math.max(0, baseline.median[pixel] - ABOVE_USUAL_SPREADS * baseline.scale[pixel]);
      }
      learnedTypical = median / widthPx;
      learnedHigh = high / widthPx;
      learnedLow = low / widthPx;
    }
    return {
      windowStartMs: this.options.windowStartMs,
      windowEndMs: this.options.windowEndMs,
      incidentStartMs: this.options.incidentStartMs,
      incidentEndMs: this.options.incidentEndMs,
      rowMs: this.options.rowMs,
      rows,
      widthPx,
      analysisStartHz,
      analysisEndHz,
      rowFilled: this.rowFilled,
      rowPeakLevel: this.rowPeakLevel,
      rowPeakPixel: this.rowPeakPixel,
      rowTypical: typicalRows,
      rowExcess: this.rowExcess,
      rowAboveShare: this.rowAboveShare,
      hasBaseline: Boolean(baseline),
      learnedTypical,
      learnedHigh,
      learnedLow,
      aboveDuringPct: percent(this.aboveDuring, this.framesDuring),
      aboveBeforePct: percent(this.aboveBefore, this.framesBefore),
      ...(this.options.alertSigma !== undefined && baseline ? {
        alertSigma: this.options.alertSigma,
        aboveAlertDuringPct: percent(this.aboveAlertDuring, this.framesDuring),
        aboveAlertBeforePct: percent(this.aboveAlertBefore, this.framesBefore),
      } : {}),
      framesDuringAnyAboveAlert: this.framesDuringAnyAboveAlert,
      alertShareSum: this.alertShareSum,
      alertShareMax: this.alertShareMax,
      framesDuring: this.framesDuring,
      framesBefore: this.framesBefore,
      framesAfter: this.framesAfter,
      framesDuringAnyAbove: this.framesDuringAnyAbove,
      strongest: this.strongest,
      typicalBefore: this.framesBefore ? this.beforeSum / this.framesBefore : undefined,
      typicalDuring: this.framesDuring ? this.duringSum / this.framesDuring : undefined,
      typicalAfter: this.framesAfter ? this.afterSum / this.framesAfter : undefined,
      peakPixelCountsDuring: this.peakPixelCountsDuring,
      shareAboveSum: this.shareAboveSum,
      shareAboveMax: this.shareAboveMax,
      maxExcess: this.maxExcess,
    };
  }
}

function pixelHz(data: AnalysisData, pixel: number): number {
  return data.analysisStartHz + ((pixel + 0.5) / data.widthPx) * (data.analysisEndHz - data.analysisStartHz);
}

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Numbers and plain sentences that a report can quote. No claim about intent is ever made. */
export function describeAnalysis(data: AnalysisData): { stats: AnalysisStats; findings: string[] } {
  const spanHz = data.analysisEndHz - data.analysisStartHz;
  const pixelWidthKHz = spanHz / data.widthPx / 1000;
  const centreHz = data.analysisStartHz + spanHz / 2;
  let modePixel = -1;
  let modeCount = 0;
  let total = 0;
  for (let pixel = 0; pixel < data.widthPx; pixel += 1) {
    total += data.peakPixelCountsDuring[pixel];
    if (data.peakPixelCountsDuring[pixel] > modeCount) {
      modeCount = data.peakPixelCountsDuring[pixel];
      modePixel = pixel;
    }
  }
  let stablePct: number | undefined;
  let spreadKHz: number | undefined;
  if (modePixel >= 0 && total > 0) {
    let near = 0;
    for (let pixel = Math.max(0, modePixel - 2); pixel <= Math.min(data.widthPx - 1, modePixel + 2); pixel += 1) near += data.peakPixelCountsDuring[pixel];
    stablePct = (100 * near) / total;
    // Central 90% of where the strongest bin was, as a spread in kHz.
    let seen = 0;
    let low = 0;
    let high = data.widthPx - 1;
    for (let pixel = 0; pixel < data.widthPx; pixel += 1) {
      seen += data.peakPixelCountsDuring[pixel];
      if (seen >= total * 0.05) { low = pixel; break; }
    }
    seen = 0;
    for (let pixel = data.widthPx - 1; pixel >= 0; pixel -= 1) {
      seen += data.peakPixelCountsDuring[pixel];
      if (seen >= total * 0.05) { high = pixel; break; }
    }
    spreadKHz = Math.max(0, (high - low + 1) * pixelWidthKHz);
  }
  const peakAtCentre = modePixel >= 0 && Math.abs(pixelHz(data, modePixel) - centreHz) <= 2.5 * pixelWidthKHz * 1000;
  const stats: AnalysisStats = {
    incidentSeconds: Math.max(0, Math.round((data.incidentEndMs - data.incidentStartMs) / 1000)),
    framesBefore: data.framesBefore,
    framesDuring: data.framesDuring,
    framesAfter: data.framesAfter,
    ...(data.strongest ? {
      strongestLevel: data.strongest.level,
      strongestMHz: round(pixelHz(data, data.strongest.pixel) / 1e6, 4),
      strongestAt: new Date(data.strongest.atMs).toISOString(),
    } : {}),
    ...(data.typicalBefore !== undefined ? { typicalBefore: round(data.typicalBefore) } : {}),
    ...(data.typicalDuring !== undefined ? { typicalDuring: round(data.typicalDuring) } : {}),
    ...(data.learnedTypical !== undefined ? { learnedTypical: round(data.learnedTypical) } : {}),
    ...(data.hasBaseline && data.maxExcess !== undefined ? { maxExcessSpreads: round(data.maxExcess) } : {}),
    ...(data.hasBaseline && data.framesDuring ? {
      duringFramesAboveUsualPct: round((100 * data.framesDuringAnyAbove) / data.framesDuring),
      typicalBandAboveUsualPct: round((100 * data.shareAboveSum) / data.framesDuring, 2),
      maxBandAboveUsualPct: round(100 * data.shareAboveMax, 2),
    } : {}),
    ...(modePixel >= 0 ? { mostFrequentPeakMHz: round(pixelHz(data, modePixel) / 1e6, 4) } : {}),
    ...(stablePct !== undefined ? { peakStablePct: round(stablePct), peakStaysWithinKHz: round(2.5 * pixelWidthKHz, 1) } : {}),
    ...(spreadKHz !== undefined ? { peakSpreadKHz: round(spreadKHz, 1) } : {}),
    windowCentreMHz: round(centreHz / 1e6, 4),
    peakAtWindowCentre: peakAtCentre,
    ...(data.alertSigma !== undefined && data.framesDuring ? {
      alertSigma: data.alertSigma,
      duringFramesAboveAlertPct: round((100 * data.framesDuringAnyAboveAlert) / data.framesDuring),
      typicalBandAboveAlertPct: round((100 * data.alertShareSum) / data.framesDuring, 2),
      maxBandAboveAlertPct: round(100 * data.alertShareMax, 2),
    } : {}),
    ...(data.framesBefore < MIN_COMPARISON_FRAMES ? { fewFramesBefore: true } : {}),
  };

  const findings: string[] = [];
  if (!data.framesDuring) {
    findings.push("No frames were recorded for this window during the incident, so no level analysis can be given.");
    return { stats, findings };
  }
  findings.push(`The incident lasted ${stats.incidentSeconds} s and ${data.framesDuring} frames were recorded during it (${data.framesBefore} before and ${data.framesAfter} after).`);
  if (stats.strongestLevel !== undefined) {
    findings.push(`The strongest level was ${stats.strongestLevel} (relative, 0 to 255) at ${stats.strongestMHz} MHz at ${utc(data.strongest!.atMs, true)} UTC.`);
  }
  if (stats.typicalDuring !== undefined) {
    const parts = [`The typical level across the band was ${stats.typicalDuring} during the incident`];
    if (stats.typicalBefore !== undefined) parts.push(`${stats.typicalBefore} before it`);
    if (stats.learnedTypical !== undefined) parts.push(`${stats.learnedTypical} learned as normal`);
    const caveat = stats.typicalBefore !== undefined && stats.fewFramesBefore
      ? ` Only ${data.framesBefore} frame${data.framesBefore === 1 ? " was" : "s were"} recorded before the incident, so the before-and-during comparison is weak.`
      : "";
    findings.push(`${parts.join(", ")}.${caveat}`);
  }
  if (data.hasBaseline && stats.duringFramesAboveAlertPct !== undefined) {
    findings.push(`Measured on the recorded frames, ${stats.duringFramesAboveAlertPct}% of the incident frames had some part of the band at or above the alert level (${stats.alertSigma}× normal variation); typically ${stats.typicalBandAboveAlertPct}% of the band and at most ${stats.maxBandAboveAlertPct}% at once.`);
  }
  if (data.hasBaseline && stats.duringFramesAboveUsualPct !== undefined) {
    findings.push(`In ${stats.duringFramesAboveUsualPct}% of the incident frames some part of the band was above its usual range (${ABOVE_USUAL_SPREADS}× normal variation, a looser measure than the alert level); typically ${stats.typicalBandAboveUsualPct}% of the band and at most ${stats.maxBandAboveUsualPct}% at once. The largest excess was ${stats.maxExcessSpreads} usual spreads above the learned level.`);
  } else if (!data.hasBaseline) {
    findings.push("No learned normal level is available for this window, so how far the signal was above normal cannot be shown.");
  }
  if (stats.peakStablePct !== undefined && stats.mostFrequentPeakMHz !== undefined) {
    if (stats.peakStablePct >= 80) {
      findings.push(`The strongest signal stayed within about ±${stats.peakStaysWithinKHz} kHz of ${stats.mostFrequentPeakMHz} MHz in ${stats.peakStablePct}% of the incident frames, which is the pattern of a fixed-frequency feature.`);
    } else {
      findings.push(`The strongest signal moved: 90% of its positions lay within a ${stats.peakSpreadKHz} kHz range, and only ${stats.peakStablePct}% of frames had it within about ±${stats.peakStaysWithinKHz} kHz of ${stats.mostFrequentPeakMHz} MHz.`);
    }
    if (peakAtCentre) {
      findings.push(`That frequency is the centre of the capture window (${stats.windowCentreMHz} MHz). A fixed spike at the window centre can also come from the receiver itself, so compare it with quiet periods before relying on it.`);
    }
  }
  return { stats, findings };
}

// ---- Charts ----------------------------------------------------------------------------------

interface Box { x: number; y: number; w: number; h: number }

const INK = "#142536";
const MUTED = "#5a6876";
const GRID = "#dfe4e9";
const RED = "#df0b0b";
const BLUE = "#1766ae";
const GREEN = "#15963d";
const GREY = "#8793a0";

function rowTimeMs(data: AnalysisData, row: number): number {
  return data.windowStartMs + (data.rows - 1 - row + 0.5) * data.rowMs;
}

function frame(box: Box, title: string, subtitle: string): string {
  return [
    `<text x="${box.x}" y="${box.y - 24}" font-size="14" font-weight="700" fill="${INK}">${xml(title)}</text>`,
    `<text x="${box.x}" y="${box.y - 9}" font-size="10.5" fill="${MUTED}">${xml(subtitle)}</text>`,
    `<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="#f7f9fa" stroke="#cbd2d9"/>`,
  ].join("");
}

function timeAxis(data: AnalysisData, box: Box): string {
  const span = Math.max(1, data.windowEndMs - data.windowStartMs);
  const long = span > 20 * 3_600_000 || utc(data.windowStartMs, true).slice(0, 10) !== utc(data.windowEndMs, true).slice(0, 10);
  const x = (ms: number) => box.x + ((ms - data.windowStartMs) / span) * box.w;
  const out: string[] = [];
  for (const tick of timeTicks(data.windowStartMs, data.windowEndMs, 8)) {
    out.push(`<line x1="${x(tick).toFixed(1)}" x2="${x(tick).toFixed(1)}" y1="${box.y}" y2="${box.y + box.h}" stroke="${GRID}"/>`);
    out.push(`<text x="${x(tick).toFixed(1)}" y="${box.y + box.h + 15}" font-size="9.5" text-anchor="middle" fill="${MUTED}">${xml(utc(tick, long))}</text>`);
  }
  out.push(`<text x="${box.x + box.w}" y="${box.y + box.h + 29}" font-size="10" text-anchor="end" fill="${MUTED}">UTC</text>`);
  // The incident itself.
  const start = Math.max(data.windowStartMs, data.incidentStartMs);
  const end = Math.min(data.windowEndMs, data.incidentEndMs);
  if (end > start) {
    out.unshift(`<rect x="${x(start).toFixed(1)}" y="${box.y}" width="${Math.max(1, x(end) - x(start)).toFixed(1)}" height="${box.h}" fill="${RED}" fill-opacity="0.07"/>`);
    out.push(`<line x1="${x(start).toFixed(1)}" x2="${x(start).toFixed(1)}" y1="${box.y}" y2="${box.y + box.h}" stroke="${RED}" stroke-dasharray="6 4"/>`);
    out.push(`<line x1="${x(end).toFixed(1)}" x2="${x(end).toFixed(1)}" y1="${box.y}" y2="${box.y + box.h}" stroke="${RED}" stroke-dasharray="6 4"/>`);
    out.push(`<text x="${(x(start) + 4).toFixed(1)}" y="${box.y + 12}" font-size="10" font-weight="700" fill="#b80000">incident</text>`);
  }
  return out.join("");
}

function yAxis(box: Box, min: number, max: number, ticks: number[], label: string, format: (value: number) => string = String): string {
  const y = (value: number) => box.y + box.h - ((value - min) / Math.max(1e-9, max - min)) * box.h;
  const out = ticks.map((tick) => `<line x1="${box.x}" x2="${box.x + box.w}" y1="${y(tick).toFixed(1)}" y2="${y(tick).toFixed(1)}" stroke="${GRID}"/><text x="${box.x - 7}" y="${(y(tick) + 3.5).toFixed(1)}" font-size="9.5" text-anchor="end" fill="${MUTED}">${xml(format(tick))}</text>`);
  out.push(`<text x="${box.x - 52}" y="${box.y + box.h / 2}" font-size="10" fill="${MUTED}" transform="rotate(-90 ${box.x - 52} ${box.y + box.h / 2})" text-anchor="middle">${xml(label)}</text>`);
  return out.join("");
}

function legend(items: Array<[string, string, string?]>, x: number, y: number): string {
  return items.map(([text, colour, dash], index) => {
    const offset = x + index * 270;
    return `<line x1="${offset}" x2="${offset + 20}" y1="${y - 4}" y2="${y - 4}" stroke="${colour}" stroke-width="2.5"${dash ? ` stroke-dasharray="${dash}"` : ""}/><text x="${offset + 26}" y="${y}" font-size="10" fill="${INK}">${xml(text)}</text>`;
  }).join("");
}

function noData(box: Box, text: string): string {
  return `<text x="${box.x + box.w / 2}" y="${box.y + box.h / 2}" font-size="13" text-anchor="middle" fill="#8a5a00">${xml(text)}</text>`;
}

function levelOverTime(data: AnalysisData, box: Box): string {
  const span = Math.max(1, data.windowEndMs - data.windowStartMs);
  const x = (ms: number) => box.x + ((ms - data.windowStartMs) / span) * box.w;
  const y = (level: number) => box.y + box.h - (level / 255) * box.h;
  const line = (values: ArrayLike<number>, colour: string, width: number) => {
    const points: string[] = [];
    for (let row = data.rows - 1; row >= 0; row -= 1) if (data.rowFilled[row]) points.push(`${x(rowTimeMs(data, row)).toFixed(1)},${y(values[row]).toFixed(1)}`);
    return points.length > 1 ? `<polyline fill="none" stroke="${colour}" stroke-width="${width}" points="${points.join(" ")}"/>` : "";
  };
  const out = [frame(box, "Signal level over time", "Strongest level and typical level across the band, per time step (relative, 0 to 255)"), yAxis(box, 0, 255, [0, 64, 128, 192, 255], "Relative level"), timeAxis(data, box)];
  if (data.learnedTypical !== undefined && data.learnedHigh !== undefined && data.learnedLow !== undefined) {
    out.push(`<rect x="${box.x}" y="${y(data.learnedHigh).toFixed(1)}" width="${box.w}" height="${Math.max(1, y(data.learnedLow) - y(data.learnedHigh)).toFixed(1)}" fill="${GREEN}" fill-opacity="0.14"/>`);
    out.push(`<line x1="${box.x}" x2="${box.x + box.w}" y1="${y(data.learnedTypical).toFixed(1)}" y2="${y(data.learnedTypical).toFixed(1)}" stroke="${GREEN}" stroke-width="1.5" stroke-dasharray="5 3"/>`);
  }
  out.push(line(data.rowTypical, BLUE, 1.6), line(data.rowPeakLevel, RED, 1.4));
  out.push(legend([["Strongest level in the band", RED], ["Typical level across the band", BLUE], ["Learned normal (shaded: usual range)", GREEN, "5 3"]], box.x, box.y + box.h + 44));
  if (!data.framesDuring && !data.framesBefore && !data.framesAfter) out.push(noData(box, "No frames were available to draw."));
  return out.join("");
}

function excessOverTime(data: AnalysisData, box: Box): string {
  const out = [frame(box, "How far above normal", "Strongest excess over the learned level, in usual spreads (1 spread = the normal variation of that frequency)")];
  if (!data.hasBaseline) return `${out.join("")}${noData(box, "No learned normal level is available for this window.")}`;
  let top = 6;
  for (let row = 0; row < data.rows; row += 1) if (data.rowFilled[row] && data.rowExcess[row] > top) top = data.rowExcess[row];
  top = Math.ceil((top * 1.08) / 5) * 5;
  const y = (value: number) => box.y + box.h - (Math.max(0, Math.min(top, value)) / top) * box.h;
  const span = Math.max(1, data.windowEndMs - data.windowStartMs);
  const x = (ms: number) => box.x + ((ms - data.windowStartMs) / span) * box.w;
  const tickStep = top <= 10 ? 2 : top <= 30 ? 5 : top <= 60 ? 10 : 20;
  const ticks = Array.from({ length: Math.floor(top / tickStep) + 1 }, (_, index) => index * tickStep);
  out.push(yAxis(box, 0, top, ticks, "Usual spreads above normal"), timeAxis(data, box));
  out.push(`<line x1="${box.x}" x2="${box.x + box.w}" y1="${y(ABOVE_USUAL_SPREADS).toFixed(1)}" y2="${y(ABOVE_USUAL_SPREADS).toFixed(1)}" stroke="${GREEN}" stroke-width="1.3" stroke-dasharray="5 3"/>`);
  out.push(`<text x="${box.x + box.w - 4}" y="${(y(ABOVE_USUAL_SPREADS) - 4).toFixed(1)}" font-size="9.5" text-anchor="end" fill="${GREEN}">usual range ends at ${ABOVE_USUAL_SPREADS}</text>`);
  const points: string[] = [];
  for (let row = data.rows - 1; row >= 0; row -= 1) if (data.rowFilled[row]) points.push(`${x(rowTimeMs(data, row)).toFixed(1)},${y(data.rowExcess[row]).toFixed(1)}`);
  if (points.length > 1) out.push(`<polyline fill="none" stroke="${RED}" stroke-width="1.5" points="${points.join(" ")}"/>`);
  out.push(legend([["Strongest excess over the learned level", RED], ["End of the usual range", GREEN, "5 3"]], box.x, box.y + box.h + 44));
  return out.join("");
}

function peakTrack(data: AnalysisData, box: Box): string {
  const palette = buildWaterfallPalette();
  const out = [frame(box, "Where the strongest signal was", "Frequency of the strongest point in each time step. A flat line means a fixed frequency; a wandering line means it moved. Colour shows its level.")];
  const spanHz = data.analysisEndHz - data.analysisStartHz;
  const y = (hz: number) => box.y + box.h - ((hz - data.analysisStartHz) / Math.max(1, spanHz)) * box.h;
  const span = Math.max(1, data.windowEndMs - data.windowStartMs);
  const x = (ms: number) => box.x + ((ms - data.windowStartMs) / span) * box.w;
  out.push(timeAxis(data, box));
  for (const hz of frequencyTicks(data.analysisStartHz, data.analysisEndHz, 6)) {
    out.push(`<line x1="${box.x}" x2="${box.x + box.w}" y1="${y(hz).toFixed(1)}" y2="${y(hz).toFixed(1)}" stroke="${GRID}"/><text x="${box.x - 7}" y="${(y(hz) + 3.5).toFixed(1)}" font-size="9.5" text-anchor="end" fill="${MUTED}">${(hz / 1e6).toFixed(3)}</text>`);
  }
  out.push(`<text x="${box.x - 62}" y="${box.y + box.h / 2}" font-size="10" fill="${MUTED}" transform="rotate(-90 ${box.x - 62} ${box.y + box.h / 2})" text-anchor="middle">Frequency (MHz)</text>`);
  const centre = (data.analysisStartHz + data.analysisEndHz) / 2;
  out.push(`<line x1="${box.x}" x2="${box.x + box.w}" y1="${y(centre).toFixed(1)}" y2="${y(centre).toFixed(1)}" stroke="${INK}" stroke-opacity="0.45" stroke-dasharray="2 4"/>`);
  out.push(`<text x="${box.x + box.w - 4}" y="${(y(centre) - 4).toFixed(1)}" font-size="9.5" text-anchor="end" fill="${MUTED}">window centre</text>`);
  let drawn = 0;
  for (let row = data.rows - 1; row >= 0; row -= 1) {
    if (!data.rowFilled[row] || data.rowPeakPixel[row] < 0) continue;
    const bytes = new Uint8Array(new Uint32Array([palette.plain[data.rowPeakLevel[row]]]).buffer);
    const hz = data.analysisStartHz + ((data.rowPeakPixel[row] + 0.5) / data.widthPx) * spanHz;
    out.push(`<circle cx="${x(rowTimeMs(data, row)).toFixed(1)}" cy="${y(hz).toFixed(1)}" r="3" fill="rgb(${bytes[0]},${bytes[1]},${bytes[2]})" stroke="#142536" stroke-opacity="0.5" stroke-width="0.6"/>`);
    drawn += 1;
  }
  if (!drawn) out.push(noData(box, "No frames were available to draw."));
  return out.join("");
}

function exceedanceByFrequency(data: AnalysisData, box: Box): string {
  const out = [frame(box, "Which frequencies were above normal, and how often", "Share of frames in which each frequency was above its usual range")];
  if (!data.hasBaseline) return `${out.join("")}${noData(box, "No learned normal level is available for this window.")}`;
  const x = (pixel: number) => box.x + ((pixel + 0.5) / data.widthPx) * box.w;
  const y = (percent: number) => box.y + box.h - (percent / 100) * box.h;
  out.push(yAxis(box, 0, 100, [0, 25, 50, 75, 100], "Share of frames (%)", (value) => `${value}%`));
  for (const hz of frequencyTicks(data.analysisStartHz, data.analysisEndHz, 8)) {
    const px = box.x + ((hz - data.analysisStartHz) / Math.max(1, data.analysisEndHz - data.analysisStartHz)) * box.w;
    out.push(`<text x="${px.toFixed(1)}" y="${box.y + box.h + 15}" font-size="9.5" text-anchor="middle" fill="${MUTED}">${(hz / 1e6).toFixed(3)}</text>`);
  }
  out.push(`<text x="${box.x + box.w}" y="${box.y + box.h + 29}" font-size="10" text-anchor="end" fill="${MUTED}">MHz</text>`);
  const area = (values: Float32Array) => {
    const points = [`${box.x},${box.y + box.h}`];
    for (let pixel = 0; pixel < data.widthPx; pixel += 1) points.push(`${x(pixel).toFixed(1)},${y(values[pixel]).toFixed(1)}`);
    points.push(`${box.x + box.w},${box.y + box.h}`);
    return points.join(" ");
  };
  if (data.framesBefore) out.push(`<polyline fill="none" stroke="${GREY}" stroke-width="1.3" points="${area(data.aboveBeforePct).split(" ").slice(1, -1).join(" ")}"/>`);
  if (data.framesDuring) {
    out.push(`<polygon fill="${RED}" fill-opacity="0.22" stroke="none" points="${area(data.aboveDuringPct)}"/>`);
    out.push(`<polyline fill="none" stroke="${RED}" stroke-width="1.4" points="${area(data.aboveDuringPct).split(" ").slice(1, -1).join(" ")}"/>`);
  } else out.push(noData(box, "No frames were recorded during the incident."));
  out.push(legend([["During the incident", RED], ["Before the incident", GREY]], box.x, box.y + box.h + 44));
  return out.join("");
}

export interface AnalysisChartSet {
  /** All charts, the key numbers and the findings on one sheet. */
  sheetSvg: string;
  charts: Array<{ id: string; file: string; title: string; svg: string }>;
  /** The same four charts as data, for the HTML and PDF report renderers. */
  specs: ChartSpec[];
  stats: AnalysisStats;
  findings: string[];
}

function rowPoints(data: AnalysisData, values: ArrayLike<number>, include: (row: number) => boolean = () => true): ChartPoint[] {
  const points: ChartPoint[] = [];
  let previousFilled = false;
  for (let row = data.rows - 1; row >= 0; row -= 1) {
    if (data.rowFilled[row] && include(row)) {
      points.push([rowTimeMs(data, row), values[row]]);
      previousFilled = true;
    } else if (previousFilled) {
      // A row with no frames is a gap, never interpolated.
      points.push(null);
      previousFilled = false;
    }
  }
  return points;
}

function incidentRegion(data: AnalysisData) {
  const start = Math.max(data.windowStartMs, data.incidentStartMs);
  const end = Math.min(data.windowEndMs, data.incidentEndMs);
  return end > start ? [{ from: start, to: end, color: REPORT_COLORS.incident, opacity: 0.07, label: "Incident" }] : [];
}

/** The four analysis charts as data. Axes scale to the recorded values; gaps stay gaps. */
export function analysisChartSpecs(data: AnalysisData): ChartSpec[] {
  const timeAxis = { label: "Time (UTC)", min: data.windowStartMs, max: data.windowEndMs, ticks: timeAxisTicks(data.windowStartMs, data.windowEndMs, 7) };
  const incidentRules = [
    ...(data.incidentStartMs >= data.windowStartMs ? [{ value: data.incidentStartMs, color: REPORT_COLORS.incident, dash: [6, 4], label: "Start" }] : []),
    ...(data.incidentEndMs <= data.windowEndMs ? [{ value: data.incidentEndMs, color: REPORT_COLORS.incident, dash: [6, 4], label: "End" }] : []),
  ];
  const anyFrames = data.framesDuring + data.framesBefore + data.framesAfter > 0;

  // 1. Level over time
  const levels: number[] = [];
  for (let row = 0; row < data.rows; row += 1) if (data.rowFilled[row]) levels.push(data.rowPeakLevel[row], data.rowTypical[row]);
  if (data.learnedHigh !== undefined) levels.push(data.learnedHigh);
  if (data.learnedLow !== undefined) levels.push(data.learnedLow);
  const [levelMin, levelMax] = levelRange(levels);
  const levelSpec: ChartSpec = {
    id: "level-over-time",
    title: "Signal level over time",
    caption: "Strongest point (red) and typical level (blue) across the window in each time step. Green: learned usual range. Gaps mean no frames were recorded.",
    ariaLabel: "Line chart of the strongest and typical relative level over time against the learned usual range.",
    width: 960,
    height: 320,
    x: timeAxis,
    y: { label: "Relative level (0–255)", min: levelMin, max: levelMax, ticks: numericTicks(levelMin, levelMax, 5, (value) => String(Math.round(value))) },
    series: [
      ...(data.learnedHigh !== undefined && data.learnedLow !== undefined
        ? [{ kind: "band" as const, name: "Usual range", color: REPORT_COLORS.usual, opacity: 0.12, upper: [[data.windowStartMs, data.learnedHigh], [data.windowEndMs, data.learnedHigh]] as ChartPoint[], lower: [[data.windowStartMs, data.learnedLow], [data.windowEndMs, data.learnedLow]] as ChartPoint[] }]
        : []),
      ...(data.learnedTypical !== undefined ? [{ kind: "line" as const, name: "Learned usual level", color: REPORT_COLORS.usual, dash: [5, 3], width: 1.4, points: [[data.windowStartMs, data.learnedTypical], [data.windowEndMs, data.learnedTypical]] as ChartPoint[] }] : []),
      { kind: "line", name: "Typical level", color: REPORT_COLORS.received, width: 1.6, points: rowPoints(data, data.rowTypical) },
      { kind: "line", name: "Strongest point", color: REPORT_COLORS.anomaly, width: 1.4, points: rowPoints(data, data.rowPeakLevel) },
    ],
    xRegions: incidentRegion(data),
    vRules: incidentRules,
    legend: [
      { name: "Strongest point", color: REPORT_COLORS.anomaly, style: "line" },
      { name: "Typical level", color: REPORT_COLORS.received, style: "line" },
      ...(data.learnedTypical !== undefined ? [{ name: "Learned usual level and range", color: REPORT_COLORS.usual, style: "dash" as const }] : []),
    ],
    ...(anyFrames ? {} : { emptyMessage: "No frames were available to draw." }),
  };

  // 2. Excess over the learned level
  let topExcess = Math.max(6, (data.alertSigma ?? 0) * 1.3);
  for (let row = 0; row < data.rows; row += 1) if (data.rowFilled[row] && data.rowExcess[row] > topExcess) topExcess = data.rowExcess[row];
  topExcess = Math.ceil((topExcess * 1.08) / 5) * 5;
  const excessSpec: ChartSpec = {
    id: "excess-over-time",
    title: "How far above normal",
    caption: "Strongest excess over the learned level, in multiples of that frequency's normal variation. Above the amber line is above the alert level.",
    ariaLabel: "Line chart of the strongest excess over the learned level over time, with the alert level and the end of the usual range marked.",
    width: 960,
    height: 300,
    x: timeAxis,
    y: { label: "× normal variation", min: 0, max: topExcess, ticks: numericTicks(0, topExcess, 5, (value) => String(Math.round(value))) },
    series: data.hasBaseline ? [{ kind: "line", name: "Strongest excess", color: REPORT_COLORS.anomaly, width: 1.5, points: rowPoints(data, data.rowExcess, (row) => data.rowExcess[row] >= 0) }] : [],
    xRegions: incidentRegion(data),
    hRules: data.hasBaseline ? [
      { value: ABOVE_USUAL_SPREADS, color: REPORT_COLORS.usual, dash: [5, 3], label: `Usual range ends (${ABOVE_USUAL_SPREADS}×)` },
      ...(data.alertSigma !== undefined ? [{ value: data.alertSigma, color: REPORT_COLORS.alertLevel, dash: [6, 3], label: `Alert level (${data.alertSigma}×)` }] : []),
    ] : [],
    vRules: incidentRules,
    legend: [
      { name: "Strongest excess", color: REPORT_COLORS.anomaly, style: "line" },
      ...(data.alertSigma !== undefined ? [{ name: "Alert level", color: REPORT_COLORS.alertLevel, style: "dash" as const }] : []),
      { name: "End of usual range", color: REPORT_COLORS.usual, style: "dash" },
    ],
    ...(data.hasBaseline ? {} : { emptyMessage: "No learned normal level is available for this window." }),
  };

  // 3. Where the strongest point was
  const spanHz = data.analysisEndHz - data.analysisStartHz;
  const peakPoints: ChartPoint[] = [];
  const peakColors: string[] = [];
  for (let row = data.rows - 1; row >= 0; row -= 1) {
    if (!data.rowFilled[row] || data.rowPeakPixel[row] < 0) continue;
    peakPoints.push([rowTimeMs(data, row), data.analysisStartHz + ((data.rowPeakPixel[row] + 0.5) / data.widthPx) * spanHz]);
    const [r, g, b] = waterfallRgb(data.rowPeakLevel[row]);
    peakColors.push(`#${[r, g, b].map((value) => value.toString(16).padStart(2, "0")).join("")}`);
  }
  const centre = (data.analysisStartHz + data.analysisEndHz) / 2;
  const peakSpec: ChartSpec = {
    id: "strongest-frequency",
    title: "Where the strongest signal was",
    caption: "Frequency of the strongest point in each time step. A flat track means a fixed frequency; a wandering track means it moved. Colour shows its level.",
    ariaLabel: "Scatter chart of the frequency of the strongest point over time.",
    width: 960,
    height: 300,
    x: timeAxis,
    y: { label: "Frequency (MHz)", min: data.analysisStartHz, max: data.analysisEndHz, ticks: frequencyAxisTicks(data.analysisStartHz, data.analysisEndHz, 5) },
    series: [{ kind: "points", name: "Strongest point", color: REPORT_COLORS.received, radius: 2.6, points: peakPoints, colors: peakColors }],
    xRegions: incidentRegion(data),
    hRules: [{ value: centre, color: REPORT_COLORS.faint, dash: [2, 4], label: "Window centre" }],
    vRules: incidentRules,
    legend: [{ name: "Strongest point (colour = level)", color: REPORT_COLORS.received, style: "line" }],
    ...(peakPoints.length ? {} : { emptyMessage: "No frames were available to draw." }),
  };

  // 4. Which frequencies were above the alert level (or the usual range)
  const useAlert = data.alertSigma !== undefined && data.aboveAlertDuringPct !== undefined;
  const during = useAlert ? data.aboveAlertDuringPct! : data.aboveDuringPct;
  const before = useAlert ? data.aboveAlertBeforePct! : data.aboveBeforePct;
  const pixelHzAt = (pixel: number) => data.analysisStartHz + ((pixel + 0.5) / data.widthPx) * spanHz;
  const exceedSpec: ChartSpec = {
    id: "above-normal-by-frequency",
    title: useAlert ? "Which frequencies were above the alert level" : "Which frequencies were above normal",
    caption: useAlert
      ? `Share of frames in which each frequency was at or above the alert level (${data.alertSigma}× normal variation). Red: during the incident. Grey: before it.`
      : "Share of frames in which each frequency was above its usual range. Red: during the incident. Grey: before it.",
    ariaLabel: "Area chart of how often each frequency was above the level, during and before the incident.",
    width: 960,
    height: 300,
    x: { label: "Frequency (MHz)", min: data.analysisStartHz, max: data.analysisEndHz, ticks: frequencyAxisTicks(data.analysisStartHz, data.analysisEndHz, 8) },
    y: { label: "Share of frames (%)", min: 0, max: 100, ticks: numericTicks(0, 100, 4, (value) => `${value}%`) },
    series: data.hasBaseline ? [
      ...(data.framesDuring ? [
        { kind: "area" as const, name: "During", color: REPORT_COLORS.anomaly, opacity: 0.2, points: Array.from(during, (value, pixel): ChartPoint => [pixelHzAt(pixel), value]) },
        { kind: "line" as const, name: "During", color: REPORT_COLORS.anomaly, width: 1.4, points: Array.from(during, (value, pixel): ChartPoint => [pixelHzAt(pixel), value]) },
      ] : []),
      ...(data.framesBefore ? [{ kind: "line" as const, name: "Before", color: REPORT_COLORS.before, width: 1.3, points: Array.from(before, (value, pixel): ChartPoint => [pixelHzAt(pixel), value]) }] : []),
    ] : [],
    legend: [
      { name: "During the incident", color: REPORT_COLORS.anomaly, style: "area" },
      { name: "Before the incident", color: REPORT_COLORS.before, style: "line" },
    ],
    ...(!data.hasBaseline ? { emptyMessage: "No learned normal level is available for this window." } : !data.framesDuring ? { emptyMessage: "No frames were recorded during the incident." } : {}),
  };
  return [levelSpec, excessSpec, peakSpec, exceedSpec];
}

/** Draws the analysis charts. Each chart is also a standalone, time-stamped SVG. */
export function renderAnalysisCharts(data: AnalysisData, meta: { label: string; incidentId: string; generatedAtMs: number; alertSigma?: number }): AnalysisChartSet {
  const { stats, findings } = describeAnalysis(data);
  const left = 90;
  const right = 30;
  const width = 1120;
  const innerWidth = width - left - right;
  const chartHeight = 230;
  const footer = (y: number, includeSource: boolean) => [
    `Figure generated ${utc(meta.generatedAtMs, true)} UTC. Data window ${utc(data.windowStartMs, true)} to ${utc(data.windowEndMs, true)} UTC.`,
    "Relative, uncalibrated levels. RF data can show interference, not intent. Derived from the recorded frames in this package; the frames are the evidence.",
    ...(includeSource ? [`Each time step covers about ${Math.max(1, round(data.rowMs / 1000, 1))} s and shows the strongest value in it. Above usual = more than ${ABOVE_USUAL_SPREADS} usual spreads over the learned level.`] : []),
  ].map((line, index) => `<text x="${left}" y="${y + index * 16}" font-size="10" fill="#34536f">${xml(line)}</text>`).join("");
  const wrap = (heightPx: number, body: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${heightPx}" viewBox="0 0 ${width} ${heightPx}" font-family="Arial, Helvetica, sans-serif" role="img"><rect width="${width}" height="${heightPx}" fill="#ffffff"/>${body}</svg>`;

  const definitions: Array<{ id: string; file: string; title: string; draw: (box: Box) => string }> = [
    { id: "level-over-time", file: "figures/chart-level-over-time.svg", title: "Signal level over time", draw: (box) => levelOverTime(data, box) },
    { id: "excess-over-time", file: "figures/chart-excess-over-time.svg", title: "How far above normal", draw: (box) => excessOverTime(data, box) },
    { id: "strongest-frequency", file: "figures/chart-strongest-frequency.svg", title: "Where the strongest signal was", draw: (box) => peakTrack(data, box) },
    { id: "above-normal-by-frequency", file: "figures/chart-above-normal-by-frequency.svg", title: "Which frequencies were above normal", draw: (box) => exceedanceByFrequency(data, box) },
  ];
  const specs = analysisChartSpecs(data);
  const standaloneFooter = [
    `${plain(meta.label)} · incident ${meta.incidentId} · ${utc(data.incidentStartMs, true)} to ${utc(data.incidentEndMs, true)} UTC.`,
    `Figure generated ${utc(meta.generatedAtMs, true)} UTC. Data window ${utc(data.windowStartMs, true)} to ${utc(data.windowEndMs, true)} UTC.`,
    "Relative, uncalibrated levels. RF data can show interference, not intent. Derived from the recorded frames in this package; the frames are the evidence.",
  ];
  const charts = definitions.map((definition) => {
    const spec = specs.find((candidate) => candidate.id === definition.id)!;
    return { id: definition.id, file: definition.file, title: definition.title, svg: chartToSvg({ ...spec, footer: standaloneFooter }, { standalone: true, idPrefix: "analysis" }) };
  });

  // The combined sheet: key numbers and findings first, then every chart.
  const sheetParts: string[] = [];
  sheetParts.push(`<text x="${left}" y="34" font-size="20" font-weight="700" fill="${INK}">Incident analysis: ${xml(plain(meta.label))}</text>`);
  sheetParts.push(`<text x="${left}" y="54" font-size="11" fill="${MUTED}">Incident ${xml(meta.incidentId)} · figure generated ${xml(utc(meta.generatedAtMs, true))} UTC</text>`);
  let cursor = 84;
  sheetParts.push(`<text x="${left}" y="${cursor}" font-size="14" font-weight="700" fill="${INK}">What the recorded frames show</text>`);
  cursor += 8;
  for (const finding of findings) {
    const lines = wrapText(plain(finding), 150);
    for (const line of lines) {
      cursor += 17;
      sheetParts.push(`<text x="${left + 8}" y="${cursor}" font-size="12" fill="${INK}">${xml(line)}</text>`);
    }
    cursor += 5;
  }
  cursor += 40;
  for (const definition of definitions) {
    const box = { x: left, y: cursor, w: innerWidth, h: chartHeight };
    sheetParts.push(definition.draw(box));
    cursor += chartHeight + 44 + 70;
  }
  sheetParts.push(footer(cursor, true));
  const sheetSvg = wrap(cursor + 60, sheetParts.join(""));
  return { sheetSvg, charts, specs, stats, findings };
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > width) {
      lines.push(current);
      current = word;
    } else current = (current + " " + word).trim();
  }
  if (current) lines.push(current);
  return lines;
}
