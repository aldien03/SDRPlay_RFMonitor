/**
 * RF interference analysis for the DGNSS report, computed in one streaming
 * pass with bounded memory (a 24 h window can hold about a million frames):
 * per capture window, frame classes (rf-monitor Standard alert rules),
 * interference episodes, time-bucketed signal series, per-second excess for
 * the navigation relationship, a time x frequency waterfall and spectrum
 * profiles. Levels are relative and uncalibrated; dBm/SNR are SDRconnect-reported.
 */
import { waterfallRgb } from "../../shared/waterfallRaster";
import { encodePng } from "../incidentFigure";
import { percentile, type PositioningAnalysis } from "./analysis";
import type { RfFrame } from "./rfEvidence";
import type { ReportWindow, RfEvidence, RfLane, RfLaneInterval } from "./types";

export type RfFrameClass = "clear" | "narrowband" | "partial-band" | "wideband" | "noise-floor";
export type RfEpisodeType = Exclude<RfFrameClass, "clear">;
export type RfFrameMetrics = Omit<RfFrame, "bins">;
export type BinsLoader = () => Promise<Uint8Array | undefined>;

export const RF_TYPE_LABEL: Record<RfEpisodeType, string> = {
  wideband: "Wideband",
  "partial-band": "Partial-band",
  "noise-floor": "Noise-floor rise",
  narrowband: "Narrowband (CW-like)",
};

/** rf-monitor Standard alert preset, applied per frame and voted k of n. */
export const RF_RULES = {
  widebandOccupancy: 0.35,
  partialWidth: 0.1,
  narrowbandPeakSigma: 10,
  noiseFloorSigma: 4,
  segmentSigma: 6,
  alertVisits: 3,
  alertWindow: 5,
  clearVisits: 10,
  maxGapMs: 30_000,
  coverageGapMs: 20_000,
} as const;

const BUCKETS = 900;
const WATERFALL_WIDTH = 600;
const WATERFALL_FRAMES_PER_COLUMN = 4;
const CLEAR_RESERVOIR = 300;
const VALUE_RESERVOIR = 2_000;
const MAX_EPISODE_BIN_READS = 4_000;

export interface RfLaneDefinition {
  id: string;
  label: string;
  shortLabel: string;
  service: "gnss" | "fugro";
  targetId: string;
}

export interface RfEpisode {
  id: string;
  laneId: string;
  laneLabel: string;
  shortLabel: string;
  fromMs: number;
  toMs: number;
  type: RfEpisodeType;
  frames: number;
  raisedFrames: number;
  peakZ: number;
  medianZ: number;
  occupiedMax: number;
  widthMHz?: number;
  centreMHz?: number;
  levelAboveUsual: number;
  powerRiseDb?: number;
  snrDropDb?: number;
  simulated: boolean;
}

/** Per time bucket; null where no frame was recorded. */
export interface RfBucketSeries {
  timeMs: number[];
  meanLevel: Array<number | null>;
  baseline: Array<number | null>;
  peakLevel: Array<number | null>;
  peakZ: Array<number | null>;
  medianZ: Array<number | null>;
  occupied: Array<number | null>;
  maxWidth: Array<number | null>;
  power: Array<number | null>;
}

export interface RfLaneAnalysis {
  definition: RfLaneDefinition;
  lane: RfLane;
  episodes: RfEpisode[];
  series: RfBucketSeries;
  /** Max peak excess per UTC second of the window (NaN = no frame). */
  secondPeakZ: Float32Array;
  /** 1 where a raised frame was recorded in that second. */
  secondRaised: Uint8Array;
  stats: {
    frames: number;
    monitoredFraction: number;
    usualLevel?: number;
    meanLevel?: number;
    peakZMax: number;
    occupiedMax: number;
    powerMedian?: number;
    powerMax?: number;
    snrMedian?: number;
    snrMin?: number;
    overloadFrames: number;
    raisedFrames: number;
  };
  analysisHz?: [number, number];
  waterfall?: { pngBase64: string; widthPx: number; heightPx: number };
  spectrum?: { hz: number[]; usual: number[]; alert: number[]; clearMax: number[]; episodeMax?: number[]; episodeMean?: number[]; episodeId?: string };
}

export function classifyFrame(frame: Pick<RfFrameMetrics, "occupied" | "maxWidth" | "medianZ" | "peakZ">): RfFrameClass {
  if (frame.occupied >= RF_RULES.widebandOccupancy) return "wideband";
  if (frame.maxWidth > RF_RULES.partialWidth) return "partial-band";
  if (frame.medianZ >= RF_RULES.noiseFloorSigma) return "noise-floor";
  if (frame.peakZ >= RF_RULES.narrowbandPeakSigma) return "narrowband";
  return "clear";
}

const SEVERITY: RfEpisodeType[] = ["wideband", "partial-band", "noise-floor", "narrowband"];

