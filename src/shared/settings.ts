import { estimateRevisitMs, generateChannelCenters } from "./bands";
import type {
  BandCatalog,
  BandPreset,
  CaptureTargetTier,
  EvidenceRetentionPolicy,
  GnssConstellation,
  MonitoringMission,
  PhysicalCaptureTarget,
  OperationalSettings,
  SchedulerHealth,
  ServiceCoverageSummary,
  ServiceGroup,
  SettingsFeasibility,
} from "./types";

export function captureTargetTierForProfile(
  target: PhysicalCaptureTarget,
  settings: OperationalSettings,
  catalog: BandCatalog,
): CaptureTargetTier {
  if (settings.scan.profile === "fast-gnss") return target.tier;
  if (settings.scan.profile === "balanced") return "survey";
  if (settings.scan.priorityWindowId === target.id) return "tier1";
  const priorityWindow = catalog.priorityWindows.find((window) => window.id === settings.scan.priorityWindowId);
  const priorityBands = new Set(priorityWindow?.relatedBandIds ?? []);
  return target.relatedBandIds.some((bandId) => priorityBands.has(bandId)) ? "tier1" : "survey";
}

/**
 * Produces the same machine-readable feasibility result for saved settings and
 * unsaved client drafts. Human-facing copy deliberately stays in the client.
 */
export function evaluateSettingsFeasibility(input: {
  settings: OperationalSettings;
  catalog: BandCatalog;
  sampleRateHz: number;
  schedulerHealth?: SchedulerHealth;
  measurementAvailable?: boolean;
}): SettingsFeasibility {
  const { settings, catalog, sampleRateHz, schedulerHealth } = input;
  const enabledSignalIds = new Set(
    settings.monitoring.gnss.enabled
      ? settings.monitoring.gnss.enabledSignalIds.filter((bandId) => {
        const band = catalog.bands.find((candidate) => candidate.id === bandId);
        return Boolean(band?.constellation && settings.monitoring.gnss.enabledSystemIds.includes(band.constellation));
      })
      : [],
  );
  const enabledTargets = catalog.captureTargets.filter((target) => target.relatedBandIds.some((bandId) => enabledSignalIds.has(bandId)));
  const tier1Targets = enabledTargets.filter((target) => captureTargetTierForProfile(target, settings, catalog) === "tier1");
  const tier1Utilization = tier1Targets.reduce((total, target) => total + target.nominalVisitMs / target.revisitObjectiveMs, 0);
  const roundedUtilization = Number(tier1Utilization.toFixed(4));
  const scheduleCapacity = tier1Utilization > 1.0001 ? "overloaded" : tier1Utilization >= 0.9999 ? "full" : "available";
  const optionalTargets = catalog.captureTargets.filter((target) => captureTargetTierForProfile(target, settings, catalog) !== "tier1");
  const configuredOptionalTargets = enabledTargets.filter((target) => captureTargetTierForProfile(target, settings, catalog) !== "tier1");
  const optionalWorkConfigured = configuredOptionalTargets.length > 0
    || settings.monitoring.startrack.enabled
    || settings.monitoring["4dx"].enabled;
  const admissionNeedsLiveProof = settings.scan.profile === "fast-gnss" || tier1Targets.length > 0;
  const optionalWorkAdmitted = optionalWorkConfigured
    && scheduleCapacity === "available"
    && (admissionNeedsLiveProof ? schedulerHealth?.optionalWorkAdmitted === true : true);
  const revisitObjective = input.measurementAvailable !== false && schedulerHealth?.tier1MeetingObjective === true
    ? "meeting"
    : input.measurementAvailable !== false && schedulerHealth?.tier1MeetingObjective === false
      ? "missed"
      : "not-verified";
  const captureSpanHz = enabledTargets.reduce((maximum, target) => Math.max(maximum, target.captureSpanHz), sampleRateHz);
  const analysisSpanHz = enabledTargets.reduce((maximum, target) => Math.max(maximum, target.analysisSpanHz), 0)
    || Math.min(sampleRateHz, 8_000_000);
  const reasons: SettingsFeasibility["reasons"] = [];
  if (scheduleCapacity === "full") reasons.push({ code: "tier1-capacity-full", severity: "attention", targetIds: tier1Targets.map((target) => target.id) });
  if (scheduleCapacity === "overloaded") reasons.push({ code: "tier1-capacity-overloaded", severity: "attention", targetIds: tier1Targets.map((target) => target.id) });
  if (revisitObjective === "not-verified") reasons.push({ code: "tier1-objective-unverified", severity: "info", targetIds: tier1Targets.map((target) => target.id) });
  if (revisitObjective === "missed") reasons.push({ code: "tier1-objective-missed", severity: "attention", targetIds: tier1Targets.map((target) => target.id) });
  if (optionalTargets.length && !schedulerHealth?.optionalQualificationReady) reasons.push({ code: "optional-qualification-pending", severity: "info", targetIds: optionalTargets.map((target) => target.id) });
  if (optionalTargets.length && scheduleCapacity !== "available") reasons.push({ code: "optional-reserve-unavailable", severity: "attention", targetIds: optionalTargets.map((target) => target.id) });
  if (sampleRateHz !== 10_000_000) reasons.push({ code: "experimental-sample-rate", severity: "attention" });
  if (analysisSpanHz < captureSpanHz) reasons.push({ code: "analysis-guard-bins", severity: "info", targetIds: enabledTargets.map((target) => target.id) });
  return {
    profile: settings.scan.profile,
    tier1Utilization: roundedUtilization,
    protectedReserveRatio: schedulerHealth?.protectedReserveRatio ?? 0.1,
    tier1Feasible: scheduleCapacity === "available",
    scheduleCapacity,
    optionalScans: optionalWorkAdmitted ? "admitted" : settings.scan.profile === "fast-gnss" || optionalWorkConfigured ? "paused" : "off",
    revisitObjective,
    optionalWorkAdmitted,
    admittedOptionalTargetIds: optionalWorkAdmitted ? configuredOptionalTargets.map((target) => target.id) : [],
    pausedOptionalTargetIds: optionalWorkAdmitted ? [] : optionalTargets.map((target) => target.id),
    captureSpanHz,
    analysisSpanHz,
    reasons,
  };
}

