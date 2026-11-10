import type { AlertTriggerSnapshot, DetectionEvent } from "../../shared/types";
import { detailKindLabel } from "../../shared/alertPolicy";
import { frequencyAxisTicks, levelRange, numericTicks, type ChartPoint, type ChartSpec } from "./chartSpec";
import { REPORT_COLORS } from "./theme";
import { utcDateTime } from "./format";

function decodeHex(value: string): Uint8Array {
  return /^[0-9a-f]*$/i.test(value) && value.length % 2 === 0 ? Uint8Array.from(Buffer.from(value, "hex")) : new Uint8Array();
}

export interface TriggerChartOptions {
  /** Narrower drawing for the incident drawer: readable at about 460 px, short legend. */
  compact?: boolean;
  /** Only the disturbed frequencies, with some clean spectrum either side. */
  disturbedOnly?: boolean;
}

/** Bin range around the raised frequencies, or the whole window when there are none. */
function focusBins(snapshot: AlertTriggerSnapshot, count: number): [number, number] {
  const ranges = snapshot.anomalyBinRanges.filter((range) => range.endBin > range.startBin);
  if (!ranges.length || count < 8) return [0, count];
  const first = Math.max(0, Math.min(...ranges.map((range) => range.startBin)));
  const last = Math.min(count, Math.max(...ranges.map((range) => range.endBin)));
  const margin = Math.max(Math.round((last - first) * 1.5), Math.round(count * 0.04), 4);
  const from = Math.max(0, first - margin);
  const to = Math.min(count, last + margin);
  return to - from >= count * 0.9 ? [0, count] : [from, to];
}

/** Exactly what the detector compared at the moment the alert was raised. */
export function triggerSnapshotChart(snapshot: AlertTriggerSnapshot, event?: Pick<DetectionEvent, "bandLabel" | "affectedLabel">, options: TriggerChartOptions = {}): ChartSpec {
  const levels = decodeHex(snapshot.levelsHex);
  const usual = decodeHex(snapshot.usualHex);
  const alert = decodeHex(snapshot.alertLevelHex);
  const count = Math.min(levels.length, usual.length, alert.length);
  const [windowStartHz, windowEndHz] = snapshot.analyzedRangeHz;
  const binHz = count ? (windowEndHz - windowStartHz) / count : 1;
  const [fromBin, toBin] = options.disturbedOnly ? focusBins(snapshot, count) : [0, count];
  const startHz = windowStartHz + fromBin * binHz;
  const endHz = windowStartHz + toBin * binHz;
  const at = (index: number) => windowStartHz + (index + 0.5) * binHz;
  const series = (values: Uint8Array): ChartPoint[] => Array.from({ length: toBin - fromBin }, (_, offset) => [at(fromBin + offset), values[fromBin + offset]] as [number, number]);
  const visible = (values: Uint8Array) => values.subarray(fromBin, toBin);
  const [yMin, yMax] = levelRange([...visible(levels), ...visible(usual), ...visible(alert)]);
  const label = event?.affectedLabel ?? event?.bandLabel ?? snapshot.targetId;
  const compact = Boolean(options.compact);
  return {
    id: "trigger-snapshot",
    title: `What the detector saw at the alert: ${label}`,
    caption: `${detailKindLabel(snapshot.detailKind)} at ${utcDateTime(snapshot.observedAt)}. Red areas were above the alert level. Levels are relative and uncalibrated.`,
    ariaLabel: `Spectrum at the moment of the alert. Received level in blue, usual level in green, alert level dashed amber, raised frequencies shaded red.`,
    width: compact ? 560 : 960,
    height: compact ? 290 : 340,
    x: { label: "Frequency (MHz)", min: startHz, max: endHz, ticks: frequencyAxisTicks(startHz, endHz, compact ? 5 : 8) },
    y: { label: compact ? "Relative level" : "Relative level (0–255)", min: yMin, max: yMax, ticks: numericTicks(yMin, yMax, compact ? 4 : 5, (value) => String(Math.round(value))) },
    series: count ? [
      { kind: "area", name: "Received", color: REPORT_COLORS.receivedFill, opacity: 0.12, points: series(levels) },
      { kind: "line", name: "Usual level", color: REPORT_COLORS.usual, width: 1.6, points: series(usual) },
      { kind: "line", name: "Alert level", color: REPORT_COLORS.alertLevel, width: 1.4, dash: [6, 4], points: series(alert) },
      { kind: "line", name: "Received", color: REPORT_COLORS.received, width: 1.4, points: series(levels) },
    ] : [],
    xRegions: snapshot.anomalyBinRanges
      .map((range) => ({ from: windowStartHz + Math.max(range.startBin, fromBin) * binHz, to: windowStartHz + Math.min(range.endBin, toBin) * binHz }))
      .filter((region) => region.to > region.from)
      .map((region) => ({ ...region, color: REPORT_COLORS.anomaly, opacity: 0.16 })),
    legend: [
      { name: compact ? "Received" : "Received at the alert", color: REPORT_COLORS.received, style: "line" },
      { name: compact ? "Usual" : "Usual level", color: REPORT_COLORS.usual, style: "line" },
      { name: "Alert level", color: REPORT_COLORS.alertLevel, style: "dash" },
      { name: compact ? "Above alert" : "Above alert level", color: REPORT_COLORS.anomaly, style: "region" },
    ],
    ...(count ? {} : { emptyMessage: "No spectrum was stored for this alert." }),
  };
}
