/**
 * DGNSS verification (07-NAV-211 method, reduced to the vessel CRP) plus the
 * correlation of navigation indicators with rf-monitor RF lanes.
 *
 * Reference for agreement is the six-system mean CRP at each shot. Absolute
 * statistics (mean/min/max/SD per axis) are only meaningful while the vessel is
 * static and are reported as such.
 */
import type { SbsDataset, SbsShot, SbsSystem } from "./sbs";
import type { PositioningSystemConfig, PositioningThresholds, ReportWindow, RfEvidence, RfLane, RfLaneState } from "./types";
import { alongCross, medianOf, referenceTrack, timingProfile, type OffsetSample, type TimingProfile, type TimingRule, type TrackPoint } from "./underWay";

export type { TimingProfile, TimingStep } from "./underWay";

export interface AxisStats {
  mean: number;
  min: number;
  max: number;
  /** Sample standard deviation (Excel STDEV.S), as in 07-NAV-211. */
  sd: number;
  n: number;
}

export interface SpreadStats {
  median: number;
  min: number;
  max: number;
  n: number;
}

export type NavIndicator = "offset" | "sats" | "hdop" | "age" | "pcalc";

export const INDICATOR_LABEL: Record<NavIndicator, string> = {
  offset: "CRP beyond agreement limit",
  sats: "Satellite loss",
  hdop: "HDOP raised",
  age: "Correction age raised",
  pcalc: "PCALC change",
};

export interface DistanceStats {
  /**
   * Per shot: [timeMs, dE, dN] of this CRP minus the control CRP. Shots where
   * either position is a timing step are left out (see `excludedTiming`).
   */
  offsets: Array<[number, number, number]>;
  n: number;
  min: number;
  max: number;
  mean: number;
  p95: number;
  withinLimit: number;
  /** Shots left out because this system or the control took a timing step. */
  excludedTiming: number;
  /** Static and slow shots (2D comparison). */
  static: { n: number; max: number; p95: number; samples: Array<[number, number]> };
  /** The distance the agreement check uses: 2D static, across track under way. */
  agreementMax: number;
  agreementP95: number;
  /** Under way: across track, and the steady along-track offset, to the control. */
  underWay?: {
    n: number;
    crossMax: number;
    crossP95: number;
    /** Median along-track offset to the control (+ ahead). Steady lag or along-track lever-arm error. */
    alongSteadyM: number;
    alongP95: number;
    /** [timeMs, along, cross] per shot under way (timing excursions included). */
    samples: Array<[number, number, number]>;
    /** Along-track timing relative to the control: steady, 95th percentile and largest, s. */
    timing: TimingProfile;
  };
}

/** A system's position timing under way, against the reference track built from all systems. */
export type TimingSummary = TimingProfile;

export interface EllipseStats {
  meanE: number;
  meanN: number;
  sdE: number;
  sdN: number;
  /** 95% error ellipse semi-axes (chi-square 2 dof, 5.991) and major-axis bearing from grid north. */
  sma: number;
  smi: number;
  orientDeg: number;
  basis: "position" | "control-delta";
}

export interface SystemAnalysis {
  id: string;
  config: PositioningSystemConfig;
  isControl: boolean;
  /** Distance from the control CRP; undefined for the control itself. */
  vsControl?: DistanceStats;
  ellipse?: EllipseStats;
  shots: SbsShot[];
  crpN: AxisStats;
  crpE: AxisStats;
  antN: AxisStats;
  antE: AxisStats;
  height: AxisStats | undefined;
  heightConstant: boolean;
  quality: {
    sats?: SpreadStats;
    hdop?: SpreadStats;
    pdop?: SpreadStats;
    age?: SpreadStats;
    pcalcUsual?: number;
    pcalcOtherShots: number;
    pcalcChanges: number;
    pcalcCodes: Array<[number, number]>;
  };
  absentFields: string[];
  /** Per shot, the indicators that tripped. */
  flags: Map<number, Set<NavIndicator>>;
  /** Timing steps under way, against the reference track built from all systems. */
  timing: TimingSummary;
}

export interface NavFlagRun {
  systemId: string;
  indicator: NavIndicator;
  fromMs: number;
  toMs: number;
  shots: number;
}

export type EventKind =
  | "rf-and-nav-common"
  | "nav-common-no-rf"
  | "nav-common-rf-unknown"
  | "antenna-group"
  | "single-receiver"
  | "correction-link"
  | "single-solution"
  | "rf-only"
  | "rf-no-nav-data";

export type EventLevel = "alert" | "check" | "info";

export interface CorrelatedEvent {
  id: string;
  fromMs: number;
  toMs: number;
  kind: EventKind;
  level: EventLevel;
  title: string;
  evidence: "RF + navigation" | "RF only" | "Navigation only";
  systems: string[];
  indicators: string[];
  rfLanes: string[];
  /** Fraction of the event during which every GNSS lane was being monitored. */
  rfCoverage: number;
  explanation: string;
  /** One short, task-oriented instruction. */
  action: string;
}

export interface LaneSummary {
  lane: RfLane;
  monitoredFraction: number;
  anomalyMs: number;
  anomalyCount: number;
}

