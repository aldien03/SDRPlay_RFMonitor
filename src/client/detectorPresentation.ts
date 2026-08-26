import type { DetectorAnomalyBinRange, DetectorSpectrumAnalysis, SignalMetricSample, SpectrumFrame } from "../shared/types";

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

