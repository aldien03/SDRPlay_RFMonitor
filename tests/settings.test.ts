import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "../src/shared/detection";
import {
  applyMonitoringMission,
  channelFrequency,
  captureTargetTierForProfile,
  compileEffectiveBands,
  createDefaultOperationalSettings,
  evaluateSettingsFeasibility,
  createServiceSummaries,
  continuousWatchTargetId,
  monitoringMissionForSettings,
  ROBUST_DETECTION_DEFAULTS,
  selectedMonitoringTargetIds,
  validateBandCatalog,
  SettingsValidationError,
  validateOperationalSettings,
} from "../src/shared/settings";
import type { OperationalSettings } from "../src/shared/types";
import { FOUR_DX_BAND, TEST_CATALOG } from "./catalogFixture";

function defaults(): OperationalSettings {
  return createDefaultOperationalSettings(TEST_CATALOG, {
    siteName: "Test site",
    displayTimeZone: "UTC",
    detection: DEFAULT_THRESHOLDS,
    retention: {
      sessionMaxBytes: 1_000_000,
      sessionMaxMs: 3_600_000,
      retentionMs: 86_400_000,
      storageMaxBytes: 10_000_000,
      minimumFreeBytes: 0,
      maintenanceIntervalMs: 60_000,
    },
  });
}