export const GNSS_CONSTELLATIONS: GnssConstellation[] = ["GPS", "GLONASS", "Galileo", "BeiDou", "SBAS"];
const REQUIRED_GNSS_SYSTEMS: GnssConstellation[] = ["GPS", "GLONASS", "Galileo", "BeiDou"];
export const SERVICE_GROUPS: ServiceGroup[] = ["startrack", "4dx", "gnss"];

function selectedGnssTargetIds(settings: OperationalSettings, catalog: BandCatalog): string[] {
  if (!settings.monitoring.gnss.enabled) return [];
  const signalIds = new Set(settings.monitoring.gnss.enabledSignalIds.filter((bandId) => {
    const band = catalog.bands.find((candidate) => candidate.id === bandId);
    return Boolean(band?.constellation && settings.monitoring.gnss.enabledSystemIds.includes(band.constellation));
  }));
  return catalog.captureTargets
    .filter((target) => target.service === "gnss" && target.relatedBandIds.some((bandId) => signalIds.has(bandId)))
    .map((target) => target.id);
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(right);
  return left.every((id) => expected.has(id));
}

/** Returns a task label only when the active selection matches that task. */
export function monitoringMissionForSettings(settings: OperationalSettings, catalog: BandCatalog): MonitoringMission {
  const radiosEnabled = settings.monitoring.startrack.enabled || settings.monitoring["4dx"].enabled;
  const selectedTargets = selectedGnssTargetIds(settings, catalog);
  if (settings.scan.profile === "gnss-priority" && !radiosEnabled && selectedTargets.length === 1) return "primary-watch";
  const tierOneTargets = catalog.captureTargets.filter((target) => target.service === "gnss" && target.tier === "tier1").map((target) => target.id);
  if (settings.scan.profile === "fast-gnss" && !radiosEnabled && sameIds(selectedTargets, tierOneTargets)) return "multi-band-survey";
  if (settings.scan.profile === "balanced" && !settings.monitoring.gnss.enabled && radiosEnabled) return "radio-survey";
  return "custom";
}

export function primaryWatchTargetId(settings: OperationalSettings, catalog: BandCatalog): string | undefined {
  const ids = selectedGnssTargetIds(settings, catalog);
  return ids.length === 1 ? ids[0] : undefined;
}

function setGnssSignals(settings: OperationalSettings, catalog: BandCatalog, signalIds: readonly string[]): void {
  const enabledSignalIds = new Set(signalIds);
  const enabledSystemIds = new Set<GnssConstellation>();
  for (const band of catalog.bands.filter((candidate) => candidate.service === "gnss" && candidate.constellation)) {
    if (enabledSignalIds.has(band.id)) enabledSystemIds.add(band.constellation!);
  }
  settings.monitoring.gnss.enabled = enabledSignalIds.size > 0;
  settings.monitoring.gnss.enabledSignalIds = [...enabledSignalIds];
  settings.monitoring.gnss.enabledSystemIds = GNSS_CONSTELLATIONS.filter((system) => enabledSystemIds.has(system));
  for (const constellation of GNSS_CONSTELLATIONS) {
    const group = settings.monitoring.gnss.constellations[constellation] ?? { enabled: false, signals: {} };
    group.enabled = enabledSystemIds.has(constellation);
    for (const band of catalog.bands.filter((candidate) => candidate.service === "gnss" && candidate.constellation === constellation)) {
      const target = catalog.captureTargets.find((candidate) => candidate.id === band.captureTargetId);
      group.signals[band.id] = {
        ...(group.signals[band.id] ?? { spanHz: target?.analysisSpanHz ?? 8_000_000 }),
        enabled: enabledSignalIds.has(band.id),
      };
    }
    settings.monitoring.gnss.constellations[constellation] = group;
  }
}

