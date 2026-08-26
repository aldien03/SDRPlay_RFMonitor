import type { BandPreset, MonitorTarget, ScanJob, ScanWindow } from "./types";

export type BandOverride = Partial<BandPreset> & Pick<BandPreset, "id"> & { enabled?: boolean };

export interface CompiledScanTarget {
  id: string;
  physicalTargetId?: string;
  centerHz: number;
  startHz: number;
  endHz: number;
  dwellMs: number;
  analysisSpanHz?: number;
  revisitObjectiveMs?: number;
  tier?: BandPreset["captureTier"];
  nominalVisitMs?: number;
  maxVisitMs?: number;
  tuneAckTimeoutMs?: number;
  settleMs?: number;
  discardFrames?: number;
  minFreshFrames?: number;
  coverage: Array<{ band: BandPreset; window: ScanWindow }>;
}

export function monitorTargetId(startHz: number, endHz: number): string {
  return `rf-${Math.round(startHz)}-${Math.round(endHz)}`;
}

export function describeMonitorTarget(target: CompiledScanTarget): MonitorTarget {
  const bands = [...new Map(target.coverage.map(({ band }) => [band.id, band])).values()];
  return {
    id: target.physicalTargetId ?? monitorTargetId(target.startHz, target.endHz),
    label: [...new Set(bands.map((band) => band.label))].join(" / "),
    service: bands[0]?.service ?? "gnss",
    relatedBandIds: bands.map((band) => band.id),
    centerHz: target.centerHz,
    startHz: target.startHz,
    endHz: target.endHz,
    expectedRevisitMs: target.revisitObjectiveMs ?? target.dwellMs,
    priority: target.tier === "tier1",
  };
}

export function generateChannelCenters(band: BandPreset): number[] {
  if (!band.channelSpacingHz || !band.channelCount) return [];
  return Array.from({ length: band.channelCount }, (_, index) => band.startHz + index * band.channelSpacingHz!);
}

function selectedFrequencyWindows(band: BandPreset, sampleRateHz: number): ScanWindow[] {
  const frequencies = [...new Set(band.selectedFrequenciesHz ?? [])].sort((left, right) => left - right);
  const windows: ScanWindow[] = [];
  let index = 0;
  while (index < frequencies.length) {
    const first = frequencies[index];
    let endIndex = index;
    while (endIndex + 1 < frequencies.length && frequencies[endIndex + 1] - first <= sampleRateHz) endIndex += 1;
    const last = frequencies[endIndex];
    let startHz = Math.max(band.startHz, Math.round((first + last - sampleRateHz) / 2));
    let endHz = Math.min(band.endHz, startHz + sampleRateHz);
    if (endHz - startHz < sampleRateHz) startHz = Math.max(band.startHz, endHz - sampleRateHz);
    windows.push({
      id: `${band.id}-selected-window-${windows.length + 1}`,
      bandId: band.id,
      centerHz: Math.round((startHz + endHz) / 2),
      startHz,
      endHz,
    });
    index = endIndex + 1;
  }
  return windows;
}

export function createScanWindows(band: BandPreset, sampleRateHz: number, overlapRatio = 0.2): ScanWindow[] {
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0) throw new Error("sampleRateHz must be greater than zero");
  if (!Number.isFinite(overlapRatio) || overlapRatio < 0 || overlapRatio >= 1) {
    throw new Error("overlapRatio must be between zero (inclusive) and one (exclusive)");
  }
  if (band.selectedFrequenciesHz?.length) return selectedFrequencyWindows(band, sampleRateHz);
  const bandWidth = band.endHz - band.startHz;
  if (bandWidth <= 0) throw new Error(`Band ${band.id} has an invalid frequency range`);
  if (bandWidth <= sampleRateHz) {
    return [{
      id: `${band.id}-window-1`,
      bandId: band.id,
      centerHz: band.centerHz,
      startHz: band.startHz,
      endHz: band.endHz,
    }];
  }

  const firstCenter = band.startHz + sampleRateHz / 2;
  const lastCenter = band.endHz - sampleRateHz / 2;
  const preferredStep = sampleRateHz * (1 - overlapRatio);
  const intervalCount = Math.max(1, Math.ceil((lastCenter - firstCenter) / preferredStep));
  return Array.from({ length: intervalCount + 1 }, (_, index) => {
    const centerHz = Math.round(firstCenter + ((lastCenter - firstCenter) * index) / intervalCount);
    return {
      id: `${band.id}-window-${index + 1}`,
      bandId: band.id,
      centerHz,
      startHz: index === 0 ? band.startHz : Math.round(centerHz - sampleRateHz / 2),
      endHz: index === intervalCount ? band.endHz : Math.round(centerHz + sampleRateHz / 2),
    };
  });
}

