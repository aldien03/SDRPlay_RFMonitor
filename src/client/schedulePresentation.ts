import { captureTargetTierForProfile, effectiveRevisitObjectiveMs } from "../shared/settings";
import type { BandCatalog, OperationalSettings, PhysicalCaptureTarget, SettingsFeasibility } from "../shared/types";

export interface WindowSchedule {
  targetId: string;
  /** Effective tier for the selected task, not the catalog tier alone. */
  enforced: boolean;
  objectiveMs: number;
  /** Share of the receiver's continuous time this window needs, 0 to 1. */
  utilization: number;
}

export function windowSchedule(input: {
  target: PhysicalCaptureTarget;
  settings: OperationalSettings;
  catalog: BandCatalog;
}): WindowSchedule {
  const { target, settings, catalog } = input;
  const enforced = captureTargetTierForProfile(target, settings, catalog) === "tier1";
  // The task may relax this window's objective, and the row must state the
  // cadence the scheduler will actually use, not the catalog default.
  const objectiveMs = effectiveRevisitObjectiveMs(target, settings);
  const utilization = objectiveMs > 0 ? target.nominalVisitMs / objectiveMs : 0;
  return { targetId: target.id, enforced, objectiveMs, utilization };
}

export function windowScheduleCopy(schedule: WindowSchedule): string {
  if (!schedule.enforced) return "Best effort";
  if (schedule.objectiveMs < 60_000) return `Checked every ${Math.round(schedule.objectiveMs / 1_000)} s`;
  return `Checked every ${Math.round(schedule.objectiveMs / 60_000)} min`;
}

export interface CapacitySummary {
  state: "available" | "full" | "overloaded";
  headline: string;
  detail: string;
}

export function scheduleCapacityCopy(feasibility: SettingsFeasibility): CapacitySummary {
  const state = feasibility.scheduleCapacity;
  const percent = Math.round(feasibility.tier1Utilization * 100);
  if (state === "full") {
    return {
      state,
      headline: "Schedule is full",
      detail: "Using all of the receiver's time. Survey windows will not be checked while this selection runs.",
    };
  }
  if (state === "overloaded") {
    return {
      state,
      headline: "Schedule is over capacity",
      detail: `This selection needs ${percent}% of the receiver's time, so these windows cannot all be checked on time. Remove a window, or accept that some checks will be late.`,
    };
  }
  return {
    state,
    headline: "Schedule fits",
    detail: `Using ${percent}% of the receiver's time. The rest is reserve for survey windows.`,
  };
}