/** Deterministic reservoir so the same evidence always gives the same report. */
class Reservoir<T> {
  readonly items: T[] = [];
  private seen = 0;
  private seed = 0x2545f491;
  constructor(private readonly size: number) {}
  private random(): number {
    this.seed ^= this.seed << 13;
    this.seed ^= this.seed >>> 17;
    this.seed ^= this.seed << 5;
    return (this.seed >>> 0) / 0x100000000;
  }
  /** Returns the slot to fill, or -1 when this item is not kept. */
  offer(): number {
    this.seen += 1;
    if (this.items.length < this.size) return this.items.length;
    const slot = Math.floor(this.random() * this.seen);
    return slot < this.size ? slot : -1;
  }
  put(slot: number, item: T): void {
    this.items[slot] = item;
  }
  add(item: T): void {
    const slot = this.offer();
    if (slot >= 0) this.put(slot, item);
  }
}

interface Geometry {
  startHz: number;
  endHz: number;
  length: number;
  analysisStartBin: number;
  analysisEndBin: number;
}

interface EpisodeState {
  fromMs: number;
  lastRaisedMs: number;
  frames: number;
  framesAtLastRaised: number;
  raised: number;
  classes: Map<RfEpisodeType, number>;
  peakZ: number;
  medianZ: number;
  occupied: number;
  levelAbove: number;
  powerMax?: number;
  snrMin?: number;
  binsMax?: Float32Array;
  binsSum?: Float64Array;
  binsCount: number;
  binReads: number;
  simulated: boolean;
  geometry?: Geometry;
}

interface PendingFrame {
  frame: RfFrameMetrics;
  cls: RfFrameClass;
  bins?: Uint8Array;
}

class LaneAccumulator {
  private frames = 0;
  private raisedFrames = 0;
  private overload = 0;
  private peakZMax = 0;
  private occupiedMax = 0;
  private readonly runs: Array<[number, number]> = [];
  private readonly recent: PendingFrame[] = [];
  private active?: EpisodeState;
  private clearRun = 0;
  private lastTimeMs?: number;
  private readonly closed: EpisodeState[] = [];
  private readonly bucketMs: number;
  private readonly bucket = {
    count: new Uint32Array(BUCKETS),
    meanSum: new Float64Array(BUCKETS),
    baseSum: new Float64Array(BUCKETS),
    peakLevel: new Float32Array(BUCKETS).fill(Number.NaN),
    peakZ: new Float32Array(BUCKETS).fill(Number.NaN),
    medianZ: new Float32Array(BUCKETS).fill(Number.NaN),
    occupied: new Float32Array(BUCKETS).fill(Number.NaN),
    maxWidth: new Float32Array(BUCKETS).fill(Number.NaN),
    powerSum: new Float64Array(BUCKETS),
    powerCount: new Uint32Array(BUCKETS),
  };
  readonly secondPeakZ: Float32Array;
  readonly secondRaised: Uint8Array;
  private readonly meanLevels = new Reservoir<number>(VALUE_RESERVOIR);
  private readonly baselines = new Reservoir<number>(VALUE_RESERVOIR);
  private readonly powers = new Reservoir<number>(VALUE_RESERVOIR);
  private readonly clearPowers = new Reservoir<number>(VALUE_RESERVOIR);
  private readonly snrs = new Reservoir<number>(VALUE_RESERVOIR);
  private readonly clearSnrs = new Reservoir<number>(VALUE_RESERVOIR);
  private powerMax?: number;
  private snrMin?: number;
  private readonly clearBins = new Reservoir<Uint8Array>(CLEAR_RESERVOIR);
  private geometry?: Geometry;
  private waterfallGrid?: Int16Array;
  private waterfallHeight = 0;
  private readonly columnSamples = new Uint8Array(WATERFALL_WIDTH);

  constructor(readonly definition: RfLaneDefinition, private readonly window: ReportWindow) {
    this.bucketMs = (window.endMs - window.startMs) / BUCKETS;
    const seconds = Math.min(86_400, Math.ceil((window.endMs - window.startMs) / 1000));
    this.secondPeakZ = new Float32Array(seconds).fill(Number.NaN);
    this.secondRaised = new Uint8Array(seconds);
  }

