import { createHash } from "node:crypto";
import {
  DETECTOR_QUALIFICATION_PLAN_VERSION,
  detectorQualificationPlan,
  type DetectorQualificationFamily,
} from "../shared/detectorQualification";
import {
  SYNTHETIC_GENERATOR_VERSION,
  SYNTHETIC_SCENARIO_SCHEMA_VERSION,
  SYNTHETIC_VALIDATION_PROTOCOL_VERSION,
  type BinomialConfidenceInterval,
  type IndependentRunSummary,
  type SyntheticArtifactHashes,
  type SyntheticArtifactInputs,
  type SyntheticEvidenceMarker,
  type SyntheticEventKind,
  type SyntheticGroundTruth,
  type SyntheticRunMetadata,
  type SyntheticRunMode,
  type SyntheticRunProvenance,
  type SyntheticRunScore,
  type SyntheticScenarioDefinition,
  type SyntheticScenarioEvent,
  type SyntheticSensorState,
  type SyntheticTargetDefinition,
  type ValidationEventScore,
  type ValidationLatencyDistribution,
  type ValidationObservationWindow,
  type ValidationObservedAlert,
  type ValidationTargetScore,
} from "../shared/syntheticValidation";
import type { BandCatalog } from "../shared/types";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MAX_TARGETS = 32;
const MAX_EVENTS = 512;
const MAX_BINS = 16_384;
const MAX_DURATION_MS = 7 * 24 * 60 * 60_000;

type CanonicalValue = null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue };

function canonicalValue(value: unknown, seen: WeakSet<object>): CanonicalValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot hash a non-finite number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value === undefined) return null;
  if (typeof value !== "object") throw new Error(`Cannot hash ${typeof value}`);
  if (seen.has(value)) throw new Error("Cannot hash a circular value");
  seen.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      return { type: value.constructor.name, bytes: Array.from(bytes) };
    }
    if (value instanceof ArrayBuffer) return { type: "ArrayBuffer", bytes: Array.from(new Uint8Array(value)) };
    if (Array.isArray(value)) return value.map((entry) => canonicalValue(entry, seen));
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalValue(entry, seen)]));
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, new WeakSet()));
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertNonEmpty(value: string, label: string): void {
  if (!value.trim()) throw new Error(`${label} must not be empty`);
}

function assertInteger(value: number, label: string, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
}

function assertRatio(value: number, label: string, allowZero = false): void {
  const minimum = allowZero ? 0 : Number.EPSILON;
  if (!Number.isFinite(value) || value < minimum || value > 1) throw new Error(`${label} must be between ${allowZero ? 0 : ">0"} and 1`);
}

function validateExpectedOutcome(event: SyntheticScenarioEvent): void {
  const required = event.kind === "sham" || event.kind === "matched-power-spoofing"
    ? "no-alert"
    : event.kind === "configuration-change" || event.kind === "data-gap"
      ? "unknown"
      : "alert";
  if (event.expected.outcome !== required) {
    throw new Error(`${event.kind} event ${event.id} must expect ${required}`);
  }
  if (required !== "alert" && event.expected.acceptedAlertKinds?.length) {
    throw new Error(`${event.kind} event ${event.id} cannot accept an alert kind`);
  }
}

function validateEventParameters(event: SyntheticScenarioEvent): void {
  switch (event.kind) {
    case "wideband":
      assertInteger(event.amplitudeBins, `${event.id}.amplitudeBins`, 1, 255);
      assertRatio(event.occupancyRatio, `${event.id}.occupancyRatio`);
      if (event.centerRatio !== undefined) assertRatio(event.centerRatio, `${event.id}.centerRatio`, true);
      break;
    case "pulsed-wideband":
      assertInteger(event.amplitudeBins, `${event.id}.amplitudeBins`, 1, 255);
      assertRatio(event.occupancyRatio, `${event.id}.occupancyRatio`);
      assertInteger(event.periodMs, `${event.id}.periodMs`, 1, MAX_DURATION_MS);
      assertRatio(event.dutyCycle, `${event.id}.dutyCycle`);
      if (event.centerRatio !== undefined) assertRatio(event.centerRatio, `${event.id}.centerRatio`, true);
      break;
    case "cw":
      assertInteger(event.amplitudeBins, `${event.id}.amplitudeBins`, 1, 255);
      assertRatio(event.centerBinRatio, `${event.id}.centerBinRatio`, true);
      assertInteger(event.widthBins, `${event.id}.widthBins`, 1, MAX_BINS);
      break;
    case "multitone":
      assertInteger(event.amplitudeBins, `${event.id}.amplitudeBins`, 1, 255);
      if (!event.toneBinRatios.length || event.toneBinRatios.length > 64) throw new Error(`${event.id}.toneBinRatios must contain 1 to 64 tones`);
      event.toneBinRatios.forEach((ratio, index) => assertRatio(ratio, `${event.id}.toneBinRatios[${index}]`, true));
      assertInteger(event.widthBins, `${event.id}.widthBins`, 1, MAX_BINS);
      break;
    case "moving-narrowband":
      assertInteger(event.amplitudeBins, `${event.id}.amplitudeBins`, 1, 255);
      assertRatio(event.startBinRatio, `${event.id}.startBinRatio`, true);
      assertRatio(event.endBinRatio, `${event.id}.endBinRatio`, true);
      assertInteger(event.widthBins, `${event.id}.widthBins`, 1, MAX_BINS);
      assertInteger(event.sweepPeriodMs, `${event.id}.sweepPeriodMs`, 1, MAX_DURATION_MS);
      break;
    case "overload":
      if (event.clipLevel !== undefined) assertInteger(event.clipLevel, `${event.id}.clipLevel`, 1, 255);
      break;
    case "configuration-change":
      assertInteger(event.configurationOffset, `${event.id}.configurationOffset`, 1, 1_000_000);
      break;
    default:
      break;
  }
}

