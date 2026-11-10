/**
 * Chart specs for the DGNSS verification report, laid out like the existing
 * DGNSS verification deliverable, with rf-monitor RF periods shaded on every
 * time series. Drawn by the shared report renderers (SVG and PDF vector).
 *
 * Series colours: six categorical slots in fixed order, one per DGNSS system
 * everywhere (validated: adjacent CVD dE >= 9.1, normal-vision >= 19.6 on
 * white; three slots are below 3:1 contrast, so values are also tabulated).
 */
import { numericTicks, timeAxisTicks, type ChartLegendItem, type ChartPoint, type ChartRegion, type ChartSeries, type ChartSpec } from "../report/chartSpec";
import { REPORT_COLORS } from "../report/theme";
import { niceStep } from "../chartKit";
import { limitText, percentile, type PositioningAnalysis, type SystemAnalysis } from "./analysis";
import type { RfLaneState } from "./types";

export const SYSTEM_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300"] as const;

const RF_SHADE = { color: REPORT_COLORS.anomaly, opacity: 0.12 };
const STATE = {
  normal: { color: REPORT_COLORS.usual, opacity: 0.3, label: "Normal" },
  anomaly: { color: REPORT_COLORS.anomaly, opacity: 0.9, label: "RF anomaly" },
  flag: { color: REPORT_COLORS.alertLevel, opacity: 0.9, label: "Navigation flag" },
  none: { color: REPORT_COLORS.before, opacity: 0.22, label: "Not monitored / no data" },
} as const;
type StateKey = keyof typeof STATE;

const WIDE = 760;

export function colorOf(analysis: PositioningAnalysis, id: string): string {
  return SYSTEM_COLORS[Math.max(0, analysis.systems.findIndex((system) => system.id === id)) % SYSTEM_COLORS.length];
}

export function niceCeil(value: number, minimum: number): number {
  const target = Math.max(minimum, value);
  const step = niceStep(target / 4);
  return Math.ceil(target / step) * step;
}

function decimalsFor(span: number): number {
  return span <= 0.2 ? 2 : span <= 2 ? 1 : 0;
}

/** Whole-number ticks only (satellites, age, PCALC). */
function integerTicks(min: number, max: number, target: number) {
  const step = Math.max(1, niceStep((max - min) / Math.max(1, target)));
  const ticks = [];
  for (let value = Math.ceil(min / step) * step; value <= max; value += step) ticks.push({ value, label: String(value) });
  return ticks;
}

export function timeAxis(analysis: PositioningAnalysis) {
  return { label: "UTC (HH:MM:SS)", min: analysis.window.startMs, max: analysis.window.endMs, ticks: timeAxisTicks(analysis.window.startMs, analysis.window.endMs, 9) };
}

/** Union of GNSS-lane anomaly periods, shaded on every time series. */
export function rfAnomalyRegions(analysis: PositioningAnalysis, beam?: string): ChartRegion[] {
  const lanes = analysis.rf.lanes.filter((lane) => lane.service === "gnss" || (beam && lane.id === `fugro-${beam.toLowerCase()}`));
  const spans = lanes.flatMap((lane) => lane.intervals.filter((interval) => interval.state === "anomaly").map((interval) => [interval.fromMs, interval.toMs] as [number, number])).sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  return merged.map(([from, to]) => ({ from, to, ...RF_SHADE }));
}

export function noDataRegions(analysis: PositioningAnalysis): ChartRegion[] {
  const { window, positioningCoverage } = analysis;
  const regions: ChartRegion[] = [];
  const shade = { color: REPORT_COLORS.before, opacity: 0.12, label: "No Gator data" };
  if (positioningCoverage.fromMs > window.startMs) regions.push({ from: window.startMs, to: positioningCoverage.fromMs, ...shade });
  if (positioningCoverage.toMs < window.endMs) regions.push({ from: positioningCoverage.toMs, to: window.endMs, ...shade });
  return regions;
}