  async add(frame: RfFrameMetrics, loadBins: BinsLoader): Promise<void> {
    const { window } = this;
    if (frame.timeMs < window.startMs || frame.timeMs >= window.endMs) return;
    this.frames += 1;
    const cls = classifyFrame(frame);
    const raised = cls !== "clear";
    if (raised) this.raisedFrames += 1;
    if (frame.overload) this.overload += 1;
    this.peakZMax = Math.max(this.peakZMax, frame.peakZ);
    this.occupiedMax = Math.max(this.occupiedMax, frame.occupied);
    this.geometry ??= { startHz: frame.startHz, endHz: frame.endHz, length: 0, analysisStartBin: frame.analysisStartBin, analysisEndBin: frame.analysisEndBin };

    const last = this.runs.at(-1);
    // Frames can arrive slightly out of order; runs and episodes only ever extend forward.
    if (last && frame.timeMs - last[1] <= RF_RULES.coverageGapMs) last[1] = Math.max(last[1], frame.timeMs);
    else this.runs.push([frame.timeMs, frame.timeMs]);

    const b = Math.min(BUCKETS - 1, Math.floor((frame.timeMs - window.startMs) / this.bucketMs));
    const k = this.bucket;
    k.count[b] += 1;
    k.meanSum[b] += frame.meanLevel;
    k.baseSum[b] += frame.baselineLevel;
    const keepMax = (array: Float32Array, value: number) => {
      if (Number.isNaN(array[b]) || value > array[b]) array[b] = value;
    };
    keepMax(k.peakLevel, frame.peakLevel);
    keepMax(k.peakZ, frame.peakZ);
    keepMax(k.medianZ, frame.medianZ);
    keepMax(k.occupied, frame.occupied);
    keepMax(k.maxWidth, frame.maxWidth);
    if (frame.powerDbm !== undefined) {
      k.powerSum[b] += frame.powerDbm;
      k.powerCount[b] += 1;
    }

    const second = Math.floor((frame.timeMs - window.startMs) / 1000);
    if (second >= 0 && second < this.secondPeakZ.length) {
      if (Number.isNaN(this.secondPeakZ[second]) || frame.peakZ > this.secondPeakZ[second]) this.secondPeakZ[second] = frame.peakZ;
      if (raised) this.secondRaised[second] = 1;
    }

    this.meanLevels.add(frame.meanLevel);
    this.baselines.add(frame.baselineLevel);
    if (frame.powerDbm !== undefined) {
      this.powers.add(frame.powerDbm);
      if (!raised) this.clearPowers.add(frame.powerDbm);
      this.powerMax = Math.max(this.powerMax ?? -Infinity, frame.powerDbm);
    }
    if (frame.snrDb !== undefined) {
      this.snrs.add(frame.snrDb);
      if (!raised) this.clearSnrs.add(frame.snrDb);
      this.snrMin = Math.min(this.snrMin ?? Infinity, frame.snrDb);
    }

    // Raw bins only where needed: raised frames, a clear reservoir, a few frames per waterfall column.
    const column = Math.min(WATERFALL_WIDTH - 1, Math.floor(((frame.timeMs - window.startMs) / (window.endMs - window.startMs)) * WATERFALL_WIDTH));
    const clearSlot = raised ? -1 : this.clearBins.offer();
    const wantColumn = this.columnSamples[column] < WATERFALL_FRAMES_PER_COLUMN;
    const wantEpisode = raised && (this.active?.binReads ?? 0) < MAX_EPISODE_BIN_READS;
    let bins: Uint8Array | undefined;
    if (clearSlot >= 0 || wantColumn || wantEpisode) bins = await loadBins();
    if (bins) {
      this.geometry.length = bins.length;
      if (clearSlot >= 0) this.clearBins.put(clearSlot, bins);
      if (wantColumn || raised) this.paintColumn(column, bins);
    }

    // Episode voting: k of n raised frames; ends after n clear frames or a long gap.
    if (this.lastTimeMs !== undefined && frame.timeMs - this.lastTimeMs > RF_RULES.maxGapMs) {
      this.closeEpisode();
      this.recent.length = 0;
    }
    this.lastTimeMs = Math.max(this.lastTimeMs ?? frame.timeMs, frame.timeMs);
    const pending: PendingFrame = { frame, cls, bins };
    if (this.active) {
      this.addToEpisode(this.active, pending);
      if (raised) this.clearRun = 0;
      else if (++this.clearRun >= RF_RULES.clearVisits) this.closeEpisode();
    } else {
      this.recent.push(pending);
      if (this.recent.length > RF_RULES.alertWindow) this.recent.shift();
      if (this.recent.filter((entry) => entry.cls !== "clear").length >= RF_RULES.alertVisits) {
        const first = this.recent.findIndex((entry) => entry.cls !== "clear");
        const episode = this.newEpisode(Math.min(...this.recent.slice(first).map((entry) => entry.frame.timeMs)));
        for (const entry of this.recent.slice(first)) this.addToEpisode(episode, entry);
        this.active = episode;
        this.clearRun = 0;
        this.recent.length = 0;
      }
    }
  }

  private paintColumn(column: number, bins: Uint8Array): void {
    const geometry = this.geometry!;
    const first = geometry.analysisStartBin;
    const count = geometry.analysisEndBin - first;
    if (!this.waterfallGrid) {
      this.waterfallHeight = Math.ceil(count / 2);
      this.waterfallGrid = new Int16Array(WATERFALL_WIDTH * this.waterfallHeight).fill(-1);
    }
    this.columnSamples[column] = Math.min(255, this.columnSamples[column] + 1);
    for (let row = 0; row < this.waterfallHeight; row += 1) {
      const bin = first + row * 2;
      const value = Math.max(bins[bin] ?? 0, bins[bin + 1] ?? 0);
      const index = (this.waterfallHeight - 1 - row) * WATERFALL_WIDTH + column;
      if (value > this.waterfallGrid[index]) this.waterfallGrid[index] = value;
    }
  }