export function validateSyntheticScenario(input: SyntheticScenarioDefinition): SyntheticScenarioDefinition {
  if (input.schemaVersion !== SYNTHETIC_SCENARIO_SCHEMA_VERSION) throw new Error("Unsupported synthetic scenario schema");
  assertNonEmpty(input.id, "Scenario id");
  assertNonEmpty(input.version, "Scenario version");
  assertNonEmpty(input.name, "Scenario name");
  assertNonEmpty(input.seed, "Scenario seed");
  assertInteger(input.durationMs, "Scenario durationMs", 1, MAX_DURATION_MS);
  assertInteger(input.nominalFrameIntervalMs, "Scenario nominalFrameIntervalMs", 1, input.durationMs);
  if (!input.targets.length || input.targets.length > MAX_TARGETS) throw new Error(`Scenario must contain 1 to ${MAX_TARGETS} targets`);
  if (input.events.length > MAX_EVENTS) throw new Error(`Scenario cannot contain more than ${MAX_EVENTS} events`);

  const targetIds = new Set<string>();
  for (const target of input.targets) {
    assertNonEmpty(target.id, "Target id");
    if (targetIds.has(target.id)) throw new Error(`Duplicate target id ${target.id}`);
    targetIds.add(target.id);
    assertInteger(target.binCount, `${target.id}.binCount`, 8, MAX_BINS);
    assertInteger(target.baselineLevel, `${target.id}.baselineLevel`, 0, 255);
    assertInteger(target.noiseAmplitudeBins, `${target.id}.noiseAmplitudeBins`, 0, 64);
    if (target.rippleAmplitudeBins !== undefined) assertInteger(target.rippleAmplitudeBins, `${target.id}.rippleAmplitudeBins`, 0, 64);
  }

  const eventIds = new Set<string>();
  for (const event of input.events) {
    assertNonEmpty(event.id, "Event id");
    if (eventIds.has(event.id)) throw new Error(`Duplicate event id ${event.id}`);
    eventIds.add(event.id);
    if (!targetIds.has(event.targetId)) throw new Error(`Event ${event.id} uses unknown target ${event.targetId}`);
    if (!Number.isFinite(event.startMonotonicMs) || !Number.isFinite(event.endMonotonicMs)
      || event.startMonotonicMs < 0 || event.endMonotonicMs <= event.startMonotonicMs || event.endMonotonicMs > input.durationMs) {
      throw new Error(`Event ${event.id} has an invalid monotonic interval`);
    }
    validateExpectedOutcome(event);
    validateEventParameters(event);
  }

  return structuredClone(input);
}

export function createSyntheticArtifactHashes(input: SyntheticArtifactInputs): SyntheticArtifactHashes {
  return {
    softwareBuildHash: sha256Canonical(input.softwareBuild),
    configurationHash: sha256Canonical(input.configuration),
    ruleSetHash: sha256Canonical(input.ruleSet),
    baselineHash: sha256Canonical(input.baseline),
  };
}