export function regionLegend(analysis: PositioningAnalysis, regions: ChartRegion[]): ChartLegendItem[] {
  const items: ChartLegendItem[] = [];
  if (regions.some((region) => region.color === RF_SHADE.color)) items.push({ name: "RF anomaly", color: RF_SHADE.color, style: "region" });
  if (regions.some((region) => region.label === "No Gator data")) items.push({ name: "No Gator data", color: REPORT_COLORS.before, style: "region" });
  return items;
}

/** Min/max per time bucket keeps spikes visible over 24 h; gaps stay gaps. */
export function timeSeries(samples: Array<[number, number | null]>, analysis: PositioningAnalysis, buckets = 900): ChartPoint[] {
  const intervalMs = analysis.dataset.intervalMs;
  const raw: ChartPoint[] = [];
  let previous: number | undefined;
  for (const [time, value] of samples) {
    if (value === null || !Number.isFinite(value)) {
      raw.push(null);
      previous = undefined;
      continue;
    }
    if (previous !== undefined && time - previous > intervalMs * 3) raw.push(null);
    raw.push([time, value]);
    previous = time;
  }
  if (raw.length <= buckets * 2) return raw;
  const size = (analysis.window.endMs - analysis.window.startMs) / buckets;
  const output: ChartPoint[] = [];
  let bucket = -1;
  let low: [number, number] | undefined;
  let high: [number, number] | undefined;
  const flush = () => {
    if (!low || !high) return;
    output.push(...(low[0] <= high[0] ? [low, high] : [high, low]));
    low = high = undefined;
  };
  for (const point of raw) {
    if (!point) {
      flush();
      output.push(null);
      continue;
    }
    const index = Math.floor((point[0] - analysis.window.startMs) / size);
    if (index !== bucket) {
      flush();
      bucket = index;
    }
    if (!low || point[1] < low[1]) low = point;
    if (!high || point[1] > high[1]) high = point;
  }
  flush();
  return output;
}

// ---- all sensors relative to control ---------------------------------------------

function comparisons(analysis: PositioningAnalysis): SystemAnalysis[] {
  return analysis.systems.filter((system) => !system.isControl);
}

function deltaChart(analysis: PositioningAnalysis, kind: "e" | "n" | "range"): ChartSpec {
  const systems = comparisons(analysis);
  const pick = ([, dE, dN]: [number, number, number]) => (kind === "e" ? dE : kind === "n" ? dN : Math.hypot(dE, dN));
  const values = systems.flatMap((system) => (system.vsControl?.offsets ?? []).map(pick));
  const limit = analysis.thresholds.agreementM;
  let min: number;
  let max: number;
  if (kind === "range") {
    min = 0;
    max = niceCeil(Math.max(limit * 1.15, ...values.map((value) => value * 1.1)), 0.1);
  } else {
    const extent = niceCeil(Math.max(0.05, ...values.map((value) => Math.abs(value) * 1.15)), 0.05);
    min = -extent;
    max = extent;
  }
  const regions = [...noDataRegions(analysis), ...rfAnomalyRegions(analysis)];
  const control = analysis.systems.find((system) => system.isControl)!;
  const label = kind === "e" ? "Delta Easting (m)" : kind === "n" ? "Delta Northing (m)" : "2D Range (m)";
  return {
    id: `delta-${kind}`,
    title: label.replace(" (m)", ""),
    caption: "",
    ariaLabel: `${label} of each comparison system relative to control ${control.id} over time.`,
    width: WIDE,
    height: 250,
    x: timeAxis(analysis),
    y: { label, min, max, ticks: numericTicks(min, max, 5, (value) => value.toFixed(decimalsFor(max - min))) },
    xRegions: regions,
    series: systems.map((system) => ({ kind: "line" as const, name: system.id, color: colorOf(analysis, system.id), width: 1.3, points: timeSeries((system.vsControl?.offsets ?? []).map((offset) => [offset[0], pick(offset)]), analysis) })),
    hRules: kind === "range" ? [{ value: limit, color: REPORT_COLORS.anomaly, dash: [6, 4], label: `Control threshold (${limitText(limit)})` }] : [{ value: 0, color: REPORT_COLORS.ink, dash: [4, 3] }],
    legend: [...systems.map((system) => ({ name: system.id, color: colorOf(analysis, system.id), style: "line" as const })), ...(kind !== "range" ? [{ name: "Control = 0", color: REPORT_COLORS.ink, style: "dash" as const }] : []), ...regionLegend(analysis, regions)],
  };
}

