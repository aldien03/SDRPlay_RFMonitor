import { compileScanTargets, describeMonitorTarget } from "../shared/bands";
import { captureWindowNaming } from "../shared/monitorGroups";
import type {
  BandCatalog,
  BandPreset,
  BaselineDescriptor,
  BaselineLifecycle,
  ChannelMonitorState,
  ServiceGroup,
} from "../shared/types";
import { formatRange } from "./format";

/**
 * Mirrors the server's restart guard so the UI can say no before the operator
 * clicks. Returns undefined when a restart would be accepted.
 */
export function restartBlockedReason(state: ChannelMonitorState | undefined): string | undefined {
  if (!state) return undefined;
  if (state.lifecycle === "active") return "An alert is active on this frequency.";
  if (state.lifecycle === "recovering") return "This frequency is recovering.";
  if (state.candidateCount > 0) return "A signal check is still running on this frequency.";
  return undefined;
}

export const SIGNAL_LEARNING_REQUIRED_HOURS = 24;

export type SignalLearningState = "learning" | "ready" | "approved" | "needs-learning";

export interface SignalLearningTargetView {
  targetId: string;
  label: string;
  /** Signals covered by this physical window, when they differ from the window name. */
  signalsLabel?: string;
  service: ServiceGroup;
  state: SignalLearningState;
  representativeHours: number;
  baseline?: BaselineDescriptor;
}

export interface SignalLearningServiceView {
  id: ServiceGroup;
  label: string;
  state: SignalLearningState;
  representativeHours: number;
  targets: SignalLearningTargetView[];
}

export interface SavedSignalLearningView {
  key: string;
  label: string;
  service?: ServiceGroup;
  /** True when this record's target is still one of the monitored windows. */
  targetActive: boolean;
  state: SignalLearningState;
  representativeHours: number;
  observationCount: number;
  baseline: BaselineDescriptor;
}

export interface SignalLearningPresentation {
  activeServices: SignalLearningServiceView[];
  activeTargets: SignalLearningTargetView[];
  saved: SavedSignalLearningView[];
}

function generationNumber(baseline: BaselineDescriptor): number {
  const value = Number(baseline.learningGenerationId);
  return Number.isFinite(value) ? value : 0;
}

function baselineTime(baseline: BaselineDescriptor): number {
  const value = Date.parse(baseline.learningStartedAt);
  return Number.isFinite(value) ? value : 0;
}

function compareBaselineRecency(left: BaselineDescriptor, right: BaselineDescriptor): number {
  return baselineTime(left) - baselineTime(right)
    || generationNumber(left) - generationNumber(right)
    || left.fingerprintId.localeCompare(right.fingerprintId);
}

function latestGenerations(baselines: readonly BaselineDescriptor[]): BaselineDescriptor[] {
  const latest = new Map<string, BaselineDescriptor>();
  for (const baseline of baselines) {
    const key = `${baseline.targetId}:${baseline.fingerprintId}`;
    const current = latest.get(key);
    if (!current || compareBaselineRecency(current, baseline) < 0) latest.set(key, baseline);
  }
  return [...latest.values()];
}

export function currentBaselinesByTarget(baselines: readonly BaselineDescriptor[]): Map<string, BaselineDescriptor> {
  const current = new Map<string, BaselineDescriptor>();
  for (const baseline of baselines) {
    const selected = current.get(baseline.targetId);
    if (!selected || compareBaselineRecency(selected, baseline) < 0) current.set(baseline.targetId, baseline);
  }
  return current;
}

export function signalLearningState(lifecycle?: BaselineLifecycle): SignalLearningState {
  if (lifecycle === "reviewable") return "ready";
  if (lifecycle === "protected") return "approved";
  if (lifecycle === "stale") return "needs-learning";
  return "learning";
}

export function signalLearningStateLabel(state: SignalLearningState): string {
  if (state === "ready") return "Learning complete";
  if (state === "approved") return "Approved";
  if (state === "needs-learning") return "Needs new learning";
  return "Learning";
}

export function signalLearningProgressLabel(representativeHours: number): string {
  return representativeHours >= SIGNAL_LEARNING_REQUIRED_HOURS
    ? `${SIGNAL_LEARNING_REQUIRED_HOURS} hours complete`
    : `${representativeHours} of ${SIGNAL_LEARNING_REQUIRED_HOURS} hours`;
}

function serviceLearningState(targets: readonly SignalLearningTargetView[]): SignalLearningState {
  if (targets.some((target) => target.state === "needs-learning")) return "needs-learning";
  if (targets.length > 0 && targets.every((target) => target.state === "approved")) return "approved";
  if (
    targets.some((target) => target.state === "ready")
    && targets.every((target) => target.state === "ready" || target.state === "approved")
  ) return "ready";
  return "learning";
}