/** Applies one explicit single-tuner mission without changing the v3 storage schema. */
export function applyMonitoringMission(
  settings: OperationalSettings,
  catalog: BandCatalog,
  mission: Exclude<MonitoringMission, "custom">,
  requestedTargetId?: string,
): OperationalSettings {
  const next = structuredClone(settings);
  if (mission === "primary-watch") {
    const target = catalog.captureTargets.find((candidate) => candidate.service === "gnss" && candidate.id === requestedTargetId)
      ?? catalog.captureTargets.find((candidate) => candidate.id === "gnss-l1-e1-b1c-sbas")
      ?? catalog.captureTargets.find((candidate) => candidate.service === "gnss" && candidate.tier === "tier1")
      ?? catalog.captureTargets.find((candidate) => candidate.service === "gnss");
    if (!target) throw new SettingsValidationError({ monitoring: "No GNSS band is available" });
    const priorityWindow = catalog.priorityWindows.find((window) => window.relatedBandIds.some((bandId) => target.relatedBandIds.includes(bandId)));
    next.scan.profile = "gnss-priority";
    next.scan.priorityWindowId = priorityWindow?.id ?? target.id;
    next.scan.maxPriorityGapMs = Math.max(2_000, target.revisitObjectiveMs);
    next.monitoring.startrack.enabled = false;
    next.monitoring["4dx"].enabled = false;
    setGnssSignals(next, catalog, target.relatedBandIds);
    return next;
  }
  if (mission === "multi-band-survey") {
    const tierOneSignals = catalog.captureTargets
      .filter((target) => target.service === "gnss" && target.tier === "tier1")
      .flatMap((target) => target.relatedBandIds);
    if (!tierOneSignals.length) throw new SettingsValidationError({ monitoring: "No GNSS survey bands are available" });
    next.scan.profile = "fast-gnss";
    next.monitoring.startrack.enabled = false;
    next.monitoring["4dx"].enabled = false;
    setGnssSignals(next, catalog, tierOneSignals);
    return next;
  }
  next.scan.profile = "balanced";
  next.monitoring.gnss.enabled = false;
  next.monitoring.startrack.enabled = true;
  next.monitoring["4dx"].enabled = true;
  return next;
}

const ROBUST_DETECTION_DEFAULTS: OperationalSettings["detection"] = {
  ruleSetId: "rf-relative-mad-v1",
  scaleFloorBins: 1,
  widebandObservationSigma: 6,
  widebandObservationOccupancy: 0.35,
  interferenceSigma: 8,
  interferenceOccupancy: 0.5,
  interferenceHits: 3,
  interferenceWindow: 5,
  interferenceExposureMs: 2_000,
  narrowbandPeakSigma: 10,
  narrowbandMaxWidthRatio: 0.1,
  driftSigma: 4,
  driftExposureMs: 10_000,
  clearObservations: 10,
  reservoirSize: 256,
  minimumLearningMs: 30 * 60_000,
};

export class SettingsValidationError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super(Object.values(fields)[0] ?? "Operational settings are invalid");
    this.name = "SettingsValidationError";
  }
}

export interface OperationalSettingsSeed {
  siteName: string;
  deploymentId?: string;
  displayTimeZone: string;
  detection: OperationalSettings["detection"];
  retention: EvidenceRetentionPolicy;
  updatedAt?: string;
}

function serviceBand(catalog: BandCatalog, service: ServiceGroup): BandPreset {
  const band = catalog.bands.find((candidate) => candidate.service === service);
  if (!band) throw new Error(`Frequency catalog does not define ${service}`);
  return band;
}

