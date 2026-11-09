/**
 * A chart described once and drawn twice: as SVG (HTML report, stand-alone
 * files, in-app views) and as PDF vector graphics. Specs are plain JSON so they
 * can be stored in report.json and redrawn later without re-reading evidence.
 */
import { niceStep } from "../chartKit";
import { utcTime } from "./format";

/** One sample; null breaks a line so gaps are drawn as gaps. */
export type ChartPoint = [number, number] | null;

export interface ChartTick {
  value: number;
  label: string;
}

export interface ChartAxis {
  label: string;
  min: number;
  max: number;
  ticks: ChartTick[];
}

export type ChartSeries =
  | { kind: "line"; name: string; color: string; width?: number; dash?: number[]; points: ChartPoint[] }
  | { kind: "points"; name: string; color: string; radius?: number; points: ChartPoint[]; colors?: string[] }
  | { kind: "area"; name: string; color: string; opacity: number; points: ChartPoint[] }
  | { kind: "band"; name: string; color: string; opacity: number; upper: ChartPoint[]; lower: ChartPoint[] };

export interface ChartRegion {
  from: number;
  to: number;
  color: string;
  opacity: number;
  label?: string;
}

export interface ChartRule {
  value: number;
  color: string;
  dash?: number[];
  label?: string;
}

export interface ChartLegendItem {
  name: string;
  color: string;
  style: "line" | "dash" | "area" | "region";
}

export interface ChartImage {
  /** PNG bytes, base64, drawn stretched over the plot area. */
  pngBase64: string;
  widthPx: number;
  heightPx: number;
}

export interface ChartSpec {
  id: string;
  title: string;
  /** One-line "how to read" caption shown under the chart. */
  caption: string;
  ariaLabel: string;
  width: number;
  height: number;
  x: ChartAxis;
  y: ChartAxis;
  series: ChartSeries[];
  xRegions?: ChartRegion[];
  hRules?: ChartRule[];
  vRules?: ChartRule[];
  image?: ChartImage;
  legend: ChartLegendItem[];
  emptyMessage?: string;
  /** Lines printed under a stand-alone chart file (time stamp, data window, scope). */
  footer?: string[];
}

export const CHART_MARGIN = { left: 84, right: 22, top: 36, bottom: 50 } as const;

export function plotBox(spec: Pick<ChartSpec, "width" | "height">) {
  return {
    left: CHART_MARGIN.left,
    top: CHART_MARGIN.top,
    width: spec.width - CHART_MARGIN.left - CHART_MARGIN.right,
    height: spec.height - CHART_MARGIN.top - CHART_MARGIN.bottom,
  };
}

export function numericTicks(min: number, max: number, target: number, format: (value: number) => string): ChartTick[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return [{ value: min, label: format(min) }];
  const step = niceStep((max - min) / Math.max(1, target));
  const ticks: ChartTick[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) {
    ticks.push({ value: Number(value.toPrecision(12)), label: format(Number(value.toPrecision(12))) });
  }
  return ticks;
}

const TIME_STEPS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600, 43200, 86400].map((seconds) => seconds * 1000);

export function timeAxisTicks(startMs: number, endMs: number, target: number): ChartTick[] {
  const span = Math.max(1, endMs - startMs);
  const step = TIME_STEPS_MS.find((candidate) => span / candidate <= target) ?? TIME_STEPS_MS[TIME_STEPS_MS.length - 1];
  const ticks: ChartTick[] = [];
  for (let tick = Math.ceil(startMs / step) * step; tick <= endMs; tick += step) ticks.push({ value: tick, label: utcTime(tick) });
  return ticks;
}

export function frequencyAxisTicks(startHz: number, endHz: number, target: number): ChartTick[] {
  const step = niceStep((endHz - startHz) / Math.max(1, target));
  const decimals = step >= 1e6 ? 0 : step >= 1e5 ? 1 : step >= 1e4 ? 2 : 3;
  return numericTicks(startHz, endHz, target, (value) => (value / 1e6).toFixed(decimals));
}