function hash32(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    let value = seed += 0x6d2b79f5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

export function detectorQualificationTrialSeed(
  catalog: BandCatalog,
  targetId: string,
  family: DetectorQualificationFamily,
  trialIndex: number,
): string {
  const plan = detectorQualificationPlan(catalog);
  if (!plan.targets.some((target) => target.id === targetId)) throw new Error(`Unknown qualification target ${targetId}`);
  if (!plan.scenarios.find((scenario) => scenario.level === "isolated-randomized")?.families.includes(family)) {
    throw new Error(`Unknown randomized qualification family ${family}`);
  }
  assertInteger(trialIndex, "trialIndex", 0, Number.MAX_SAFE_INTEGER);
  return createHash("sha256")
    .update(`${DETECTOR_QUALIFICATION_PLAN_VERSION}:${targetId}:${family}:${trialIndex}`)
    .digest("hex");
}

function randomInteger(random: () => number, minimum: number, maximum: number): number {
  return minimum + Math.floor(random() * (maximum - minimum + 1));
}

function randomRatio(random: () => number, minimum: number, maximum: number): number {
  return Number((minimum + random() * (maximum - minimum)).toFixed(6));
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function activeAt(event: SyntheticScenarioEvent, monotonicMs: number): boolean {
  return monotonicMs >= event.startMonotonicMs && monotonicMs < event.endMonotonicMs;
}

function addPeak(bins: Uint8Array, center: number, widthBins: number, amplitudeBins: number): void {
  const halfWidth = Math.max(0.5, widthBins / 2);
  const start = Math.max(0, Math.floor(center - halfWidth));
  const end = Math.min(bins.length - 1, Math.ceil(center + halfWidth));
  for (let index = start; index <= end; index += 1) {
    const distance = Math.abs(index - center);
    const weight = Math.max(0, 1 - distance / (halfWidth + 0.5));
    bins[index] = clampByte(bins[index] + amplitudeBins * weight);
  }
}

function addOccupiedBand(bins: Uint8Array, occupancyRatio: number, centerRatio: number, amplitudeBins: number): void {
  const width = Math.max(1, Math.round(bins.length * occupancyRatio));
  const center = centerRatio * (bins.length - 1);
  const start = Math.max(0, Math.min(bins.length - width, Math.round(center - width / 2)));
  const end = Math.min(bins.length, start + width);
  for (let index = start; index < end; index += 1) bins[index] = clampByte(bins[index] + amplitudeBins);
}

function applyEvent(bins: Uint8Array, event: SyntheticScenarioEvent, monotonicMs: number): void {
  switch (event.kind) {
    case "wideband":
      addOccupiedBand(bins, event.occupancyRatio, event.centerRatio ?? 0.5, event.amplitudeBins);
      break;
    case "pulsed-wideband": {
      const phase = (monotonicMs - event.startMonotonicMs) % event.periodMs;
      if (phase < event.periodMs * event.dutyCycle) addOccupiedBand(bins, event.occupancyRatio, event.centerRatio ?? 0.5, event.amplitudeBins);
      break;
    }
    case "cw":
      addPeak(bins, event.centerBinRatio * (bins.length - 1), event.widthBins, event.amplitudeBins);
      break;
    case "multitone":
      for (const ratio of event.toneBinRatios) addPeak(bins, ratio * (bins.length - 1), event.widthBins, event.amplitudeBins);
      break;
    case "moving-narrowband": {
      const phase = ((monotonicMs - event.startMonotonicMs) % event.sweepPeriodMs) / event.sweepPeriodMs;
      const ratio = event.startBinRatio + (event.endBinRatio - event.startBinRatio) * phase;
      addPeak(bins, ratio * (bins.length - 1), event.widthBins, event.amplitudeBins);
      break;
    }
    case "overload":
      bins.fill(event.clipLevel ?? 250);
      break;
    default:
      // Shams, configuration controls, data gaps and matched-power spoofing
      // deliberately make no spectral change.
      break;
  }
}

function intervalOverlap(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): number {
  return Math.max(0, Math.min(leftEnd, rightEnd) - Math.max(leftStart, rightStart));
}

function overlaps(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return intervalOverlap(leftStart, leftEnd, rightStart, rightEnd) > 0;
}

function mergedExposure(windows: ValidationObservationWindow[], targetId: string, start: number, end: number): number {
  const intervals = windows
    .filter((window) => window.targetId === targetId && window.outcome === "valid" && overlaps(window.startMonotonicMs, window.endMonotonicMs, start, end))
    .map((window) => [Math.max(start, window.startMonotonicMs), Math.min(end, window.endMonotonicMs)] as const)
    .sort((left, right) => left[0] - right[0]);
  let total = 0;
  let cursorStart: number | undefined;
  let cursorEnd = 0;
  for (const [intervalStart, intervalEnd] of intervals) {
    if (cursorStart === undefined) {
      cursorStart = intervalStart;
      cursorEnd = intervalEnd;
    } else if (intervalStart <= cursorEnd) {
      cursorEnd = Math.max(cursorEnd, intervalEnd);
    } else {
      total += cursorEnd - cursorStart;
      cursorStart = intervalStart;
      cursorEnd = intervalEnd;
    }
  }
  return total + (cursorStart === undefined ? 0 : cursorEnd - cursorStart);
}

function alertEnd(alert: ValidationObservedAlert): number {
  return Math.max(alert.startedMonotonicMs, alert.clearedMonotonicMs ?? alert.lastSeenMonotonicMs ?? alert.startedMonotonicMs);
}

function alertOverlapsEvent(alert: ValidationObservedAlert, event: SyntheticScenarioEvent, graceMs = 0): boolean {
  return alert.targetId === event.targetId
    && alert.startedMonotonicMs < event.endMonotonicMs + graceMs
    && alertEnd(alert) >= event.startMonotonicMs;
}

function unionAlertDuration(alerts: ValidationObservedAlert[]): number {
  const byTarget = new Map<string, Array<readonly [number, number]>>();
  for (const alert of alerts) {
    const intervals = byTarget.get(alert.targetId) ?? [];
    intervals.push([alert.startedMonotonicMs, alertEnd(alert)]);
    byTarget.set(alert.targetId, intervals);
  }
  let duration = 0;
  for (const intervals of byTarget.values()) {
    intervals.sort((left, right) => left[0] - right[0]);
    let start: number | undefined;
    let end = 0;
    for (const [nextStart, nextEnd] of intervals) {
      if (start === undefined) {
        start = nextStart;
        end = nextEnd;
      } else if (nextStart <= end) {
        end = Math.max(end, nextEnd);
      } else {
        duration += end - start;
        start = nextStart;
        end = nextEnd;
      }
    }
    if (start !== undefined) duration += end - start;
  }
  return duration;
}

function validateScoringInputs(
  scenario: SyntheticScenarioDefinition,
  alerts: ValidationObservedAlert[],
  observations: ValidationObservationWindow[],
): void {
  const targetIds = new Set(scenario.targets.map((target) => target.id));
  const alertIds = new Set<string>();
  for (const alert of alerts) {
    assertNonEmpty(alert.id, "Alert id");
    if (alertIds.has(alert.id)) throw new Error(`Duplicate alert id ${alert.id}`);
    alertIds.add(alert.id);
    if (!targetIds.has(alert.targetId)) throw new Error(`Alert ${alert.id} uses unknown target ${alert.targetId}`);
    const timestamps = [alert.startedMonotonicMs, alert.lastSeenMonotonicMs, alert.clearedMonotonicMs].filter((value): value is number => value !== undefined);
    if (timestamps.some((value) => !Number.isFinite(value) || value < alert.startedMonotonicMs) || alert.startedMonotonicMs < 0) {
      throw new Error(`Alert ${alert.id} has invalid monotonic timestamps`);
    }
  }
  for (const [index, observation] of observations.entries()) {
    if (!targetIds.has(observation.targetId)) throw new Error(`Observation ${index} uses unknown target ${observation.targetId}`);
    if (!Number.isFinite(observation.startMonotonicMs) || !Number.isFinite(observation.endMonotonicMs)
      || observation.startMonotonicMs < 0 || observation.endMonotonicMs <= observation.startMonotonicMs
      || observation.endMonotonicMs > scenario.durationMs) {
      throw new Error(`Observation ${index} has invalid monotonic timestamps`);
    }
  }
}

function normalQuantile(probability: number): number {
  // Peter J. Acklam's inverse-normal approximation.
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const high = 1 - low;
  if (probability <= 0 || probability >= 1) throw new Error("Normal probability must be between 0 and 1");
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (probability > high) {
    const q = Math.sqrt(-2 * Math.log(1 - probability));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = probability - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export function binomialWilsonInterval(successes: number, trials: number, confidence = 0.95): BinomialConfidenceInterval {
  assertInteger(trials, "trials", 1, Number.MAX_SAFE_INTEGER);
  assertInteger(successes, "successes", 0, trials);
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) throw new Error("confidence must be between 0 and 1");
  const z = normalQuantile(0.5 + confidence / 2);
  const proportion = successes / trials;
  const zSquared = z * z;
  const denominator = 1 + zSquared / trials;
  const center = (proportion + zSquared / (2 * trials)) / denominator;
  const margin = z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * trials)) / trials) / denominator;
  return {
    successes,
    trials,
    confidence,
    lower: successes === 0 ? 0 : Math.max(0, center - margin),
    upper: successes === trials ? 1 : Math.min(1, center + margin),
    method: "wilson-score",
    side: "two-sided",
  };
}

