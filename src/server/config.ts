import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_THRESHOLDS, type DetectionThresholds } from "../shared/detection";
import { compileEffectiveBands, createDefaultOperationalSettings, validateBandCatalog, validateOperationalSettings } from "../shared/settings";
import type { BandCatalog, BandPreset, DataDomain, EvidenceRetentionPolicy, OperationalSettings, RuntimeIdentity } from "../shared/types";
import { createDataDomainPaths, type DataDomainPaths } from "./dataDomains";
import { createRuntimeIdentity, loadReleaseIdentity, withIdentityConfiguration } from "./releaseIdentity";

export type SimulationMode = "auto" | "on" | "off";

export interface AppConfig {
  runtimeIdentity: RuntimeIdentity;
  siteName: string;
  deploymentId?: string;
  displayTimeZone: string;
  host: string;
  port: number;
  receiverUrls: string[];
  sdrConnectTimeoutMs: number;
  sampleRateHz: number;
  maxSpectrumRateHz: number;
  maxSpectrumBins: number;
  evidenceFrameIntervalMs: number;
  maxPendingEvidenceFrames: number;
  sdrDeviceIndex?: number;
  iqCaptureMs: number;
  iqMaxBytes: number;
  storageRoot: string;
  /** Active domain selected before any storage component is constructed. */
  dataDomain: DataDomain;
  dataRoots: DataDomainPaths;
  retentionPolicy: EvidenceRetentionPolicy;
  bands: BandPreset[];
  detectionThresholds: DetectionThresholds;
  bandCatalog: BandCatalog;
  operationalSettings: OperationalSettings;
  configurationHash: string;
  settingsPaths: {
    catalog: string;
    operational: string;
    admin: string;
    audit: string;
    revisions: string;
  };
  configurationSources: {
    explicit: boolean;
    bands: string;
    detection: string;
    catalog: string;
    operational: string;
  };
  simulation: SimulationMode;
  /** Requires explicit opt-in in addition to RF_MONITOR_SIMULATION=on. */
  syntheticExercises: boolean;
  allowedOrigins: string[];
  tlsRejectUnauthorized: boolean;
  adminSessionMs: number;
}

function positiveInteger(value: string | undefined, fallback: number, name = "Value"): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function nonNegativeInteger(value: string | undefined, fallback: number, name = "Value"): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

function finiteNumber(value: string | undefined, fallback: number, name = "Value"): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

function optionalNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error("SDRCONNECT_DEVICE_INDEX must be a non-negative integer");
  return parsed;
}

function textSetting(value: string | undefined, fallback: string, name: string, maxLength = 100): string {
  const text = value?.trim() || fallback;
  if (text.length > maxLength) throw new Error(`${name} must not exceed ${maxLength} characters`);
  return text;
}

function isLoopbackHost(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(host.toLowerCase());
}

function booleanSetting(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value !== "true" && value !== "false") throw new Error(`${name} must be true or false`);
  return value === "true";
}

function receiverUrlSettings(environment: NodeJS.ProcessEnv): string[] {
  const receiverUrls = (environment.SDRCONNECT_URLS ?? environment.SDRCONNECT_URL ?? "ws://127.0.0.1:5454/")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!receiverUrls.length) throw new Error("At least one SDRconnect WebSocket URL is required");
  const unique = new Set<string>();
  for (const value of receiverUrls) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid SDRconnect WebSocket URL: ${value}`);
    }
    if (!["ws:", "wss:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
      throw new Error(`SDRconnect URL must be ws:// or wss:// without embedded credentials: ${value}`);
    }
    if (!isLoopbackHost(url.hostname)) throw new Error("SDRconnect must remain on a loopback address; port 5454 must not be exposed to the LAN");
    if (unique.has(url.href)) throw new Error(`SDRconnect URL is duplicated: ${value}`);
    unique.add(url.href);
  }
  if (unique.size !== 1) throw new Error("RF Monitor 1.0 supports exactly one local RSPdx/SDRconnect endpoint");
  return [...unique];
}

function portSetting(value: string | undefined, fallback: number, name: string): number {
  const port = positiveInteger(value, fallback, name);
  if (port > 65_535) throw new Error(`${name} must be between 1 and 65535`);
  return port;
}

function timeZoneSetting(value: string | undefined): string {
  const timeZone = value?.trim() || "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone }).format(new Date());
  } catch {
    throw new Error(`RF_MONITOR_DISPLAY_TIME_ZONE is not a valid IANA time zone: ${timeZone}`);
  }
  return timeZone;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, canonicalValue(entry)]));
}