  private newEpisode(fromMs: number): EpisodeState {
    return { fromMs, lastRaisedMs: fromMs, frames: 0, framesAtLastRaised: 0, raised: 0, classes: new Map(), peakZ: 0, medianZ: 0, occupied: 0, levelAbove: -Infinity, binsCount: 0, binReads: 0, simulated: false };
  }

  private addToEpisode(episode: EpisodeState, entry: PendingFrame): void {
    const { frame, cls, bins } = entry;
    episode.frames += 1;
    episode.peakZ = Math.max(episode.peakZ, frame.peakZ);
    episode.medianZ = Math.max(episode.medianZ, frame.medianZ);
    episode.occupied = Math.max(episode.occupied, frame.occupied);
    episode.levelAbove = Math.max(episode.levelAbove, frame.meanLevel - frame.baselineLevel);
    if (frame.powerDbm !== undefined) episode.powerMax = Math.max(episode.powerMax ?? -Infinity, frame.powerDbm);
    if (frame.snrDb !== undefined) episode.snrMin = Math.min(episode.snrMin ?? Infinity, frame.snrDb);
    if (frame.simulated) episode.simulated = true;
    if (cls !== "clear") {
      episode.raised += 1;
      episode.lastRaisedMs = Math.max(episode.lastRaisedMs, frame.timeMs);
      episode.framesAtLastRaised = episode.frames;
      episode.classes.set(cls, (episode.classes.get(cls) ?? 0) + 1);
    }
    if (bins) {
      episode.binReads += 1;
      episode.binsMax ??= new Float32Array(bins.length);
      episode.binsSum ??= new Float64Array(bins.length);
      for (let index = 0; index < bins.length; index += 1) {
        if (bins[index] > episode.binsMax[index]) episode.binsMax[index] = bins[index];
        episode.binsSum[index] += bins[index];
      }
      episode.binsCount += 1;
      episode.geometry ??= this.geometry;
    }
  }

  private closeEpisode(): void {
    if (this.active) {
      this.active.frames = this.active.framesAtLastRaised;
      this.closed.push(this.active);
    }
    this.active = undefined;
    this.clearRun = 0;
  }