function deltaEllipse(offsets: Array<[number, number, number]>): ChartPoint[] {
  if (offsets.length < 3) return [];
  const meanE = offsets.reduce((sum, [, dE]) => sum + dE, 0) / offsets.length;
  const meanN = offsets.reduce((sum, [, , dN]) => sum + dN, 0) / offsets.length;
  let varE = 0;
  let varN = 0;
  let cov = 0;
  for (const [, dE, dN] of offsets) {
    varE += (dE - meanE) ** 2;
    varN += (dN - meanN) ** 2;
    cov += (dE - meanE) * (dN - meanN);
  }
  const n = offsets.length - 1;
  varE /= n;
  varN /= n;
  cov /= n;
  const half = (varE + varN) / 2;
  const root = Math.sqrt(((varE - varN) / 2) ** 2 + cov ** 2);
  const major = half + root;
  const minor = Math.max(0, half - root);
  const theta = cov !== 0 ? Math.atan2(major - varE, cov) : varE >= varN ? 0 : Math.PI / 2;
  const a = Math.sqrt(5.991 * major);
  const b = Math.sqrt(5.991 * minor);
  const points: ChartPoint[] = [];
  for (let step = 0; step <= 72; step += 1) {
    const t = (step / 72) * 2 * Math.PI;
    const x = a * Math.cos(t);
    const y = b * Math.sin(t);
    points.push([meanE + x * Math.cos(theta) - y * Math.sin(theta), meanN + x * Math.sin(theta) + y * Math.cos(theta)]);
  }
  return points;
}

function controlScatter(analysis: PositioningAnalysis, view: "overview" | "detail"): ChartSpec {
  const systems = comparisons(analysis);
  const limit = analysis.thresholds.agreementM;
  const control = analysis.systems.find((system) => system.isControl)!;
  const extents = systems.flatMap((system) => {
    const offsets = system.vsControl?.offsets ?? [];
    return offsets.length ? [percentile(offsets.map(([, dE]) => Math.abs(dE)), 0.995), percentile(offsets.map(([, , dN]) => Math.abs(dN)), 0.995)] : [];
  });
  const dataRange = Math.max(0.02, ...extents.map((value) => value * 1.25));
  const range = view === "overview" ? niceCeil(Math.max(limit * 1.2, dataRange), 0.1) : niceCeil(dataRange, 0.02);
  const circle: ChartPoint[] = [];
  for (let step = 0; step <= 96; step += 1) circle.push([limit * Math.cos((step / 96) * 2 * Math.PI), limit * Math.sin((step / 96) * 2 * Math.PI)]);
  const arm = range * 0.05;
  const series: ChartSeries[] = [];
  for (const system of systems) {
    const offsets = system.vsControl?.offsets ?? [];
    const stride = Math.max(1, Math.ceil(offsets.length / 600));
    series.push({ kind: "points", name: system.id, color: colorOf(analysis, system.id), radius: view === "overview" ? 1.7 : 2.1, points: offsets.filter(([, dE, dN], index) => index % stride === 0 || Math.hypot(dE, dN) > limit).map(([, dE, dN]) => [dE, dN]) });
  }
  if (view === "detail") for (const system of systems) series.push({ kind: "line", name: `${system.id} 95%`, color: colorOf(analysis, system.id), width: 1.6, points: deltaEllipse(system.vsControl?.offsets ?? []) });
  if (limit <= range) series.push({ kind: "line", name: "Threshold", color: REPORT_COLORS.anomaly, width: 1.4, dash: [6, 4], points: circle });
  series.push({ kind: "line", name: "Control", color: REPORT_COLORS.ink, width: 2, points: [[-arm, 0], [arm, 0], null, [0, -arm], [0, arm]] });
  const decimals = decimalsFor(range * 2);
  return {
    id: `scatter-${view}`,
    title: view === "overview" ? `Overview with ${limitText(limit)} threshold` : "Detail with 95% ellipses",
    caption: "",
    ariaLabel: `Scatter of each comparison system's CRP delta from control ${control.id}${view === "overview" ? ` with the ${limitText(limit)} threshold circle` : ", zoomed to the data, with 95% ellipses"}.`,
    width: 380,
    height: 360,
    x: { label: "Delta Easting (m)", min: -range, max: range, ticks: numericTicks(-range, range, 4, (value) => value.toFixed(decimals)) },
    y: { label: "Delta Northing (m)", min: -range, max: range, ticks: numericTicks(-range, range, 4, (value) => value.toFixed(decimals)) },
    series,
    hRules: [{ value: 0, color: REPORT_COLORS.rule }],
    vRules: [{ value: 0, color: REPORT_COLORS.rule }],
    legend: [],
  };
}