export interface MotionSummary {
  state: "static" | "dynamic" | "mixed";
  n: number;
  minKnots: number;
  maxKnots: number;
  meanKnots: number;
  medianKnots: number;
  p95Knots: number;
  movingFraction: number;
  /** [timeMs, knots] of the mean CRP over ~30 s. */
  series: Array<[number, number]>;
  /** Per-shot speed of the reference track; shots split into static (≤ movingKnots) and under way. */
  shots: { static: KnotStats; underWay: KnotStats; all: KnotStats };
  /** Speed from which offsets are split along/across track. */
  alongTrackKnots: number;
}

export interface KnotStats {
  n: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  fromMs?: number;
  toMs?: number;
}

export interface PositioningAnalysis {
  controlId: string;
  dataset: SbsDataset;
  window: ReportWindow;
  thresholds: PositioningThresholds;
  systems: SystemAnalysis[];
  times: number[];
  meanCrp: Array<[number, number, number]>;
  motion: MotionSummary;
  positioningCoverage: GatorCoverage;
  flagRuns: NavFlagRun[];
  events: CorrelatedEvent[];
  rf: RfEvidence;
  lanes: LaneSummary[];
  /** Comparisons beyond the limit: static 2D, or under way across track or steady along track. */
  agreementFailures: string[];
  /** Shot positions of all systems together against the smooth reference track, under way. */
  commonTiming?: TimingProfile;
  verdict: string;
  verdictLevel: EventLevel | "ok";
}

// ---- small statistics ---------------------------------------------------------

function axisStats(values: number[]): AxisStats {
  const finite = values.filter(Number.isFinite);
  const n = finite.length;
  if (!n) return { mean: Number.NaN, min: Number.NaN, max: Number.NaN, sd: Number.NaN, n: 0 };
  // Subtract the first value before summing so UTM-sized numbers keep their precision.
  const origin = finite[0];
  let sum = 0;
  for (const value of finite) sum += value - origin;
  const mean = origin + sum / n;
  let squares = 0;
  for (const value of finite) squares += (value - mean) ** 2;
  return { mean, min: Math.min(...finite), max: Math.max(...finite), sd: n > 1 ? Math.sqrt(squares / (n - 1)) : 0, n };
}