describe("operational monitoring settings", () => {
  it("defaults new installations to the combined L1/E1/B1C/SBAS Continuous Watch target", () => {
    const settings = defaults();
    expect(settings.monitoring.startrack.enabled).toBe(false);
    expect(settings.monitoring["4dx"].enabled).toBe(false);
    expect(settings.scan.profile).toBe("gnss-priority");
    expect(new Set(compileEffectiveBands(TEST_CATALOG, settings).map((band) => band.captureTargetId))).toEqual(new Set([
      "gnss-l1-e1-b1c-sbas",
    ]));
    expect(monitoringMissionForSettings(settings, TEST_CATALOG)).toBe("continuous-watch");
  });

  it("applies Continuous Watch as one selected physical GNSS target", () => {
    const settings = applyMonitoringMission(defaults(), TEST_CATALOG, "continuous-watch");
    expect(settings.schemaVersion).toBe(4);
    expect(settings.scan.profile).toBe("gnss-priority");
    expect(settings.monitoring.startrack.enabled).toBe(false);
    expect(settings.monitoring["4dx"].enabled).toBe(false);
    expect(continuousWatchTargetId(settings, TEST_CATALOG)).toBe("gnss-l1-e1-b1c-sbas");
    expect(new Set(compileEffectiveBands(TEST_CATALOG, settings).map((band) => band.captureTargetId))).toEqual(new Set(["gnss-l1-e1-b1c-sbas"]));
    expect(monitoringMissionForSettings(validateOperationalSettings(settings, TEST_CATALOG), TEST_CATALOG)).toBe("continuous-watch");

    const l5 = applyMonitoringMission(settings, TEST_CATALOG, "continuous-watch", "gnss-l5-e5a-b2a");
    expect(continuousWatchTargetId(l5, TEST_CATALOG)).toBe("gnss-l5-e5a-b2a");
    expect(l5.scan.priorityWindowId).toBe("gnss-l5-e5a-b2a");
    expect(l5.scan.maxPriorityGapMs).toBe(6_000);
    expect(validateOperationalSettings(l5, TEST_CATALOG).monitoring.gnss.enabledSignalIds.sort()).toEqual(["beidou-b2a", "galileo-e5a", "gps-l5"]);
  });

  it("defaults Multi-band Survey to the Tier-1 GNSS target set", () => {
    const configured = defaults();
    configured.monitoring.startrack.enabled = true;
    configured.monitoring["4dx"].enabled = true;
    configured.monitoring.gnss.enabledSignalIds.push("beidou-b1i");
    const settings = applyMonitoringMission(configured, TEST_CATALOG, "multi-band-survey");
    const targetIds = new Set(compileEffectiveBands(TEST_CATALOG, settings).map((band) => band.captureTargetId));
    expect(settings.scan.profile).toBe("fast-gnss");
    expect(settings.monitoring.startrack.enabled).toBe(false);
    expect(settings.monitoring["4dx"].enabled).toBe(false);
    expect(targetIds).toEqual(new Set(TEST_CATALOG.captureTargets.filter((target) => target.service === "gnss" && target.tier === "tier1").map((target) => target.id)));
    expect(monitoringMissionForSettings(settings, TEST_CATALOG)).toBe("multi-band-survey");
  });

  it("lets Multi-band Survey combine selected GNSS and Fugro frequency windows", () => {
    const selectedIds = ["gnss-l1-e1-b1c-sbas", "gnss-l5-e5a-b2a", "fugro-corrections-lband"];
    const configured = defaults();
    configured.monitoring.fugro.selectedBeamIds = ["fugro-ersat", "fugro-easat"];
    const settings = applyMonitoringMission(configured, TEST_CATALOG, "multi-band-survey", selectedIds);
    expect(selectedMonitoringTargetIds(settings, TEST_CATALOG)).toEqual(selectedIds);
    expect(settings.monitoring.fugro.enabled).toBe(true);
    expect(settings.monitoring.fugro.selectedBeamIds).toEqual(["fugro-ersat", "fugro-easat"]);
    expect(new Set(compileEffectiveBands(TEST_CATALOG, settings).map((band) => band.captureTargetId))).toEqual(new Set(selectedIds));
    expect(monitoringMissionForSettings(settings, TEST_CATALOG)).toBe("multi-band-survey");
  });

  it("keeps Radio Survey exclusive from GNSS and admits its stitched sweeps", () => {
    const settings = applyMonitoringMission(defaults(), TEST_CATALOG, "radio-survey");
    expect(settings.scan.profile).toBe("balanced");
    expect(settings.monitoring.gnss.enabled).toBe(false);
    expect(settings.monitoring.startrack.enabled).toBe(true);
    expect(settings.monitoring["4dx"].enabled).toBe(true);
    expect(compileEffectiveBands(TEST_CATALOG, settings).every((band) => band.service !== "gnss")).toBe(true);
    expect(evaluateSettingsFeasibility({ settings, catalog: TEST_CATALOG, sampleRateHz: 10_000_000 }).optionalWorkAdmitted).toBe(true);
    expect(monitoringMissionForSettings(settings, TEST_CATALOG)).toBe("radio-survey");
  });

  it("applies Continuous Watch to Fugro as one physical target with multiple beam guides", () => {
    const beamIds = ["fugro-ersat", "fugro-easat"];
    const configured = defaults();
    configured.monitoring.fugro.selectedBeamIds = beamIds;
    const settings = applyMonitoringMission(configured, TEST_CATALOG, "continuous-watch", "fugro-corrections-lband");
    const effective = compileEffectiveBands(TEST_CATALOG, settings);

    expect(settings.scan).toMatchObject({ profile: "correction-watch", priorityWindowId: "fugro-corrections-lband" });
    expect(settings.monitoring).toMatchObject({
      gnss: { enabled: false },
      startrack: { enabled: false },
      "4dx": { enabled: false },
      fugro: { enabled: true, selectedBeamIds: beamIds },
    });
    expect(effective.map((band) => band.id)).toEqual(beamIds);
    expect(new Set(effective.map((band) => band.captureTargetId))).toEqual(new Set(["fugro-corrections-lband"]));
    expect(new Set(effective.map((band) => band.captureCenterHz))).toEqual(new Set([1_545_742_500]));
    expect(new Set(effective.map((band) => band.captureSpanHz))).toEqual(new Set([10_000_000]));
    expect(new Set(effective.map((band) => band.analysisSpanHz))).toEqual(new Set([8_000_000]));
    expect(monitoringMissionForSettings(validateOperationalSettings(settings, TEST_CATALOG), TEST_CATALOG)).toBe("continuous-watch");
  });

  it("requires one known beam whenever the Fugro window is enabled", () => {
    const settings = applyMonitoringMission(defaults(), TEST_CATALOG, "continuous-watch", "fugro-corrections-lband");
    settings.monitoring.fugro.selectedBeamIds = [];
    expect(() => validateOperationalSettings(settings, TEST_CATALOG)).toThrow(/Select at least one Fugro beam/);
    settings.monitoring.fugro.selectedBeamIds = ["fugro-unknown"];
    expect(() => validateOperationalSettings(settings, TEST_CATALOG)).toThrow(/unknown beam/);
  });

  it("does not mislabel a legacy simultaneous selection as Radio Survey", () => {
    const settings = defaults();
    settings.scan.profile = "balanced";
    settings.monitoring.startrack.enabled = true;
    expect(monitoringMissionForSettings(settings, TEST_CATALOG)).toBe("custom");
  });

  it("accepts only StarTrack frequencies aligned to the catalog grid", () => {
    const settings = defaults();
    settings.monitoring.startrack.enabled = true;
    settings.monitoring.startrack.channels = { mode: "frequencies", frequenciesHz: [410_000_000, 410_025_000] };
    expect(validateOperationalSettings(settings, TEST_CATALOG).monitoring.startrack.channels.frequenciesHz).toEqual([410_000_000, 410_025_000]);
    settings.monitoring.startrack.channels.frequenciesHz = [410_012_500];
    expect(() => validateOperationalSettings(settings, TEST_CATALOG)).toThrow(SettingsValidationError);
  });

  it("requires at least 51 contiguous 4DX channels and maps their endpoints exactly", () => {
    const settings = defaults();
    settings.monitoring["4dx"].enabled = true;
    settings.monitoring["4dx"].channels = { mode: "range", frequenciesHz: [], startChannel: 20, endChannel: 70 };
    const effective = compileEffectiveBands(TEST_CATALOG, validateOperationalSettings(settings, TEST_CATALOG));
    const fourDx = effective.find((band) => band.service === "4dx")!;
    expect(fourDx.channelCount).toBe(51);
    expect(fourDx.startHz).toBe(channelFrequency(FOUR_DX_BAND, 20));
    expect(fourDx.endHz).toBe(channelFrequency(FOUR_DX_BAND, 70));
    settings.monitoring["4dx"].channels.endChannel = 69;
    expect(() => validateOperationalSettings(settings, TEST_CATALOG)).toThrow(/at least 51 contiguous channels/);
  });

  it("preserves constellation children while a parent is disabled", () => {
    const settings = defaults();
    settings.monitoring.gnss.enabledSystemIds = settings.monitoring.gnss.enabledSystemIds.filter((system) => system !== "GLONASS");
    settings.monitoring.gnss.enabledSignalIds = settings.monitoring.gnss.enabledSignalIds.filter((bandId) => bandId !== "gps-l2");
    settings.monitoring.gnss.enabled = false;
    settings.monitoring.startrack.enabled = true;
    const validated = validateOperationalSettings(settings, TEST_CATALOG);
    expect(validated.monitoring.gnss.constellations.GLONASS.enabled).toBe(false);
    expect(validated.monitoring.gnss.constellations.GPS.signals["gps-l2"].enabled).toBe(false);
    expect(compileEffectiveBands(TEST_CATALOG, validated).every((band) => band.service !== "gnss")).toBe(true);
  });

  it("rejects an empty monitoring profile and points operators to Pause", () => {
    const settings = defaults();
    settings.monitoring.startrack.enabled = false;
    settings.monitoring["4dx"].enabled = false;
    settings.monitoring.gnss.enabled = false;
    expect(() => validateOperationalSettings(settings, TEST_CATALOG)).toThrow(/use Pause/);
  });

  it("uses catalog labels and selected coverage in service summaries", () => {
    const settings = defaults();
    settings.monitoring.startrack.enabled = true;
    settings.monitoring.startrack.channels = { mode: "frequencies", frequenciesHz: [410_000_000, 410_025_000] };
    settings.monitoring["4dx"].enabled = false;
    const bands = compileEffectiveBands(TEST_CATALOG, settings);
    const summaries = createServiceSummaries(TEST_CATALOG, settings, bands, 10_000_000);
    expect(summaries.find((summary) => summary.service === "startrack")).toMatchObject({ label: TEST_CATALOG.services[0].label, coverageLabel: "2 selected frequencies" });
    expect(summaries.find((summary) => summary.service === "4dx")).toMatchObject({ enabled: false, coverageLabel: "Off" });
    settings.monitoring.gnss.enabledSystemIds = settings.monitoring.gnss.enabledSystemIds.filter((system) => system !== "Galileo");
    const gnssBands = compileEffectiveBands(TEST_CATALOG, settings);
    const gnssSummary = createServiceSummaries(TEST_CATALOG, settings, gnssBands, 10_000_000).find((summary) => summary.service === "gnss");
    expect(gnssSummary?.coverageLabel).not.toContain("Galileo");
  });
  it("migrates schema 1 catalogs and profiles without silently enabling the new scan policy", () => {
    const legacyCatalog = structuredClone(TEST_CATALOG) as any;
    legacyCatalog.schemaVersion = 1;
    delete legacyCatalog.priorityWindows;
    delete legacyCatalog.captureTargets;
    for (const band of legacyCatalog.bands) {
      for (const field of ["captureTargetId", "captureCenterHz", "captureSpanHz", "analysisSpanHz", "revisitObjectiveMs", "captureTier", "nominalVisitMs", "maxVisitMs", "settleMs", "discardFrames", "minFreshFrames"] as const) delete band[field];
    }
    const catalog = validateBandCatalog(legacyCatalog);
    expect(catalog.schemaVersion).toBe(4);
    expect(catalog.catalogVersion).toBe(legacyCatalog.catalogVersion);
    expect(catalog.priorityWindows[0].id).toBe("gnss-l1-core");

    const legacySettings = defaults() as any;
    legacySettings.schemaVersion = 1;
    delete legacySettings.monitoring.gnss.enabledSystemIds;
    delete legacySettings.monitoring.gnss.enabledSignalIds;
    delete legacySettings.monitoring.gnss.constellations.SBAS;
    delete legacySettings.scan.profile;
    delete legacySettings.scan.priorityWindowId;
    delete legacySettings.scan.maxPriorityGapMs;
    const settings = validateOperationalSettings(legacySettings, catalog);
    expect(settings).toMatchObject({
      schemaVersion: 4,
      scan: { profile: "balanced", maxPriorityGapMs: 10_000 },
      monitoring: { fugro: { enabled: false, selectedBeamIds: [] } },
    });
    expect(settings.monitoring.gnss.enabledSignalIds).not.toContain("sbas-l1");
  });

  it("migrates v3 settings to v4 without changing the active mission or stored choices", () => {
    const current = applyMonitoringMission(defaults(), TEST_CATALOG, "multi-band-survey");
    current.revision = 17;
    current.retention.retentionMs = 7 * 86_400_000;
    const legacy = structuredClone(current) as any;
    legacy.schemaVersion = 3;
    delete legacy.monitoring.fugro;
    delete legacy.scan.dwellMs.fugro;
    delete legacy.scan.priority.fugro;

    const migrated = validateOperationalSettings(legacy, TEST_CATALOG);
    expect(migrated).toMatchObject({
      schemaVersion: 4,
      revision: 17,
      scan: { profile: "fast-gnss", dwellMs: { fugro: 1_000 }, priority: { fugro: 10 } },
      monitoring: { fugro: { enabled: false, selectedBeamIds: [] } },
      retention: { retentionMs: 7 * 86_400_000 },
    });
    expect(monitoringMissionForSettings(migrated, TEST_CATALOG)).toBe("multi-band-survey");
  });

  it("catalogs the published Fugro carriers with one shared capture target", () => {
    const beams = TEST_CATALOG.bands.filter((band) => band.service === "fugro");
    expect(beams.map((beam) => [beam.label, beam.centerHz, beam.correctionBeam?.linkId, beam.correctionBeam?.symbolRateHz, beam.correctionBeam?.bitRateBps])).toEqual([
      ["ARSAT", 1_545_245_000, 13, 4_876, 2_400],
      ["SASAT", 1_545_815_000, 4, 2_438, 1_200],
      ["OCSAT", 1_545_875_000, 18, 2_438, 1_200],
      ["ERSAT", 1_545_950_000, 20, 4_876, 2_400],
      ["EASAT", 1_546_230_000, 6, 2_438, 1_200],
      ["IRSAT", 1_546_240_000, 7, 2_438, 1_200],
    ]);
    expect(new Set(beams.map((beam) => beam.captureTargetId))).toEqual(new Set(["fugro-corrections-lband"]));
  });

  it("derives capture tiers from the selected profile and catalog priority window", () => {
    const settings = defaults();
    const l1 = TEST_CATALOG.captureTargets.find((target) => target.id === "gnss-l1-e1-b1c-sbas")!;
    const l2 = TEST_CATALOG.captureTargets.find((target) => target.id === "gnss-gps-l2c")!;
    settings.scan.profile = "gnss-priority";
    expect(captureTargetTierForProfile(l1, settings, TEST_CATALOG)).toBe("tier1");
    expect(captureTargetTierForProfile(l2, settings, TEST_CATALOG)).toBe("survey");
    settings.scan.profile = "balanced";
    expect(captureTargetTierForProfile(l1, settings, TEST_CATALOG)).toBe("survey");
    settings.scan.profile = "fast-gnss";
    expect(captureTargetTierForProfile(l2, settings, TEST_CATALOG)).toBe(l2.tier);
  });

  it("returns structured feasibility facts and recalculates an unsaved draft", () => {
    const settings = applyMonitoringMission(defaults(), TEST_CATALOG, "multi-band-survey");
    const full = evaluateSettingsFeasibility({ settings, catalog: TEST_CATALOG, sampleRateHz: 10_000_000 });
    expect(full).toMatchObject({
      scheduleCapacity: "full",
      optionalScans: "paused",
      revisitObjective: "not-verified",
      tier1Utilization: 1,
      captureSpanHz: 10_000_000,
      analysisSpanHz: 8_000_000,
    });
    expect(full.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      "tier1-capacity-full",
      "tier1-objective-unverified",
      "analysis-guard-bins",
    ]));
    expect(full).not.toHaveProperty("warnings");

    const draft = structuredClone(settings);
    const keepSignals = new Set(TEST_CATALOG.captureTargets.find((target) => target.id === "gnss-l1-e1-b1c-sbas")!.relatedBandIds);
    draft.monitoring.gnss.enabledSignalIds = draft.monitoring.gnss.enabledSignalIds.filter((bandId) => keepSignals.has(bandId));
    const available = evaluateSettingsFeasibility({ settings: draft, catalog: TEST_CATALOG, sampleRateHz: 10_000_000 });
    expect(available).toMatchObject({ scheduleCapacity: "available", tier1Utilization: 0.5 });
  });

  it("uses measured scheduler status without turning objectives into guarantees", () => {
    const settings = applyMonitoringMission(defaults(), TEST_CATALOG, "multi-band-survey");
    const schedulerHealth = {
      profile: "fast-gnss" as const,
      configurationEpoch: 1,
      tuneEpoch: 1,
      completedVisits: 100,
      unknownVisits: 0,
      missedObjectives: 0,
      tier1MeetingObjective: true,
      optionalQualificationReady: true,
      optionalQualificationElapsedMs: 86_400_000,
      optionalWorkAdmitted: false,
      protectedReserveRatio: 0.1,
    };
    expect(evaluateSettingsFeasibility({ settings, catalog: TEST_CATALOG, sampleRateHz: 10_000_000, schedulerHealth }).revisitObjective).toBe("meeting");
    expect(evaluateSettingsFeasibility({
      settings,
      catalog: TEST_CATALOG,
      sampleRateHz: 10_000_000,
      schedulerHealth,
      measurementAvailable: false,
    }).revisitObjective).toBe("not-verified");
  });

  it("ships detection defaults that pass validation", () => {
    const settings = { ...defaults(), detection: { ...ROBUST_DETECTION_DEFAULTS } };
    const validated = validateOperationalSettings(settings, TEST_CATALOG);
    expect(validated.detection).toEqual(ROBUST_DETECTION_DEFAULTS);
  });

  it("keeps the shipped rule set id", () => {
    expect(ROBUST_DETECTION_DEFAULTS.ruleSetId).toBe("rf-relative-mad-v1");
  });
});