// ---- per-system time series ---------------------------------------------------------

interface LaneSpan {
  fromMs: number;
  toMs: number;
  state: StateKey;
}

export function laneChart(analysis: PositioningAnalysis, input: { id: string; title: string; lanes: Array<{ label: string; spans: LaneSpan[] }>; separatorAfter?: number; states: StateKey[]; events?: boolean; height?: number }): ChartSpec {
  const count = input.lanes.length;
  const minimumWidth = (analysis.window.endMs - analysis.window.startMs) / 700;
  const bands = new Map<StateKey, { upper: ChartPoint[]; lower: ChartPoint[] }>();
  input.lanes.forEach((lane, index) => {
    const top = count - index - 0.16;
    const bottom = count - index - 0.84;
    for (const span of lane.spans) {
      let { fromMs, toMs } = span;
      if ((span.state === "anomaly" || span.state === "flag") && toMs - fromMs < minimumWidth) {
        const middle = (fromMs + toMs) / 2;
        fromMs = middle - minimumWidth / 2;
        toMs = middle + minimumWidth / 2;
      }
      const entry = bands.get(span.state) ?? { upper: [], lower: [] };
      entry.upper.push([fromMs, top], [toMs, top], null);
      entry.lower.push([fromMs, bottom], [toMs, bottom], null);
      bands.set(span.state, entry);
    }
  });
  const order: StateKey[] = ["none", "normal", "flag", "anomaly"];
  const events = input.events ? analysis.events : [];
  return {
    id: input.id,
    title: input.title,
    caption: "",
    ariaLabel: `${input.title}: lanes ${input.lanes.map((lane) => lane.label).join(", ")}.`,
    width: WIDE,
    height: input.height ?? 86 + count * 23,
    x: timeAxis(analysis),
    y: { label: "", min: 0, max: count, ticks: input.lanes.map((lane, index) => ({ value: count - index - 0.5, label: lane.label })) },
    series: order.filter((state) => bands.has(state)).map((state) => ({ kind: "band" as const, name: STATE[state].label, color: STATE[state].color, opacity: STATE[state].opacity, ...bands.get(state)! })),
    hRules: input.separatorAfter !== undefined ? [{ value: count - input.separatorAfter, color: REPORT_COLORS.muted }] : [],
    vRules: events.map((event) => ({ value: event.fromMs, color: REPORT_COLORS.navy, dash: [3, 3], label: event.id })),
    legend: input.states.filter((state) => bands.has(state)).map((state) => ({ name: STATE[state].label, color: STATE[state].color, style: "region" as const })),
  };
}