export function binomialWilsonOneSidedInterval(successes: number, trials: number, confidence = 0.95): BinomialConfidenceInterval {
  assertInteger(trials, "trials", 1, Number.MAX_SAFE_INTEGER);
  assertInteger(successes, "successes", 0, trials);
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) throw new Error("confidence must be between 0 and 1");
  const z = normalQuantile(confidence);
  const proportion = successes / trials;
  const zSquared = z * z;
  const denominator = 1 + zSquared / trials;
  const center = (proportion + zSquared / (2 * trials)) / denominator;
  const margin = z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * trials)) / trials) / denominator;
  return {
    successes,
    trials,
    confidence,
    lower: successes === 0 ? 0 : Math.max(0, center - margin),
    upper: 1,
    method: "wilson-score",
    side: "one-sided",
  };
}

function latencyDistribution(values: number[]): ValidationLatencyDistribution {
  const ordered = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  if (!ordered.length) return { samples: 0 };
  const percentile = (ratio: number) => ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * ratio) - 1)];
  return {
    samples: ordered.length,
    minimumMs: ordered[0],
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    maximumMs: ordered.at(-1),
  };
}

export function scoreSyntheticValidationRun(input: {
  truth: SyntheticGroundTruth;
  truthCommitment?: string;
  alerts: ValidationObservedAlert[];
  observations: ValidationObservationWindow[];
  postEventAlertGraceMs?: number;
}): SyntheticRunScore {
  const scenario = validateSyntheticScenario(input.truth.scenario);
  const scenarioHash = sha256Canonical(scenario);
  if (scenarioHash !== input.truth.scenarioHash) throw new Error("Ground-truth scenario hash does not match its content");
  if (!input.truth.synthetic) throw new Error("Ground truth is not marked synthetic");
  if (!input.truthCommitment || !isSha256(input.truthCommitment)) throw new Error("A valid pre-run truth commitment is required for scoring");
  const graceMs = input.postEventAlertGraceMs ?? 30_000;
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error("postEventAlertGraceMs must be non-negative");
  validateScoringInputs(scenario, input.alerts, input.observations);

  const alerts = input.alerts.map((alert) => ({ ...alert }));
  const usedAlerts = new Set<string>();
  const eventScores: ValidationEventScore[] = [];
  let observableExpectedAlertEvents = 0;
  let detectedObservableExpectedEvents = 0;

  const orderedEvents = [...scenario.events].sort((left, right) => left.startMonotonicMs - right.startMonotonicMs || left.id.localeCompare(right.id));
  for (const event of orderedEvents) {
    if (event.expected.outcome === "alert") {
      const observedExposure = mergedExposure(input.observations, event.targetId, event.startMonotonicMs, event.endMonotonicMs);
      const observable = observedExposure > 0;
      if (observable) observableExpectedAlertEvents += 1;
      const alert = alerts
        .filter((candidate) => !usedAlerts.has(candidate.id)
          && alertOverlapsEvent(candidate, event, graceMs)
          && (!event.expected.acceptedAlertKinds?.length || (candidate.kind !== undefined && event.expected.acceptedAlertKinds.includes(candidate.kind))))
        .sort((left, right) => left.startedMonotonicMs - right.startedMonotonicMs)[0];
      if (!alert) {
        eventScores.push({
          eventId: event.id,
          targetId: event.targetId,
          kind: event.kind,
          expectedOutcome: "alert",
          verdict: "missed",
          observedEventExposureMs: observedExposure,
        });
        continue;
      }
      usedAlerts.add(alert.id);
      if (observable) detectedObservableExpectedEvents += 1;
      const exposureEnd = Math.min(event.endMonotonicMs, Math.max(event.startMonotonicMs, alert.startedMonotonicMs));
      const observedExposureToAlertMs = mergedExposure(input.observations, event.targetId, event.startMonotonicMs, exposureEnd);
      const wallClockLatencyMs = Math.max(0, alert.startedMonotonicMs - event.startMonotonicMs);
      eventScores.push({
        eventId: event.id,
        targetId: event.targetId,
        kind: event.kind,
        expectedOutcome: "alert",
        verdict: "detected",
        matchedAlertId: alert.id,
        observedEventExposureMs: observedExposure,
        wallClockLatencyMs,
        observedExposureToAlertMs,
        unobservedLatencyToAlertMs: Math.max(0, wallClockLatencyMs - observedExposureToAlertMs),
      });
      continue;
    }

    if (event.expected.outcome === "no-alert") {
      const alert = alerts.find((candidate) => !usedAlerts.has(candidate.id) && alertOverlapsEvent(candidate, event));
      if (alert) usedAlerts.add(alert.id);
      eventScores.push({
        eventId: event.id,
        targetId: event.targetId,
        kind: event.kind,
        expectedOutcome: "no-alert",
        verdict: alert ? "unexpected-alert" : "correct-non-detection",
        ...(alert ? { matchedAlertId: alert.id } : {}),
      });
      continue;
    }

    const unknownObserved = input.observations.some((observation) => observation.targetId === event.targetId
      && observation.outcome === "unknown"
      && overlaps(observation.startMonotonicMs, observation.endMonotonicMs, event.startMonotonicMs, event.endMonotonicMs));
    eventScores.push({
      eventId: event.id,
      targetId: event.targetId,
      kind: event.kind,
      expectedOutcome: "unknown",
      verdict: unknownObserved ? "unknown-observed" : "unknown-missed",
    });
  }

  const unmatchedAlerts = alerts.filter((alert) => !usedAlerts.has(alert.id));
  const unexpectedAlertIds = new Set([
    ...unmatchedAlerts.map((alert) => alert.id),
    ...eventScores.filter((score) => score.verdict === "unexpected-alert" && score.matchedAlertId).map((score) => score.matchedAlertId!),
  ]);
  const unexpectedAlerts = unexpectedAlertIds.size;
  const expectedAlertEvents = eventScores.filter((score) => score.expectedOutcome === "alert").length;
  const detectedExpectedEvents = eventScores.filter((score) => score.verdict === "detected").length;
  const expectedNoAlertEvents = eventScores.filter((score) => score.expectedOutcome === "no-alert").length;
  const correctNonDetections = eventScores.filter((score) => score.verdict === "correct-non-detection").length;
  const expectedUnknownEvents = eventScores.filter((score) => score.expectedOutcome === "unknown").length;
  const observedUnknownEvents = eventScores.filter((score) => score.verdict === "unknown-observed").length;
  const targetHours = scenario.targets.length * scenario.durationMs / 3_600_000;
  const falseAlertDurationMs = unionAlertDuration(alerts.filter((alert) => unexpectedAlertIds.has(alert.id)));
  const precisionDenominator = detectedExpectedEvents + unexpectedAlerts;
  const perTarget: ValidationTargetScore[] = scenario.targets.map((target) => {
    const scores = eventScores.filter((score) => score.targetId === target.id);
    const alertScores = scores.filter((score) => score.expectedOutcome === "alert");
    const detected = alertScores.filter((score) => score.verdict === "detected");
    const unexpectedForTarget = alerts.filter((alert) => alert.targetId === target.id && unexpectedAlertIds.has(alert.id));
    const durationHours = scenario.durationMs / 3_600_000;
    return {
      targetId: target.id,
      expectedAlertEvents: alertScores.length,
      detectedExpectedEvents: detected.length,
      missedExpectedEvents: alertScores.length - detected.length,
      observableExpectedAlertEvents: alertScores.filter((score) => (score.observedEventExposureMs ?? 0) > 0).length,
      unobservedExpectedAlertEvents: alertScores.filter((score) => (score.observedEventExposureMs ?? 0) === 0).length,
      expectedNoAlertEvents: scores.filter((score) => score.expectedOutcome === "no-alert").length,
      correctNonDetections: scores.filter((score) => score.verdict === "correct-non-detection").length,
      expectedUnknownEvents: scores.filter((score) => score.expectedOutcome === "unknown").length,
      observedUnknownEvents: scores.filter((score) => score.verdict === "unknown-observed").length,
      unexpectedAlerts: unexpectedForTarget.length,
      falseAlertDurationMs: unionAlertDuration(unexpectedForTarget),
      falseAlertsPerTargetHour: durationHours ? unexpectedForTarget.length / durationHours : 0,
      wallClockLatency: latencyDistribution(detected.flatMap((score) => score.wallClockLatencyMs === undefined ? [] : [score.wallClockLatencyMs])),
      observedExposureToAlert: latencyDistribution(detected.flatMap((score) => score.observedExposureToAlertMs === undefined ? [] : [score.observedExposureToAlertMs])),
      unobservedLatencyToAlert: latencyDistribution(detected.flatMap((score) => score.unobservedLatencyToAlertMs === undefined ? [] : [score.unobservedLatencyToAlertMs])),
    };
  });

  return {
    schemaVersion: 1,
    synthetic: true,
    runId: input.truth.runId,
    scenarioId: scenario.id,
    scenarioVersion: scenario.version,
    scenarioSeed: scenario.seed,
    scenarioHash,
    truthCommitment: input.truthCommitment,
    eventScores,
    perTarget,
    expectedAlertEvents,
    detectedExpectedEvents,
    missedExpectedEvents: expectedAlertEvents - detectedExpectedEvents,
    observableExpectedAlertEvents,
    detectedObservableExpectedEvents,
    unobservedExpectedAlertEvents: expectedAlertEvents - observableExpectedAlertEvents,
    expectedNoAlertEvents,
    correctNonDetections,
    unexpectedAlerts,
    expectedUnknownEvents,
    observedUnknownEvents,
    detectionProbability: expectedAlertEvents ? detectedExpectedEvents / expectedAlertEvents : null,
    conditionalDetectionProbability: observableExpectedAlertEvents ? detectedObservableExpectedEvents / observableExpectedAlertEvents : null,
    precision: precisionDenominator ? detectedExpectedEvents / precisionDenominator : null,
    falseAlertsPerTargetHour: targetHours ? unexpectedAlerts / targetHours : 0,
    falseAlertDurationMs,
    passed: detectedExpectedEvents === expectedAlertEvents
      && correctNonDetections === expectedNoAlertEvents
      && observedUnknownEvents === expectedUnknownEvents
      && unexpectedAlerts === 0,
  };
}

