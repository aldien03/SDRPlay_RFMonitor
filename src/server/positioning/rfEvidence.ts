/**
 * Spectrum frame shape used by the DGNSS report's RF analysis, and the
 * mock-up-only transform that superimposes a simulated wideband episode.
 * Levels are relative uint8 values; dBm and SNR are as reported by SDRconnect.
 */

export interface RfFrame {
  timeMs: number;
  /** Physical capture target, e.g. "gnss-l1-e1-b1c-sbas". */
  targetId: string;
  bandId: string;
  meanLevel: number;
  peakLevel: number;
  baselineLevel: number;
  medianZ: number;
  peakZ: number;
  occupied: number;
  maxWidth: number;
  powerDbm?: number;
  snrDb?: number;
  overload: boolean;
  startHz: number;
  endHz: number;
  analysisStartBin: number;
  analysisEndBin: number;
  /** Full captured spectrum (inputBinCount bins). */
  bins?: Uint8Array;
  /** Set on frames altered for the mock-up. */
  simulated?: boolean;
}

/**
 * Mock-up only: a transform that raises 66% of the analysed band on the given
 * targets between two times (bins and metrics), marking every altered frame.
 */
export function simulatedWideband(targets: string[], fromMs: number, toMs: number): (frame: RfFrame) => RfFrame {
  let seed = 12345;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return (seed / 0x7fffffff) * 8 - 4;
  };
  return (frame) => {
    if (!targets.includes(frame.targetId) || frame.timeMs < fromMs || frame.timeMs > toMs) return frame;
    const ramp = Math.min(1, (frame.timeMs - fromMs) / 20_000, (toMs - frame.timeMs) / 20_000) * 0.6 + 0.4;
    let bins = frame.bins;
    if (bins) {
      bins = new Uint8Array(bins);
      const width = frame.analysisEndBin - frame.analysisStartBin;
      const from = frame.analysisStartBin + Math.round(width * 0.18);
      const to = frame.analysisStartBin + Math.round(width * 0.84);
      for (let bin = from; bin < to; bin += 1) bins[bin] = Math.max(0, Math.min(255, bins[bin] + Math.round(24 * ramp + noise())));
    }
    return {
      ...frame,
      bins,
      meanLevel: frame.meanLevel + 15 * ramp,
      peakLevel: Math.min(255, frame.peakLevel + 26 * ramp),
      medianZ: Math.max(frame.medianZ, 9 * ramp),
      peakZ: Math.max(frame.peakZ, 30 * ramp),
      occupied: Math.max(frame.occupied, 0.64 * ramp),
      maxWidth: Math.max(frame.maxWidth, 0.62 * ramp),
      powerDbm: frame.powerDbm !== undefined ? frame.powerDbm + 12 * ramp : undefined,
      snrDb: frame.snrDb !== undefined ? frame.snrDb - 6 * ramp : undefined,
      simulated: true,
    };
  };
}