export function compileScanTargets(bands: BandPreset[], sampleRateHz: number): CompiledScanTarget[] {
  const physicalBands = bands.filter((band) => band.captureTargetId && band.captureCenterHz && band.captureSpanHz);
  const physicalTargets = new Map<string, CompiledScanTarget>();
  for (const band of physicalBands) {
    const id = band.captureTargetId!;
    // Catalog span is nominal. Experimental 9 MS/s operation cannot truthfully
    // map bins over the production 10 MHz display span.
    const effectiveCaptureSpanHz = Math.min(band.captureSpanHz!, sampleRateHz);
    const halfSpan = effectiveCaptureSpanHz / 2;
    const window: ScanWindow = {
      id: `${id}-${band.id}`,
      bandId: band.id,
      centerHz: band.captureCenterHz!,
      startHz: Math.round(band.captureCenterHz! - halfSpan),
      endHz: Math.round(band.captureCenterHz! + halfSpan),
    };
    const existing = physicalTargets.get(id);
    if (existing) {
      if (existing.centerHz !== window.centerHz || existing.startHz !== window.startHz || existing.endHz !== window.endHz) {
        throw new Error(`Physical capture target ${id} has inconsistent tuning parameters`);
      }
      existing.coverage.push({ band, window });
      continue;
    }
    physicalTargets.set(id, {
      id,
      physicalTargetId: id,
      centerHz: window.centerHz,
      startHz: window.startHz,
      endHz: window.endHz,
      dwellMs: band.nominalVisitMs ?? band.dwellMs,
      analysisSpanHz: band.analysisSpanHz,
      revisitObjectiveMs: band.revisitObjectiveMs,
      tier: band.captureTier,
      nominalVisitMs: band.nominalVisitMs,
      maxVisitMs: band.maxVisitMs,
      tuneAckTimeoutMs: band.tuneAckTimeoutMs,
      settleMs: band.settleMs,
      discardFrames: band.discardFrames,
      minFreshFrames: band.minFreshFrames,
      coverage: [{ band, window }],
    });
  }
  const legacyBands = bands.filter((band) => !band.captureTargetId);
  const windows = legacyBands.flatMap((band) => createScanWindows(band, sampleRateHz).map((window) => ({ band, window })))
    .sort((left, right) => left.window.startHz - right.window.startHz || left.window.endHz - right.window.endHz);
  const targets: CompiledScanTarget[] = [];
  for (const coverage of windows) {
    const match = targets.find((target) => {
      const startHz = Math.min(target.startHz, coverage.window.startHz);
      const endHz = Math.max(target.endHz, coverage.window.endHz);
      return endHz - startHz <= sampleRateHz;
    });
    if (!match) {
      targets.push({
        id: `scan-target-${targets.length + 1}`,
        centerHz: coverage.window.centerHz,
        startHz: coverage.window.startHz,
        endHz: coverage.window.endHz,
        dwellMs: coverage.band.dwellMs,
        coverage: [coverage],
      });
      continue;
    }
    match.startHz = Math.min(match.startHz, coverage.window.startHz);
    match.endHz = Math.max(match.endHz, coverage.window.endHz);
    match.centerHz = Math.round((match.startHz + match.endHz) / 2);
    match.dwellMs = Math.max(match.dwellMs, coverage.band.dwellMs);
    match.coverage.push(coverage);
  }
  return [...physicalTargets.values(), ...targets.map((target) => ({ ...target, id: monitorTargetId(target.startHz, target.endHz) }))]
    .sort((left, right) => left.centerHz - right.centerHz);
}

export function estimateRevisitMs(bands: BandPreset[], sampleRateHz: number): number {
  return compileScanTargets(bands, sampleRateHz).reduce((total, target) => total + target.dwellMs, 0);
}

export function createScanJobs(bands: BandPreset[], receiverCount: number, now = Date.now()): ScanJob[] {
  if (Math.max(1, receiverCount) === 1) {
    return bands.map((band, index) => ({
      id: `job-${band.id}`,
      bandId: band.id,
      receiver: 0,
      mode: "priority-scan",
      status: index === 0 ? "active" : "coverage-gap",
      nextRunAt: new Date(now + index * band.dwellMs).toISOString(),
    }));
  }

  const gnss = bands.filter((band) => band.service === "gnss");
  const sweep = bands.filter((band) => band.service !== "gnss");
  return [
    ...sweep.map((band, index) => ({
      id: `job-${band.id}`,
      bandId: band.id,
      receiver: 0,
      mode: "sweep" as const,
      status: index === 0 ? ("active" as const) : ("queued" as const),
      nextRunAt: new Date(now + index * band.dwellMs).toISOString(),
    })),
    ...gnss.map((band, index) => ({
      id: `job-${band.id}`,
      bandId: band.id,
      receiver: 1,
      mode: "continuous" as const,
      status: index === 0 ? ("watching" as const) : ("queued" as const),
      nextRunAt: new Date(now + index * band.dwellMs).toISOString(),
    })),
  ];
}

export function mergeBandOverrides(defaults: BandPreset[], overrides: BandOverride[]): BandPreset[] {
  const byId = new Map(defaults.map((band) => [band.id, band]));
  for (const override of overrides) {
    if (override.enabled === false) {
      byId.delete(override.id);
      continue;
    }
    const current = byId.get(override.id);
    const { enabled: _enabled, ...values } = override;
    if (current) byId.set(override.id, { ...current, ...values });
    else byId.set(override.id, values as BandPreset);
  }
  return [...byId.values()];
}