export function summarizeIndependentValidationRuns(scores: SyntheticRunScore[], confidence = 0.95): IndependentRunSummary {
  if (!scores.length) throw new Error("At least one independent run score is required");
  const detectionRuns = scores.filter((score) => score.expectedAlertEvents > 0);
  const detectionSuccesses = detectionRuns.filter((score) => score.detectedExpectedEvents === score.expectedAlertEvents).length;
  const falseAlertRuns = scores.filter((score) => score.expectedNoAlertEvents > 0 || score.expectedAlertEvents === 0);
  const falseAlertFreeRuns = falseAlertRuns.filter((score) => score.unexpectedAlerts === 0).length;
  const groups = new Map<string, {
    targetId: string;
    family: SyntheticScenarioEvent["kind"];
    runs: Array<{ score: SyntheticRunScore; events: ValidationEventScore[] }>;
  }>();
  for (const score of scores) {
    const groupedEvents = new Map<string, ValidationEventScore[]>();
    for (const event of score.eventScores) {
      const key = `${event.targetId}:${event.kind}`;
      const entries = groupedEvents.get(key) ?? [];
      entries.push(event);
      groupedEvents.set(key, entries);
    }
    for (const [key, events] of groupedEvents) {
      const existing = groups.get(key) ?? {
        targetId: events[0].targetId,
        family: events[0].kind,
        runs: [],
      };
      existing.runs.push({ score, events });
      groups.set(key, existing);
    }
  }
  const perTargetAndFamily = [...groups.values()].map((group) => {
    const detectionGroupRuns = group.runs.filter((run) => run.events.some((event) => event.expectedOutcome === "alert"));
    const detectionGroupSuccesses = detectionGroupRuns.filter((run) => run.events
      .filter((event) => event.expectedOutcome === "alert")
      .every((event) => event.verdict === "detected")).length;
    const controlGroupRuns = group.runs.filter((run) => run.events.some((event) => event.expectedOutcome === "no-alert"));
    const controlGroupSuccesses = controlGroupRuns.filter((run) => run.events
      .filter((event) => event.expectedOutcome === "no-alert")
      .every((event) => event.verdict === "correct-non-detection")
      && (run.score.perTarget.find((target) => target.targetId === group.targetId)?.unexpectedAlerts ?? 0) === 0).length;
    return {
      targetId: group.targetId,
      scenarioFamily: group.family,
      independentRuns: group.runs.length,
      detectionSuccesses: detectionGroupSuccesses,
      detectionTrials: detectionGroupRuns.length,
      detectionLower95: detectionGroupRuns.length
        ? binomialWilsonOneSidedInterval(detectionGroupSuccesses, detectionGroupRuns.length, confidence)
        : null,
      falseAlertFreeRuns: controlGroupSuccesses,
      falseAlertTrials: controlGroupRuns.length,
      falseAlertFreeLower95: controlGroupRuns.length
        ? binomialWilsonOneSidedInterval(controlGroupSuccesses, controlGroupRuns.length, confidence)
        : null,
    };
  }).sort((left, right) => left.targetId.localeCompare(right.targetId) || left.scenarioFamily.localeCompare(right.scenarioFamily));
  return {
    schemaVersion: 1,
    synthetic: true,
    runCount: scores.length,
    detectionRunSuccesses: detectionSuccesses,
    detectionRunTrials: detectionRuns.length,
    detectionRunInterval: detectionRuns.length ? binomialWilsonInterval(detectionSuccesses, detectionRuns.length, confidence) : null,
    falseAlertFreeRuns,
    falseAlertRunTrials: falseAlertRuns.length,
    falseAlertFreeRunInterval: falseAlertRuns.length ? binomialWilsonInterval(falseAlertFreeRuns, falseAlertRuns.length, confidence) : null,
    perTargetAndFamily,
    allPassed: scores.every((score) => score.passed),
  };
}

