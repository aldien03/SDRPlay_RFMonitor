import { describe, expect, it } from "vitest";
import {
  scheduleCapacityCopy,
  windowSchedule,
  windowScheduleCopy,
  type WindowSchedule,
} from "../src/client/schedulePresentation";
import { DEFAULT_THRESHOLDS } from "../src/shared/detection";
import { applyMonitoringMission, createDefaultOperationalSettings, evaluateSettingsFeasibility } from "../src/shared/settings";
import type { OperationalSettings } from "../src/shared/types";
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

function target(id: string) {
  const found = TEST_CATALOG.captureTargets.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`missing test target ${id}`);
  return found;
}

describe("schedulePresentation", () => {
  it("formats an enforced window's objective in whole seconds", () => {
    const twoSeconds: WindowSchedule = { targetId: "a", enforced: true, objectiveMs: 2_000, utilization: 0.5 };
    const thirtySeconds: WindowSchedule = { targetId: "b", enforced: true, objectiveMs: 30_000, utilization: 0.033 };
    expect(windowScheduleCopy(twoSeconds)).toBe("Checked every 2 s");
    expect(windowScheduleCopy(thirtySeconds)).toBe("Checked every 30 s");
  });

  it("formats an objective of 60 s or more in whole minutes", () => {
    const oneMinute: WindowSchedule = { targetId: "a", enforced: true, objectiveMs: 60_000, utilization: 0.017 };
    const twoMinutes: WindowSchedule = { targetId: "b", enforced: true, objectiveMs: 120_000, utilization: 0.008 };
    expect(windowScheduleCopy(oneMinute)).toBe("Checked every 1 min");
    expect(windowScheduleCopy(twoMinutes)).toBe("Checked every 2 min");
  });

  it("reports Best effort for a window that is not enforced under the selected task, even at catalog tier1", () => {
    const configured = applyMonitoringMission(settings(), TEST_CATALOG, "continuous-watch", "gnss-l1-e1-b1c-sbas");
    const l2c = target("gnss-gps-l2c");
    expect(l2c.tier).toBe("tier1");
    const schedule = windowSchedule({ target: l2c, settings: configured, catalog: TEST_CATALOG });
    expect(schedule.enforced).toBe(false);
    expect(windowScheduleCopy(schedule)).toBe("Best effort");
  });

  it("computes utilization as visit over objective, and 0 when the objective is not positive", () => {
    const configured = applyMonitoringMission(settings(), TEST_CATALOG, "continuous-watch", "gnss-l1-e1-b1c-sbas");
    const l1 = target("gnss-l1-e1-b1c-sbas");
    expect(windowSchedule({ target: l1, settings: configured, catalog: TEST_CATALOG }).utilization).toBe(0.5);

    const noObjective = { ...l1, revisitObjectiveMs: 0 };
    expect(windowSchedule({ target: noObjective, settings: configured, catalog: TEST_CATALOG }).utilization).toBe(0);
  });

  it("marks the shipped GNSS default as exactly full", () => {
    const configured = applyMonitoringMission(settings(), TEST_CATALOG, "gnss-survey");
    const feasibility = evaluateSettingsFeasibility({ settings: configured, catalog: TEST_CATALOG, sampleRateHz: 10_000_000 });
    const capacity = scheduleCapacityCopy(feasibility);

    expect(feasibility.scheduleCapacity).toBe("full");
    expect(capacity.headline).toBe("Schedule is full");

    const defaultIds = TEST_CATALOG.captureTargets
      .filter((candidate) => candidate.service === "gnss" && candidate.tier === "tier1")
      .map((candidate) => candidate.id);
    const summedUtilization = defaultIds.reduce((total, id) => {
      const schedule = windowSchedule({ target: target(id), settings: configured, catalog: TEST_CATALOG });
      return total + schedule.utilization;
    }, 0);
    expect(summedUtilization).toBeCloseTo(1, 3);
  });

  it("reports over capacity when the Fugro window is added at catalog objectives", () => {
    // The GNSS + Fugro preset relaxes objectives so this selection fits. Clearing
    // the relaxation reproduces the raw selection an operator can still build by
    // hand, and that one must still be reported as over capacity.
    const defaultIds = TEST_CATALOG.captureTargets
      .filter((candidate) => candidate.service === "gnss" && candidate.tier === "tier1")
      .map((candidate) => candidate.id);
    const configured = applyMonitoringMission(settings(), TEST_CATALOG, "gnss-fugro-survey", [...defaultIds, "fugro-corrections-lband"]);
    const withoutRelaxation = { ...configured, scan: { ...configured.scan, revisitObjectiveOverridesMs: {} } };
    const feasibility = evaluateSettingsFeasibility({ settings: withoutRelaxation, catalog: TEST_CATALOG, sampleRateHz: 10_000_000 });
    const capacity = scheduleCapacityCopy(feasibility);

    expect(feasibility.scheduleCapacity).toBe("overloaded");
    expect(capacity.headline).toBe("Schedule is over capacity");
    expect(capacity.detail).toContain("150%");
  });

  it("reports Schedule fits and a percentage below 100 for an under-committed selection", () => {
    const configured = applyMonitoringMission(settings(), TEST_CATALOG, "gnss-survey");
    const keepSignals = new Set(target("gnss-l1-e1-b1c-sbas").relatedBandIds);
    configured.monitoring.gnss.enabledSignalIds = configured.monitoring.gnss.enabledSignalIds.filter((bandId) => keepSignals.has(bandId));
    const feasibility = evaluateSettingsFeasibility({ settings: configured, catalog: TEST_CATALOG, sampleRateHz: 10_000_000 });
    const capacity = scheduleCapacityCopy(feasibility);

    expect(feasibility.scheduleCapacity).toBe("available");
    expect(capacity.headline).toBe("Schedule fits");
    expect(capacity.detail).toMatch(/Using \d{1,2}% of the receiver's time/);
  });

  it("reports Schedule fits for the gnss-fugro-survey preset's relaxed selection", () => {
    const configured = applyMonitoringMission(settings(), TEST_CATALOG, "gnss-fugro-survey");
    const feasibility = evaluateSettingsFeasibility({ settings: configured, catalog: TEST_CATALOG, sampleRateHz: 10_000_000 });
    const capacity = scheduleCapacityCopy(feasibility);

    expect(feasibility.scheduleCapacity).toBe("available");
    expect(capacity.headline).toBe("Schedule fits");
    expect(capacity.detail).toMatch(/Using \d{1,2}% of the receiver's time/);
  });

  it("reports the gnss-fugro-survey preset's relaxed cadence for each of its five windows", () => {
    const configured = applyMonitoringMission(settings(), TEST_CATALOG, "gnss-fugro-survey");
    const cadence = (id: string) => windowScheduleCopy(windowSchedule({ target: target(id), settings: configured, catalog: TEST_CATALOG }));

    expect(cadence("gnss-l1-e1-b1c-sbas")).toBe("Checked every 2 s");
    expect(cadence("fugro-corrections-lband")).toBe("Checked every 4 s");
    expect(cadence("gnss-gps-l2c")).toBe("Checked every 18 s");
    expect(cadence("gnss-l5-e5a-b2a")).toBe("Checked every 18 s");
    expect(cadence("gnss-glonass-g1")).toBe("Checked every 18 s");
  });
});