function runLength(items: Array<{ fromMs: number; toMs: number; state: StateKey }>): LaneSpan[] {
  const output: LaneSpan[] = [];
  for (const item of items) {
    const last = output.at(-1);
    if (last && last.state === item.state && item.fromMs - last.toMs <= 1) last.toMs = item.toMs;
    else output.push({ ...item });
  }
  return output;
}

function navSpans(analysis: PositioningAnalysis, system: SystemAnalysis): LaneSpan[] {
  const interval = analysis.dataset.intervalMs;
  const spans: LaneSpan[] = [];
  if (analysis.positioningCoverage.fromMs > analysis.window.startMs) spans.push({ fromMs: analysis.window.startMs, toMs: analysis.positioningCoverage.fromMs, state: "none" });
  spans.push(...runLength(system.shots.map((shot) => ({ fromMs: shot.timeMs, toMs: shot.timeMs + interval, state: system.flags.get(shot.timeMs)?.size ? "flag" : "normal" }))));
  if (analysis.positioningCoverage.toMs < analysis.window.endMs) spans.push({ fromMs: analysis.positioningCoverage.toMs, toMs: analysis.window.endMs, state: "none" });
  return spans;
}

function rfState(state: RfLaneState): StateKey {
  return state === "anomaly" ? "anomaly" : state === "unmonitored" ? "none" : "normal";
}

/** All GNSS lanes folded into one: anomaly beats not-monitored beats normal. */
function gnssCombinedSpans(analysis: PositioningAnalysis): LaneSpan[] {
  const gnss = analysis.rf.lanes.filter((lane) => lane.service === "gnss");
  const edges = [...new Set([analysis.window.startMs, analysis.window.endMs, ...gnss.flatMap((lane) => lane.intervals.flatMap((interval) => [interval.fromMs, interval.toMs]))])].sort((left, right) => left - right);
  const spans: Array<{ fromMs: number; toMs: number; state: StateKey }> = [];
  for (let index = 0; index < edges.length - 1; index += 1) {
    const middle = (edges[index] + edges[index + 1]) / 2;
    const states = gnss.map((lane) => lane.intervals.find((interval) => interval.fromMs <= middle && interval.toMs > middle)?.state ?? "unmonitored");
    const state: StateKey = states.includes("anomaly") ? "anomaly" : states.includes("unmonitored") ? "none" : "normal";
    spans.push({ fromMs: edges[index], toMs: edges[index + 1], state });
  }
  return runLength(spans);
}