function makeTruth(runId: string, scenario: SyntheticScenarioDefinition): SyntheticGroundTruth {
  const cloned = structuredClone(scenario);
  return { schemaVersion: 1, synthetic: true, runId, scenario: cloned, scenarioHash: sha256Canonical(cloned) };
}

function truthCommitment(runId: string, scenarioHash: string, artifactHashes: SyntheticArtifactHashes): string {
  return sha256Canonical({ runId, scenarioHash, artifactHashes });
}

export function verifySyntheticTruthDisclosure(metadata: SyntheticRunMetadata, truth: SyntheticGroundTruth): boolean {
  if (metadata.runId !== truth.runId || !truth.synthetic) return false;
  const actualScenarioHash = sha256Canonical(truth.scenario);
  if (actualScenarioHash !== truth.scenarioHash) return false;
  return truthCommitment(metadata.runId, truth.scenarioHash, metadata.artifactHashes) === metadata.truthCommitment;
}

export class SyntheticValidationRun {
  readonly #scenario: SyntheticScenarioDefinition;
  readonly #targets: Map<string, SyntheticTargetDefinition>;
  readonly #truth: SyntheticGroundTruth;
  readonly #metadata: SyntheticRunMetadata;
  readonly provenance: SyntheticRunProvenance;

  constructor(input: {
    scenario: SyntheticScenarioDefinition;
    mode: SyntheticRunMode;
    runId: string;
    artifacts: SyntheticArtifactInputs;
  }) {
    assertNonEmpty(input.runId, "Run id");
    this.#scenario = validateSyntheticScenario(input.scenario);
    this.#targets = new Map(this.#scenario.targets.map((target) => [target.id, target]));
    this.#truth = makeTruth(input.runId, this.#scenario);
    const artifactHashes = createSyntheticArtifactHashes(input.artifacts);
    this.provenance = {
      ...artifactHashes,
      validationProtocolVersion: SYNTHETIC_VALIDATION_PROTOCOL_VERSION,
      generatorVersion: SYNTHETIC_GENERATOR_VERSION,
      scenarioHash: this.#truth.scenarioHash,
    };
    const base = {
      schemaVersion: 1 as const,
      synthetic: true as const,
      runId: input.runId,
      mode: input.mode,
      durationMs: this.#scenario.durationMs,
      targetIds: this.#scenario.targets.map((target) => target.id),
      validationProtocolVersion: SYNTHETIC_VALIDATION_PROTOCOL_VERSION,
      generatorVersion: SYNTHETIC_GENERATOR_VERSION,
      artifactHashes,
      truthCommitment: truthCommitment(input.runId, this.#truth.scenarioHash, artifactHashes),
    };
    this.#metadata = input.mode === "guided"
      ? { ...base, mode: "guided", truth: structuredClone(this.#truth) }
      : { ...base, mode: "blinded" };
  }

  getMetadata(): SyntheticRunMetadata {
    return structuredClone(this.#metadata);
  }

  getEvidenceMarker(): SyntheticEvidenceMarker {
    return {
      schemaVersion: 1,
      synthetic: true,
      runId: this.#metadata.runId,
      mode: this.#metadata.mode,
      validationProtocolVersion: SYNTHETIC_VALIDATION_PROTOCOL_VERSION,
      generatorVersion: SYNTHETIC_GENERATOR_VERSION,
      truthCommitment: this.#metadata.truthCommitment,
    };
  }

  discloseTruth(): SyntheticGroundTruth {
    return structuredClone(this.#truth);
  }

  sensorStateAt(targetId: string, monotonicMs: number): SyntheticSensorState {
    this.assertQuery(targetId, monotonicMs);
    const events = this.#scenario.events.filter((event) => event.targetId === targetId);
    let configurationOffset = 0;
    for (const event of events) {
      if (event.kind === "configuration-change" && monotonicMs >= event.startMonotonicMs) configurationOffset += event.configurationOffset;
    }
    return {
      dataAvailable: !events.some((event) => event.kind === "data-gap" && activeAt(event, monotonicMs)),
      overload: events.some((event) => event.kind === "overload" && activeAt(event, monotonicMs)),
      configurationOffset,
    };
  }

  /**
   * Returns only a packed relative FFT frame. Undefined represents an explicit
   * data gap. No scenario id, event kind, expected outcome, or truth flag is
   * carried on the detector-facing frame path.
   */
  frameAt(targetId: string, monotonicMs: number): Uint8Array | undefined {
    this.assertQuery(targetId, monotonicMs);
    const state = this.sensorStateAt(targetId, monotonicMs);
    if (!state.dataAvailable) return undefined;
    const target = this.#targets.get(targetId)!;
    const frameNumber = Math.floor(monotonicMs / this.#scenario.nominalFrameIntervalMs);
    const random = mulberry32(hash32(`${this.#scenario.seed}:${targetId}:${frameNumber}`));
    const bins = new Uint8Array(target.binCount);
    const rippleAmplitude = target.rippleAmplitudeBins ?? 0;
    const phase = random() * Math.PI * 2;
    for (let index = 0; index < bins.length; index += 1) {
      const noise = (random() * 2 - 1) * target.noiseAmplitudeBins;
      const ripple = rippleAmplitude * Math.sin(index * 0.091 + phase);
      bins[index] = clampByte(target.baselineLevel + noise + ripple);
    }
    for (const event of this.#scenario.events) {
      if (event.targetId === targetId && activeAt(event, monotonicMs)) applyEvent(bins, event, monotonicMs);
    }
    return bins;
  }

  score(alerts: ValidationObservedAlert[], observations: ValidationObservationWindow[], postEventAlertGraceMs?: number): SyntheticRunScore {
    return scoreSyntheticValidationRun({
      truth: this.#truth,
      truthCommitment: this.#metadata.truthCommitment,
      alerts,
      observations,
      postEventAlertGraceMs,
    });
  }

  private assertQuery(targetId: string, monotonicMs: number): void {
    if (!this.#targets.has(targetId)) throw new Error(`Unknown synthetic target ${targetId}`);
    if (!Number.isFinite(monotonicMs) || monotonicMs < 0 || monotonicMs > this.#scenario.durationMs) {
      throw new Error("Synthetic monotonic time is outside the scenario");
    }
  }
}

function baseTarget(target?: Partial<SyntheticTargetDefinition>): SyntheticTargetDefinition {
  return {
    id: target?.id ?? "gnss-l1-e1-b1c-sbas",
    binCount: target?.binCount ?? 512,
    baselineLevel: target?.baselineLevel ?? 32,
    noiseAmplitudeBins: target?.noiseAmplitudeBins ?? 2,
    rippleAmplitudeBins: target?.rippleAmplitudeBins ?? 2,
  };
}

/**
 * Commissioning fixtures cover RF anomaly families and required negative/fault
 * controls. They are inputs to tests, not claims about physical RF waveforms.
 */
export function createResearchSyntheticScenarioSuite(input: {
  seedPrefix: string;
  target?: Partial<SyntheticTargetDefinition>;
}): SyntheticScenarioDefinition[] {
  assertNonEmpty(input.seedPrefix, "seedPrefix");
  const target = baseTarget(input.target);
  const common: Omit<SyntheticScenarioDefinition, "id" | "name" | "seed" | "events"> = {
    schemaVersion: SYNTHETIC_SCENARIO_SCHEMA_VERSION,
    version: "1.0.0",
    durationMs: 20_000,
    nominalFrameIntervalMs: 250,
    targets: [target],
  };
  const scenario = (id: string, event: SyntheticScenarioEvent): SyntheticScenarioDefinition => ({
    ...common,
    id,
    name: id,
    seed: `${input.seedPrefix}:${id}`,
    events: [event],
  });
  const interval = { targetId: target.id, startMonotonicMs: 5_000, endMonotonicMs: 15_000 };
  const alert = { outcome: "alert" as const };
  const noAlert = { outcome: "no-alert" as const };
  const unknown = { outcome: "unknown" as const };
  return [
    scenario("sham", { id: "sham-1", kind: "sham", ...interval, expected: noAlert }),
    scenario("wideband", { id: "wideband-1", kind: "wideband", ...interval, amplitudeBins: 72, occupancyRatio: 0.8, expected: alert }),
    scenario("pulsed-wideband", { id: "pulsed-wideband-1", kind: "pulsed-wideband", ...interval, amplitudeBins: 72, occupancyRatio: 0.8, periodMs: 1_000, dutyCycle: 0.5, expected: alert }),
    scenario("cw", { id: "cw-1", kind: "cw", ...interval, amplitudeBins: 180, centerBinRatio: 0.5, widthBins: 3, expected: alert }),
    scenario("multitone", { id: "multitone-1", kind: "multitone", ...interval, amplitudeBins: 150, toneBinRatios: [0.25, 0.5, 0.75], widthBins: 3, expected: alert }),
    scenario("moving-narrowband", { id: "moving-1", kind: "moving-narrowband", ...interval, amplitudeBins: 180, startBinRatio: 0.2, endBinRatio: 0.8, widthBins: 9, sweepPeriodMs: 20_000, expected: alert }),
    scenario("overload", { id: "overload-1", kind: "overload", ...interval, clipLevel: 250, expected: alert }),
    scenario("configuration-change", { id: "configuration-1", kind: "configuration-change", ...interval, configurationOffset: 1, expected: unknown }),
    scenario("data-gap", { id: "gap-1", kind: "data-gap", ...interval, expected: unknown }),
    scenario("matched-power-spoofing", { id: "matched-power-1", kind: "matched-power-spoofing", ...interval, expected: noAlert }),
  ].map(validateSyntheticScenario);
}

/**
 * Builds one reproducible high-margin randomized trial from the frozen DET-210
 * envelope. The trial seed is independent of execution or tune order.
 */
export function createRandomizedSyntheticScenario(input: {
  catalog: BandCatalog;
  targetId: string;
  family: SyntheticEventKind;
  trialIndex: number;
  binCount?: number;
}): SyntheticScenarioDefinition {
  const seed = detectorQualificationTrialSeed(input.catalog, input.targetId, input.family, input.trialIndex);
  const random = mulberry32(hash32(seed));
  const baselineLevel = randomInteger(random, 24, 48);
  const noiseAmplitudeBins = randomInteger(random, 1, 4);
  const rippleAmplitudeBins = randomInteger(random, 0, 3);
  const selected = createResearchSyntheticScenarioSuite({
    seedPrefix: seed,
    target: {
      id: input.targetId,
      binCount: input.binCount ?? 512,
      baselineLevel,
      noiseAmplitudeBins,
      rippleAmplitudeBins,
    },
  }).find((scenario) => scenario.events[0]?.kind === input.family);
  if (!selected) throw new Error(`Synthetic family ${input.family} has no generated fixture`);
  const event = selected.events[0];
  switch (event.kind) {
    case "wideband":
      event.amplitudeBins = randomInteger(random, 48, 96);
      event.occupancyRatio = randomRatio(random, 0.6, 0.9);
      event.centerRatio = randomRatio(random, 0.4, 0.6);
      break;
    case "pulsed-wideband":
      event.amplitudeBins = randomInteger(random, 48, 96);
      event.occupancyRatio = randomRatio(random, 0.6, 0.9);
      event.centerRatio = randomRatio(random, 0.4, 0.6);
      // The qualification envelope contains pulses that survive the three-frame
      // visit median and provide the detector's required observed exposure.
      // Lower-duty/asynchronous pulses remain characterization cases because a
      // one-tuner, time-gapped monitor cannot guarantee that it observes them.
      event.periodMs = 1_000;
      event.dutyCycle = randomRatio(random, 0.6, 0.9);
      break;
    case "cw":
      event.amplitudeBins = randomInteger(random, 96, 200);
      event.centerBinRatio = randomRatio(random, 0.15, 0.85);
      event.widthBins = randomInteger(random, 1, 5);
      break;
    case "multitone": {
      event.amplitudeBins = randomInteger(random, 96, 200);
      event.widthBins = randomInteger(random, 1, 5);
      const tones = randomInteger(random, 2, 5);
      event.toneBinRatios = Array.from({ length: tones }, (_value, index) => Number((0.15 + ((index + 1) / (tones + 1)) * 0.7).toFixed(6)));
      break;
    }
    case "moving-narrowband":
      event.amplitudeBins = randomInteger(random, 96, 200);
      event.widthBins = randomInteger(random, 3, 9);
      event.startBinRatio = randomRatio(random, 0.15, 0.35);
      event.endBinRatio = randomRatio(random, 0.65, 0.85);
      // Keep high-margin qualification motion within the temporal resolution of
      // a median-combined visit. Faster motion is still valid characterization,
      // but is not labelled a guaranteed detector alert.
      event.sweepPeriodMs = randomInteger(random, 90_000, 180_000);
      break;
    case "overload":
      event.clipLevel = randomInteger(random, 230, 255);
      break;
    case "configuration-change":
      event.configurationOffset = randomInteger(random, 1, 4);
      break;
    default:
      break;
  }
  selected.seed = seed;
  selected.id = `randomized-${input.family}-${input.targetId}-${input.trialIndex}`;
  selected.name = `Randomized ${input.family}`;
  return validateSyntheticScenario(selected);
}

export function isSha256(value: string): boolean {
  return SHA256_PATTERN.test(value);
}