  finish(): RfLaneAnalysis {
    this.closeEpisode();
    const { window, definition } = this;
    const windowMs = window.endMs - window.startMs;
    const median = (values: number[]) => (values.length ? percentile(values, 0.5) : undefined);
    const clearPower = median(this.clearPowers.items);
    const clearSnr = median(this.clearSnrs.items);

    let profile: { usual: Float64Array; scale: Float64Array } | undefined;
    const sample = this.clearBins.items;
    if (sample.length >= 5) {
      const length = sample[0].length;
      profile = { usual: new Float64Array(length), scale: new Float64Array(length) };
      const column = new Array<number>(sample.length);
      for (let bin = 0; bin < length; bin += 1) {
        for (let index = 0; index < sample.length; index += 1) column[index] = sample[index][bin] ?? 0;
        const center = percentile(column, 0.5);
        profile.usual[bin] = center;
        profile.scale[bin] = Math.max(1, 1.4826 * percentile(column.map((value) => Math.abs(value - center)), 0.5));
      }
    }

    const episodes: RfEpisode[] = this.closed.map((state) => {
      const type = SEVERITY.find((candidate) => (state.classes.get(candidate) ?? 0) >= Math.max(1, state.raised * 0.2)) ?? "narrowband";
      let centreMHz: number | undefined;
      let widthMHz: number | undefined;
      if (profile && state.binsMax && state.geometry) {
        const geometry = state.geometry;
        const binHz = (geometry.endHz - geometry.startHz) / state.binsMax.length;
        let weight = 0;
        let weighted = 0;
        let run = 0;
        let best = 0;
        for (let bin = geometry.analysisStartBin; bin < geometry.analysisEndBin; bin += 1) {
          const excess = (state.binsMax[bin] - profile.usual[bin]) / profile.scale[bin];
          if (excess >= RF_RULES.segmentSigma) {
            weight += excess;
            weighted += excess * bin;
            run += 1;
            best = Math.max(best, run);
          } else run = 0;
        }
        if (weight > 0) {
          centreMHz = (geometry.startHz + (weighted / weight + 0.5) * binHz) / 1e6;
          widthMHz = (best * binHz) / 1e6;
        }
      }
      return {
        id: "",
        laneId: definition.id,
        laneLabel: definition.label,
        shortLabel: definition.shortLabel,
        fromMs: state.fromMs,
        toMs: state.lastRaisedMs + 1_000,
        type,
        frames: state.frames,
        raisedFrames: state.raised,
        peakZ: state.peakZ,
        medianZ: state.medianZ,
        occupiedMax: state.occupied,
        widthMHz,
        centreMHz,
        levelAboveUsual: Number.isFinite(state.levelAbove) ? state.levelAbove : 0,
        powerRiseDb: state.powerMax !== undefined && clearPower !== undefined ? state.powerMax - clearPower : undefined,
        snrDropDb: state.snrMin !== undefined && clearSnr !== undefined ? clearSnr - state.snrMin : undefined,
        simulated: state.simulated,
      };
    });

    let intervals: RfLaneInterval[] = [];
    let cursor = window.startMs;
    for (const [from, to] of this.runs) {
      const start = Math.max(window.startMs, from);
      const end = Math.min(window.endMs, to + 1_000);
      if (end <= start) continue;
      if (start > cursor) intervals.push({ fromMs: cursor, toMs: start, state: "unmonitored" });
      intervals.push({ fromMs: Math.max(start, cursor), toMs: end, state: "clear" });
      cursor = end;
    }
    if (cursor < window.endMs) intervals.push({ fromMs: cursor, toMs: window.endMs, state: "unmonitored" });
    for (const episode of episodes) {
      const next: RfLaneInterval[] = [];
      for (const interval of intervals) {
        if (interval.toMs <= episode.fromMs || interval.fromMs >= episode.toMs || interval.state === "unmonitored") {
          next.push(interval);
          continue;
        }
        if (interval.fromMs < episode.fromMs) next.push({ ...interval, toMs: episode.fromMs });
        next.push({ fromMs: Math.max(interval.fromMs, episode.fromMs), toMs: Math.min(interval.toMs, episode.toMs), state: "anomaly" });
        if (interval.toMs > episode.toMs) next.push({ ...interval, fromMs: episode.toMs });
      }
      intervals = next;
    }
    const monitored = intervals.filter((interval) => interval.state !== "unmonitored").reduce((sum, interval) => sum + interval.toMs - interval.fromMs, 0);

    const k = this.bucket;
    const nan = (value: number) => (Number.isNaN(value) ? null : value);
    const series: RfBucketSeries = { timeMs: [], meanLevel: [], baseline: [], peakLevel: [], peakZ: [], medianZ: [], occupied: [], maxWidth: [], power: [] };
    for (let b = 0; b < BUCKETS; b += 1) {
      const has = k.count[b] > 0;
      series.timeMs.push(window.startMs + (b + 0.5) * this.bucketMs);
      series.meanLevel.push(has ? k.meanSum[b] / k.count[b] : null);
      series.baseline.push(has ? k.baseSum[b] / k.count[b] : null);
      series.peakLevel.push(nan(k.peakLevel[b]));
      series.peakZ.push(nan(k.peakZ[b]));
      series.medianZ.push(nan(k.medianZ[b]));
      series.occupied.push(has ? k.occupied[b] * 100 : null);
      series.maxWidth.push(has ? k.maxWidth[b] * 100 : null);
      series.power.push(k.powerCount[b] ? k.powerSum[b] / k.powerCount[b] : null);
    }

    let spectrum: RfLaneAnalysis["spectrum"];
    let analysisHz: RfLaneAnalysis["analysisHz"];
    const geometry = this.geometry;
    if (profile && geometry && geometry.length) {
      const binHz = (geometry.endHz - geometry.startHz) / geometry.length;
      const bins = Array.from({ length: geometry.analysisEndBin - geometry.analysisStartBin }, (_, offset) => geometry.analysisStartBin + offset);
      const worstIndex = episodes.reduce((best, episode, index) => (best < 0 || episode.peakZ > episodes[best].peakZ ? index : best), -1);
      const worst = worstIndex >= 0 ? this.closed[worstIndex] : undefined;
      spectrum = {
        hz: bins.map((bin) => geometry.startHz + (bin + 0.5) * binHz),
        usual: bins.map((bin) => profile!.usual[bin]),
        alert: bins.map((bin) => profile!.usual[bin] + RF_RULES.segmentSigma * profile!.scale[bin]),
        clearMax: bins.map((bin) => sample.reduce((max, entry) => Math.max(max, entry[bin] ?? 0), 0)),
        ...(worst?.binsMax && worst.binsSum && worst.binsCount
          ? { episodeMax: bins.map((bin) => worst.binsMax![bin]), episodeMean: bins.map((bin) => worst.binsSum![bin] / worst.binsCount), episodeId: String(worstIndex) }
          : {}),
      };
      analysisHz = [spectrum.hz[0], spectrum.hz.at(-1)!];
    }

    return {
      definition,
      lane: { id: definition.id, label: definition.label, shortLabel: definition.shortLabel, service: definition.service, intervals },
      episodes,
      series,
      secondPeakZ: this.secondPeakZ,
      secondRaised: this.secondRaised,
      stats: {
        frames: this.frames,
        monitoredFraction: monitored / windowMs,
        usualLevel: median(this.baselines.items),
        meanLevel: median(this.meanLevels.items),
        peakZMax: this.peakZMax,
        occupiedMax: this.occupiedMax,
        powerMedian: median(this.powers.items),
        powerMax: this.powerMax,
        snrMedian: median(this.snrs.items),
        snrMin: this.snrMin,
        overloadFrames: this.overload,
        raisedFrames: this.raisedFrames,
      },
      analysisHz,
      waterfall: this.renderWaterfall(),
      spectrum,
    };
  }

