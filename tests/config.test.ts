import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config";
import { DEFAULT_THRESHOLDS } from "../src/shared/detection";
import { createDefaultOperationalSettings } from "../src/shared/settings";
import { TEST_CATALOG } from "./catalogFixture";

const temporaryRoots: string[] = [];

const explicitRuntimeSettings = {
  RF_MONITOR_HOST: "127.0.0.1",
  RF_MONITOR_PORT: "8080",
  RF_MONITOR_SIMULATION: "off",
  RF_MONITOR_IQ_CAPTURE_MS: "0",
  RF_MONITOR_IQ_MAX_BYTES: "1048576",
  SDRCONNECT_TIMEOUT_MS: "3000",
  SDRCONNECT_SAMPLE_RATE_HZ: "10000000",
  SDRCONNECT_DEVICE_INDEX: "0",
  SDRCONNECT_TLS_REJECT_UNAUTHORIZED: "true",
  SDRCONNECT_URL: "ws://127.0.0.1:5454/",
};

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function explicitEnvironment(profileOverride?: object): Promise<NodeJS.ProcessEnv> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-config-"));
  temporaryRoots.push(root);
  const catalogPath = path.join(root, "catalog.json");
  const operationalPath = path.join(root, "operational.json");
  const adminPath = path.join(root, "admin.json");
  const settings = createDefaultOperationalSettings(TEST_CATALOG, {
    siteName: "Configured Site",
    deploymentId: "configured-01",
    displayTimeZone: "UTC",
    detection: DEFAULT_THRESHOLDS,
    retention: {
      sessionMaxBytes: 1_048_576,
      sessionMaxMs: 86_400_000,
      retentionMs: 30 * 86_400_000,
      storageMaxBytes: 10_485_760,
      minimumFreeBytes: 0,
      maintenanceIntervalMs: 60_000,
    },
  });
  await writeFile(catalogPath, JSON.stringify(TEST_CATALOG));
  await writeFile(operationalPath, JSON.stringify(profileOverride ?? settings));
  await writeFile(adminPath, JSON.stringify({ schemaVersion: 1 }));
  return {
    ...explicitRuntimeSettings,
    RF_MONITOR_REQUIRE_EXPLICIT_CONFIG: "true",
    RF_MONITOR_STORAGE: path.join(root, "evidence"),
    RF_MONITOR_CATALOG_FILE: catalogPath,
    RF_MONITOR_OPERATIONAL_FILE: operationalPath,
    RF_MONITOR_ADMIN_FILE: adminPath,
  };
}