export function operationalConfigurationHash(settings: OperationalSettings, catalogVersion: string): string {
  return createHash("sha256").update(JSON.stringify(canonicalValue({ catalogVersion, settings }))).digest("hex");
}

async function readJson<T>(filePath: string, description: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    throw new Error(`${description} could not be read from ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function optionalJson<T>(filePath: string | undefined): Promise<T | undefined> {
  if (!filePath) return undefined;
  try {
    return JSON.parse(await readFile(path.resolve(filePath), "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function legacyEnabledBandIds(value: unknown): Set<string> | undefined {
  if (!value) return undefined;
  const list = Array.isArray(value) ? value : typeof value === "object" && value && Array.isArray((value as { bands?: unknown[] }).bands)
    ? (value as { bands: unknown[] }).bands
    : undefined;
  if (!list) throw new Error("Legacy band configuration must contain a bands array");
  return new Set(list.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Legacy band configuration contains an invalid entry");
    const band = entry as { id?: unknown; enabled?: unknown };
    if (typeof band.id !== "string" || !band.id.trim()) throw new Error("Legacy band configuration contains a band without an id");
    return band.enabled !== false ? band.id : "";
  }).filter(Boolean));
}

async function operationalProfile(
  filePath: string,
  revisionsPath: string,
  catalog: BandCatalog,
  required: boolean,
): Promise<{ settings?: OperationalSettings; source?: string }> {
  let primaryError: unknown;
  try {
    const settings = await optionalJson<OperationalSettings>(filePath);
    if (settings) return { settings: validateOperationalSettings(settings, catalog), source: filePath };
    primaryError = new Error(`Operational profile is missing: ${filePath}`);
  } catch (error) {
    primaryError = error;
  }
  try {
    const candidates = (await readdir(revisionsPath))
      .filter((name) => /^operational-r\d{6}.*\.json$/.test(name))
      .sort()
      .reverse();
    for (const name of candidates) {
      try {
        const revisionPath = path.join(revisionsPath, name);
        const settings = validateOperationalSettings(await readJson<OperationalSettings>(revisionPath, "Operational revision"), catalog);
        return { settings, source: `recovered:${revisionPath}` };
      } catch {
        // Continue until the newest valid revision is found.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (required || (primaryError as NodeJS.ErrnoException)?.code !== "ENOENT") {
    throw new Error(`Operational profile is unavailable and no valid revision could be recovered: ${primaryError instanceof Error ? primaryError.message : String(primaryError)}`);
  }
  return {};
}

function applyLegacyBandSelection(settings: OperationalSettings, enabledIds: Set<string> | undefined, catalog: BandCatalog): void {
  if (!enabledIds) return;
  settings.monitoring.startrack.enabled = catalog.bands.some((band) => band.service === "startrack" && enabledIds.has(band.id));
  settings.monitoring["4dx"].enabled = catalog.bands.some((band) => band.service === "4dx" && enabledIds.has(band.id));
  let gnssEnabled = false;
  for (const constellation of Object.values(settings.monitoring.gnss.constellations)) {
    let constellationEnabled = false;
    for (const [bandId, signal] of Object.entries(constellation.signals)) {
      signal.enabled = enabledIds.has(bandId);
      constellationEnabled ||= signal.enabled;
      gnssEnabled ||= signal.enabled;
    }
    constellation.enabled = constellationEnabled;
  }
  settings.monitoring.gnss.enabledSignalIds = catalog.bands
    .filter((band) => band.service === "gnss" && enabledIds.has(band.id))
    .map((band) => band.id);
  settings.monitoring.gnss.enabledSystemIds = [...new Set(catalog.bands
    .filter((band) => settings.monitoring.gnss.enabledSignalIds.includes(band.id) && band.constellation)
    .map((band) => band.constellation!))];
  settings.monitoring.gnss.enabled = gnssEnabled;
  if (![settings.monitoring.startrack.enabled, settings.monitoring["4dx"].enabled, settings.monitoring.gnss.enabled].some(Boolean)) {
    settings.monitoring.startrack.enabled = true;
  }
}

export function withOperationalSettings(config: AppConfig, settings: OperationalSettings): AppConfig {
  const validated = validateOperationalSettings(settings, config.bandCatalog);
  const configurationHash = operationalConfigurationHash(validated, config.bandCatalog.catalogVersion);
  return {
    ...config,
    runtimeIdentity: withIdentityConfiguration(config.runtimeIdentity, {
      catalogVersion: config.bandCatalog.catalogVersion,
      configurationHash,
      configurationRevision: validated.revision,
      detectorRuleSetId: validated.detection.ruleSetId,
      expectedSampleRateHz: config.sampleRateHz,
    }),
    siteName: validated.siteName,
    deploymentId: validated.deploymentId,
    displayTimeZone: validated.displayTimeZone,
    retentionPolicy: { ...validated.retention },
    detectionThresholds: { ...validated.detection },
    bands: compileEffectiveBands(config.bandCatalog, validated),
    operationalSettings: validated,
    configurationHash,
  };
}

export async function loadConfig(environment: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  for (const legacyName of ["RF_MONITOR_REQUIRE_AUTH", "RF_MONITOR_API_TOKEN"] as const) {
    if (environment[legacyName]?.trim()) throw new Error(`${legacyName} was removed in RF Monitor 1.0; remove it and use the HTTPS operator-network allowlist`);
  }
  const explicit = booleanSetting(environment.RF_MONITOR_REQUIRE_EXPLICIT_CONFIG, false, "RF_MONITOR_REQUIRE_EXPLICIT_CONFIG");
  const catalogPath = path.resolve(environment.RF_MONITOR_CATALOG_FILE ?? "./config/band-catalog.example.json");
  const operationalPath = path.resolve(environment.RF_MONITOR_OPERATIONAL_FILE ?? "./tmp/runtime-config/operational.json");
  const adminPath = path.resolve(environment.RF_MONITOR_ADMIN_FILE ?? "./tmp/runtime-config/admin.json");
  if (explicit) {
    const required = [
      "RF_MONITOR_CATALOG_FILE", "RF_MONITOR_OPERATIONAL_FILE", "RF_MONITOR_ADMIN_FILE", "RF_MONITOR_HOST", "RF_MONITOR_PORT",
      "RF_MONITOR_STORAGE", "RF_MONITOR_SIMULATION", "RF_MONITOR_IQ_CAPTURE_MS", "RF_MONITOR_IQ_MAX_BYTES", "SDRCONNECT_TIMEOUT_MS",
      "SDRCONNECT_SAMPLE_RATE_HZ", "SDRCONNECT_DEVICE_INDEX", "SDRCONNECT_TLS_REJECT_UNAUTHORIZED",
    ].filter((name) => !environment[name]?.trim());
    if (!(environment.SDRCONNECT_URLS ?? environment.SDRCONNECT_URL)?.trim()) required.push("SDRCONNECT_URL or SDRCONNECT_URLS");
    if (required.length) throw new Error(`Explicit production configuration is missing: ${required.join(", ")}`);
    for (const name of ["RF_MONITOR_STORAGE", "RF_MONITOR_CATALOG_FILE", "RF_MONITOR_OPERATIONAL_FILE", "RF_MONITOR_ADMIN_FILE"] as const) {
      if (!path.isAbsolute(environment[name]!)) throw new Error(`${name} must be an absolute path in explicit production configuration`);
    }
    for (const name of ["RF_MONITOR_FIELD_DATA_ROOT", "RF_MONITOR_TEST_DATA_ROOT"] as const) {
      if (environment[name]?.trim() && !path.isAbsolute(environment[name]!)) {
        throw new Error(`${name} must be an absolute path in explicit production configuration`);
      }
    }
  }

  const requestedSimulation = environment.RF_MONITOR_SIMULATION ?? "off";
  if (!["auto", "on", "off"].includes(requestedSimulation)) throw new Error("RF_MONITOR_SIMULATION must be auto, on, or off");
  const host = textSetting(environment.RF_MONITOR_HOST, "127.0.0.1", "RF_MONITOR_HOST", 253);
  if (!isLoopbackHost(host)) throw new Error("RF_MONITOR_HOST must be a loopback address in RF Monitor 1.0; expose the dashboard only through the configured HTTPS reverse proxy");

  const legacyDetection = await optionalJson<Partial<DetectionThresholds>>(environment.RF_MONITOR_DETECTION_FILE);
  const detection: DetectionThresholds = {
    ruleSetId: "rf-relative-mad-v1",
    scaleFloorBins: finiteNumber(environment.RF_DETECT_SCALE_FLOOR_BINS, legacyDetection?.scaleFloorBins ?? DEFAULT_THRESHOLDS.scaleFloorBins, "RF_DETECT_SCALE_FLOOR_BINS"),
    widebandObservationSigma: finiteNumber(environment.RF_DETECT_WIDEBAND_OBSERVATION_SIGMA, legacyDetection?.widebandObservationSigma ?? DEFAULT_THRESHOLDS.widebandObservationSigma, "RF_DETECT_WIDEBAND_OBSERVATION_SIGMA"),
    widebandObservationOccupancy: finiteNumber(environment.RF_DETECT_WIDEBAND_OBSERVATION_OCCUPANCY, legacyDetection?.widebandObservationOccupancy ?? DEFAULT_THRESHOLDS.widebandObservationOccupancy, "RF_DETECT_WIDEBAND_OBSERVATION_OCCUPANCY"),
    interferenceSigma: finiteNumber(environment.RF_DETECT_INTERFERENCE_SIGMA, legacyDetection?.interferenceSigma ?? DEFAULT_THRESHOLDS.interferenceSigma, "RF_DETECT_INTERFERENCE_SIGMA"),
    interferenceOccupancy: finiteNumber(environment.RF_DETECT_INTERFERENCE_OCCUPANCY, legacyDetection?.interferenceOccupancy ?? DEFAULT_THRESHOLDS.interferenceOccupancy, "RF_DETECT_INTERFERENCE_OCCUPANCY"),
    interferenceHits: positiveInteger(environment.RF_DETECT_INTERFERENCE_HITS, legacyDetection?.interferenceHits ?? DEFAULT_THRESHOLDS.interferenceHits, "RF_DETECT_INTERFERENCE_HITS"),
    interferenceWindow: positiveInteger(environment.RF_DETECT_INTERFERENCE_WINDOW, legacyDetection?.interferenceWindow ?? DEFAULT_THRESHOLDS.interferenceWindow, "RF_DETECT_INTERFERENCE_WINDOW"),
    interferenceExposureMs: positiveInteger(environment.RF_DETECT_INTERFERENCE_EXPOSURE_MS, legacyDetection?.interferenceExposureMs ?? DEFAULT_THRESHOLDS.interferenceExposureMs, "RF_DETECT_INTERFERENCE_EXPOSURE_MS"),
    narrowbandPeakSigma: finiteNumber(environment.RF_DETECT_NARROWBAND_PEAK_SIGMA, legacyDetection?.narrowbandPeakSigma ?? DEFAULT_THRESHOLDS.narrowbandPeakSigma, "RF_DETECT_NARROWBAND_PEAK_SIGMA"),
    narrowbandMaxWidthRatio: finiteNumber(environment.RF_DETECT_NARROWBAND_MAX_WIDTH_RATIO, legacyDetection?.narrowbandMaxWidthRatio ?? DEFAULT_THRESHOLDS.narrowbandMaxWidthRatio, "RF_DETECT_NARROWBAND_MAX_WIDTH_RATIO"),
    driftSigma: finiteNumber(environment.RF_DETECT_DRIFT_SIGMA, legacyDetection?.driftSigma ?? DEFAULT_THRESHOLDS.driftSigma, "RF_DETECT_DRIFT_SIGMA"),
    driftExposureMs: positiveInteger(environment.RF_DETECT_DRIFT_EXPOSURE_MS, legacyDetection?.driftExposureMs ?? DEFAULT_THRESHOLDS.driftExposureMs, "RF_DETECT_DRIFT_EXPOSURE_MS"),
    clearObservations: positiveInteger(environment.RF_DETECT_CLEAR_OBSERVATIONS, legacyDetection?.clearObservations ?? DEFAULT_THRESHOLDS.clearObservations, "RF_DETECT_CLEAR_OBSERVATIONS"),
    reservoirSize: positiveInteger(environment.RF_DETECT_RESERVOIR_SIZE, legacyDetection?.reservoirSize ?? DEFAULT_THRESHOLDS.reservoirSize, "RF_DETECT_RESERVOIR_SIZE"),
    minimumLearningMs: positiveInteger(environment.RF_DETECT_MINIMUM_LEARNING_MS, legacyDetection?.minimumLearningMs ?? DEFAULT_THRESHOLDS.minimumLearningMs, "RF_DETECT_MINIMUM_LEARNING_MS"),
  };
  const retention: EvidenceRetentionPolicy = {
    sessionMaxBytes: positiveInteger(environment.RF_MONITOR_SESSION_MAX_BYTES, 2 * 1024 * 1024 * 1024, "RF_MONITOR_SESSION_MAX_BYTES"),
    sessionMaxMs: positiveInteger(environment.RF_MONITOR_SESSION_MAX_HOURS, 24, "RF_MONITOR_SESSION_MAX_HOURS") * 60 * 60 * 1000,
    retentionMs: positiveInteger(environment.RF_MONITOR_RETENTION_DAYS, 30, "RF_MONITOR_RETENTION_DAYS") * 24 * 60 * 60 * 1000,
    storageMaxBytes: positiveInteger(environment.RF_MONITOR_STORAGE_MAX_BYTES, 50 * 1024 * 1024 * 1024, "RF_MONITOR_STORAGE_MAX_BYTES"),
    minimumFreeBytes: nonNegativeInteger(environment.RF_MONITOR_MIN_FREE_BYTES, 5 * 1024 * 1024 * 1024, "RF_MONITOR_MIN_FREE_BYTES"),
    maintenanceIntervalMs: positiveInteger(environment.RF_MONITOR_MAINTENANCE_INTERVAL_MS, 60_000, "RF_MONITOR_MAINTENANCE_INTERVAL_MS"),
  };
  if (retention.storageMaxBytes < retention.sessionMaxBytes) throw new Error("RF_MONITOR_STORAGE_MAX_BYTES must be greater than or equal to RF_MONITOR_SESSION_MAX_BYTES");

  const catalog = validateBandCatalog(await readJson<BandCatalog>(catalogPath, "Frequency catalog"));
  const revisionsPath = path.join(path.dirname(operationalPath), "revisions");
  const loadedOperational = environment.RF_MONITOR_OPERATIONAL_FILE || explicit
    ? await operationalProfile(operationalPath, revisionsPath, catalog, explicit)
    : {};
  const storedOperational = loadedOperational.settings;
  if (explicit) await readJson<unknown>(adminPath, "Settings administrator file");
  let operational = storedOperational ?? createDefaultOperationalSettings(catalog, {
    siteName: textSetting(environment.RF_MONITOR_SITE_NAME, "RF Monitoring Site", "RF_MONITOR_SITE_NAME", 80),
    deploymentId: environment.RF_MONITOR_DEPLOYMENT_ID ? textSetting(environment.RF_MONITOR_DEPLOYMENT_ID, "", "RF_MONITOR_DEPLOYMENT_ID", 80) : undefined,
    displayTimeZone: timeZoneSetting(environment.RF_MONITOR_DISPLAY_TIME_ZONE),
    detection,
    retention,
  });
  if (!storedOperational) {
    const legacyBands = await optionalJson<unknown>(environment.RF_MONITOR_BANDS_FILE);
    applyLegacyBandSelection(operational, legacyEnabledBandIds(legacyBands), catalog);
  }
  operational = validateOperationalSettings(operational, catalog);
  const dataDomain: DataDomain = requestedSimulation === "off" ? "field" : "test";
  const dataRoots = createDataDomainPaths({
    baseRoot: path.resolve(environment.RF_MONITOR_STORAGE ?? "./evidence"),
    fieldRoot: environment.RF_MONITOR_FIELD_DATA_ROOT,
    testRoot: environment.RF_MONITOR_TEST_DATA_ROOT,
    legacyBaselineFile: path.join(path.dirname(operationalPath), "baselines", "baselines-v1.json"),
  });
  const storageRoot = dataRoots[dataDomain].evidenceRoot;
  const configurationHash = operationalConfigurationHash(operational, catalog.catalogVersion);
  const releaseIdentity = await loadReleaseIdentity({ environment });
  const config: AppConfig = {
    runtimeIdentity: createRuntimeIdentity(releaseIdentity, {
      catalogVersion: catalog.catalogVersion,
      configurationHash,
      configurationRevision: operational.revision,
      detectorRuleSetId: operational.detection.ruleSetId,
      expectedSampleRateHz: positiveInteger(environment.SDRCONNECT_SAMPLE_RATE_HZ, 10_000_000, "SDRCONNECT_SAMPLE_RATE_HZ"),
    }),
    siteName: operational.siteName,
    deploymentId: operational.deploymentId,
    displayTimeZone: operational.displayTimeZone,
    host,
    port: portSetting(environment.RF_MONITOR_PORT, 8080, "RF_MONITOR_PORT"),
    receiverUrls: receiverUrlSettings(environment),
    sdrConnectTimeoutMs: positiveInteger(environment.SDRCONNECT_TIMEOUT_MS, 3_000, "SDRCONNECT_TIMEOUT_MS"),
    sampleRateHz: positiveInteger(environment.SDRCONNECT_SAMPLE_RATE_HZ, 10_000_000, "SDRCONNECT_SAMPLE_RATE_HZ"),
    maxSpectrumRateHz: positiveInteger(environment.RF_MONITOR_SPECTRUM_RATE_HZ, 4, "RF_MONITOR_SPECTRUM_RATE_HZ"),
    maxSpectrumBins: positiveInteger(environment.RF_MONITOR_MAX_SPECTRUM_BINS, 2_048, "RF_MONITOR_MAX_SPECTRUM_BINS"),
    evidenceFrameIntervalMs: positiveInteger(environment.RF_MONITOR_EVIDENCE_FRAME_INTERVAL_MS, 2_000, "RF_MONITOR_EVIDENCE_FRAME_INTERVAL_MS"),
    maxPendingEvidenceFrames: positiveInteger(environment.RF_MONITOR_MAX_PENDING_EVIDENCE_FRAMES, 8, "RF_MONITOR_MAX_PENDING_EVIDENCE_FRAMES"),
    sdrDeviceIndex: optionalNonNegativeInteger(environment.SDRCONNECT_DEVICE_INDEX) ?? 0,
    iqCaptureMs: nonNegativeInteger(environment.RF_MONITOR_IQ_CAPTURE_MS, 0, "RF_MONITOR_IQ_CAPTURE_MS"),
    iqMaxBytes: positiveInteger(environment.RF_MONITOR_IQ_MAX_BYTES, 64 * 1024 * 1024, "RF_MONITOR_IQ_MAX_BYTES"),
    storageRoot,
    dataDomain,
    dataRoots,
    retentionPolicy: { ...operational.retention },
    bands: compileEffectiveBands(catalog, operational),
    detectionThresholds: { ...operational.detection },
    bandCatalog: catalog,
    operationalSettings: operational,
    configurationHash,
    settingsPaths: {
      catalog: catalogPath,
      operational: operationalPath,
      admin: adminPath,
      audit: path.join(path.dirname(operationalPath), "config-audit.jsonl"),
      revisions: revisionsPath,
    },
    configurationSources: {
      explicit,
      bands: environment.RF_MONITOR_BANDS_FILE ? path.resolve(environment.RF_MONITOR_BANDS_FILE) : "catalog-derived",
      detection: environment.RF_MONITOR_DETECTION_FILE ? path.resolve(environment.RF_MONITOR_DETECTION_FILE) : "operational profile",
      catalog: catalogPath,
      operational: loadedOperational.source ?? "generated initial profile",
    },
    simulation: requestedSimulation as SimulationMode,
    syntheticExercises: booleanSetting(environment.RF_MONITOR_SYNTHETIC_EXERCISES, false, "RF_MONITOR_SYNTHETIC_EXERCISES"),
    allowedOrigins: (environment.RF_MONITOR_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    tlsRejectUnauthorized: booleanSetting(environment.SDRCONNECT_TLS_REJECT_UNAUTHORIZED, true, "SDRCONNECT_TLS_REJECT_UNAUTHORIZED"),
    adminSessionMs: positiveInteger(environment.RF_MONITOR_ADMIN_SESSION_MINUTES, 15, "RF_MONITOR_ADMIN_SESSION_MINUTES") * 60_000,
  };
  if (![9_000_000, 10_000_000].includes(config.sampleRateHz)) {
    throw new Error("SDRCONNECT_SAMPLE_RATE_HZ must be 10000000 for production or 9000000 for a separately commissioned experiment");
  }
  if (config.maxSpectrumRateHz !== 4) throw new Error("RF_MONITOR_SPECTRUM_RATE_HZ must remain at the bounded 4 Hz detector processing rate");
  if (config.maxSpectrumBins > 2_048) throw new Error("RF_MONITOR_MAX_SPECTRUM_BINS cannot exceed 2048");
  if (config.maxPendingEvidenceFrames > 8) throw new Error("RF_MONITOR_MAX_PENDING_EVIDENCE_FRAMES cannot exceed 8");
  if (config.evidenceFrameIntervalMs < 2_000) throw new Error("RF_MONITOR_EVIDENCE_FRAME_INTERVAL_MS cannot be below the 2-second clear-state interval");
  if (config.iqCaptureMs !== 0) throw new Error("IQ capture is disabled in spectrum-only RF Monitor v1; RF_MONITOR_IQ_CAPTURE_MS must be 0");
  return config;
}
