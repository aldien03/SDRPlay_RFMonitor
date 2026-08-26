import { describe, expect, it } from "vitest";
import {
  assertRfOnlyDetectionClaim,
  assertRfOnlyClaim,
  MAX_ANALYSIS_SPAN_HZ,
  normalizeReceiverSerial,
  parseSupportedReceiverModel,
  productionHardwareBlockers,
  PRODUCTION_SAMPLE_RATE_HZ,
  RF_ONLY_VERDICTS,
  rfOnlyDetectionClaimBlockers,
  rfOnlyClaimBlockers,
} from "../src/shared/productContract";

describe("RF-only product contract", () => {
  it("[trace:HW-002] accepts only the frozen one-tuner 10 MS/s production envelope", () => {
    expect(productionHardwareBlockers({
      receiverCount: 1,
      receiverModel: "RSPdx-R2",
      sampleRateHz: PRODUCTION_SAMPLE_RATE_HZ,
      analysisSpanHz: MAX_ANALYSIS_SPAN_HZ,
      iqEnabled: false,
    })).toEqual([]);
  });

  it("[trace:HW-001] parses only exact original RSPdx and RSPdx R2 model names", () => {
    expect(parseSupportedReceiverModel("RSPdx")).toBe("RSPdx");
    expect(parseSupportedReceiverModel("rspdx")).toBe("RSPdx");
    expect(parseSupportedReceiverModel("RSPdx R2")).toBe("RSPdx R2");
    expect(parseSupportedReceiverModel("RSPdx-R2")).toBe("RSPdx R2");
    for (const deceptive of [
      "RSPdx clone",
      "Clone RSPdx",
      "RSPdx Pro",
      "RSPdxR2",
      "RSPdx R20",
      "NotRSPdx",
      "RSPdx (TEST)",
      "RSPdx\nR2",
    ]) expect(parseSupportedReceiverModel(deceptive)).toBeUndefined();
    expect(normalizeReceiverSerial("  RSPDX-1234  ")).toBe("RSPDX-1234");
    for (const placeholder of ["", "unknown", "N/A", "not reported", "bad\nserial"] ) {
      expect(normalizeReceiverSerial(placeholder)).toBeUndefined();
    }
  });

  it("keeps experimental and out-of-scope configurations unqualified", () => {
    expect(productionHardwareBlockers({
      receiverCount: 2,
      receiverModel: "Generic SDR",
      sampleRateHz: 9_000_000,
      analysisSpanHz: 10_000_000,
      iqEnabled: true,
    })).toEqual([
      "single-tuner-required",
      "unsupported-receiver-model",
      "production-sample-rate-required",
      "analysis-span-out-of-scope",
      "iq-disabled",
    ]);
  });

  it("[trace:CLAIM-003] [trace:CLAIM-004] makes unsupported RF conclusions fail closed", () => {
    const rejected = {
      verdict: "Suspected RF interference" as const,
      evidenceStrength: "High" as const,
      calibrated: true,
      attributesIntent: true,
      assessesNavigationIntegrity: true,
      includesIq: true,
    };
    expect(rfOnlyClaimBlockers(rejected)).toEqual([
      "high-evidence-requires-independent-source",
      "absolute-calibration-unavailable",
      "intent-not-observable",
      "navigation-integrity-source-unavailable",
      "iq-disabled",
    ]);
    expect(() => assertRfOnlyClaim(rejected)).toThrow(/RF-only product claim rejected/);
  });

  it("[trace:CLAIM-001] [trace:CLAIM-002] freezes the operator verdict vocabulary without spoofing or intent claims", () => {
    expect(RF_ONLY_VERDICTS).toEqual([
      "Suspected RF interference",
      "Narrow RF anomaly",
      "Receiver overloaded",
      "Coverage lost",
      "Test inconclusive",
      "No RF anomaly detected",
    ]);
    expect(RF_ONLY_VERDICTS.join(" ")).not.toMatch(/spoof|jam|intent|navigation integrity/i);
  });

  it("enforces RF-only claims at the detection-event boundary", () => {
    const accepted = {
      kind: "wideband-noise-rise" as const,
      severity: "medium" as const,
      evidenceStrength: "Medium" as const,
      evidenceBasis: "Repeated relative RF anomaly against an approved baseline.",
      observed: "Relative energy rose across the analyzed band.",
      recommendedAction: "Check position and time on an independent receiver. Keep recording.",
    };
    expect(rfOnlyDetectionClaimBlockers(accepted)).toEqual([]);
    expect(() => assertRfOnlyDetectionClaim(accepted)).not.toThrow();

    expect(() => assertRfOnlyDetectionClaim({
      ...accepted,
      observed: "Relative RF energy stayed above normal. RF data can show interference, not intent.",
    })).not.toThrow();

    expect(rfOnlyDetectionClaimBlockers({
      ...accepted,
      observed: "Operator review is needed to determine intent.",
    })).toContain("unsupported-rf-only-copy");

    const rejected = {
      ...accepted,
      severity: "high" as const,
      evidenceStrength: "High" as const,
      observed: "Confirmed spoofing at -42 dBm.",
    };
    expect(rfOnlyDetectionClaimBlockers(rejected as never)).toEqual([
      "high-evidence-requires-independent-source",
      "high-severity-is-not-an-rf-only-operator-level",
      "unsupported-rf-only-copy",
    ]);
    expect(() => assertRfOnlyDetectionClaim(rejected as never)).toThrow(/RF-only detection event rejected/);
  });

  it.each([
    "Jam detected.",
    "Likely jammer near the antenna.",
    "The source was jamming navigation.",
    "This was deliberate interference.",
    "A deliberately disruptive transmitter was found.",
    "The transmitter's intention is hostile.",
    "The disruption was unintentional.",
    "This source jams navigation receivers.",
    "J-A-M source detected.",
    "j\u200bam source detected.",
    "Position-integrity failure confirmed.",
  ])("rejects prohibited or obfuscated operator copy: %s", (observed) => {
    expect(rfOnlyDetectionClaimBlockers({
      kind: "wideband-noise-rise",
      severity: "medium",
      evidenceStrength: "Medium",
      evidenceBasis: "Repeated relative RF anomaly against an approved baseline.",
      observed,
      recommendedAction: "Check an independent receiver.",
    })).toContain("unsupported-rf-only-copy");
  });
});