function serviceForSurveyRange(catalog: BandCatalog, startHz: number, endHz: number): ServiceGroup | undefined {
  const centerHz = (startHz + endHz) / 2;
  return catalog.bands.find((band) => (
    !band.captureTargetId
    && centerHz >= band.startHz
    && centerHz <= band.endHz
  ))?.service;
}

function parseSurveyTargetId(targetId: string): { startHz: number; endHz: number } | undefined {
  const match = /^rf-(\d+)-(\d+)$/.exec(targetId);
  if (!match) return undefined;
  const startHz = Number(match[1]);
  const endHz = Number(match[2]);
  return Number.isFinite(startHz) && Number.isFinite(endHz) && endHz > startHz ? { startHz, endHz } : undefined;
}

function savedBaselineIdentity(
  baseline: BaselineDescriptor,
  catalog: BandCatalog,
  activeTargets: ReadonlyMap<string, SignalLearningTargetView>,
): { label: string; service?: ServiceGroup } {
  const active = activeTargets.get(baseline.targetId);
  if (active) return { label: active.label, service: active.service };
  const physical = catalog.captureTargets.find((target) => target.id === baseline.targetId);
  if (physical) return { label: physical.label, service: physical.service };
  const survey = parseSurveyTargetId(baseline.targetId);
  if (survey) {
    const service = serviceForSurveyRange(catalog, survey.startHz, survey.endHz);
    const serviceLabel = catalog.services.find((candidate) => candidate.id === service)?.label;
    return {
      label: [serviceLabel, formatRange(survey.startHz, survey.endHz)].filter(Boolean).join(" "),
      service,
    };
  }
  return { label: "Saved RF target" };
}

export function buildSignalLearningPresentation(input: {
  catalog: BandCatalog;
  effectiveBands: readonly BandPreset[];
  sampleRateHz: number;
  baselines: readonly BaselineDescriptor[];
}): SignalLearningPresentation {
  const baselines = latestGenerations(input.baselines);
  const currentBaselines = currentBaselinesByTarget(baselines);
  const serviceLabels = new Map(input.catalog.services.map((service) => [service.id, service.label]));
  const activeTargets = compileScanTargets([...input.effectiveBands], input.sampleRateHz).map((target): SignalLearningTargetView => {
    const described = describeMonitorTarget(target);
    const baseline = currentBaselines.get(target.id);
    const serviceLabel = serviceLabels.get(described.service);
    const physical = target.physicalTargetId
      ? input.catalog.captureTargets.find((candidate) => candidate.id === target.physicalTargetId)
      : undefined;
    const bands = [...new Map(target.coverage.map(({ band }) => [band.id, band])).values()];
    const naming = captureWindowNaming({
      serviceLabel: serviceLabel ?? described.service,
      fallbackLabel: physical?.label
        ?? (target.physicalTargetId
          ? described.label
          : [serviceLabel, formatRange(target.startHz, target.endHz)].filter(Boolean).join(" ")),
      centerHz: target.centerHz,
      signals: bands.map((band) => ({ label: band.label, centerHz: band.centerHz })),
    });
    return {
      targetId: target.id,
      label: naming.label,
      ...(naming.signalsLabel ? { signalsLabel: naming.signalsLabel } : {}),
      service: described.service,
      state: signalLearningState(baseline?.lifecycle),
      representativeHours: baseline?.representativeHours ?? 0,
      baseline,
    };
  });
  const activeTargetMap = new Map(activeTargets.map((target) => [target.targetId, target]));
  const activeBaselineSet = new Set(activeTargets.flatMap((target) => target.baseline ? [target.baseline] : []));
  const activeServices = input.catalog.services.flatMap((service): SignalLearningServiceView[] => {
    const targets = activeTargets.filter((target) => target.service === service.id);
    if (!targets.length) return [];
    let representativeHours = SIGNAL_LEARNING_REQUIRED_HOURS;
    for (const target of targets) representativeHours = Math.min(representativeHours, target.representativeHours);
    return [{
      id: service.id,
      label: service.label,
      state: serviceLearningState(targets),
      representativeHours,
      targets,
    }];
  });
  const saved = baselines
    .filter((baseline) => !activeBaselineSet.has(baseline))
    .map((baseline): SavedSignalLearningView => {
      const identity = savedBaselineIdentity(baseline, input.catalog, activeTargetMap);
      return {
        key: `${baseline.targetId}:${baseline.fingerprintId}:${baseline.learningGenerationId}`,
        ...identity,
        targetActive: activeTargetMap.has(baseline.targetId),
        state: signalLearningState(baseline.lifecycle),
        representativeHours: baseline.representativeHours,
        observationCount: baseline.observationCount,
        baseline,
      };
    })
    .sort((left, right) => left.label.localeCompare(right.label));

  return { activeServices, activeTargets, saved };
}
