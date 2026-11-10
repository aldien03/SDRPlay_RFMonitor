/**
 * Alert sensitivity: the operator-adjustable rules that decide when relative
 * RF energy raises an alert. These rules are deliberately independent of the
 * signal-learning rules (`settings.detection`), which are hashed into every
 * baseline fingerprint. Changing alert sensitivity therefore never discards a
 * learned baseline, never restarts learning, and never ends an open incident.
 *
 * Pure and browser-safe: no Node imports. Hashing lives in detection.ts.
 */
import type {
  AlertDetailKind,
  AlertingSettings,
  AlertPolicyBound,
  AlertPolicyChoice,
  AlertPolicySetting,
  AlertPolicyValues,
  AlertPresetDefinition,
  AlertPresetId,
  AlertRuleComparison,
  BaselineLifecycle,
  DetectionKind,
  DetectionRuleSettings,
  DetectorAnomalyBinRange,
  ServiceGroup,
} from "./types";

export const ALERT_CLASSIFIER_VERSION = "rf-alert-segments-1" as const;
export const ALERT_PRESET_TABLE_VERSION = 1 as const;
export const ALERT_PRESET_IDS: AlertPresetId[] = ["conservative", "standard", "sensitive", "very-sensitive"];
export const MAX_ALERT_SEGMENTS = 64;
export const MAX_DISTURBED_RANGES = 16;

const PRESET_VALUES: Record<AlertPresetId, AlertPolicyValues> = {
  conservative: {
    segmentSigma: 8,
    segmentGapRatio: 0.005,
    widebandOccupancy: 0.5,
    partialSigma: 8,
    narrowbandMaxWidthRatio: 0.1,
    narrowbandPeakSigma: 12,
    narrowbandMinBins: 1,
    alertVisits: 4,
    alertWindow: 5,
    minExposureMs: 1_500,
    noiseFloorSigma: 5,
    noiseFloorExposureMs: 20_000,
    noiseFloorRequiresProtected: true,
    burstSigma: 0,
    clearVisits: 10,
  },
  standard: {
    segmentSigma: 6,
    segmentGapRatio: 0.005,
    widebandOccupancy: 0.35,
    partialSigma: 6,
    narrowbandMaxWidthRatio: 0.1,
    narrowbandPeakSigma: 10,
    narrowbandMinBins: 1,
    alertVisits: 3,
    alertWindow: 5,
    minExposureMs: 1_000,
    noiseFloorSigma: 4,
    noiseFloorExposureMs: 10_000,
    noiseFloorRequiresProtected: false,
    burstSigma: 0,
    clearVisits: 10,
  },
  sensitive: {
    segmentSigma: 5,
    segmentGapRatio: 0.005,
    widebandOccupancy: 0.3,
    partialSigma: 5,
    narrowbandMaxWidthRatio: 0.1,
    narrowbandPeakSigma: 8,
    narrowbandMinBins: 2,
    alertVisits: 2,
    alertWindow: 4,
    minExposureMs: 800,
    noiseFloorSigma: 3.5,
    noiseFloorExposureMs: 8_000,
    noiseFloorRequiresProtected: false,
    burstSigma: 8,
    clearVisits: 10,
  },
  "very-sensitive": {
    segmentSigma: 4,
    segmentGapRatio: 0.005,
    widebandOccupancy: 0.25,
    partialSigma: 4,
    narrowbandMaxWidthRatio: 0.1,
    narrowbandPeakSigma: 6,
    narrowbandMinBins: 2,
    alertVisits: 2,
    alertWindow: 3,
    minExposureMs: 0,
    noiseFloorSigma: 3,
    noiseFloorExposureMs: 6_000,
    noiseFloorRequiresProtected: false,
    burstSigma: 7,
    clearVisits: 12,
  },
};

const PRESET_COPY: Record<AlertPresetId, { label: string; effect: string }> = {
  conservative: { label: "Conservative", effect: "Fewest alerts" },
  standard: { label: "Standard", effect: "Balanced" },
  sensitive: { label: "Sensitive", effect: "Earlier alerts" },
  "very-sensitive": { label: "Very sensitive", effect: "Earliest alerts, more false alerts" },
};