export function createDefaultOperationalSettings(catalog: BandCatalog, seed: OperationalSettingsSeed): OperationalSettings {
  const fourDx = serviceBand(catalog as BandCatalog, "4dx");
  const gnssBands = catalog.bands.filter((band) => band.service === "gnss" && band.constellation && band.signal);
  const enabledSignalIds = gnssBands
    .filter((band) => band.defaultEnabled ?? catalog.captureTargets.find((target) => target.id === band.captureTargetId)?.defaultEnabled ?? false)
    .map((band) => band.id);
  const constellations = Object.fromEntries(GNSS_CONSTELLATIONS.map((constellation) => [
    constellation,
    {
      enabled: gnssBands.some((band) => band.constellation === constellation && enabledSignalIds.includes(band.id)),
      signals: Object.fromEntries(gnssBands
        .filter((band) => band.constellation === constellation)
        .map((band) => [band.id, { enabled: enabledSignalIds.includes(band.id), spanHz: band.captureTargetId
          ? catalog.captureTargets.find((target) => target.id === band.captureTargetId)?.analysisSpanHz ?? 8_000_000
          : band.endHz - band.startHz }])),
    },
  ])) as OperationalSettings["monitoring"]["gnss"]["constellations"];
  const enabledSystemIds = GNSS_CONSTELLATIONS.filter((constellation) => constellations[constellation].enabled);
  const defaults: OperationalSettings = {
    schemaVersion: 3,
    revision: 1,
    updatedAt: seed.updatedAt ?? new Date().toISOString(),
    siteName: seed.siteName,
    deploymentId: seed.deploymentId,
    displayTimeZone: seed.displayTimeZone,
    monitoring: {
      startrack: { enabled: false, channels: { mode: "all", frequenciesHz: [] } },
      "4dx": { enabled: false, channels: { mode: "all", frequenciesHz: [], startChannel: 1, endChannel: fourDx.channelCount } },
      gnss: { enabled: true, enabledSystemIds, enabledSignalIds, constellations },
    },
    scan: {
      profile: "fast-gnss",
      priorityWindowId: catalog.priorityWindows[0]?.id ?? "gnss-l1-core",
      maxPriorityGapMs: 2_000,
      dwellMs: { startrack: 8_000, "4dx": 8_000, gnss: 1_000 },
      priority: { startrack: 1, "4dx": 1, gnss: 10 },
    },
    detection: { ...seed.detection },
    retention: { ...seed.retention },
    liveFocusTimeoutMs: 2 * 60_000,
  };
  const primaryTarget = catalog.captureTargets.find((target) => target.id === "gnss-l1-e1-b1c-sbas")
    ?? catalog.captureTargets.find((target) => target.service === "gnss" && target.tier === "tier1")
    ?? catalog.captureTargets.find((target) => target.service === "gnss");
  return primaryTarget
    ? applyMonitoringMission(defaults, catalog, "primary-watch", primaryTarget.id)
    : defaults;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function createLegacyCaptureTargets(bands: BandPreset[]): PhysicalCaptureTarget[] {
  const groups = new Map<number, BandPreset[]>();
  for (const band of bands.filter((candidate) => candidate.service === "gnss")) {
    groups.set(band.centerHz, [...(groups.get(band.centerHz) ?? []), band]);
  }
  return [...groups.entries()].map(([centerHz, related]) => {
    const tier1 = related.some((band) => ["gps-l1", "gps-l2", "gps-l5", "glonass-g1"].includes(band.id));
    return {
      id: `gnss-${centerHz}`,
      label: related.map((band) => band.label).join(" / "),
      service: "gnss" as const,
      relatedBandIds: related.map((band) => band.id),
      centerHz,
      captureSpanHz: 10_000_000,
      analysisSpanHz: 8_000_000,
      tier: tier1 ? "tier1" as const : "tier2" as const,
      defaultEnabled: false,
      revisitObjectiveMs: tier1 ? (centerHz === 1_575_420_000 ? 2_000 : 6_000) : 30_000,
      weight: tier1 ? 10 : 1,
      nominalVisitMs: 1_000,
      maxVisitMs: 1_500,
      tuneAckTimeoutMs: 500,
      settleMs: 250,
      discardFrames: 2,
      minFreshFrames: 3,
    };
  });
}

export function validateBandCatalog(input: BandCatalog): BandCatalog {
  const catalog = structuredClone(input) as Omit<BandCatalog, "schemaVersion" | "captureTargets"> & { schemaVersion: 1 | 2 | 3; priorityWindows?: BandCatalog["priorityWindows"]; captureTargets?: PhysicalCaptureTarget[] };
  const sourceSchemaVersion = catalog.schemaVersion;
  if (catalog.schemaVersion === 1) {
    catalog.schemaVersion = 2;
    catalog.priorityWindows = [{ id: "gnss-l1-core", label: "GNSS L1 / E1 / B1C core", service: "gnss", centerHz: 1_575_420_000, spanHz: 10_000_000, relatedBandIds: ["gps-l1", "galileo-e1", "beidou-b1c"] }];
  }
  if (catalog.schemaVersion === 2) {
    catalog.schemaVersion = 3;
    // A real v1/v2 catalog has no physical-target fields. Clear any stray
    // forward-version fields before deriving the structural migration so a
    // partially edited catalog cannot cross-link two different centers.
    if (sourceSchemaVersion < 3) {
      for (const band of catalog.bands) {
        delete band.captureTargetId;
        delete band.captureCenterHz;
        delete band.captureSpanHz;
        delete band.analysisSpanHz;
        delete band.revisitObjectiveMs;
        delete band.captureTier;
        delete band.nominalVisitMs;
        delete band.maxVisitMs;
        delete band.settleMs;
        delete band.discardFrames;
        delete band.minFreshFrames;
      }
    }
    catalog.captureTargets = createLegacyCaptureTargets(catalog.bands);
    const targetByBand = new Map(catalog.captureTargets.flatMap((target) => target.relatedBandIds.map((bandId) => [bandId, target.id] as const)));
    for (const band of catalog.bands) if (band.service === "gnss" && !band.captureTargetId) band.captureTargetId = targetByBand.get(band.id);
  }
  if (catalog?.schemaVersion !== 3 || typeof catalog.catalogVersion !== "string" || !catalog.catalogVersion.trim()) {
    throw new Error("Frequency catalog must have schemaVersion 1 and a catalogVersion");
  }
  if (!Array.isArray(catalog.services) || !Array.isArray(catalog.bands)) throw new Error("Frequency catalog is incomplete");
  const services = new Set(catalog.services.map((service) => service.id));
  for (const required of SERVICE_GROUPS) if (!services.has(required)) throw new Error(`Frequency catalog is missing service ${required}`);
  const ids = new Set<string>();
  for (const band of catalog.bands) {
    if (!band || typeof band.id !== "string" || !/^[A-Za-z0-9._-]+$/.test(band.id)) throw new Error("Frequency catalog contains an invalid band id");
    if (ids.has(band.id)) throw new Error(`Frequency catalog band id is duplicated: ${band.id}`);
    ids.add(band.id);
    if (!services.has(band.service) || !band.label?.trim()) throw new Error(`Frequency catalog band ${band.id} is incomplete`);
    if (![band.startHz, band.endHz, band.centerHz].every(finite) || band.startHz >= band.endHz || band.centerHz < band.startHz || band.centerHz > band.endHz) {
      throw new Error(`Frequency catalog band ${band.id} has an invalid range`);
    }
    if (!Number.isInteger(band.dwellMs) || band.dwellMs < 250 || !Number.isInteger(band.priority) || band.priority < 0) {
      throw new Error(`Frequency catalog band ${band.id} has invalid scan settings`);
    }
    if ((band.channelSpacingHz === undefined) !== (band.channelCount === undefined)) throw new Error(`Frequency catalog band ${band.id} has an incomplete channel plan`);
    if (band.channelSpacingHz !== undefined && (!Number.isInteger(band.channelSpacingHz) || band.channelSpacingHz <= 0 || !Number.isInteger(band.channelCount) || band.channelCount! <= 0)) {
      throw new Error(`Frequency catalog band ${band.id} has an invalid channel plan`);
    }
  }
  if (!Array.isArray(catalog.priorityWindows) || !catalog.priorityWindows.length) throw new Error("Frequency catalog must define at least one priority window");
  for (const window of catalog.priorityWindows) {
    if (!window.id?.trim() || window.service !== "gnss" || !finite(window.centerHz) || !finite(window.spanHz) || window.spanHz <= 0 || !Array.isArray(window.relatedBandIds) || !window.relatedBandIds.length) throw new Error("Frequency catalog contains an invalid priority window");
    if (window.relatedBandIds.some((id) => !ids.has(id))) throw new Error(`Priority window ${window.id} references an unknown band`);
  }
  if (!Array.isArray(catalog.captureTargets) || !catalog.captureTargets.length || catalog.captureTargets.length > 64) throw new Error("Frequency catalog must define 1 to 64 physical capture targets");
  const captureIds = new Set<string>();
  for (const target of catalog.captureTargets) {
    if (!target.id?.trim() || captureIds.has(target.id)) throw new Error(`Physical capture target id is missing or duplicated: ${target.id ?? "unknown"}`);
    captureIds.add(target.id);
    if (!target.label?.trim() || target.service !== "gnss" || !finite(target.centerHz) || !finite(target.captureSpanHz) || !finite(target.analysisSpanHz) || target.captureSpanHz <= 0 || target.captureSpanHz > 10_000_000 || target.analysisSpanHz <= 0 || target.analysisSpanHz > target.captureSpanHz) throw new Error(`Physical capture target ${target.id} has invalid frequency bounds`);
    if (!Array.isArray(target.relatedBandIds) || !target.relatedBandIds.length || target.relatedBandIds.some((id) => !ids.has(id))) throw new Error(`Physical capture target ${target.id} references an unknown signal`);
    if (![target.revisitObjectiveMs, target.nominalVisitMs, target.maxVisitMs, target.tuneAckTimeoutMs, target.settleMs, target.discardFrames, target.minFreshFrames].every((value) => Number.isInteger(value) && value > 0) || target.maxVisitMs < target.nominalVisitMs) throw new Error(`Physical capture target ${target.id} has invalid visit timing`);
    for (const bandId of target.relatedBandIds) {
      const band = catalog.bands.find((candidate) => candidate.id === bandId)!;
      if (band.service !== target.service || (band.captureTargetId && band.captureTargetId !== target.id)) throw new Error(`Signal ${bandId} has an inconsistent physical capture target`);
      Object.assign(band, {
        captureTargetId: target.id,
        captureCenterHz: target.centerHz,
        captureSpanHz: target.captureSpanHz,
        analysisSpanHz: target.analysisSpanHz,
        revisitObjectiveMs: target.revisitObjectiveMs,
        captureTier: target.tier,
        nominalVisitMs: target.nominalVisitMs,
        maxVisitMs: target.maxVisitMs,
        tuneAckTimeoutMs: target.tuneAckTimeoutMs,
        settleMs: target.settleMs,
        discardFrames: target.discardFrames,
        minFreshFrames: target.minFreshFrames,
        nominalDisplayHz: target.nominalDisplayHz ?? band.nominalDisplayHz,
      });
    }
  }
  for (const band of catalog.bands.filter((candidate) => candidate.service === "gnss")) if (!band.captureTargetId || !captureIds.has(band.captureTargetId)) throw new Error(`GNSS signal ${band.id} must reference a physical capture target`);
  serviceBand(catalog as BandCatalog, "startrack");
  serviceBand(catalog as BandCatalog, "4dx");
  for (const constellation of REQUIRED_GNSS_SYSTEMS) {
    if (!catalog.bands.some((band) => band.service === "gnss" && band.constellation === constellation)) {
      throw new Error(`Frequency catalog is missing ${constellation}`);
    }
  }
  return catalog as BandCatalog;
}

export function validateOperationalSettings(input: OperationalSettings, catalog: BandCatalog): OperationalSettings {
  const fields: Record<string, string> = {};
  if (!input || typeof input !== "object") throw new SettingsValidationError({ settings: "Operational settings are required" });
  const settings = structuredClone(input) as Omit<OperationalSettings, "schemaVersion"> & { schemaVersion: 1 | 2 | 3; scan: OperationalSettings["scan"] & { profile?: OperationalSettings["scan"]["profile"]; priorityWindowId?: string; maxPriorityGapMs?: number } };
  if (settings?.schemaVersion === 1) {
    settings.schemaVersion = 2;
    settings.scan.profile = "balanced";
    settings.scan.priorityWindowId = catalog.priorityWindows[0]?.id ?? "gnss-l1-core";
    settings.scan.maxPriorityGapMs = 10_000;
  }
  if (settings?.schemaVersion === 2) {
    settings.schemaVersion = 3;
    const groups = settings.monitoring?.gnss?.constellations ?? {} as OperationalSettings["monitoring"]["gnss"]["constellations"];
    settings.monitoring.gnss.enabledSystemIds = Object.entries(groups).filter(([, group]) => group.enabled).map(([system]) => system as GnssConstellation);
    settings.monitoring.gnss.enabledSignalIds = Object.values(groups).flatMap((group) => Object.entries(group.signals).filter(([, signal]) => signal.enabled).map(([bandId]) => bandId));
    // Legacy thresholds were raw display-bin deltas. Do not reinterpret them
    // as robust MAD scales; v3 starts from an explicitly versioned rule set.
    settings.detection = { ...ROBUST_DETECTION_DEFAULTS };
  }
  if (settings?.schemaVersion !== 3) fields.schemaVersion = "Unsupported operational-settings schema";
  if (!Number.isInteger(settings?.revision) || settings.revision < 1) fields.revision = "Revision must be a positive integer";
  if (typeof settings?.siteName !== "string" || !settings.siteName.trim() || settings.siteName.length > 80) fields.siteName = "Site name must contain 1 to 80 characters";
  settings.siteName = settings.siteName?.trim();
  if (settings.deploymentId !== undefined && (typeof settings.deploymentId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(settings.deploymentId))) {
    fields.deploymentId = "Deployment ID may use letters, numbers, dot, underscore, and hyphen";
  }
  if (typeof settings.displayTimeZone !== "string" || !validateTimeZone(settings.displayTimeZone)) fields.displayTimeZone = "Select a valid IANA time zone";
  if (!settings.monitoring || !settings.scan?.dwellMs || !settings.scan?.priority || !settings.detection || !settings.retention) fields.settings = "Operational settings are incomplete";
  if (Object.keys(fields).length) throw new SettingsValidationError(fields);

  const startrack = serviceBand(catalog, "startrack");
  const startrackSelection = settings.monitoring.startrack?.channels;
  if (!startrackSelection || !Array.isArray(startrackSelection.frequenciesHz)) fields["monitoring.startrack"] = "Radio frequency selection is missing";
  if (startrackSelection?.mode === "frequencies" && Array.isArray(startrackSelection.frequenciesHz)) {
    const frequencies = [...new Set(startrackSelection.frequenciesHz)].sort((left, right) => left - right);
    if (!frequencies.length) fields["monitoring.startrack.frequenciesHz"] = "Select at least one StarTrack frequency";
    for (const frequency of frequencies) {
      if (!Number.isInteger(frequency) || frequency < startrack.startHz || frequency > startrack.endHz || (frequency - startrack.startHz) % startrack.channelSpacingHz! !== 0) {
        fields["monitoring.startrack.frequenciesHz"] = `Selected frequencies must align to the catalog's ${startrack.channelSpacingHz! / 1_000} kHz grid`;
        break;
      }
    }
    startrackSelection.frequenciesHz = frequencies;
  }
  if (!startrackSelection || !["all", "frequencies"].includes(startrackSelection.mode)) fields["monitoring.startrack.mode"] = "Choose all frequencies or selected frequencies";

  const fourDx = serviceBand(catalog as BandCatalog, "4dx");
  const fourDxSelection = settings.monitoring["4dx"]?.channels;
  if (!fourDxSelection || !["all", "range"].includes(fourDxSelection.mode)) fields["monitoring.4dx.mode"] = "Choose all channels or a deployed channel range";
  if (fourDxSelection?.mode === "range") {
    const start = fourDxSelection.startChannel;
    const end = fourDxSelection.endChannel;
    if (!Number.isInteger(start) || !Number.isInteger(end) || start! < 1 || end! > fourDx.channelCount! || start! > end!) {
      fields["monitoring.4dx.range"] = `Choose channels 1 through ${fourDx.channelCount}`;
    } else if (end! - start! + 1 < 51) {
      fields["monitoring.4dx.range"] = "A saved 4DX deployment range must contain at least 51 contiguous channels";
    }
  }

  let enabledSignals = 0;
  if (!settings.monitoring.gnss || !Array.isArray(settings.monitoring.gnss.enabledSystemIds) || !Array.isArray(settings.monitoring.gnss.enabledSignalIds)) {
    fields["monitoring.gnss"] = "GNSS selection is missing";
  } else {
    settings.monitoring.gnss.enabledSystemIds = [...new Set(settings.monitoring.gnss.enabledSystemIds)];
    settings.monitoring.gnss.enabledSignalIds = [...new Set(settings.monitoring.gnss.enabledSignalIds)];
    const catalogSystems = new Set(catalog.bands.map((band) => band.constellation).filter(Boolean));
    const catalogSignalIds = new Set(catalog.bands.filter((band) => band.service === "gnss").map((band) => band.id));
    if (settings.monitoring.gnss.enabledSystemIds.some((system) => !catalogSystems.has(system))) fields["monitoring.gnss.enabledSystemIds"] = "GNSS selection contains an unknown system";
    if (settings.monitoring.gnss.enabledSignalIds.some((bandId) => !catalogSignalIds.has(bandId))) fields["monitoring.gnss.enabledSignalIds"] = "GNSS selection contains an unknown signal";
    settings.monitoring.gnss.constellations ??= {} as OperationalSettings["monitoring"]["gnss"]["constellations"];
    for (const constellation of GNSS_CONSTELLATIONS) {
      const catalogSignals = catalog.bands.filter((band) => band.service === "gnss" && band.constellation === constellation);
      const group = settings.monitoring.gnss.constellations[constellation] ?? { enabled: false, signals: {} };
      group.enabled = settings.monitoring.gnss.enabledSystemIds.includes(constellation);
      for (const band of catalogSignals) {
        const target = catalog.captureTargets.find((candidate) => candidate.id === band.captureTargetId);
        const signal = group.signals?.[band.id] ?? { enabled: false, spanHz: target?.analysisSpanHz ?? 8_000_000 };
        signal.enabled = settings.monitoring.gnss.enabledSignalIds.includes(band.id);
        if (!Number.isInteger(signal.spanHz) || signal.spanHz < 1_000_000 || signal.spanHz > 80_000_000) {
          fields[`monitoring.gnss.${band.id}.spanHz`] = "GNSS monitoring span must be between 1 and 80 MHz";
        }
        group.signals[band.id] = signal;
        if (settings.monitoring.gnss.enabled && group.enabled && signal.enabled) enabledSignals += 1;
      }
      settings.monitoring.gnss.constellations[constellation] = group;
    }
  }
  if (settings.monitoring.gnss?.enabled && !enabledSignals) fields["monitoring.gnss"] = "Enable at least one GNSS signal";

  if (![settings.monitoring.startrack?.enabled, settings.monitoring["4dx"]?.enabled, settings.monitoring.gnss?.enabled].some(Boolean)) {
    fields.monitoring = "Enable at least one service; use Pause when monitoring should stop";
  }
  if (!["balanced", "gnss-priority", "fast-gnss"].includes(settings.scan.profile)) fields["scan.profile"] = "Choose Primary Watch, Multi-band Survey, or Radio Survey";
  if (!catalog.priorityWindows.some((window) => window.id === settings.scan.priorityWindowId)
    && !catalog.captureTargets.some((target) => target.service === "gnss" && target.id === settings.scan.priorityWindowId)) {
    fields["scan.priorityWindowId"] = "Select a catalog-defined GNSS band";
  }
  if (!Number.isInteger(settings.scan.maxPriorityGapMs) || settings.scan.maxPriorityGapMs < 2_000 || settings.scan.maxPriorityGapMs > 300_000) fields["scan.maxPriorityGapMs"] = "Priority-window gap must be between 2 and 300 seconds";
  for (const service of SERVICE_GROUPS) {
    if (!Number.isInteger(settings.scan.dwellMs[service]) || settings.scan.dwellMs[service] < 250 || settings.scan.dwellMs[service] > 300_000) {
      fields[`scan.dwellMs.${service}`] = "Dwell time must be between 250 ms and 5 minutes";
    }
    if (!Number.isInteger(settings.scan.priority[service]) || settings.scan.priority[service] < 0 || settings.scan.priority[service] > 10) {
      fields[`scan.priority.${service}`] = "Priority must be between 0 and 10";
    }
  }
  if (settings.detection.ruleSetId !== "rf-relative-mad-v1") fields["detection.ruleSetId"] = "Unsupported detector rule set";
  for (const key of ["scaleFloorBins", "widebandObservationSigma", "interferenceSigma", "narrowbandPeakSigma", "driftSigma"] as const) {
    if (!finite(settings.detection[key]) || settings.detection[key] <= 0) fields[`detection.${key}`] = "Value must be greater than zero";
  }
  for (const key of ["widebandObservationOccupancy", "interferenceOccupancy", "narrowbandMaxWidthRatio"] as const) {
    if (!finite(settings.detection[key]) || settings.detection[key] < 0 || settings.detection[key] > 1) fields[`detection.${key}`] = "Value must be between zero and one";
  }
  for (const key of ["interferenceHits", "interferenceWindow", "interferenceExposureMs", "driftExposureMs", "clearObservations", "reservoirSize", "minimumLearningMs"] as const) {
    if (!Number.isInteger(settings.detection[key]) || settings.detection[key] < 1) fields[`detection.${key}`] = "Value must be a positive whole number";
  }
  if (settings.detection.interferenceHits > settings.detection.interferenceWindow) fields["detection.interferenceHits"] = "Required hits cannot exceed the voting window";
  if (settings.detection.reservoirSize > 256) fields["detection.reservoirSize"] = "Baseline reservoir cannot exceed 256 observations";
  const retention = settings.retention;
  for (const key of ["sessionMaxBytes", "sessionMaxMs", "retentionMs", "storageMaxBytes", "maintenanceIntervalMs"] as const) {
    if (!Number.isInteger(retention[key]) || retention[key] <= 0) fields[`retention.${key}`] = "Value must be a positive integer";
  }
  if (!Number.isInteger(retention.minimumFreeBytes) || retention.minimumFreeBytes < 0) fields["retention.minimumFreeBytes"] = "Free-space reserve cannot be negative";
  if (retention.sessionMaxBytes > 2 * 1024 * 1024 * 1024) fields["retention.sessionMaxBytes"] = "Session size cannot exceed the 2 GiB evidence bound";
  if (retention.sessionMaxMs > 24 * 60 * 60 * 1000) fields["retention.sessionMaxMs"] = "Session duration cannot exceed the 24-hour evidence bound";
  if (retention.storageMaxBytes < retention.sessionMaxBytes) fields["retention.storageMaxBytes"] = "Storage limit must be at least as large as one session";
  if (!Number.isInteger(settings.liveFocusTimeoutMs) || settings.liveFocusTimeoutMs < 60_000 || settings.liveFocusTimeoutMs > 3_600_000) fields.liveFocusTimeoutMs = "Single-frequency check must be between 1 and 60 minutes";
  if (Object.keys(fields).length) throw new SettingsValidationError(fields);
  return settings as OperationalSettings;
}

export function compileEffectiveBands(catalog: BandCatalog, settings: OperationalSettings): BandPreset[] {
  const bands: BandPreset[] = [];
  const startrack = serviceBand(catalog, "startrack");
  if (settings.monitoring.startrack.enabled) {
    bands.push({
      ...startrack,
      dwellMs: settings.scan.dwellMs.startrack,
      priority: settings.scan.priority.startrack,
      selectedFrequenciesHz: settings.monitoring.startrack.channels.mode === "frequencies"
        ? [...settings.monitoring.startrack.channels.frequenciesHz]
        : undefined,
    });
  }
  const fourDx = serviceBand(catalog as BandCatalog, "4dx");
  if (settings.monitoring["4dx"].enabled) {
    const selection = settings.monitoring["4dx"].channels;
    if (selection.mode === "range") {
      const startChannel = selection.startChannel!;
      const endChannel = selection.endChannel!;
      const startHz = fourDx.startHz + (startChannel - 1) * fourDx.channelSpacingHz!;
      const endHz = fourDx.startHz + (endChannel - 1) * fourDx.channelSpacingHz!;
      bands.push({ ...fourDx, startHz, endHz, centerHz: Math.round((startHz + endHz) / 2), channelCount: endChannel - startChannel + 1, dwellMs: settings.scan.dwellMs["4dx"], priority: settings.scan.priority["4dx"] });
    } else {
      bands.push({ ...fourDx, dwellMs: settings.scan.dwellMs["4dx"], priority: settings.scan.priority["4dx"] });
    }
  }
  if (settings.monitoring.gnss.enabled) {
    for (const band of catalog.bands.filter((candidate) => candidate.service === "gnss" && candidate.constellation)) {
      if (!settings.monitoring.gnss.enabledSystemIds.includes(band.constellation!) || !settings.monitoring.gnss.enabledSignalIds.includes(band.id)) continue;
      const target = catalog.captureTargets.find((candidate) => candidate.id === band.captureTargetId);
      const signal = settings.monitoring.gnss.constellations[band.constellation!]?.signals[band.id];
      const halfSpan = (target?.captureSpanHz ?? signal?.spanHz ?? 8_000_000) / 2;
      bands.push({
        ...band,
        startHz: Math.round((target?.centerHz ?? band.centerHz) - halfSpan),
        endHz: Math.round((target?.centerHz ?? band.centerHz) + halfSpan),
        dwellMs: target?.nominalVisitMs ?? settings.scan.dwellMs.gnss,
        priority: settings.scan.priority.gnss,
        captureCenterHz: target?.centerHz,
        captureSpanHz: target?.captureSpanHz,
        analysisSpanHz: target?.analysisSpanHz,
        revisitObjectiveMs: target?.revisitObjectiveMs,
        captureTier: target?.tier,
        nominalVisitMs: target?.nominalVisitMs,
        maxVisitMs: target?.maxVisitMs,
        tuneAckTimeoutMs: target?.tuneAckTimeoutMs,
        settleMs: target?.settleMs,
        discardFrames: target?.discardFrames,
        minFreshFrames: target?.minFreshFrames,
        nominalDisplayHz: target?.nominalDisplayHz ?? band.nominalDisplayHz,
      });
    }
  }
  if (!bands.length) throw new SettingsValidationError({ monitoring: "Enable at least one monitoring target" });
  return bands;
}

function mhz(value: number, digits = 3): string {
  return `${(value / 1_000_000).toFixed(digits).replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")} MHz`;
}

export function createServiceSummaries(catalog: BandCatalog, settings: OperationalSettings, effectiveBands: BandPreset[], sampleRateHz: number): ServiceCoverageSummary[] {
  return catalog.services.map((definition) => {
    const bands = effectiveBands.filter((band) => band.service === definition.id);
    let coverageLabel = "Off";
    if (definition.id === "startrack" && settings.monitoring.startrack.enabled) {
      const selection = settings.monitoring.startrack.channels;
      coverageLabel = selection.mode === "all" ? `${mhz(serviceBand(catalog, "startrack").startHz, 0)} - ${mhz(serviceBand(catalog, "startrack").endHz, 0)}` : `${selection.frequenciesHz.length} selected ${selection.frequenciesHz.length === 1 ? "frequency" : "frequencies"}`;
    }
    if (definition.id === "4dx" && settings.monitoring["4dx"].enabled) {
      const selection = settings.monitoring["4dx"].channels;
      coverageLabel = selection.mode === "all" ? `All ${serviceBand(catalog, "4dx").channelCount} channels` : `Channels ${selection.startChannel}-${selection.endChannel}`;
    }
    if (definition.id === "gnss" && settings.monitoring.gnss.enabled) {
      const enabled = GNSS_CONSTELLATIONS.filter((constellation) => bands.some((band) => band.constellation === constellation));
      coverageLabel = enabled.join(", ");
    }
    return {
      service: definition.id,
      label: definition.label,
      description: definition.description,
      enabled: bands.length > 0,
      coverageLabel,
      targetCount: bands.length,
      estimatedRevisitMs: bands.length ? estimateRevisitMs(bands, sampleRateHz) : 0,
    };
  });
}

export function channelFrequency(band: BandPreset, channel: number): number {
  if (!band.channelSpacingHz || !band.channelCount || !Number.isInteger(channel) || channel < 1 || channel > band.channelCount) {
    throw new Error(`Channel must be between 1 and ${band.channelCount ?? 0}`);
  }
  return band.startHz + (channel - 1) * band.channelSpacingHz;
}

export function validFocusFrequencies(band: BandPreset): number[] {
  return band.channelSpacingHz && band.channelCount ? generateChannelCenters(band) : [band.centerHz];
}

export function changedFieldPaths(previous: unknown, next: unknown, prefix = ""): string[] {
  if (Object.is(previous, next)) return [];
  if (!previous || !next || typeof previous !== "object" || typeof next !== "object" || Array.isArray(previous) || Array.isArray(next)) return [prefix || "settings"];
  const left = previous as Record<string, unknown>;
  const right = next as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].flatMap((key) => changedFieldPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key));
}
