import { presentOperatorSummary, type OperatorSummaryV1 } from "../shared/operatorSummary";

export interface SurfaceAlertCopy {
  heading: string;
  detail: string;
  simulation: boolean;
}

export function surfaceAlertCopy(summary: OperatorSummaryV1): SurfaceAlertCopy | undefined {
  if (summary.monitoring.state !== "alert" && summary.monitoring.state !== "recovering") return undefined;
  const targetsLabel = summary.affectedTargets.map((target) => target.label).join(", ");
  const observation = summary.incident?.observation || presentOperatorSummary(summary).observation;
  const detail = [targetsLabel || undefined, observation].filter(Boolean).join(" · ");
  return { heading: presentOperatorSummary(summary).monitoring, detail, simulation: summary.dataMode === "simulation" };
}

export function SurfaceAlertBanner({ summary, onOpenDashboard }: { summary: OperatorSummaryV1; onOpenDashboard: () => void }) {
  const copy = surfaceAlertCopy(summary);
  if (!copy) return null;
  return (
    <div className={`surface-alert-banner ${copy.simulation ? "simulation" : ""}`} role="alert">
      <strong>{copy.simulation ? "Simulation · " : ""}{copy.heading}</strong>
      <span>{copy.detail}</span>
      <button type="button" onClick={onOpenDashboard}>Open dashboard</button>
    </div>
  );
}