  private renderWaterfall(): RfLaneAnalysis["waterfall"] {
    const grid = this.waterfallGrid;
    if (!grid) return undefined;
    const width = WATERFALL_WIDTH;
    const height = this.waterfallHeight;
    // A window visited in turn leaves short empty columns; hold the last one across gaps shorter than the coverage gap.
    const hold = Math.ceil(RF_RULES.coverageGapMs / ((this.window.endMs - this.window.startMs) / width));
    let lastFilled = -1;
    for (let x = 0; x < width; x += 1) {
      if (this.columnSamples[x] === 0) continue;
      if (lastFilled >= 0 && x - lastFilled > 1 && x - lastFilled <= hold) {
        for (let fill = lastFilled + 1; fill < x; fill += 1) for (let row = 0; row < height; row += 1) grid[row * width + fill] = grid[row * width + lastFilled];
      }
      lastFilled = x;
    }
    const filled: number[] = [];
    for (let index = 0; index < grid.length; index += 7) if (grid[index] >= 0) filled.push(grid[index]);
    if (!filled.length) return undefined;
    const low = percentile(filled, 0.05);
    const high = Math.max(low + 20, percentile(filled, 0.999));
    const rgba = new Uint8Array(width * height * 4);
    for (let index = 0; index < grid.length; index += 1) {
      const value = grid[index];
      const [r, g, b] = value < 0 ? [230, 234, 238] : waterfallRgb(Math.max(0, Math.min(255, ((value - low) / (high - low)) * 255)));
      rgba[index * 4] = r;
      rgba[index * 4 + 1] = g;
      rgba[index * 4 + 2] = b;
      rgba[index * 4 + 3] = 255;
    }
    return { pngBase64: Buffer.from(encodePng(width, height, rgba)).toString("base64"), widthPx: width, heightPx: height };
  }
}

/** Streaming RF analysis over all lanes of a report window. Frames must arrive in time order. */
export class RfAccumulator {
  private readonly lanes: LaneAccumulator[];
  private readonly byTarget = new Map<string, LaneAccumulator[]>();
  frames = 0;

  constructor(definitions: RfLaneDefinition[], window: ReportWindow) {
    this.lanes = definitions.map((definition) => new LaneAccumulator(definition, window));
    for (const lane of this.lanes) this.byTarget.set(lane.definition.targetId, [...(this.byTarget.get(lane.definition.targetId) ?? []), lane]);
  }

  wants(targetId: string): boolean {
    return this.byTarget.has(targetId);
  }

  async add(frame: RfFrameMetrics, loadBins: BinsLoader): Promise<void> {
    const lanes = this.byTarget.get(frame.targetId);
    if (!lanes) return;
    this.frames += 1;
    let cached: Promise<Uint8Array | undefined> | undefined;
    const once: BinsLoader = () => (cached ??= loadBins());
    for (const lane of lanes) await lane.add(frame, once);
  }

  finish(source: RfEvidence["source"]): { lanes: RfLaneAnalysis[]; episodes: RfEpisode[]; evidence: RfEvidence } {
    const lanes = this.lanes.map((lane) => lane.finish());
    const episodes = lanes.flatMap((lane) => lane.episodes).sort((left, right) => left.fromMs - right.fromMs);
    episodes.forEach((episode, index) => {
      episode.id = `RF${index + 1}`;
    });
    for (const lane of lanes) {
      if (lane.spectrum?.episodeId !== undefined) lane.spectrum.episodeId = lane.episodes[Number(lane.spectrum.episodeId)]?.id;
    }
    const evidence: RfEvidence = {
      source,
      lanes: lanes.map((lane) => lane.lane),
      incidents: episodes.map((episode) => ({
        id: episode.id,
        title: `${RF_TYPE_LABEL[episode.type]} on ${episode.shortLabel}${episode.simulated ? " (simulated)" : ""}`,
        fromMs: episode.fromMs,
        toMs: episode.toMs,
        laneIds: [episode.laneId],
        evidenceStrength: episode.raisedFrames >= 10 ? "Medium" : "Low",
      })),
    };
    return { lanes, episodes, evidence };
  }
}

/** Convenience for in-memory frames (tests, mock-up). */
export async function analyseRf(input: { frames: RfFrame[]; window: ReportWindow; lanes: RfLaneDefinition[]; source: RfEvidence["source"] }): Promise<ReturnType<RfAccumulator["finish"]>> {
  const accumulator = new RfAccumulator(input.lanes, input.window);
  for (const frame of [...input.frames].sort((left, right) => left.timeMs - right.timeMs)) {
    const { bins, ...metrics } = frame;
    await accumulator.add(metrics, async () => bins);
  }
  return accumulator.finish(input.source);
}