export function percentile(values: number[], fraction: number): number {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function spread(values: Array<number | null>): SpreadStats | undefined {
  const finite = values.filter((value): value is number => value !== null && Number.isFinite(value));
  if (!finite.length) return undefined;
  return { median: percentile(finite, 0.5), min: Math.min(...finite), max: Math.max(...finite), n: finite.length };
}

function mode(values: number[]): number | undefined {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}

// ---- windows and RF lanes -----------------------------------------------------

/** UTC midnight of the day holding `ms`. */
export function utcDayStart(ms: number): number {
  const day = new Date(ms);
  return Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
}

/** "YYYY-MM-DD" of each UTC day touched by [startMs, endMs]. */
export function utcDays(startMs: number, endMs: number): string[] {
  const days: string[] = [];
  for (let day = utcDayStart(startMs); day <= endMs && days.length < 31; day += 86_400_000) days.push(new Date(day).toISOString().slice(0, 10));
  return days;
}

export function resolveWindow(dataset: Pick<SbsDataset, "startMs" | "endMs" | "intervalMs">, mode: ReportWindow["mode"], options: { custom?: { startMs: number; endMs: number }; day?: string } = {}): ReportWindow {
  const custom = options.custom;
  if (mode === "utc-day") {
    const chosen = options.day ? Date.parse(`${options.day}T00:00:00Z`) : Number.NaN;
    const startMs = Number.isFinite(chosen) ? chosen : utcDayStart(dataset.startMs);
    return { mode, startMs, endMs: startMs + 86_400_000 };
  }
  if (mode === "custom" && custom) {
    const endMs = Math.min(custom.endMs, custom.startMs + 86_400_000);
    return { mode, startMs: custom.startMs, endMs };
  }
  return { mode: "sbs", startMs: dataset.startMs, endMs: dataset.endMs + dataset.intervalMs };
}

/** Where the window has Gator data, and where it has none. */
export interface GatorCoverage {
  /** First and last moment with data inside the window (window start when there is none). */
  fromMs: number;
  toMs: number;
  /** Share of the window with data. */
  fraction: number;
  intervals: Array<[number, number]>;
  /** Spans inside the window without data (before, between and after the intervals). */
  missing: Array<[number, number]>;
  /** Missing spans between two data intervals: a pause or a missing file. */
  gaps: Array<[number, number]>;
}

export function gatorCoverage(dataset: Pick<SbsDataset, "startMs" | "endMs" | "intervalMs"> & { coverage?: Array<[number, number]> }, window: Pick<ReportWindow, "startMs" | "endMs">): GatorCoverage {
  const spans = dataset.coverage?.length ? dataset.coverage : [[dataset.startMs, dataset.endMs + dataset.intervalMs] as [number, number]];
  const intervals = spans
    .map(([from, to]) => [Math.max(window.startMs, from), Math.min(window.endMs, to)] as [number, number])
    .filter(([from, to]) => to > from);
  const missing: Array<[number, number]> = [];
  let cursor = window.startMs;
  for (const [from, to] of intervals) {
    if (from > cursor) missing.push([cursor, from]);
    cursor = Math.max(cursor, to);
  }
  if (cursor < window.endMs) missing.push([cursor, window.endMs]);
  const covered = intervals.reduce((sum, [from, to]) => sum + to - from, 0);
  const fromMs = intervals[0]?.[0] ?? window.startMs;
  const toMs = intervals.at(-1)?.[1] ?? window.startMs;
  return {
    fromMs,
    toMs,
    fraction: covered / Math.max(1, window.endMs - window.startMs),
    intervals,
    missing,
    gaps: missing.filter(([from, to]) => from > fromMs && to < toMs),
  };
}

function clipLane(lane: RfLane, window: ReportWindow): RfLane {
  return {
    ...lane,
    intervals: lane.intervals
      .filter((interval) => interval.toMs > window.startMs && interval.fromMs < window.endMs)
      .map((interval) => ({ ...interval, fromMs: Math.max(window.startMs, interval.fromMs), toMs: Math.min(window.endMs, interval.toMs) })),
  };
}

function overlapMs(fromA: number, toA: number, fromB: number, toB: number): number {
  return Math.max(0, Math.min(toA, toB) - Math.max(fromA, fromB));
}

function laneStateDuration(lane: RfLane, fromMs: number, toMs: number, state: RfLaneState): number {
  return lane.intervals.filter((interval) => interval.state === state).reduce((sum, interval) => sum + overlapMs(fromMs, toMs, interval.fromMs, interval.toMs), 0);
}

// ---- main ---------------------------------------------------------------------

export function analysePositioning(input: {
  dataset: SbsDataset;
  systems: PositioningSystemConfig[];
  thresholds: PositioningThresholds;
  window: ReportWindow;
  rf: RfEvidence;
  /** Control system for deltas; defaults to the first configured system. */
  controlId?: string;
}): PositioningAnalysis {
  const { dataset, thresholds, window } = input;
  const configById = new Map(input.systems.map((system) => [system.id, system]));
  const sbsSystems = dataset.systems.filter((system) => configById.has(system.id));
  const byTime = sbsSystems.map((system) => new Map(system.shots.map((shot) => [shot.timeMs, shot])));
  const times = [...new Set(sbsSystems.flatMap((system) => system.shots.map((shot) => shot.timeMs)))]
    .filter((time) => time >= window.startMs && time < window.endMs)
    .sort((left, right) => left - right);

  // Six-system mean CRP per shot (any shot with at least three solutions).
  const meanCrp: Array<[number, number, number]> = [];
  for (const time of times) {
    const shots = byTime.map((map) => map.get(time)).filter((shot): shot is SbsShot => Boolean(shot));
    if (shots.length < Math.min(3, sbsSystems.length)) continue;
    const e = shots.reduce((sum, shot) => sum + shot.crpE, 0) / shots.length;
    const n = shots.reduce((sum, shot) => sum + shot.crpN, 0) / shots.length;
    meanCrp.push([time, e, n]);
  }

  // Vessel motion from the mean CRP over ~30 s.
  const series: Array<[number, number]> = [];
  for (let index = 0, back = 0; index < meanCrp.length; index += 1) {
    while (meanCrp[index][0] - meanCrp[back][0] > 30_000) back += 1;
    const dt = (meanCrp[index][0] - meanCrp[back][0]) / 1000;
    if (dt >= 20) series.push([meanCrp[index][0], (Math.hypot(meanCrp[index][1] - meanCrp[back][1], meanCrp[index][2] - meanCrp[back][2]) / dt) * 1.943844]);
  }
  const speeds = series.map(([, knots]) => knots);
  const movingFraction = speeds.length ? speeds.filter((speed) => speed > thresholds.movingKnots).length / speeds.length : 0;
  const motion: MotionSummary = {
    state: movingFraction < 0.05 ? "static" : movingFraction > 0.5 ? "dynamic" : "mixed",
    n: speeds.length,
    minKnots: speeds.length ? Math.min(...speeds) : 0,
    maxKnots: speeds.length ? Math.max(...speeds) : 0,
    meanKnots: speeds.length ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length : 0,
    medianKnots: percentile(speeds, 0.5) || 0,
    p95Knots: percentile(speeds, 0.95) || 0,
    movingFraction,
    series,
    shots: { static: { n: 0, min: Number.NaN, max: Number.NaN, mean: Number.NaN, median: Number.NaN }, underWay: { n: 0, min: Number.NaN, max: Number.NaN, mean: Number.NaN, median: Number.NaN }, all: { n: 0, min: Number.NaN, max: Number.NaN, mean: Number.NaN, median: Number.NaN } },
    alongTrackKnots: thresholds.alongTrackMinKnots,
  };

  // Reference track: per-shot median of all systems, smoothed, with velocity.
  // Under way, offsets are split along/across track against it.
  const medianCrp: Array<[number, number, number]> = [];
  for (const time of times) {
    const shots = byTime.map((map) => map.get(time)).filter((shot): shot is SbsShot => Boolean(shot));
    if (shots.length < Math.min(3, sbsSystems.length)) continue;
    medianCrp.push([time, medianOf(shots.map((shot) => shot.crpE)), medianOf(shots.map((shot) => shot.crpN))]);
  }
  const reference = referenceTrack(medianCrp, dataset.intervalMs);
  const limit = thresholds.agreementM;
  const alongTrackKnots = Math.max(thresholds.movingKnots, thresholds.alongTrackMinKnots);
  const trackAt = (time: number): TrackPoint | undefined => {
    const point = reference.get(time);
    return point && point.knots >= alongTrackKnots ? point : undefined;
  };
  // Excursions from 0.2 m (at most half the limit) are set aside from the 2D statistics and figures.
  const timingRule: TimingRule = { minM: Math.min(0.2, limit / 2), maxCrossM: limit / 2, maxSeconds: thresholds.timingStepMaxS };
  const underWaySamples = (positions: Array<{ timeMs: number; e: number; n: number }>): OffsetSample[] => positions.flatMap((position) => {
    if (position.timeMs < window.startMs || position.timeMs >= window.endMs) return [];
    const point = trackAt(position.timeMs);
    if (!point) return [];
    const { along, cross } = alongCross(position.e - point.e, position.n - point.n, point);
    return Number.isFinite(along) ? [{ timeMs: position.timeMs, along, cross, knots: point.knots }] : [];
  });

  // Timing of each system, and of all systems together, against the reference track.
  const timingById = new Map<string, TimingProfile>();
  for (const system of sbsSystems) {
    timingById.set(system.id, timingProfile(underWaySamples(system.shots.map((shot) => ({ timeMs: shot.timeMs, e: shot.crpE, n: shot.crpN }))), timingRule));
  }
  const commonSamples = underWaySamples(medianCrp.map(([timeMs, e, n]) => ({ timeMs, e, n })));
  const commonTiming = commonSamples.length ? timingProfile(commonSamples, timingRule) : undefined;

  // Each comparison against the control at the same shot. Static and slow
  // shots compare in 2D. Under way, agreement is across track at every shot
  // plus the steady along-track offset; shot-to-shot along-track excursions
  // are timing and are set aside from the 2D statistics.
  const controlId = input.controlId && configById.has(input.controlId) ? input.controlId : sbsSystems[0].id;
  const controlShots = byTime[sbsSystems.findIndex((system) => system.id === controlId)];
  const comparisonCount = sbsSystems.length - 1;
  interface Pairing {
    aligned: Array<[number, number, number]>;
    excluded: number;
    staticDistances: Array<[number, number]>;
    underWay: Array<[number, number, number, number]>;
    timing?: TimingProfile;
    /** Shots beyond the limit (not timing). */
    beyond: Set<number>;
  }
  const pairings = new Map<string, Pairing>();
  for (const system of sbsSystems) {
    if (system.id === controlId) continue;
    const raw: Array<{ time: number; dE: number; dN: number; point?: TrackPoint }> = [];
    for (const shot of system.shots) {
      if (shot.timeMs < window.startMs || shot.timeMs >= window.endMs) continue;
      const control = controlShots.get(shot.timeMs);
      if (!control) continue;
      raw.push({ time: shot.timeMs, dE: shot.crpE - control.crpE, dN: shot.crpN - control.crpN, point: trackAt(shot.timeMs) });
    }
    const pairSamples: OffsetSample[] = raw.filter((entry) => entry.point)
      .map((entry) => ({ timeMs: entry.time, ...alongCross(entry.dE, entry.dN, entry.point!), knots: entry.point!.knots }));
    const timing = pairSamples.length ? timingProfile(pairSamples, timingRule) : undefined;
    const timingShots = new Set(timing?.excursions.map((step) => step.timeMs));
    const pairing: Pairing = { aligned: [], excluded: 0, staticDistances: [], underWay: [], timing, beyond: new Set() };
    const steadyAlong = timing?.steadyAlong ?? 0;
    for (const entry of raw) {
      if (entry.point) {
        const { along, cross } = alongCross(entry.dE, entry.dN, entry.point);
        pairing.underWay.push([entry.time, along, cross, entry.point.knots]);
        // Along-track excursions within the timing range are never position offsets.
        const beyondTiming = Math.abs(along - steadyAlong) > thresholds.timingStepMaxS * entry.point.knots * 0.514444;
        if (Math.abs(cross) > limit || Math.abs(steadyAlong) > limit || (beyondTiming && Math.abs(along) > limit)) pairing.beyond.add(entry.time);
        if (timingShots.has(entry.time)) {
          pairing.excluded += 1;
          continue;
        }
      } else {
        const distance = Math.hypot(entry.dE, entry.dN);
        pairing.staticDistances.push([entry.time, distance]);
        if (distance > limit) pairing.beyond.add(entry.time);
      }
      pairing.aligned.push([entry.time, entry.dE, entry.dN]);
    }
    pairings.set(system.id, pairing);
  }
  // If most comparisons are beyond the limit at the same shot, the control is
  // the outlier and is flagged instead of them.
  const exceedAt = new Map<number, string[]>();
  for (const [systemId, pairing] of pairings) for (const time of pairing.beyond) exceedAt.set(time, [...(exceedAt.get(time) ?? []), systemId]);
  const offsetFlagged = (systemId: string, time: number) => {
    const list = exceedAt.get(time) ?? [];
    const controlIsOutlier = comparisonCount >= 2 && list.length >= Math.ceil(comparisonCount / 2);
    return systemId === controlId ? controlIsOutlier : !controlIsOutlier && list.includes(systemId);
  };

  const knotStats = (entries: Array<[number, number]>): KnotStats => {
    const values = entries.map(([, knots]) => knots);
    return values.length
      ? { n: values.length, min: Math.min(...values), max: Math.max(...values), mean: values.reduce((sum, value) => sum + value, 0) / values.length, median: medianOf(values), fromMs: entries[0][0], toMs: entries.at(-1)![0] }
      : { n: 0, min: Number.NaN, max: Number.NaN, mean: Number.NaN, median: Number.NaN };
  };
  const shotSpeeds = [...reference.entries()].filter(([time]) => time >= window.startMs && time < window.endMs).map(([time, point]) => [time, point.knots] as [number, number]);
  motion.shots = {
    static: knotStats(shotSpeeds.filter(([, knots]) => knots <= thresholds.movingKnots)),
    underWay: knotStats(shotSpeeds.filter(([, knots]) => knots > thresholds.movingKnots)),
    all: knotStats(shotSpeeds),
  };
  motion.alongTrackKnots = alongTrackKnots;

  const systems: SystemAnalysis[] = sbsSystems.map((system: SbsSystem) => {
    const config = configById.get(system.id)!;
    const shots = system.shots.filter((shot) => shot.timeMs >= window.startMs && shot.timeMs < window.endMs);
    const heights = shots.map((shot) => shot.antH).filter((value): value is number => value !== null);
    const height = heights.length ? axisStats(heights) : undefined;
    const isControl = system.id === controlId;
    const pairing = pairings.get(system.id);
    const offsets = pairing?.aligned ?? [];
    const distances = offsets.map(([, dE, dN]) => Math.hypot(dE, dN));
    const timing = timingById.get(system.id) ?? timingProfile([], timingRule);
    const pcalcValues = shots.map((shot) => shot.pcalc).filter((value): value is number => value !== null);
    const pcalcUsual = mode(pcalcValues);
    let pcalcChanges = 0;
    let previous: number | undefined;
    for (const value of pcalcValues) {
      if (previous !== undefined && value !== previous) pcalcChanges += 1;
      previous = value;
    }
    const codeCounts = new Map<number, number>();
    for (const value of pcalcValues) codeCounts.set(value, (codeCounts.get(value) ?? 0) + 1);
    const quality = {
      sats: spread(shots.map((shot) => shot.nsats)),
      hdop: spread(shots.map((shot) => shot.hdop)),
      pdop: spread(shots.map((shot) => shot.pdop)),
      age: spread(shots.map((shot) => shot.ageS)),
      pcalcUsual,
      pcalcOtherShots: pcalcValues.filter((value) => value !== pcalcUsual).length,
      pcalcChanges,
      pcalcCodes: [...codeCounts.entries()].sort((left, right) => right[1] - left[1]),
    };

    // Per-shot indicator flags against the solution's own normal level.
    const flags = new Map<number, Set<NavIndicator>>();
    const flag = (time: number, indicator: NavIndicator) => {
      const set = flags.get(time) ?? new Set<NavIndicator>();
      set.add(indicator);
      flags.set(time, set);
    };
    for (const shot of shots) {
      if (offsetFlagged(system.id, shot.timeMs)) flag(shot.timeMs, "offset");
      if (shot.nsats !== null && quality.sats) {
        const floor = Math.min(quality.sats.median * (1 - thresholds.satsDropFraction), quality.sats.median - thresholds.satsDropMin);
        if (shot.nsats < floor) flag(shot.timeMs, "sats");
      }
      if (shot.hdop !== null && quality.hdop && shot.hdop > Math.max(quality.hdop.median * thresholds.hdopFactor, quality.hdop.median + thresholds.hdopExcess)) flag(shot.timeMs, "hdop");
      if (shot.ageS !== null && quality.age && shot.ageS > quality.age.median + thresholds.ageExcessS) flag(shot.timeMs, "age");
      if (shot.pcalc !== null && pcalcUsual !== undefined && shot.pcalc !== pcalcUsual) flag(shot.timeMs, "pcalc");
    }

    return {
      id: system.id,
      config,
      shots,
      crpN: axisStats(shots.map((shot) => shot.crpN)),
      crpE: axisStats(shots.map((shot) => shot.crpE)),
      antN: axisStats(shots.map((shot) => shot.antN)),
      antE: axisStats(shots.map((shot) => shot.antE)),
      height,
      heightConstant: Boolean(height && height.n > 1 && height.max - height.min < 1e-6),
      isControl,
      vsControl: isControl
        ? undefined
        : {
            offsets,
            n: distances.length,
            min: distances.length ? Math.min(...distances) : Number.NaN,
            max: distances.length ? Math.max(...distances) : Number.NaN,
            mean: distances.reduce((sum, value) => sum + value, 0) / Math.max(1, distances.length),
            p95: percentile(distances, 0.95),
            withinLimit: distances.length ? distances.filter((value) => value <= thresholds.agreementM).length / distances.length : Number.NaN,
            excludedTiming: pairing?.excluded ?? 0,
            static: {
              n: pairing?.staticDistances.length ?? 0,
              max: pairing?.staticDistances.length ? Math.max(...pairing.staticDistances.map(([, distance]) => distance)) : Number.NaN,
              p95: percentile((pairing?.staticDistances ?? []).map(([, distance]) => distance), 0.95),
              samples: pairing?.staticDistances ?? [],
            },
            ...(() => {
              const agreement = [...(pairing?.staticDistances ?? []).map(([, distance]) => distance), ...(pairing?.underWay ?? []).map(([, , cross]) => Math.abs(cross))];
              return { agreementMax: agreement.length ? Math.max(...agreement) : Number.NaN, agreementP95: percentile(agreement, 0.95) };
            })(),
            underWay: pairing?.underWay.length
              ? {
                  n: pairing.underWay.length,
                  crossMax: Math.max(...pairing.underWay.map(([, , cross]) => Math.abs(cross))),
                  crossP95: percentile(pairing.underWay.map(([, , cross]) => Math.abs(cross)), 0.95),
                  alongSteadyM: medianOf(pairing.underWay.map(([, along]) => along)),
                  alongP95: percentile(pairing.underWay.map(([, along]) => Math.abs(along)), 0.95),
                  samples: pairing.underWay.map(([time, along, cross]) => [time, along, cross] as [number, number, number]),
                  timing: pairing.timing ?? timingProfile([], timingRule),
                }
              : undefined,
          },
      ellipse: ellipseOf(
        motion.state === "static" ? shots.map((shot) => [shot.crpE, shot.crpN] as [number, number]) : offsets.map(([, dE, dN]) => [dE, dN] as [number, number]),
        motion.state === "static" ? "position" : "control-delta",
      ),
      quality,
      absentFields: system.absentFields,
      flags,
      timing,
    };
  });

  // Flag runs per solution and indicator, joined across short gaps.
  const flagRuns: NavFlagRun[] = [];
  const gapMs = thresholds.mergeGapS * 1000;
  for (const system of systems) {
    for (const indicator of Object.keys(INDICATOR_LABEL) as NavIndicator[]) {
      let run: NavFlagRun | undefined;
      for (const shot of system.shots) {
        if (!system.flags.get(shot.timeMs)?.has(indicator)) continue;
        if (run && shot.timeMs - run.toMs <= gapMs) {
          run.toMs = shot.timeMs + dataset.intervalMs;
          run.shots += 1;
        } else {
          if (run) flagRuns.push(run);
          run = { systemId: system.id, indicator, fromMs: shot.timeMs, toMs: shot.timeMs + dataset.intervalMs, shots: 1 };
        }
      }
      if (run) flagRuns.push(run);
    }
  }

  const lanes = input.rf.lanes.map((lane) => clipLane(lane, window));
  const rf: RfEvidence = { ...input.rf, lanes };
  const windowMs = window.endMs - window.startMs;
  const laneSummaries: LaneSummary[] = lanes.map((lane) => {
    const unmonitored = laneStateDuration(lane, window.startMs, window.endMs, "unmonitored");
    const covered = lane.intervals.reduce((sum, interval) => sum + (interval.toMs - interval.fromMs), 0);
    const anomalies = lane.intervals.filter((interval) => interval.state === "anomaly");
    return {
      lane,
      monitoredFraction: Math.max(0, covered - unmonitored) / windowMs,
      anomalyMs: anomalies.reduce((sum, interval) => sum + interval.toMs - interval.fromMs, 0),
      anomalyCount: anomalies.length,
    };
  });

  const positioningCoverage = gatorCoverage(dataset, window);

  const events = correlate({ systems, flagRuns, lanes, thresholds, positioningCoverage, systemConfigs: input.systems });
  const exceeding = systems.filter((system) => {
    const stats = system.vsControl;
    if (!stats) return false;
    return (stats.static.n > 0 && stats.static.max > limit)
      || (stats.underWay !== undefined && (stats.underWay.crossMax > limit || Math.abs(stats.underWay.alongSteadyM) > limit));
  }).map((system) => system.id);
  let verdict: string;
  let verdictLevel: PositioningAnalysis["verdictLevel"];
  if (events.some((event) => event.kind === "rf-and-nav-common")) {
    verdict = "Navigation degradation coincided with RF interference";
    verdictLevel = "alert";
  } else if (exceeding.length) {
    verdict = `${exceeding.join(", ")} exceeded ${limitText(thresholds.agreementM)} from control ${controlId}`;
    verdictLevel = "check";
  } else {
    verdict = `All comparisons within ${limitText(thresholds.agreementM)} of control ${controlId}; no interference affected positioning`;
    verdictLevel = events.some((event) => event.level === "check") ? "check" : "ok";
  }
  return { controlId, dataset, window, thresholds, systems, times, meanCrp, motion, positioningCoverage, flagRuns, events, rf, lanes: laneSummaries, agreementFailures: exceeding, commonTiming, verdict, verdictLevel };
}

/**
 * The distance the agreement check uses, per shot: 2D while static, across
 * track under way (along-track differences from the logging interval are not assessed).
 */
export function agreementDistances(system: Pick<SystemAnalysis, "vsControl">): Array<[number, number]> {
  const stats = system.vsControl;
  if (!stats) return [];
  if (!stats.underWay) return stats.offsets.map(([time, dE, dN]) => [time, Math.hypot(dE, dN)]);
  return [...stats.static.samples, ...stats.underWay.samples.map(([time, , cross]) => [time, Math.abs(cross)] as [number, number])].sort((left, right) => left[0] - right[0]);
}

/** 95% error ellipse from (E, N) pairs; undefined with fewer than three points. */
function ellipseOf(points: Array<[number, number]>, basis: EllipseStats["basis"]): EllipseStats | undefined {
  if (points.length < 3) return undefined;
  const e = axisStats(points.map(([east]) => east));
  const n = axisStats(points.map(([, north]) => north));
  let covariance = 0;
  for (const [east, north] of points) covariance += (east - e.mean) * (north - n.mean);
  covariance /= points.length - 1;
  const varE = e.sd ** 2;
  const varN = n.sd ** 2;
  const half = (varE + varN) / 2;
  const root = Math.sqrt(((varE - varN) / 2) ** 2 + covariance ** 2);
  const major = half + root;
  const minor = Math.max(0, half - root);
  // Eigenvector of the major eigenvalue; bearing measured clockwise from grid north.
  const vectorE = covariance !== 0 ? covariance : varE >= varN ? 1 : 0;
  const vectorN = covariance !== 0 ? major - varE : varE >= varN ? 0 : 1;
  let bearing = (Math.atan2(vectorE, vectorN) * 180) / Math.PI;
  if (bearing < 0) bearing += 180;
  if (bearing >= 180) bearing -= 180;
  const scale = Math.sqrt(5.991);
  return { meanE: e.mean, meanN: n.mean, sdE: e.sd, sdN: n.sd, sma: scale * Math.sqrt(major), smi: scale * Math.sqrt(minor), orientDeg: bearing, basis };
}

/** A configured limit exactly as entered: 0.5 -> "0.5 m". */
export function limitText(value: number): string {
  return `${Number(value.toFixed(3))} m`;
}

export function metres(value: number): string {
  if (!Number.isFinite(value)) return "–";
  return value >= 1 ? `${value.toFixed(2)} m` : `${value.toFixed(value >= 0.1 ? 2 : 3)} m`;
}

// ---- correlation ----------------------------------------------------------------

interface ClusterItem {
  fromMs: number;
  toMs: number;
  run?: NavFlagRun;
  lane?: RfLane;
}

function list(values: string[]): string {
  if (values.length <= 1) return values.join("");
  return `${values.slice(0, -1).join(", ")} and ${values.at(-1)}`;
}

function correlate(input: {
  systems: SystemAnalysis[];
  flagRuns: NavFlagRun[];
  lanes: RfLane[];
  thresholds: PositioningThresholds;
  positioningCoverage: GatorCoverage;
  systemConfigs: PositioningSystemConfig[];
}): CorrelatedEvent[] {
  const joinMs = 60_000;
  const items: ClusterItem[] = [
    ...input.flagRuns.map((run) => ({ fromMs: run.fromMs, toMs: run.toMs, run })),
    ...input.lanes.flatMap((lane) => lane.intervals.filter((interval) => interval.state === "anomaly").map((interval) => ({ fromMs: interval.fromMs, toMs: interval.toMs, lane }))),
  ].sort((left, right) => left.fromMs - right.fromMs);

  const clusters: ClusterItem[][] = [];
  for (const item of items) {
    const last = clusters.at(-1);
    const lastEnd = last ? Math.max(...last.map((entry) => entry.toMs)) : -Infinity;
    if (last && item.fromMs <= lastEnd + joinMs) last.push(item);
    else clusters.push([item]);
  }

  const configs = input.systemConfigs;
  const allGroups = [...new Set(configs.map((system) => system.antenna))];
  const gnssLanes = input.lanes.filter((lane) => lane.service === "gnss");

  const navEvents: Array<Omit<CorrelatedEvent, "id">> = clusters.map((cluster) => {
    const fromMs = Math.min(...cluster.map((item) => item.fromMs));
    const toMs = Math.max(...cluster.map((item) => item.toMs));
    const runs = cluster.flatMap((item) => (item.run ? [item.run] : []));
    const rfLanes = [...new Map(cluster.flatMap((item) => (item.lane ? [[item.lane.id, item.lane] as const] : []))).values()];
    const gnssAnomaly = rfLanes.filter((lane) => lane.service === "gnss");
    const span = Math.max(1, toMs - fromMs);
    const monitored = (lane: RfLane) => {
      const covered = lane.intervals.reduce((sum, interval) => sum + overlapMs(fromMs, toMs, interval.fromMs, interval.toMs), 0);
      return Math.max(0, covered - laneStateDuration(lane, fromMs, toMs, "unmonitored")) / span;
    };
    const rfCoverage = gnssLanes.length ? Math.min(...gnssLanes.map(monitored)) : 0;
    const bySystem = (indicators: NavIndicator[]) => [...new Set(runs.filter((run) => indicators.includes(run.indicator)).map((run) => run.systemId))].sort();
    const degraded = bySystem(["offset", "sats", "hdop"]);
    const aged = bySystem(["age"]);
    const moded = bySystem(["pcalc"]);
    const allNav = [...new Set(runs.map((run) => run.systemId))].sort();
    const indicators = [...new Set(runs.map((run) => INDICATOR_LABEL[run.indicator]))];
    const config = (id: string) => configs.find((system) => system.id === id)!;
    const hasNav = runs.length > 0;
    const covered = input.positioningCoverage.intervals.some(([from, to]) => overlapMs(fromMs, toMs, from, to) > 0);
    const rfShort = rfLanes.map((lane) => lane.shortLabel);
    const rfSentence = rfLanes.length ? ` RF anomaly on ${list(rfShort)} at the same time.` : " No RF anomaly.";

    let kind: EventKind;
    let level: EventLevel;
    let title: string;
    let explanation: string;
    let action: string;

    if (degraded.length) {
      const groups = [...new Set(degraded.map((id) => config(id).antenna))];
      const receivers = [...new Set(degraded.map((id) => config(id).receiver))];
      if (groups.length === allGroups.length && degraded.length >= Math.ceil(configs.length / 2)) {
        if (gnssAnomaly.length) {
          kind = "rf-and-nav-common";
          level = "alert";
          title = "Navigation degradation coincident with RF interference";
          action = "Log as GNSS interference; keep the rf-monitor evidence package.";
          explanation = `${degraded.length}/${configs.length} solutions on both antennas degraded together; RF anomaly on ${list(gnssAnomaly.map((lane) => lane.shortLabel))}.`;
        } else if (rfCoverage < 0.5) {
          kind = "nav-common-rf-unknown";
          level = "check";
          title = "Navigation degradation on both antennas; RF not monitored";
          action = "Check rf-monitor GNSS coverage for this period.";
          explanation = `${degraded.length}/${configs.length} solutions on both antennas degraded; GNSS bands monitored ${Math.round(rfCoverage * 100)}% of the event.`;
        } else {
          kind = "nav-common-no-rf";
          level = "check";
          title = "Navigation degradation on both antennas without RF evidence";
          action = "Check correction link, ionosphere and satellite geometry.";
          explanation = `${degraded.length}/${configs.length} solutions on both antennas degraded; monitored GNSS bands normal.`;
        }
      } else if (groups.length === 1 && receivers.length > 1) {
        kind = "antenna-group";
        level = "check";
        title = `Degradation limited to the ${groups[0]} antenna`;
        action = `Inspect ${groups[0]} antenna, cable and splitter.`;
        explanation = `Only ${list(degraded)} (${groups[0]} antenna, different receivers); other antenna normal.${rfSentence}`;
      } else if (receivers.length === 1) {
        const siblings = configs.filter((system) => system.receiver === receivers[0]).map((system) => system.id);
        const whole = siblings.every((id) => degraded.includes(id));
        kind = whole ? "single-receiver" : "single-solution";
        level = "check";
        title = whole ? `Degradation limited to ${receivers[0]}` : `Degradation on ${list(degraded)} only`;
        action = whole ? `Check ${receivers[0]} status and logs.` : `Check ${list(degraded.map((id) => config(id).output))} service on ${receivers[0]}.`;
        explanation = whole
          ? `Only ${receivers[0]} (${list(degraded)}); other receivers on the same antenna normal.${rfSentence}`
          : `Only ${list(degraded)}; other output of ${receivers[0]} normal.${rfSentence}`;
      } else {
        kind = "single-receiver";
        level = "check";
        title = `Degradation on ${list(degraded)}`;
        action = `Check ${list(degraded)} receivers and antennas.`;
        explanation = `${list(degraded)}; no common antenna or receiver.${rfSentence}`;
      }
    } else if (aged.length) {
      const beams = [...new Set(aged.map((id) => config(id).beam))];
      const beamComplete = beams.length === 1 && configs.filter((system) => system.beam === beams[0]).every((system) => aged.includes(system.id));
      const beamLane = rfLanes.find((lane) => lane.id === `fugro-${beams[0]?.toLowerCase()}`);
      kind = beamComplete ? "correction-link" : "single-solution";
      level = "check";
      title = beamComplete ? `Correction age raised on all ${beams[0]} solutions` : `Correction age raised on ${list(aged)}`;
      action = beamComplete ? `Check ${beams[0]} signal lock; compare with the other beam.` : `Check correction input on ${list([...new Set(aged.map((id) => config(id).receiver))])}.`;
      explanation = beamComplete
        ? `All ${beams[0]} solutions (${list(aged)}); satellites normal; ${beams[0]} RF lane ${beamLane ? "anomalous" : "normal"}.`
        : `Only ${list(aged)}; other ${beams.join("/")} solutions normal.${rfSentence}`;
    } else if (moded.length) {
      kind = "single-solution";
      level = "info";
      title = moded.length === 1 ? `PCALC changes on ${moded[0]} only` : `PCALC changes on ${list(moded)}`;
      action = `Check ${list(moded.map((id) => `${config(id).output} on ${config(id).receiver}`))}; no RF action.`;
      const partners = moded.flatMap((id) => configs.filter((system) => system.receiver === config(id).receiver && system.id !== id).map((system) => system.id));
      explanation = `Only ${list(moded)}${partners.length ? `; ${list(partners)} on the same receiver normal` : ""}; satellites and HDOP normal.${rfSentence}`;
    } else if (covered) {
      kind = "rf-only";
      level = "info";
      title = `RF anomaly on ${list(rfShort)} with no navigation impact`;
      action = "None for positioning; review the rf-monitor incident.";
      explanation = "All solutions normal during the RF anomaly.";
    } else {
      kind = "rf-no-nav-data";
      level = "check";
      title = `RF anomaly on ${list(rfShort)}; no positioning data`;
      action = "Export Gator data for this period to assess impact.";
      explanation = "No Gator data for this period.";
    }

    const evidence: CorrelatedEvent["evidence"] = hasNav && rfLanes.length ? "RF + navigation" : rfLanes.length ? "RF only" : "Navigation only";
    return { fromMs, toMs, kind, level, title, evidence, systems: allNav, indicators, rfLanes: rfShort, rfCoverage: Math.max(0, rfCoverage), explanation, action };
  });

  return navEvents
    .sort((left, right) => left.fromMs - right.fromMs || left.toMs - right.toMs)
    .map((event, index) => ({ ...event, id: `E${index + 1}` }));
}
