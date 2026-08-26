import type {
  DiagnosticSummaryState,
  MonitorSnapshot,
  ProductionQualification,
} from "../shared/types";
import type {
  OperatorCurrentHealthSummary,
  OperatorRecordingState,
} from "../shared/operatorSummary";
import { qualificationRecordReady } from "./productionQualification";

function currentHealthSummary(state: DiagnosticSummaryState): OperatorCurrentHealthSummary {
  if (state === "normal") return { state, reasonCode: "health-normal", actionCode: "none" };
  if (state === "simulation") return { state, reasonCode: "health-simulation", actionCode: "none" };
  if (state === "critical") return { state, reasonCode: "health-critical", actionCode: "open-system-health" };
  return { state: "attention", reasonCode: "health-attention", actionCode: "open-system-health" };
}

function recordingSummary(state: OperatorRecordingState) {
  if (state === "recording") return { state, reasonCode: "recording-active" as const, actionCode: "none" as const };
  if (state === "stopped") return { state, reasonCode: "recording-stopped" as const, actionCode: "open-recording" as const };
  return { state: "error" as const, reasonCode: "recording-error" as const, actionCode: "open-recording" as const };
}

function qualificationSummary(qualification: ProductionQualification) {
  if (qualificationRecordReady(qualification)) {
    return {
      state: "qualified" as const,
      ready: true,
      reasonCode: "qualification-qualified" as const,
      actionCode: "none" as const,
      epochId: qualification.epochId,
    };
  }
  if (qualification.state === "simulation") {
    return {
      state: "simulation" as const,
      ready: false,
      reasonCode: "qualification-simulation" as const,
      actionCode: "none" as const,
      epochId: qualification.epochId,
    };
  }
  return {
    state: qualification.state === "failed" ? "failed" as const : "pending" as const,
    ready: false,
    reasonCode: qualification.state === "failed" ? "qualification-failed" as const : "qualification-pending" as const,
    actionCode: "review-qualification" as const,
    epochId: qualification.epochId,
  };
}

/**
 * Applies process-level facts that MonitorService cannot own. Monitoring,
 * incident attribution, affected targets, and observation time are preserved.
 */
export function applyAuthoritativeOperatorRuntime(
  snapshot: MonitorSnapshot,
  input: {
    productionQualification: ProductionQualification;
    currentHealthState: DiagnosticSummaryState;
    recordingState: OperatorRecordingState;
  },
): MonitorSnapshot {
  return {
    ...snapshot,
    operatorSummary: {
      ...snapshot.operatorSummary,
      generatedAt: snapshot.generatedAt,
      serverBuildId: snapshot.identity.release.serverBuildId,
      recording: recordingSummary(input.recordingState),
      currentHealth: currentHealthSummary(input.currentHealthState),
      productionQualification: qualificationSummary(input.productionQualification),
    },
  };
}