function systemPanels(analysis: PositioningAnalysis, system: SystemAnalysis): ChartSpec[] {
  const color = colorOf(analysis, system.id);
  const beamLane = analysis.rf.lanes.find((lane) => lane.id === `fugro-${system.config.beam.toLowerCase()}`);
  const regions = [...noDataRegions(analysis), ...rfAnomalyRegions(analysis, system.config.beam)];
  const panel = (key: string, label: string, pick: (shot: SystemAnalysis["shots"][number]) => number | null, options: { integer?: boolean; floorZero?: boolean; minSpan?: number } = {}): ChartSpec => {
    const values = system.shots.map(pick).filter((value): value is number => value !== null);
    const low = values.length ? Math.min(...values) : 0;
    const high = values.length ? Math.max(...values) : 1;
    const pad = Math.max((high - low) * 0.15, options.minSpan ?? (options.integer ? 2 : 0.3));
    const min = options.floorZero ? 0 : Math.max(0, options.integer ? Math.floor(low - pad) : Math.floor((low - pad) * 10) / 10);
    const max = options.integer ? Math.ceil(high + pad) : Math.ceil((high + pad) * 10) / 10;
    return {
      id: `sys-${system.id}-${key}`,
      title: label,
      caption: "",
      ariaLabel: `${system.id} ${label} over time.`,
      width: WIDE,
      height: 150,
      x: timeAxis(analysis),
      y: { label, min, max, ticks: options.integer ? integerTicks(min, max, 4) : numericTicks(min, max, 4, (value) => value.toFixed(1)) },
      xRegions: regions,
      series: values.length ? [{ kind: "line", name: system.id, color, width: 1.4, points: timeSeries(system.shots.map((shot) => [shot.timeMs, pick(shot)]), analysis) }] : [],
      legend: [],
      emptyMessage: values.length ? undefined : "Not output by this solution",
    };
  };
  return [
    laneChart(analysis, {
      id: `sys-${system.id}-rf`,
      title: "RF (rf-monitor)",
      lanes: [{ label: "GNSS bands", spans: gnssCombinedSpans(analysis) }, ...(beamLane ? [{ label: beamLane.shortLabel, spans: beamLane.intervals.map((interval) => ({ fromMs: interval.fromMs, toMs: interval.toMs, state: rfState(interval.state) })) }] : []), { label: "Nav flags", spans: navSpans(analysis, system) }],
      states: ["normal", "anomaly", "flag", "none"],
    }),
    panel("sats", "#Sats", (shot) => shot.nsats, { integer: true }),
    panel("age", "Age (s)", (shot) => shot.ageS, { integer: true, floorZero: true }),
    panel("pcalc", "PCALC", (shot) => shot.pcalc, { integer: true, minSpan: 1 }),
    panel("hdop", "HDOP", (shot) => shot.hdop, { floorZero: true }),
    panel("pdop", "PDOP", (shot) => shot.pdop, { floorZero: true }),
  ];
}

// ---- RF page and speed ------------------------------------------------------------------

function evidenceTimeline(analysis: PositioningAnalysis): ChartSpec {
  return laneChart(analysis, {
    id: "evidence-timeline",
    title: "RF lanes (rf-monitor) and navigation flags",
    lanes: [
      ...analysis.rf.lanes.map((lane) => ({ label: lane.shortLabel, spans: lane.intervals.map((interval) => ({ fromMs: interval.fromMs, toMs: interval.toMs, state: rfState(interval.state) })) })),
      ...analysis.systems.map((system) => ({ label: system.id, spans: navSpans(analysis, system) })),
    ],
    separatorAfter: analysis.rf.lanes.length,
    states: ["normal", "anomaly", "flag", "none"],
    events: true,
  });
}

function speedChart(analysis: PositioningAnalysis): ChartSpec {
  const knots = analysis.motion.series.map(([, value]) => value);
  const max = niceCeil(Math.max(analysis.thresholds.movingKnots * 1.5, ...knots.map((value) => value * 1.1)), 0.5);
  const regions = [...noDataRegions(analysis), ...rfAnomalyRegions(analysis)];
  return {
    id: "speed",
    title: "Vessel speed",
    caption: "",
    ariaLabel: "Vessel speed from the mean CRP over time.",
    width: WIDE,
    height: 250,
    x: timeAxis(analysis),
    y: { label: "Speed (kn)", min: 0, max, ticks: numericTicks(0, max, 5, (value) => value.toFixed(1)) },
    xRegions: regions,
    series: [{ kind: "line", name: "Speed", color: REPORT_COLORS.accent, width: 1.3, points: timeSeries(analysis.motion.series, analysis) }],
    hRules: [{ value: analysis.thresholds.movingKnots, color: REPORT_COLORS.anomaly, dash: [6, 4], label: `Movement threshold (${analysis.thresholds.movingKnots} kn)` }],
    legend: regionLegend(analysis, regions),
  };
}

export function buildPositioningCharts(analysis: PositioningAnalysis): ChartSpec[] {
  return [
    deltaChart(analysis, "e"),
    deltaChart(analysis, "n"),
    deltaChart(analysis, "range"),
    controlScatter(analysis, "overview"),
    controlScatter(analysis, "detail"),
    ...analysis.systems.flatMap((system) => systemPanels(analysis, system)),
    evidenceTimeline(analysis),
    speedChart(analysis),
  ];
}