describe("service configuration", () => {
  it("uses legacy environment values only to seed a first operational profile", async () => {
    const config = await loadConfig({
      RF_MONITOR_SITE_NAME: "Test Monitoring Site",
      RF_MONITOR_DEPLOYMENT_ID: "test-site-02",
      RF_MONITOR_DISPLAY_TIME_ZONE: "Europe/Oslo",
      RF_DETECT_WIDEBAND_OBSERVATION_SIGMA: "7",
      RF_DETECT_INTERFERENCE_HITS: "5",
    });

    expect(config.siteName).toBe("Test Monitoring Site");
    expect(config.deploymentId).toBe("test-site-02");
    expect(config.displayTimeZone).toBe("Europe/Oslo");
    expect(config.operationalSettings.detection.widebandObservationSigma).toBe(7);
    expect(config.operationalSettings.detection.interferenceHits).toBe(5);
    expect(config.configurationSources.operational).toBe("generated initial profile");
    expect(config).toMatchObject({
      dataDomain: "field",
      maxSpectrumRateHz: 4,
      maxSpectrumBins: 2_048,
      syntheticExercises: false,
      evidenceFrameIntervalMs: 2_000,
      maxPendingEvidenceFrames: 8,
    });
    expect(config.dataRoots.field.root).not.toBe(config.dataRoots.test.root);
    expect(config.storageRoot).toBe(config.dataRoots.field.evidenceRoot);
  });

  it("routes auto and explicit simulation exclusively to the test data root", async () => {
    const automatic = await loadConfig({ RF_MONITOR_SIMULATION: "auto" });
    const simulated = await loadConfig({ RF_MONITOR_SIMULATION: "on" });
    expect(automatic).toMatchObject({ dataDomain: "test", storageRoot: automatic.dataRoots.test.evidenceRoot });
    expect(simulated).toMatchObject({ dataDomain: "test", storageRoot: simulated.dataRoots.test.evidenceRoot });
  });

  it("rejects equal or nested field and test roots", async () => {
    const root = path.join(os.tmpdir(), "rf-monitor-overlap");
    await expect(loadConfig({
      RF_MONITOR_STORAGE: root,
      RF_MONITOR_FIELD_DATA_ROOT: path.join(root, "shared"),
      RF_MONITOR_TEST_DATA_ROOT: path.join(root, "shared"),
    })).rejects.toThrow(/separate, non-nested/);
    await expect(loadConfig({
      RF_MONITOR_STORAGE: root,
      RF_MONITOR_FIELD_DATA_ROOT: path.join(root, "field"),
      RF_MONITOR_TEST_DATA_ROOT: path.join(root, "field", "test"),
    })).rejects.toThrow(/separate, non-nested/);
  });

  it("rejects a direct LAN bind in tokenless v1.0", async () => {
    await expect(loadConfig({ RF_MONITOR_HOST: "0.0.0.0" })).rejects.toThrow(/must be a loopback address/);
  });

  it("rejects removed LAN token settings", async () => {
    await expect(loadConfig({ RF_MONITOR_REQUIRE_AUTH: "true" })).rejects.toThrow(/removed in RF Monitor 1.0/);
    await expect(loadConfig({ RF_MONITOR_API_TOKEN: "legacy-secret" })).rejects.toThrow(/removed in RF Monitor 1.0/);
  });

  it("rejects malformed infrastructure values", async () => {
    await expect(loadConfig({ RF_MONITOR_DISPLAY_TIME_ZONE: "Mars/Olympus" })).rejects.toThrow(/valid IANA time zone/);
    await expect(loadConfig({ RF_MONITOR_SIMULATION: "enabled" })).rejects.toThrow(/must be auto, on, or off/);
    await expect(loadConfig({ RF_MONITOR_SYNTHETIC_EXERCISES: "sometimes" })).rejects.toThrow(/must be true or false/);
    await expect(loadConfig({ RF_MONITOR_PORT: "70000" })).rejects.toThrow(/between 1 and 65535/);
    await expect(loadConfig({ RF_MONITOR_SPECTRUM_RATE_HZ: "1" })).rejects.toThrow(/must remain at the bounded 4 Hz/);
    await expect(loadConfig({ SDRCONNECT_TLS_REJECT_UNAUTHORIZED: "sometimes" })).rejects.toThrow(/must be true or false/);
  });

  it("validates and normalizes SDRconnect endpoint lists", async () => {
    const config = await loadConfig({ SDRCONNECT_URLS: "ws://127.0.0.1:5454" });
    expect(config.receiverUrls).toEqual(["ws://127.0.0.1:5454/"]);
    await expect(loadConfig({ SDRCONNECT_URL: "wss://receiver.example.test:5443/api" })).rejects.toThrow(/loopback/);
    await expect(loadConfig({ SDRCONNECT_URLS: "ws://127.0.0.1:5454/,ws://localhost:5455/" })).rejects.toThrow(/exactly one/);
    await expect(loadConfig({ SDRCONNECT_URL: "http://127.0.0.1:5454/" })).rejects.toThrow(/must be ws:\/\/ or wss:\/\//);
    await expect(loadConfig({ SDRCONNECT_URLS: "ws://127.0.0.1:5454/,ws://127.0.0.1:5454/" })).rejects.toThrow(/duplicated/);
  });

  it("fails closed when strict production configuration is incomplete", async () => {
    await expect(loadConfig({ RF_MONITOR_REQUIRE_EXPLICIT_CONFIG: "true" })).rejects.toThrow(/Explicit production configuration is missing/);
  });

  it("requires absolute catalog, profile, credential, and storage paths", async () => {
    await expect(loadConfig({
      ...explicitRuntimeSettings,
      RF_MONITOR_REQUIRE_EXPLICIT_CONFIG: "true",
      RF_MONITOR_STORAGE: "relative/evidence",
      RF_MONITOR_CATALOG_FILE: "relative/catalog.json",
      RF_MONITOR_OPERATIONAL_FILE: "relative/operational.json",
      RF_MONITOR_ADMIN_FILE: "relative/admin.json",
    })).rejects.toThrow(/must be an absolute path/);
  });

  it("loads the installed catalog and operational profile as the production authority", async () => {
    const environment = await explicitEnvironment();
    const operational = JSON.parse(await readFile(environment.RF_MONITOR_OPERATIONAL_FILE!, "utf8"));
    operational.monitoring.startrack.enabled = false;
    operational.monitoring.gnss.enabled = false;
    operational.monitoring["4dx"].enabled = true;
    operational.monitoring["4dx"].channels = { mode: "range", frequenciesHz: [], startChannel: 10, endChannel: 60 };
    await writeFile(environment.RF_MONITOR_OPERATIONAL_FILE!, JSON.stringify(operational));

    const config = await loadConfig(environment);
    expect(config.bands).toHaveLength(1);
    expect(config.bands[0]).toMatchObject({ id: "4dx-902400-927600", channelCount: 51 });
    expect(config.configurationSources).toMatchObject({ explicit: true, catalog: path.resolve(environment.RF_MONITOR_CATALOG_FILE!) });
  });

  it("rejects an incomplete operational policy rather than inheriting hidden defaults", async () => {
    const environment = await explicitEnvironment({ schemaVersion: 1, revision: 1, siteName: "Incomplete" });
    await expect(loadConfig(environment)).rejects.toThrow(/no valid revision could be recovered/);
  });

  it("recovers the newest valid revision when the active profile is corrupted", async () => {
    const environment = await explicitEnvironment();
    const operationalPath = environment.RF_MONITOR_OPERATIONAL_FILE!;
    const valid = JSON.parse(await readFile(operationalPath, "utf8"));
    const revisions = path.join(path.dirname(operationalPath), "revisions");
    await mkdir(revisions, { recursive: true });
    await writeFile(path.join(revisions, "operational-r000001-20260820T120000Z.json"), JSON.stringify(valid));
    await writeFile(operationalPath, "{broken");

    const config = await loadConfig(environment);
    expect(config.siteName).toBe("Configured Site");
    expect(config.configurationSources.operational).toMatch(/^recovered:/);
  });

  it("migrates enabled legacy band selections into the initial profile", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rf-monitor-legacy-"));
    temporaryRoots.push(root);
    const bandsPath = path.join(root, "bands.json");
    await writeFile(bandsPath, JSON.stringify({ bands: TEST_CATALOG.bands.map((band) => ({ id: band.id, enabled: band.constellation === "GPS" })) }));
    const config = await loadConfig({ RF_MONITOR_BANDS_FILE: bandsPath });
    expect(config.operationalSettings.monitoring.startrack.enabled).toBe(false);
    expect(config.operationalSettings.monitoring["4dx"].enabled).toBe(false);
    expect(config.operationalSettings.monitoring.gnss.constellations.GPS.enabled).toBe(true);
    expect(config.operationalSettings.monitoring.gnss.constellations.Galileo.enabled).toBe(false);
  });
});