/** The default lanes: the four Tier-1 GNSS windows and one lane per configured Fugro beam. */
export function defaultRfLanes(beams: string[]): RfLaneDefinition[] {
  return [
    { id: "gnss-l1-e1-b1c-sbas", label: "GPS L1 / Galileo E1 / BeiDou B1C / SBAS L1", shortLabel: "L1 / E1 / B1C", service: "gnss", targetId: "gnss-l1-e1-b1c-sbas" },
    { id: "gnss-glonass-g1", label: "GLONASS G1", shortLabel: "GLONASS G1", service: "gnss", targetId: "gnss-glonass-g1" },
    { id: "gnss-gps-l2c", label: "GPS L2C", shortLabel: "L2C", service: "gnss", targetId: "gnss-gps-l2c" },
    { id: "gnss-l5-e5a-b2a", label: "GPS L5 / Galileo E5a / BeiDou B2a", shortLabel: "L5 / E5a / B2a", service: "gnss", targetId: "gnss-l5-e5a-b2a" },
    ...[...new Set(beams.filter(Boolean))].map((beam) => ({ id: `fugro-${beam.toLowerCase()}`, label: `Fugro ${beam}`, shortLabel: beam, service: "fugro" as const, targetId: "fugro-corrections-lband" })),
  ];
}

// ---- RF and navigation relationship ------------------------------------------------

export interface GroupImpact {
  group: string;
  systems: string[];
  /** Median satellite loss during minus before, % of each system's own median (positive = loss). */
  satsLossPct?: number;
  hdopRise?: number;
  ageRiseS?: number;
  /** Largest 2D range to the control during the episode (comparison systems in the group). */
  maxRangeM?: number;
}

export interface EpisodeImpact {
  episode: RfEpisode;
  covered: boolean;
  groups: GroupImpact[];
  assessment: string;
  level: "alert" | "check" | "info";
}

export interface RelationshipStat {
  laneId: string;
  laneLabel: string;
  group: string;
  pairs: number;
  /** Spearman rank correlation between RF peak excess and satellite loss. */
  r?: number;
  /** Lag (s) of the strongest correlation; positive = navigation follows RF. */
  lagS?: number;
  raisedPairs: number;
}

export interface GroupSeries {
  group: string;
  /** [timeMs, value] per shot: median satellite loss %, median HDOP, max range to control, median correction age. */
  satsLoss: Array<[number, number | null]>;
  hdop: Array<[number, number | null]>;
  range: Array<[number, number | null]>;
  age: Array<[number, number | null]>;
}

function rank(values: number[]): number[] {
  const order = values.map((value, index) => [value, index] as const).sort((left, right) => left[0] - right[0]);
  const ranks = new Array<number>(values.length);
  for (let index = 0; index < order.length; ) {
    let end = index;
    while (end + 1 < order.length && order[end + 1][0] === order[index][0]) end += 1;
    for (let k = index; k <= end; k += 1) ranks[order[k][1]] = (index + end) / 2;
    index = end + 1;
  }
  return ranks;
}

