import type { DetectionEvent, EvidenceStrength } from "./types";

export const RF_PRODUCT_CONTRACT_VERSION = "rf-spectrum-sentinel-v1" as const;
export const PRODUCTION_SAMPLE_RATE_HZ = 10_000_000;
export const MAX_ANALYSIS_SPAN_HZ = 8_000_000;
export const PHYSICAL_TUNER_COUNT = 1;
export const MAX_RF_ONLY_EVIDENCE_STRENGTH: EvidenceStrength = "Medium";

export type SupportedReceiverModel = "RSPdx" | "RSPdx R2";

/**
 * Canonicalize only the two receiver models in the frozen product envelope.
 * SDRconnect has used both a space and a hyphen before R2; no prefix, suffix,
 * instance label, or marketing-like variant is accepted.
 */
export function parseSupportedReceiverModel(value: unknown): SupportedReceiverModel | undefined {
  if (typeof value !== "string") return undefined;
  const candidate = value.trim();
  if (/^rspdx$/i.test(candidate)) return "RSPdx";
  if (/^rspdx(?: |-)r2$/i.test(candidate)) return "RSPdx R2";
  return undefined;
}

/** Parse SDRconnect's live device label while keeping configured model fields strict. */
export function parseReportedReceiverModel(value: unknown): SupportedReceiverModel | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(rspdx(?: |-)r2|rspdx)(?: \([a-f0-9]{8,32}\))?$/iu.exec(value.trim());
  return match ? parseSupportedReceiverModel(match[1]) : undefined;
}

export function normalizeReceiverSerial(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const serial = value.trim();
  if (!serial || serial.length > 128 || /[\u0000-\u001f\u007f]/.test(serial)) return undefined;
  if (/^(?:unknown|none|null|n\/?a|not[- ]?reported)$/i.test(serial)) return undefined;
  return serial;
}

export const RF_ONLY_VERDICTS = [
  "Suspected RF interference",
  "Narrow RF anomaly",
  "Receiver overloaded",
  "Coverage lost",
  "Test inconclusive",
  "No RF anomaly detected",
] as const;

export type RfOnlyVerdict = typeof RF_ONLY_VERDICTS[number];

export interface ProductionHardwareConfiguration {
  receiverCount: number;
  receiverModel: string;
  sampleRateHz: number;
  analysisSpanHz: number;
  iqEnabled: boolean;
}

export interface RfOnlyClaim {
  verdict: RfOnlyVerdict;
  evidenceStrength: EvidenceStrength;
  calibrated: boolean;
  attributesIntent: boolean;
  assessesNavigationIntegrity: boolean;
  includesIq: boolean;
}

export function productionHardwareBlockers(configuration: ProductionHardwareConfiguration): string[] {
  return [
    ...(configuration.receiverCount !== PHYSICAL_TUNER_COUNT ? ["single-tuner-required"] : []),
    ...(!parseSupportedReceiverModel(configuration.receiverModel) ? ["unsupported-receiver-model"] : []),
    ...(configuration.sampleRateHz !== PRODUCTION_SAMPLE_RATE_HZ ? ["production-sample-rate-required"] : []),
    ...(!Number.isFinite(configuration.analysisSpanHz) || configuration.analysisSpanHz <= 0 || configuration.analysisSpanHz > MAX_ANALYSIS_SPAN_HZ
      ? ["analysis-span-out-of-scope"]
      : []),
    ...(configuration.iqEnabled ? ["iq-disabled"] : []),
  ];
}

export function rfOnlyClaimBlockers(claim: RfOnlyClaim): string[] {
  return [
    ...(claim.evidenceStrength === "High" ? ["high-evidence-requires-independent-source"] : []),
    ...(claim.calibrated ? ["absolute-calibration-unavailable"] : []),
    ...(claim.attributesIntent ? ["intent-not-observable"] : []),
    ...(claim.assessesNavigationIntegrity ? ["navigation-integrity-source-unavailable"] : []),
    ...(claim.includesIq ? ["iq-disabled"] : []),
  ];
}

export function assertRfOnlyClaim(claim: RfOnlyClaim): void {
  const blockers = rfOnlyClaimBlockers(claim);
  if (blockers.length) throw new Error(`RF-only product claim rejected: ${blockers.join(", ")}`);
}

export type RfOnlyDetectionClaim = Pick<DetectionEvent,
  | "kind"
  | "severity"
  | "evidenceStrength"
  | "evidenceBasis"
  | "observed"
  | "recommendedAction"
>;

const UNSUPPORTED_RF_COPY = /(?:^|[^a-z0-9])(?:spoof(?:ers?|ing|ed)?|j[\s._/-]*a[\s._/-]*m(?:mers?|ming|med|s)?|(?:un)?intent(?:ion(?:al(?:ly)?)?)?|deliberat(?:e|ely)|dbm)(?:$|[^a-z0-9])|\b(?:navigation|position|timing)[\s._/-]+integrity\b/i;
const RF_ONLY_SCOPE_DISCLAIMER = /\bRF data can show interference,\s*not intent\.?/gi;

function normalizedOperatorCopy(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

/** Runtime guard used at the event boundary as well as by type-level claim tests. */
export function rfOnlyDetectionClaimBlockers(event: RfOnlyDetectionClaim): string[] {
  const verdict: RfOnlyVerdict = event.kind === "overload"
    ? "Receiver overloaded"
    : event.kind === "narrowband-spike"
      ? "Narrow RF anomaly"
      : "Suspected RF interference";
  // The approved scope disclaimer explicitly denies intent attribution. Strip
  // only that exact sentence before looking for unsupported affirmative copy;
  // every other mention of intent, spoofing, jamming, calibration, or
  // navigation integrity still fails closed.
  const checkedCopy = normalizedOperatorCopy(
    `${event.evidenceBasis}\n${event.observed}\n${event.recommendedAction}`
      .replace(RF_ONLY_SCOPE_DISCLAIMER, ""),
  );
  return [
    ...rfOnlyClaimBlockers({
      verdict,
      evidenceStrength: event.evidenceStrength,
      calibrated: false,
      attributesIntent: false,
      assessesNavigationIntegrity: false,
      includesIq: false,
    }),
    ...(event.severity === "high" ? ["high-severity-is-not-an-rf-only-operator-level"] : []),
    ...(UNSUPPORTED_RF_COPY.test(checkedCopy)
      ? ["unsupported-rf-only-copy"]
      : []),
  ];
}

export function assertRfOnlyDetectionClaim(event: RfOnlyDetectionClaim): void {
  const blockers = rfOnlyDetectionClaimBlockers(event);
  if (blockers.length) throw new Error(`RF-only detection event rejected: ${blockers.join(", ")}`);
}
