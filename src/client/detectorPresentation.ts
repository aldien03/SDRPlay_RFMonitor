import type { DetectorAnomalyBinRange, DetectorSpectrumAnalysis, SignalMetricSample, SpectrumFrame } from "../shared/types";
import { formatFrequency } from "./format";

function safeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value);
}

/**
 * Accepts only a complete detector annotation for this exact frame grid.
 * Unknown/malformed metadata fails closed to no baseline and no red overlay.
 */
export function detectorAnalysisForFrame(frame: SpectrumFrame | undefined): DetectorSpectrumAnalysis | undefined {
  const analysis = frame?.detectorAnalysis;
  if (!frame || !analysis || analysis.schemaVersion !== 1 || analysis.source !== "relative-mad-detector") return undefined;
  if (!safeInteger(analysis.analysisStartBin) || !safeInteger(analysis.analysisEndBin)
    || analysis.analysisStartBin < 0 || analysis.analysisEndBin <= analysis.analysisStartBin
    || analysis.analysisEndBin > frame.bins.length
    || !Array.isArray(analysis.analyzedRangeHz) || analysis.analyzedRangeHz.length !== 2
    || !analysis.analyzedRangeHz.every(Number.isFinite)
    || analysis.analyzedRangeHz[1] <= analysis.analyzedRangeHz[0]
    || !Array.isArray(analysis.anomalyBinRanges)) return undefined;
  for (const range of analysis.anomalyBinRanges) {
    if (!safeInteger(range.startBin) || !safeInteger(range.endBin)
      || range.startBin < analysis.analysisStartBin || range.endBin <= range.startBin
      || range.endBin > analysis.analysisEndBin) return undefined;
  }
  if (analysis.overload && analysis.anomalyBinRanges.length) return undefined;
  return analysis;
}

export function detectorAnomalyRanges(frame: SpectrumFrame | undefined): DetectorAnomalyBinRange[] {
  const analysis = detectorAnalysisForFrame(frame);
  if (!analysis || analysis.disposition !== "anomalous" || analysis.overload) return [];
  return analysis.anomalyBinRanges;
}

export function detectorBaselineAvailable(
  frame: SpectrumFrame | undefined,
  metrics: SignalMetricSample | undefined,
): boolean {
  const analysis = detectorAnalysisForFrame(frame);
  return Boolean(analysis?.baselineAvailable && metrics && frame && metrics.bandId === frame.bandId);
}

export interface DisturbancePlacement {
  startHz: number;
  endHz: number;
  widthHz: number;
  /** Centre of the disturbance minus the centre of the window. Signed. */
  offsetHz: number;
  /** Disturbance width as a fraction of the analysed span, 0 to 1. */
  coverageRatio: number;
}

/**
 * Placement comes only from the live frame's detector annotation: a stored
 * incident's affectedRangeHz is the whole analysed span, not where the
 * disturbance was, so there is nothing to place for an archived incident.
 */
export function disturbancePlacement(frame: SpectrumFrame | undefined): DisturbancePlacement | undefined {
  const analysis = detectorAnalysisForFrame(frame);
  if (!frame || !analysis || analysis.overload || !analysis.anomalyBinRanges.length || frame.bins.length < 2) return undefined;
  const startBin = Math.min(...analysis.anomalyBinRanges.map((range) => range.startBin));
  const endBin = Math.max(...analysis.anomalyBinRanges.map((range) => range.endBin));
  const binWidthHz = (frame.endHz - frame.startHz) / frame.bins.length;
  const startHz = frame.startHz + startBin * binWidthHz;
  const endHz = frame.startHz + endBin * binWidthHz;
  const widthHz = endHz - startHz;
  const offsetHz = (startHz + endHz) / 2 - (frame.startHz + frame.endHz) / 2;
  const analysedWidthHz = (analysis.analysisEndBin - analysis.analysisStartBin) * binWidthHz;
  const coverageRatio = analysedWidthHz > 0 ? Math.min(1, Math.max(0, widthHz / analysedWidthHz)) : 0;
  return { startHz, endHz, widthHz, offsetHz, coverageRatio };
}

export function disturbancePlacementCopy(placement: DisturbancePlacement): string {
  const extent = `${formatFrequency(placement.startHz, 3).replace(" MHz", "")}-${formatFrequency(placement.endHz, 3)}`;
  const width = `${formatFrequency(placement.widthHz, 3).replace(" MHz", " MHz wide")}`;
  const offsetMagnitude = Math.abs(placement.offsetHz);
  const offset = offsetMagnitude < 10_000
    ? "at the centre"
    : `${formatFrequency(offsetMagnitude, 3).replace(" MHz", ` MHz ${placement.offsetHz < 0 ? "below" : "above"} the centre`)}`;
  const coverage = `${Math.round(placement.coverageRatio * 100)}% of the checked span`;
  return [extent, width, offset, coverage].join(" · ");
}

