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
});
