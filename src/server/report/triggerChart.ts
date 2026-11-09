import type { AlertTriggerSnapshot, DetectionEvent } from "../../shared/types";
import { detailKindLabel } from "../../shared/alertPolicy";
import { frequencyAxisTicks, levelRange, numericTicks, type ChartPoint, type ChartSpec } from "./chartSpec";
import { REPORT_COLORS } from "./theme";
import { utcDateTime } from "./format";

function decodeHex(value: string): Uint8Array {
  return /^[0-9a-f]*$/i.test(value) && value.length % 2 === 0 ? Uint8Array.from(Buffer.from(value, "hex")) : new Uint8Array();
}

/** Exactly what the detector compared at the moment the alert was raised. */
export function triggerSnapshotChart(snapshot: AlertTriggerSnapshot, event?: Pick<DetectionEvent, "bandLabel" | "affectedLabel">): ChartSpec {
  const levels = decodeHex(snapshot.levelsHex);
  const usual = decodeHex(snapshot.usualHex);
  const alert = decodeHex(snapshot.alertLevelHex);
  const count = Math.min(levels.length, usual.length, alert.length);
  const [startHz, endHz] = snapshot.analyzedRangeHz;
  const binHz = count ? (endHz - startHz) / count : 1;
  const at = (index: number) => startHz + (index + 0.5) * binHz;
  const series = (values: Uint8Array): ChartPoint[] => Array.from({ length: count }, (_, index) => [at(index), values[index]] as [number, number]);
  const [yMin, yMax] = levelRange([...levels.subarray(0, count), ...usual.subarray(0, count), ...alert.subarray(0, count)]);
  const label = event?.affectedLabel ?? event?.bandLabel ?? snapshot.targetId;
  return {
    id: "trigger-snapshot",
    title: `What the detector saw at the alert: ${label}`,
    caption: `${detailKindLabel(snapshot.detailKind)} at ${utcDateTime(snapshot.observedAt)}. Red areas were above the alert level. Levels are relative and uncalibrated.`,
    ariaLabel: `Spectrum at the moment of the alert. Received level in blue, usual level in green, alert level dashed amber, raised frequencies shaded red.`,
    width: 960,
    height: 340,
    x: { label: "Frequency (MHz)", min: startHz, max: endHz, ticks: frequencyAxisTicks(startHz, endHz, 8) },
    y: { label: "Relative level (0–255)", min: yMin, max: yMax, ticks: numericTicks(yMin, yMax, 5, (value) => String(Math.round(value))) },
    series: count ? [
      { kind: "area", name: "Received", color: REPORT_COLORS.receivedFill, opacity: 0.12, points: series(levels) },
      { kind: "line", name: "Usual level", color: REPORT_COLORS.usual, width: 1.6, points: series(usual) },
      { kind: "line", name: "Alert level", color: REPORT_COLORS.alertLevel, width: 1.4, dash: [6, 4], points: series(alert) },
      { kind: "line", name: "Received", color: REPORT_COLORS.received, width: 1.4, points: series(levels) },
    ] : [],
    xRegions: snapshot.anomalyBinRanges.map((range) => ({
      from: startHz + range.startBin * binHz,
      to: startHz + range.endBin * binHz,
      color: REPORT_COLORS.anomaly,
      opacity: 0.16,
    })),
    legend: [
      { name: "Received at the alert", color: REPORT_COLORS.received, style: "line" },
      { name: "Usual level", color: REPORT_COLORS.usual, style: "line" },
      { name: "Alert level", color: REPORT_COLORS.alertLevel, style: "dash" },
      { name: "Above alert level", color: REPORT_COLORS.anomaly, style: "region" },
    ],
    ...(count ? {} : { emptyMessage: "No spectrum was stored for this alert." }),
  };
}