function pearson(x: number[], y: number[]): number | undefined {
  if (x.length < 10) return undefined;
  const mx = x.reduce((sum, value) => sum + value, 0) / x.length;
  const my = y.reduce((sum, value) => sum + value, 0) / y.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let index = 0; index < x.length; index += 1) {
    sxy += (x[index] - mx) * (y[index] - my);
    sxx += (x[index] - mx) ** 2;
    syy += (y[index] - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : undefined;
}

export function groupSeries(analysis: PositioningAnalysis): GroupSeries[] {
  const groups = [...new Set(analysis.systems.map((system) => system.config.antennaGroup))];
  const shotMaps = new Map(analysis.systems.map((system) => [system.id, new Map(system.shots.map((shot) => [shot.timeMs, shot]))]));
  const offsetMaps = new Map(analysis.systems.map((system) => [system.id, new Map((system.vsControl?.offsets ?? []).map((offset) => [offset[0], offset]))]));
  return groups.map((group) => {
    const members = analysis.systems.filter((system) => system.config.antennaGroup === group);
    const series: GroupSeries = { group, satsLoss: [], hdop: [], range: [], age: [] };
    for (const time of analysis.times) {
      const losses: number[] = [];
      const hdops: number[] = [];
      const ranges: number[] = [];
      const ages: number[] = [];
      for (const system of members) {
        const shot = shotMaps.get(system.id)!.get(time);
        if (!shot) continue;
        if (shot.nsats !== null && system.quality.sats?.median) losses.push(((system.quality.sats.median - shot.nsats) / system.quality.sats.median) * 100);
        if (shot.hdop !== null) hdops.push(shot.hdop);
        if (shot.ageS !== null) ages.push(shot.ageS);
        const offset = offsetMaps.get(system.id)!.get(time);
        if (offset) ranges.push(Math.hypot(offset[1], offset[2]));
      }
      series.satsLoss.push([time, losses.length ? percentile(losses, 0.5) : null]);
      series.hdop.push([time, hdops.length ? percentile(hdops, 0.5) : null]);
      series.range.push([time, ranges.length ? Math.max(...ranges) : null]);
      series.age.push([time, ages.length ? percentile(ages, 0.5) : null]);
    }
    return series;
  });
}

/** RF peak excess and raised flag around a UTC time, from the per-second arrays (±2 s). */
export function rfAt(lane: RfLaneAnalysis, windowStartMs: number, timeMs: number): { peakZ: number; raised: boolean } | undefined {
  const centre = Math.floor((timeMs - windowStartMs) / 1000);
  let peak = Number.NaN;
  let raised = false;
  for (let second = centre - 2; second <= centre + 2; second += 1) {
    if (second < 0 || second >= lane.secondPeakZ.length) continue;
    const value = lane.secondPeakZ[second];
    if (!Number.isNaN(value) && (Number.isNaN(peak) || value > peak)) peak = value;
    if (lane.secondRaised[second]) raised = true;
  }
  return Number.isNaN(peak) ? undefined : { peakZ: peak, raised };
}

export function relateRfToNavigation(analysis: PositioningAnalysis, rf: { lanes: RfLaneAnalysis[]; episodes: RfEpisode[] }, series: GroupSeries[]): { impacts: EpisodeImpact[]; stats: RelationshipStat[] } {
  const before = 5 * 60_000;
  const values = (list: Array<[number, number | null]>, from: number, to: number) => list.filter(([time, value]) => time >= from && time <= to && value !== null).map(([, value]) => value as number);
  const impacts: EpisodeImpact[] = rf.episodes.map((episode) => {
    const covered = analysis.times.some((time) => time >= episode.fromMs && time <= episode.toMs);
    const groups: GroupImpact[] = series.map((entry) => {
      const delta = (list: Array<[number, number | null]>) => {
        const during = values(list, episode.fromMs, episode.toMs);
        let prior = values(list, episode.fromMs - before, episode.fromMs - 1);
        if (!prior.length) prior = values(list, analysis.window.startMs, analysis.window.endMs);
        return during.length && prior.length ? percentile(during, 0.5) - percentile(prior, 0.5) : undefined;
      };
      const ranges = values(entry.range, episode.fromMs, episode.toMs);
      return {
        group: entry.group,
        systems: analysis.systems.filter((system) => system.config.antennaGroup === entry.group).map((system) => system.id),
        satsLossPct: delta(entry.satsLoss),
        hdopRise: delta(entry.hdop),
        ageRiseS: delta(entry.age),
        maxRangeM: ranges.length ? Math.max(...ranges) : undefined,
      };
    });
    const limit = analysis.thresholds.agreementM;
    const hit = groups.filter((group) => (group.satsLossPct ?? 0) >= analysis.thresholds.satsDropFraction * 100 || (group.hdopRise ?? 0) >= analysis.thresholds.hdopExcess || (group.maxRangeM ?? 0) > limit);
    const jammingType = episode.type === "wideband" || episode.type === "partial-band" || episode.type === "noise-floor";
    const kind = jammingType ? "Jamming-type" : RF_TYPE_LABEL[episode.type];
    let assessment: string;
    let level: EpisodeImpact["level"];
    if (!covered) {
      assessment = `${kind} interference; no Gator data for this period.`;
      level = "check";
    } else if (hit.length === groups.length && groups.length > 1) {
      assessment = `${kind} interference degraded both antenna groups.`;
      level = "alert";
    } else if (hit.length) {
      assessment = `${kind} interference coincided with degradation on the ${hit.map((group) => group.group).join("/")} antenna only.`;
      level = "check";
    } else {
      assessment = `${kind} interference; no measurable positioning impact on either antenna.`;
      level = "info";
    }
    return { episode, covered, groups, assessment, level };
  });

  const stats: RelationshipStat[] = [];
  for (const lane of rf.lanes.filter((entry) => entry.definition.service === "gnss" && entry.stats.frames)) {
    for (const entry of series) {
      const pairsAt = (lagMs: number) => {
        const x: number[] = [];
        const y: number[] = [];
        let raised = 0;
        for (const [time, loss] of entry.satsLoss) {
          if (loss === null) continue;
          const rf = rfAt(lane, analysis.window.startMs, time - lagMs);
          if (!rf) continue;
          x.push(rf.peakZ);
          y.push(loss);
          if (rf.raised) raised += 1;
        }
        return { x, y, raised };
      };
      const base = pairsAt(0);
      let best: { r: number; lag: number } | undefined;
      for (let lag = -120; lag <= 120; lag += 10) {
        const { x, y } = pairsAt(lag * 1000);
        const r = pearson(rank(x), rank(y));
        if (r !== undefined && (!best || Math.abs(r) > Math.abs(best.r))) best = { r, lag };
      }
      stats.push({ laneId: lane.definition.id, laneLabel: lane.definition.shortLabel, group: entry.group, pairs: base.x.length, r: pearson(rank(base.x), rank(base.y)), lagS: best?.lag, raisedPairs: base.raised });
    }
  }
  return { impacts, stats };
}