export const ALERT_POLICY_BOUNDS: AlertPolicyBound[] = [
  { key: "segmentSigma", label: "Raised level", unit: "x", min: 2, max: 20, step: 0.5 },
  { key: "widebandOccupancy", label: "Band-wide share", unit: "ratio", min: 0.05, max: 1, step: 0.01 },
  { key: "partialSigma", label: "Partial-band strength", unit: "x", min: 2, max: 30, step: 0.5 },
  { key: "narrowbandMaxWidthRatio", label: "Narrow width limit", unit: "ratio", min: 0.005, max: 0.5, step: 0.005 },
  { key: "narrowbandPeakSigma", label: "Narrow peak strength", unit: "x", min: 3, max: 40, step: 0.5 },
  { key: "narrowbandMinBins", label: "Narrow minimum width", unit: "bins", min: 1, max: 16, step: 1 },
  { key: "alertVisits", label: "Raised checks needed", unit: "checks", min: 1, max: 10, step: 1 },
  { key: "alertWindow", label: "Out of last checks", unit: "checks", min: 1, max: 10, step: 1 },
  { key: "minExposureMs", label: "Minimum observed time", unit: "ms", min: 0, max: 60_000, step: 100 },
  { key: "noiseFloorSigma", label: "Noise-floor rise", unit: "x", min: 1, max: 20, step: 0.5 },
  { key: "noiseFloorExposureMs", label: "Noise-floor time", unit: "ms", min: 0, max: 600_000, step: 500 },
  { key: "noiseFloorRequiresProtected", label: "Noise floor only on approved baselines", unit: "boolean", min: 0, max: 1, step: 1 },
  { key: "burstSigma", label: "Short-burst strength", unit: "x", min: 4, max: 40, step: 0.5, zeroMeansOff: true },
  { key: "clearVisits", label: "Clean checks to clear", unit: "checks", min: 2, max: 60, step: 1 },
  { key: "segmentGapRatio", label: "Join gaps up to", unit: "ratio", min: 0, max: 0.05, step: 0.001 },
];

export function alertPresetValues(id: AlertPresetId): AlertPolicyValues {
  return { ...PRESET_VALUES[id] };
}

export function alertPresetDefinitions(): AlertPresetDefinition[] {
  return ALERT_PRESET_IDS.map((id) => ({ id, ...PRESET_COPY[id], values: alertPresetValues(id) }));
}

export function alertPresetLabel(choice: AlertPolicyChoice): string {
  // A record written by a newer or older release may name a preset this one does not know.
  return choice === "custom" ? "Custom" : PRESET_COPY[choice]?.label ?? "Custom";
}

export function alertPolicySetting(preset: AlertPresetId): AlertPolicySetting {
  return { preset, values: alertPresetValues(preset) };
}

export function defaultAlertingSettings(): AlertingSettings {
  return { presetTableVersion: ALERT_PRESET_TABLE_VERSION, default: alertPolicySetting("standard"), targetOverrides: {} };
}

function sameValues(left: AlertPolicyValues, right: AlertPolicyValues): boolean {
  return (Object.keys(PRESET_VALUES.standard) as Array<keyof AlertPolicyValues>).every((key) => left[key] === right[key]);
}

/** Which named preset these exact values equal, if any. */
export function matchingAlertPreset(values: AlertPolicyValues): AlertPresetId | undefined {
  return ALERT_PRESET_IDS.find((id) => sameValues(values, PRESET_VALUES[id]));
}

/**
 * Settings saved before alert sensitivity existed carried their alert
 * behaviour inside the learning rules. Preserve deliberate operator choices:
 * default rules become Standard; customised rules become an equivalent Custom.
 */