/**
 * Robust y range for relative levels: data-driven with padding, so a quiet
 * band is not squashed into the bottom of a fixed 0-255 axis.
 */
export function levelRange(values: number[], options: { floor?: number; ceiling?: number; minimumSpan?: number } = {}): [number, number] {
  const finite = values.filter((value) => Number.isFinite(value));
  if (!finite.length) return [0, 255];
  const sorted = [...finite].sort((left, right) => left - right);
  const low = sorted[Math.floor(sorted.length * 0.005)];
  const high = sorted[sorted.length - 1];
  const span = Math.max(options.minimumSpan ?? 20, high - low);
  let min = low - span * 0.1;
  let max = high + span * 0.15;
  min = Math.max(options.floor ?? 0, Math.floor(min / 5) * 5);
  max = Math.min(options.ceiling ?? 255, Math.ceil(max / 5) * 5);
  if (max <= min) max = min + 10;
  return [min, max];
}

/** Split a point list into drawable runs at nulls. */
export function runs(points: ChartPoint[]): Array<Array<[number, number]>> {
  const output: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  for (const point of points) {
    if (point && Number.isFinite(point[0]) && Number.isFinite(point[1])) current.push(point);
    else if (current.length) {
      output.push(current);
      current = [];
    }
  }
  if (current.length) output.push(current);
  return output;
}

export function scaleX(spec: Pick<ChartSpec, "x" | "width" | "height">, value: number): number {
  const box = plotBox(spec);
  const span = spec.x.max - spec.x.min || 1;
  return box.left + ((value - spec.x.min) / span) * box.width;
}

export function scaleY(spec: Pick<ChartSpec, "y" | "width" | "height">, value: number): number {
  const box = plotBox(spec);
  const span = spec.y.max - spec.y.min || 1;
  const clamped = Math.min(spec.y.max, Math.max(spec.y.min, value));
  return box.top + box.height - ((clamped - spec.y.min) / span) * box.height;
}

/** Point list → SVG path in chart coordinates (y down). Shared by both renderers. */
export function linePath(spec: ChartSpec, points: ChartPoint[]): string {
  return runs(points)
    .map((run) => run.map(([x, y], index) => `${index ? "L" : "M"}${scaleX(spec, x).toFixed(1)} ${scaleY(spec, y).toFixed(1)}`).join(" "))
    .join(" ");
}

export function areaPaths(spec: ChartSpec, points: ChartPoint[]): string[] {
  const baseline = scaleY(spec, spec.y.min);
  return runs(points).filter((run) => run.length > 1).map((run) => {
    const top = run.map(([x, y], index) => `${index ? "L" : "M"}${scaleX(spec, x).toFixed(1)} ${scaleY(spec, y).toFixed(1)}`).join(" ");
    return `${top} L${scaleX(spec, run.at(-1)![0]).toFixed(1)} ${baseline.toFixed(1)} L${scaleX(spec, run[0][0]).toFixed(1)} ${baseline.toFixed(1)} Z`;
  });
}

export function bandPaths(spec: ChartSpec, upper: ChartPoint[], lower: ChartPoint[]): string[] {
  const paths: string[] = [];
  let currentUpper: Array<[number, number]> = [];
  let currentLower: Array<[number, number]> = [];
  const flush = () => {
    if (currentUpper.length > 1) {
      const top = currentUpper.map(([x, y], index) => `${index ? "L" : "M"}${scaleX(spec, x).toFixed(1)} ${scaleY(spec, y).toFixed(1)}`).join(" ");
      const bottom = [...currentLower].reverse().map(([x, y]) => `L${scaleX(spec, x).toFixed(1)} ${scaleY(spec, y).toFixed(1)}`).join(" ");
      paths.push(`${top} ${bottom} Z`);
    }
    currentUpper = [];
    currentLower = [];
  };
  for (let index = 0; index < Math.min(upper.length, lower.length); index += 1) {
    const top = upper[index];
    const bottom = lower[index];
    if (top && bottom) {
      currentUpper.push(top);
      currentLower.push(bottom);
    } else flush();
  }
  flush();
  return paths;
}
