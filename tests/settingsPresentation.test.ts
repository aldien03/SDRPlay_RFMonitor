import { describe, expect, it } from "vitest";
import {
  buildSignalLearningPresentation,
  signalLearningProgressLabel,
  signalLearningState,
  signalLearningStateLabel,
} from "../src/client/settingsPresentation";
import { DEFAULT_THRESHOLDS } from "../src/shared/detection";
import { applyMonitoringMission, compileEffectiveBands, createDefaultOperationalSettings } from "../src/shared/settings";
import type { BaselineDescriptor, OperationalSettings } from "../src/shared/types";
import { TEST_CATALOG } from "./catalogFixture";

function settings(): OperationalSettings {
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

function baseline(targetId: string, lifecycle: BaselineDescriptor["lifecycle"], representativeHours: number, overrides: Partial<BaselineDescriptor> = {}): BaselineDescriptor {
  return {
    dataDomain: "field",
    targetId,
    lifecycle,
    fingerprintId: `${targetId}-fingerprint`,
    learningGenerationId: "1",
    observationCount: 100,
    validCoverageRatio: 1,
    representativeHours,
    learningStartedAt: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

describe("settings signal learning presentation", () => {
  it("uses short normal-user labels for every lifecycle", () => {
    expect(signalLearningStateLabel(signalLearningState("learning"))).toBe("Learning");
    expect(signalLearningStateLabel(signalLearningState("provisional"))).toBe("Learning");
    expect(signalLearningStateLabel(signalLearningState("reviewable"))).toBe("Learning complete");
    expect(signalLearningStateLabel(signalLearningState("protected"))).toBe("Approved");
    expect(signalLearningStateLabel(signalLearningState("stale"))).toBe("Needs new learning");
  });

  it("caps normal learning copy at completion", () => {
    expect(signalLearningProgressLabel(23)).toBe("23 of 24 hours");
    expect(signalLearningProgressLabel(24)).toBe("24 hours complete");
    expect(signalLearningProgressLabel(28)).toBe("24 hours complete");
  });

  it("shows active services for the selected mission and uses the least-complete target for progress", () => {
    const configured = applyMonitoringMission(settings(), TEST_CATALOG, "multi-band-survey");
    const baselines = [
      baseline("gnss-l1-e1-b1c-sbas", "provisional", 10),
      baseline("gnss-gps-l2c", "reviewable", 24),
      baseline("gnss-l5-e5a-b2a", "protected", 24),
      baseline("gnss-glonass-g1", "learning", 2),
      baseline("rf-410000000-420000000", "protected", 24),
    ];
    const presentation = buildSignalLearningPresentation({
      catalog: TEST_CATALOG,
      effectiveBands: compileEffectiveBands(TEST_CATALOG, configured),
      sampleRateHz: 10_000_000,
      baselines,
    });

    expect(presentation.activeServices).toHaveLength(1);
    expect(presentation.activeServices[0]).toMatchObject({ id: "gnss", state: "learning", representativeHours: 2 });
    expect(presentation.activeServices[0].targets).toHaveLength(4);
    expect(presentation.saved).toHaveLength(1);
    expect(presentation.saved[0].label).toBe("StarTrack radio 410 - 420 MHz");
    expect(presentation.saved[0].label).not.toContain("rf-");
  });

  it("adds enabled radio services without exposing their generated target ids", () => {
    const configured = settings();
    configured.monitoring.startrack.enabled = true;
    configured.monitoring["4dx"].enabled = true;
    const presentation = buildSignalLearningPresentation({
      catalog: TEST_CATALOG,
      effectiveBands: compileEffectiveBands(TEST_CATALOG, configured),
      sampleRateHz: 10_000_000,
      baselines: [],
    });

    expect(presentation.activeServices.map((service) => service.id)).toEqual(["startrack", "4dx", "gnss"]);
    expect(presentation.activeServices.every((service) => service.representativeHours === 0)).toBe(true);
    expect(presentation.activeTargets.every((target) => !target.label.includes("rf-"))).toBe(true);
    expect(presentation.activeTargets.some((target) => target.label.includes("410 - 420 MHz"))).toBe(true);
  });

  it("uses the newest target baseline and keeps the previous fingerprint in saved learning", () => {
    const configured = settings();
    const targetId = "gnss-l1-e1-b1c-sbas";
    const previous = baseline(targetId, "protected", 24, {
      fingerprintId: "previous",
      protectedAt: "2026-08-22T11:00:00.000Z",
    });
    const current = baseline(targetId, "provisional", 3, {
      fingerprintId: "current",
      learningGenerationId: "2",
      learningStartedAt: "2026-08-23T10:00:00.000Z",
    });
    const presentation = buildSignalLearningPresentation({
      catalog: TEST_CATALOG,
      effectiveBands: compileEffectiveBands(TEST_CATALOG, configured),
      sampleRateHz: 10_000_000,
      baselines: [previous, current],
    });

    expect(presentation.activeTargets.find((target) => target.targetId === targetId)?.baseline?.fingerprintId).toBe("current");
    expect(presentation.saved.map((item) => item.baseline.fingerprintId)).toContain("previous");
  });

  it("lists the Fugro capture window as one active frequency", () => {
    const configured = applyMonitoringMission(settings(), TEST_CATALOG, "continuous-watch", "fugro-corrections-lband");
    const presentation = buildSignalLearningPresentation({
      catalog: TEST_CATALOG,
      effectiveBands: compileEffectiveBands(TEST_CATALOG, configured),
      sampleRateHz: 10_000_000,
      baselines: [],
    });

    expect(presentation.activeTargets).toHaveLength(1);
    expect(presentation.activeTargets[0]).toMatchObject({ targetId: "fugro-corrections-lband", service: "fugro" });
  });

  it("keeps one stable window name when the Fugro beam selection changes", () => {
    const configuredOne = applyMonitoringMission(settings(), TEST_CATALOG, "continuous-watch", "fugro-corrections-lband");
    const configuredTwo = structuredClone(configuredOne);
    configuredTwo.monitoring.fugro.selectedBeamIds = ["fugro-ersat", "fugro-easat"];
    const presentationOne = buildSignalLearningPresentation({
      catalog: TEST_CATALOG,
      effectiveBands: compileEffectiveBands(TEST_CATALOG, configuredOne),
      sampleRateHz: 10_000_000,
      baselines: [],
    });
    const presentationTwo = buildSignalLearningPresentation({
      catalog: TEST_CATALOG,
      effectiveBands: compileEffectiveBands(TEST_CATALOG, configuredTwo),
      sampleRateHz: 10_000_000,
      baselines: [],
    });
    const catalogLabel = TEST_CATALOG.captureTargets.find((target) => target.id === "fugro-corrections-lband")!.label;
    const targetOne = presentationOne.activeTargets.find((target) => target.targetId === "fugro-corrections-lband");
    const targetTwo = presentationTwo.activeTargets.find((target) => target.targetId === "fugro-corrections-lband");

    expect(targetOne?.label).toBe(catalogLabel);
    expect(targetTwo?.label).toBe(catalogLabel);
    expect(targetOne?.signalsLabel).not.toBe(targetTwo?.signalsLabel);
  });

  it("names an active frequency the same way the restart dialog does", () => {
    const configured = applyMonitoringMission(settings(), TEST_CATALOG, "multi-band-survey", ["fugro-corrections-lband", "gnss-l1-e1-b1c-sbas"]);
    const presentation = buildSignalLearningPresentation({
      catalog: TEST_CATALOG,
      effectiveBands: compileEffectiveBands(TEST_CATALOG, configured),
      sampleRateHz: 10_000_000,
      baselines: [],
    });
    const captureTargetsById = new Map(TEST_CATALOG.captureTargets.map((target) => [target.id, target]));
    const matched = presentation.activeTargets.filter((target) => captureTargetsById.has(target.targetId));

    expect(matched.length).toBeGreaterThan(0);
    for (const target of matched) expect(target.label).toBe(captureTargetsById.get(target.targetId)!.label);
  });

  it("marks a saved record whose frequency is no longer monitored", () => {
    const configured = applyMonitoringMission(settings(), TEST_CATALOG, "radio-survey");
    const effectiveBands = compileEffectiveBands(TEST_CATALOG, configured);
    const probe = buildSignalLearningPresentation({ catalog: TEST_CATALOG, effectiveBands, sampleRateHz: 10_000_000, baselines: [] });
    const monitoredTargetId = probe.activeTargets[0].targetId;
    const fugroBaseline = baseline("fugro-corrections-lband", "protected", 24);
    const previousMonitored = baseline(monitoredTargetId, "protected", 24, {
      fingerprintId: "previous",
      learningStartedAt: "2026-08-22T11:00:00.000Z",
    });
    const currentMonitored = baseline(monitoredTargetId, "provisional", 3, {
      fingerprintId: "current",
      learningGenerationId: "2",
      learningStartedAt: "2026-08-23T10:00:00.000Z",
    });
    const presentation = buildSignalLearningPresentation({
      catalog: TEST_CATALOG,
      effectiveBands,
      sampleRateHz: 10_000_000,
      baselines: [fugroBaseline, previousMonitored, currentMonitored],
    });
    const fugroCatalogLabel = TEST_CATALOG.captureTargets.find((target) => target.id === "fugro-corrections-lband")!.label;

    expect(presentation.saved.find((item) => item.baseline.targetId === "fugro-corrections-lband")).toMatchObject({
      targetActive: false,
      label: fugroCatalogLabel,
    });
    expect(presentation.saved.find((item) => item.baseline.fingerprintId === "previous")).toMatchObject({ targetActive: true });
  });
});
