import { OPERATOR_REASON_COPY, presentOperatorSummary, type OperatorSummaryV1 } from "../shared/operatorSummary";
import type { DetectionEvent, MonitorSnapshot } from "../shared/types";

/**
 * Resolves the current incident only through the canonical server summary.
 * Historical events are opened explicitly from Evidence History.
 */
export function currentOperatorEvent(snapshot: MonitorSnapshot): DetectionEvent | undefined {
  const incidentId = snapshot.operatorSummary.incident?.id;
  if (!incidentId) return undefined;
  if (snapshot.activeEvent?.id === incidentId) return snapshot.activeEvent;
  return snapshot.events.find((event) => event.id === incidentId);
}

export function operatorAffectedTargetIds(summary: OperatorSummaryV1): string[] {
  return summary.affectedTargets.map((target) => target.id);
}

export type OperatorObservationSurface = "card" | "pinned" | "incident" | "footer";

export interface OperatorObservationView {
  at: string | null;
  ageMs: number | null;
  ageLabel: string;
}

function validTimestampMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function conciseAge(ageMs: number): string {
  const seconds = Math.floor(Math.max(0, ageMs) / 1_000);
  if (seconds < 2) return "Now";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

/** One observation clock for every operator surface. */
export function operatorObservationForSurface(
  summary: OperatorSummaryV1,
  _surface: OperatorObservationSurface,
  nowMs?: number,
): OperatorObservationView {
  const atMs = validTimestampMs(summary.observation.at);
  if (summary.observation.coverage !== "observed" || atMs === undefined) {
    return {
      at: null,
      ageMs: null,
      ageLabel: summary.observation.coverage === "not-observed" ? "Not observed" : "Unknown",
    };
  }
  const generatedAtMs = validTimestampMs(summary.generatedAt) ?? atMs;
  const referenceMs = nowMs ?? generatedAtMs;
  const ageMs = Math.max(
    0,
    summary.observation.ageMs ?? 0,
    generatedAtMs - atMs,
    referenceMs - atMs,
  );
  return { at: new Date(atMs).toISOString(), ageMs, ageLabel: conciseAge(ageMs) };
}

/**
 * WebSocket delivery is ordered, but this guard prevents an obsolete replay
 * from moving the canonical observation clock backwards.
 */
export function mergeCanonicalOperatorSummary(
  current: OperatorSummaryV1,
  incoming: OperatorSummaryV1,
): OperatorSummaryV1 {
  const currentAtMs = current.observation.coverage === "observed" ? validTimestampMs(current.observation.at) : undefined;
  const incomingAtMs = incoming.observation.coverage === "observed" ? validTimestampMs(incoming.observation.at) : undefined;
  const sameTarget = current.observation.targetId === incoming.observation.targetId;
  if (!sameTarget) return incoming;
  if (currentAtMs === undefined || incomingAtMs === undefined || incomingAtMs >= currentAtMs) return incoming;
  const generatedAtMs = validTimestampMs(incoming.generatedAt) ?? currentAtMs;
  return {
    ...incoming,
    observation: {
      at: new Date(currentAtMs).toISOString(),
      ageMs: Math.max(0, generatedAtMs - currentAtMs),
      coverage: "observed",
      ...(current.observation.targetId ? { targetId: current.observation.targetId } : {}),
    },
  };
}

/** Whether the summary's single observation belongs to this feed. */
export function operatorObservationMatchesTargets(summary: OperatorSummaryV1, targetIds: readonly string[]): boolean {
  if (summary.observation.targetId) return targetIds.includes(summary.observation.targetId);
  // One-release compatibility for a legacy summary that named exactly one
  // affected target but omitted the new attribution field.
  return summary.affectedTargets.length === 1 && targetIds.includes(summary.affectedTargets[0].id);
}

export function isRealOperatorAlert(summary: OperatorSummaryV1): boolean {
  return summary.dataMode === "field"
    && summary.monitoring.state === "alert"
    && !summary.incident?.synthetic;
}

export function operatorAnnouncement(summary: OperatorSummaryV1): string {
  const presentation = presentOperatorSummary(summary);
  const affected = summary.affectedTargets.map((target) => target.label).join(", ");
  const observation = summary.incident?.observation || presentation.observation;
  const action = summary.incident?.recommendedAction || presentation.action;
  return [
    summary.dataMode === "simulation" ? "Simulation" : undefined,
    presentation.monitoring,
    affected || undefined,
    observation,
    action !== "None" ? `Action: ${action}` : undefined,
    OPERATOR_REASON_COPY[summary.recording.reasonCode],
  ].filter(Boolean).join(". ");
}