export function deriveAlertingFromDetection(detection: DetectionRuleSettings, defaults: DetectionRuleSettings): AlertingSettings {
  const keys = Object.keys(defaults) as Array<keyof DetectionRuleSettings>;
  const unchanged = keys.every((key) => detection[key] === defaults[key]);
  if (unchanged) return defaultAlertingSettings();
  const standard = alertPresetValues("standard");
  const window = Math.max(1, Math.min(10, Math.trunc(detection.interferenceWindow)));
  const values: AlertPolicyValues = {
    ...standard,
    segmentSigma: clamp(detection.widebandObservationSigma, 2, 20),
    widebandOccupancy: clamp(detection.widebandObservationOccupancy, 0.05, 1),
    partialSigma: clamp(detection.widebandObservationSigma, 2, 30),
    narrowbandMaxWidthRatio: clamp(detection.narrowbandMaxWidthRatio, 0.005, 0.5),
    narrowbandPeakSigma: clamp(Math.max(detection.narrowbandPeakSigma, detection.widebandObservationSigma), 3, 40),
    alertWindow: window,
    alertVisits: Math.max(1, Math.min(window, Math.trunc(detection.interferenceHits))),
    noiseFloorSigma: clamp(detection.driftSigma, 1, 20),
    noiseFloorExposureMs: clamp(Math.trunc(detection.driftExposureMs), 0, 600_000),
    clearVisits: clamp(Math.trunc(detection.clearObservations), 2, 60),
  };
  const preset = matchingAlertPreset(values);
  return {
    presetTableVersion: ALERT_PRESET_TABLE_VERSION,
    default: preset ? alertPolicySetting(preset) : { preset: "custom", values },
    targetOverrides: {},
  };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Server-side normalisation: a named preset always carries that preset's exact values. */
export function normalizeAlertPolicySetting(setting: AlertPolicySetting): AlertPolicySetting {
  if (setting.preset !== "custom" && ALERT_PRESET_IDS.includes(setting.preset)) return alertPolicySetting(setting.preset);
  return { preset: "custom", values: { ...setting.values } };
}

export function validateAlertPolicyValues(values: unknown, prefix: string): Record<string, string> {
  const fields: Record<string, string> = {};
  if (!values || typeof values !== "object") return { [prefix]: "Alert rules are missing" };
  const record = values as Record<string, unknown>;
  for (const bound of ALERT_POLICY_BOUNDS) {
    const value = record[bound.key];
    const path = `${prefix}.${bound.key}`;
    if (bound.unit === "boolean") {
      if (typeof value !== "boolean") fields[path] = "Choose on or off";
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      fields[path] = `${bound.label}: enter a number`;
      continue;
    }
    if (bound.zeroMeansOff && value === 0) continue;
    if ((bound.unit === "checks" || bound.unit === "bins") && !Number.isInteger(value)) {
      fields[path] = `${bound.label}: enter a whole number`;
      continue;
    }
    if (value < bound.min || value > bound.max) fields[path] = `${bound.label}: must be between ${bound.min} and ${bound.max}`;
  }
  if (!Object.keys(fields).length) {
    const typed = values as AlertPolicyValues;
    if (typed.alertVisits > typed.alertWindow) fields[`${prefix}.alertVisits`] = "Raised checks needed cannot exceed the number of checks";
    if (typed.partialSigma < typed.segmentSigma) fields[`${prefix}.partialSigma`] = "Partial-band strength cannot be below the raised level";
    if (typed.narrowbandPeakSigma < typed.segmentSigma) fields[`${prefix}.narrowbandPeakSigma`] = "Narrow peak strength cannot be below the raised level";
    if (typed.burstSigma !== 0 && typed.burstSigma < typed.segmentSigma) fields[`${prefix}.burstSigma`] = "Short-burst strength cannot be below the raised level";
  }
  return fields;
}

export function validateAlertingSettings(input: unknown, knownTargetIds: ReadonlySet<string>): { settings?: AlertingSettings; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  if (!input || typeof input !== "object") return { fields: { alerting: "Alert sensitivity is missing" } };
  const raw = input as Partial<AlertingSettings>;
  if (raw.presetTableVersion !== ALERT_PRESET_TABLE_VERSION) fields["alerting.presetTableVersion"] = "Unsupported alert preset table";
  const checkSetting = (setting: unknown, prefix: string): AlertPolicySetting | undefined => {
    if (!setting || typeof setting !== "object") {
      fields[prefix] = "Alert sensitivity is missing";
      return undefined;
    }
    const candidate = setting as AlertPolicySetting;
    if (candidate.preset !== "custom" && !ALERT_PRESET_IDS.includes(candidate.preset as AlertPresetId)) {
      fields[`${prefix}.preset`] = "Choose a sensitivity";
      return undefined;
    }
    if (candidate.preset === "custom") Object.assign(fields, validateAlertPolicyValues(candidate.values, `${prefix}.values`));
    return normalizeAlertPolicySetting(candidate);
  };
  const defaultSetting = checkSetting(raw.default, "alerting.default");
  const overrides: Record<string, AlertPolicySetting> = {};
  if (raw.targetOverrides !== undefined && (typeof raw.targetOverrides !== "object" || raw.targetOverrides === null || Array.isArray(raw.targetOverrides))) {
    fields["alerting.targetOverrides"] = "Window sensitivity must name catalog windows";
  } else {
    for (const [targetId, setting] of Object.entries(raw.targetOverrides ?? {})) {
      if (!knownTargetIds.has(targetId)) {
        fields[`alerting.targetOverrides.${targetId}`] = "Unknown frequency window";
        continue;
      }
      const normalized = checkSetting(setting, `alerting.targetOverrides.${targetId}`);
      if (normalized) overrides[targetId] = normalized;
    }
  }
  if (Object.keys(fields).length || !defaultSetting) return { fields };
  return {
    settings: { presetTableVersion: ALERT_PRESET_TABLE_VERSION, default: defaultSetting, targetOverrides: overrides },
    fields,
  };
}

export interface ResolvedAlertPolicy {
  choice: AlertPolicyChoice;
  source: "default" | "window";
  values: AlertPolicyValues;
}

export function resolveAlertPolicy(alerting: AlertingSettings | undefined, targetId: string): ResolvedAlertPolicy {
  const override = alerting?.targetOverrides?.[targetId];
  if (override) return { choice: override.preset, source: "window", values: override.values };
  const setting = alerting?.default ?? alertPolicySetting("standard");
  return { choice: setting.preset, source: "default", values: setting.values };
}

// ---------------------------------------------------------------------------
// Plain-language descriptions (Settings, Help, reports)
// ---------------------------------------------------------------------------

export function formatMultiple(value: number): string {
  return `${Number.isInteger(value) ? value : value.toFixed(1)}×`;
}

export function formatSeconds(ms: number): string {
  if (ms <= 0) return "no minimum";
  const seconds = ms / 1_000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

function formatWidthMHz(ratio: number, spanHz?: number): string {
  if (!spanHz || !Number.isFinite(spanHz)) return `${Math.round(ratio * 100)}% of the window`;
  const mhz = (ratio * spanHz) / 1e6;
  return `${mhz >= 0.1 ? mhz.toFixed(1) : mhz.toFixed(2)} MHz`;
}

export interface AlertRuleDescription {
  id: "wideband" | "partial-band" | "narrowband" | "noise-floor" | "burst" | "persistence" | "clear";
  label: string;
  text: string;
}

/** Short fact list: exactly what triggers an alert with these values. */
export function describeAlertPolicy(values: AlertPolicyValues, spanHz?: number): AlertRuleDescription[] {
  return [
    {
      id: "wideband",
      label: "Band-wide rise",
      text: `${Math.round(values.widebandOccupancy * 100)}% of the window at ${formatMultiple(values.segmentSigma)} normal variation`,
    },
    {
      id: "partial-band",
      label: "Wider signal",
      text: `Wider than ${formatWidthMHz(values.narrowbandMaxWidthRatio, spanHz)} at ${formatMultiple(values.partialSigma)}`,
    },
    {
      id: "narrowband",
      label: "Narrow signal",
      text: `Peak at ${formatMultiple(values.narrowbandPeakSigma)}`,
    },
    {
      id: "noise-floor",
      label: "Noise-floor rise",
      text: `Whole window at ${formatMultiple(values.noiseFloorSigma)} for ${formatSeconds(values.noiseFloorExposureMs)}${values.noiseFloorRequiresProtected ? " (approved baselines only)" : ""}`,
    },
    {
      id: "burst",
      label: "Short bursts",
      text: values.burstSigma > 0 ? `Single frames at ${formatMultiple(values.burstSigma)}` : "Off",
    },
    {
      id: "persistence",
      label: "Must repeat",
      text: `${values.alertVisits} of ${values.alertWindow} checks${values.minExposureMs > 0 ? `, ${formatSeconds(values.minExposureMs)} observed` : ""}`,
    },
    { id: "clear", label: "Clears after", text: `${values.clearVisits} clean checks` },
  ];
}

// ---------------------------------------------------------------------------
// Segment classifier
// ---------------------------------------------------------------------------

export interface AlertSegment {
  startBin: number;
  /** Half-open end. */
  endBin: number;
  peakZ: number;
  peakBin: number;
  medianZ: number;
}

export interface AlertFeatures {
  binCount: number;
  medianZ: number;
  peakZ: number;
  peakBin: number;
  /** Share of bins at or above the raised level. */
  occupancy: number;
  segments: AlertSegment[];
  widestSegmentRatio: number;
  widestSegmentMedianZ: number;
}

let medianScratch = new Float32Array(0);

function sliceMedian(z: ArrayLike<number>, start: number, end: number): number {
  const length = end - start;
  if (length <= 0) return 0;
  if (medianScratch.length < length) medianScratch = new Float32Array(Math.max(length, medianScratch.length * 2));
  for (let index = 0; index < length; index += 1) medianScratch[index] = z[start + index];
  const view = medianScratch.subarray(0, length);
  view.sort();
  return view[Math.floor((length - 1) / 2)];
}

/**
 * Find raised segments in a per-bin z vector. Runs at or above `sigma` that are
 * separated by at most `gapBins` quiet bins are joined, so one wide emission
 * whose individual bins dip below the line is still one segment.
 */
export function segmentFeatures(z: ArrayLike<number>, binCount: number, sigma: number, gapRatio: number, medianZ: number): AlertFeatures {
  const count = Math.max(0, Math.min(binCount, z.length));
  const gapBins = Math.max(0, Math.round(gapRatio * count));
  const raw: Array<{ start: number; end: number }> = [];
  let raised = 0;
  let peakZ = 0;
  let peakBin = 0;
  let runStart = -1;
  for (let index = 0; index < count; index += 1) {
    const value = z[index];
    if (value > peakZ) {
      peakZ = value;
      peakBin = index;
    }
    if (value >= sigma) {
      raised += 1;
      if (runStart < 0) runStart = index;
    } else if (runStart >= 0) {
      raw.push({ start: runStart, end: index });
      runStart = -1;
    }
  }
  if (runStart >= 0) raw.push({ start: runStart, end: count });
  const merged: Array<{ start: number; end: number }> = [];
  for (const run of raw) {
    const previous = merged.at(-1);
    if (previous && run.start - previous.end <= gapBins) previous.end = run.end;
    else merged.push({ ...run });
  }
  let segments: AlertSegment[] = merged.map((run) => {
    let segmentPeak = 0;
    let segmentPeakBin = run.start;
    for (let index = run.start; index < run.end; index += 1) {
      if (z[index] > segmentPeak) {
        segmentPeak = z[index];
        segmentPeakBin = index;
      }
    }
    return { startBin: run.start, endBin: run.end, peakZ: segmentPeak, peakBin: segmentPeakBin, medianZ: sliceMedian(z, run.start, run.end) };
  });
  if (segments.length > MAX_ALERT_SEGMENTS) {
    segments = [...segments]
      .sort((left, right) => (right.endBin - right.startBin) * right.medianZ - (left.endBin - left.startBin) * left.medianZ)
      .slice(0, MAX_ALERT_SEGMENTS)
      .sort((left, right) => left.startBin - right.startBin);
  }
  let widest: AlertSegment | undefined;
  for (const segment of segments) {
    if (!widest || segment.endBin - segment.startBin > widest.endBin - widest.startBin) widest = segment;
  }
  return {
    binCount: count,
    medianZ,
    peakZ,
    peakBin,
    occupancy: count ? raised / count : 0,
    segments,
    widestSegmentRatio: widest && count ? (widest.endBin - widest.startBin) / count : 0,
    widestSegmentMedianZ: widest?.medianZ ?? 0,
  };
}

export type EmissionKind = Extract<AlertDetailKind, "wideband" | "partial-band" | "narrowband" | "burst">;

export interface AlertClassification {
  emission?: Exclude<EmissionKind, "burst">;
  floor: boolean;
  /** Segments that met an emission rule; drawn red and reported as disturbed. */
  qualifying: AlertSegment[];
  rules: AlertRuleComparison[];
}

export function classifyAlert(features: AlertFeatures, values: AlertPolicyValues, options: { floorMedianZ: number; floorAllowed: boolean }): AlertClassification {
  const count = Math.max(1, features.binCount);
  const narrowLimit = values.narrowbandMaxWidthRatio * count;
  const wide = features.segments.filter((segment) => segment.endBin - segment.startBin > narrowLimit);
  const partial = wide.filter((segment) => segment.medianZ >= values.partialSigma);
  const narrow = features.segments.filter((segment) => {
    const width = segment.endBin - segment.startBin;
    return width <= narrowLimit && width >= values.narrowbandMinBins && segment.peakZ >= values.narrowbandPeakSigma;
  });
  const strongestNarrow = features.segments
    .filter((segment) => segment.endBin - segment.startBin <= narrowLimit)
    .reduce((best, segment) => Math.max(best, segment.peakZ), 0);
  const widestWide = wide.reduce<AlertSegment | undefined>((best, segment) => (
    !best || segment.endBin - segment.startBin > best.endBin - best.startBin ? segment : best
  ), undefined);
  const widebandMet = features.occupancy > 0 && features.occupancy >= values.widebandOccupancy;
  const floor = options.floorAllowed && options.floorMedianZ >= values.noiseFloorSigma;
  let emission: AlertClassification["emission"];
  let qualifying: AlertSegment[] = [];
  if (widebandMet) {
    emission = "wideband";
    qualifying = features.segments;
  } else if (partial.length) {
    emission = "partial-band";
    qualifying = [...partial, ...narrow].sort((left, right) => left.startBin - right.startBin);
  } else if (narrow.length) {
    emission = "narrowband";
    qualifying = narrow;
  }
  const rules: AlertRuleComparison[] = [
    { rule: "wideband", label: "Raised share of window", measured: round(features.occupancy, 4), threshold: values.widebandOccupancy, unit: "ratio", met: widebandMet },
    {
      rule: "partial-band",
      label: "Wider-signal strength",
      measured: round(widestWide?.medianZ ?? 0, 2),
      threshold: values.partialSigma,
      unit: "x",
      met: partial.length > 0,
    },
    { rule: "narrowband", label: "Narrow-peak strength", measured: round(strongestNarrow, 2), threshold: values.narrowbandPeakSigma, unit: "x", met: narrow.length > 0 },
    { rule: "noise-floor", label: "Noise-floor rise", measured: round(options.floorMedianZ, 2), threshold: values.noiseFloorSigma, unit: "x", met: floor },
  ];
  return { emission, floor, qualifying, rules };
}

/** Single-frame burst: a frame whose raised share or a wider segment passes at the burst level. */
export function burstFromFrame(features: AlertFeatures, values: AlertPolicyValues): boolean {
  if (values.burstSigma <= 0) return false;
  if (features.occupancy >= values.widebandOccupancy) return true;
  const narrowLimit = values.narrowbandMaxWidthRatio * Math.max(1, features.binCount);
  return features.segments.some((segment) => segment.endBin - segment.startBin > narrowLimit && segment.medianZ >= values.burstSigma);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const SEVERITY: Record<AlertDetailKind, number> = {
  overload: 6,
  wideband: 5,
  "partial-band": 4,
  narrowband: 3,
  burst: 2,
  "noise-floor": 1,
};

export function moreSevereDetailKind(left: AlertDetailKind | undefined, right: AlertDetailKind | undefined): AlertDetailKind | undefined {
  if (!left) return right;
  if (!right) return left;
  return SEVERITY[right] > SEVERITY[left] ? right : left;
}

export interface AlertTrackerState {
  policyHash: string;
  votes: Array<{ atMs: number; kind?: EmissionKind; exposureMs: number }>;
  floorExposureMs: number;
  lastObservedAtMs?: number;
  /** Whether the previous check was alert-eligible; used to count alert onsets. */
  wasEligible: boolean;
}

export function createAlertTrackerState(policyHash: string): AlertTrackerState {
  return { policyHash, votes: [], floorExposureMs: 0, wasEligible: false };
}

export interface AlertTrackerResult {
  /** The kind this single check suggests (pending candidate). */
  candidateKind?: AlertDetailKind;
  /** Set when persistence is met: the alert kind to raise. */
  alertKind?: AlertDetailKind;
  votes: number;
  required: number;
  window: number;
  exposureMs: number;
  requiredExposureMs: number;
  floorExposureMs: number;
  floorRequiredMs: number;
  /** True only on the check where an alert first becomes eligible. */
  onset: boolean;
}

export function updateAlertTracker(state: AlertTrackerState, input: {
  atMs: number;
  emission?: EmissionKind;
  floor: boolean;
  exposureMs: number;
  values: AlertPolicyValues;
  voteGapMs: number;
  policyHash: string;
}): AlertTrackerResult {
  if (state.policyHash !== input.policyHash) {
    state.policyHash = input.policyHash;
    state.votes = [];
    state.floorExposureMs = 0;
    state.wasEligible = false;
  }
  if (state.lastObservedAtMs !== undefined && input.atMs - state.lastObservedAtMs > input.voteGapMs) {
    state.votes = [];
    state.floorExposureMs = 0;
    state.wasEligible = false;
  }
  state.lastObservedAtMs = input.atMs;
  const exposureMs = Math.max(0, Number.isFinite(input.exposureMs) ? input.exposureMs : 0);
  state.votes.push({ atMs: input.atMs, kind: input.emission, exposureMs });
  if (state.votes.length > input.values.alertWindow) state.votes = state.votes.slice(-input.values.alertWindow);
  state.floorExposureMs = input.floor ? Math.min(input.values.noiseFloorExposureMs * 4 + 1, state.floorExposureMs + exposureMs) : 0;
  const emissionVotes = state.votes.filter((vote) => vote.kind !== undefined);
  const votedExposure = emissionVotes.reduce((total, vote) => total + vote.exposureMs, 0);
  const emissionEligible = Boolean(input.emission)
    && emissionVotes.length >= input.values.alertVisits
    && votedExposure >= input.values.minExposureMs;
  const floorEligible = input.floor && state.floorExposureMs >= input.values.noiseFloorExposureMs;
  let alertKind: AlertDetailKind | undefined;
  if (emissionEligible) {
    alertKind = emissionVotes.reduce<AlertDetailKind | undefined>((best, vote) => moreSevereDetailKind(best, vote.kind), undefined);
  } else if (floorEligible) {
    alertKind = "noise-floor";
  }
  const eligible = alertKind !== undefined;
  const onset = eligible && !state.wasEligible;
  state.wasEligible = eligible;
  return {
    candidateKind: input.emission ?? (input.floor ? "noise-floor" : undefined),
    alertKind,
    votes: emissionVotes.length,
    required: input.values.alertVisits,
    window: input.values.alertWindow,
    exposureMs: votedExposure,
    requiredExposureMs: input.values.minExposureMs,
    floorExposureMs: Math.min(state.floorExposureMs, input.values.noiseFloorExposureMs),
    floorRequiredMs: input.values.noiseFloorExposureMs,
    onset,
  };
}

/**
 * Vote gap scaled to how often a window is actually revisited, so slowly
 * revisited windows can still accumulate repeated checks.
 */
export function alertVoteGapMs(revisitObjectiveMs: number | undefined): number {
  const objective = Number.isFinite(revisitObjectiveMs) && revisitObjectiveMs! > 0 ? revisitObjectiveMs! : 10_000;
  return Math.min(30 * 60_000, Math.max(30_000, Math.round(objective * 3)));
}

// ---------------------------------------------------------------------------
// Kind mapping and evidence semantics
// ---------------------------------------------------------------------------

export function publicDetectionKind(detail: AlertDetailKind, service: ServiceGroup): DetectionKind {
  if (detail === "overload") return "overload";
  if (service === "gnss") return "gnss-energy-anomaly";
  if (detail === "narrowband") return "narrowband-spike";
  if (detail === "noise-floor") return "baseline-drift";
  return "wideband-noise-rise";
}

/** The legacy three-value analysis kind that evidence validators accept. */
export function analysisKindFor(detail: AlertDetailKind | undefined): "wideband-noise-rise" | "narrowband-spike" | "baseline-drift" | undefined {
  if (!detail || detail === "overload") return undefined;
  if (detail === "narrowband") return "narrowband-spike";
  if (detail === "noise-floor") return "baseline-drift";
  return "wideband-noise-rise";
}

export function legacyDetailKind(kind: DetectionKind): AlertDetailKind | undefined {
  if (kind === "overload") return "overload";
  if (kind === "narrowband-spike") return "narrowband";
  if (kind === "baseline-drift") return "noise-floor";
  if (kind === "wideband-noise-rise") return "wideband";
  return undefined;
}

export function detailKindLabel(detail: AlertDetailKind): string {
  switch (detail) {
    case "wideband": return "Band-wide rise";
    case "partial-band": return "Wider signal";
    case "narrowband": return "Narrow signal";
    case "noise-floor": return "Noise-floor rise";
    case "burst": return "Short bursts";
    case "overload": return "Receiver overload";
  }
}

export function referenceKind(lifecycle: BaselineLifecycle): "approved" | "local" {
  return lifecycle === "protected" ? "approved" : "local";
}

export function binRangesToHz(ranges: DetectorAnomalyBinRange[], analyzedRangeHz: [number, number], binCount: number, limit = MAX_DISTURBED_RANGES): Array<[number, number]> {
  const count = Math.max(1, binCount);
  const width = (analyzedRangeHz[1] - analyzedRangeHz[0]) / count;
  const hz = ranges
    .filter((range) => range.endBin > range.startBin)
    .map((range): [number, number] => [
      Math.round(analyzedRangeHz[0] + range.startBin * width),
      Math.round(analyzedRangeHz[0] + range.endBin * width),
    ]);
  return mergeHzRanges(hz, limit);
}

/** Merge overlapping ranges; when over the limit, join the closest neighbours. */
export function mergeHzRanges(ranges: Array<[number, number]>, limit = MAX_DISTURBED_RANGES): Array<[number, number]> {
  const sorted = ranges
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
    .map(([start, end]): [number, number] => [start, end])
    .sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push(range);
  }
  while (merged.length > Math.max(1, limit)) {
    let bestIndex = 0;
    let bestGap = Infinity;
    for (let index = 0; index < merged.length - 1; index += 1) {
      const gap = merged[index + 1][0] - merged[index][1];
      if (gap < bestGap) {
        bestGap = gap;
        bestIndex = index;
      }
    }
    merged[bestIndex] = [merged[bestIndex][0], merged[bestIndex + 1][1]];
    merged.splice(bestIndex + 1, 1);
  }
  return merged;
}
