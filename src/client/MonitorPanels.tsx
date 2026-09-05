import {
  Check,
  Download,
  FileText,
  RadioTower,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { presentOperatorSummary, type OperatorSummaryV1 } from "../shared/operatorSummary";
import type { DetectionEvent, MonitorSnapshot, SpectrumFrame } from "../shared/types";
import { dateTime, formatDuration, formatRange } from "./format";
import { operatorObservationForSurface } from "./operatorViewModel";
import { disturbancePlacement, disturbancePlacementCopy } from "./detectorPresentation";

export function IncidentPanel({
  event,
  operatorSummary,
  services,
  displayTimeZone,
  onAddNote,
  onAcknowledge,
  onExport,
  archived = false,
  frame,
}: {
  event?: DetectionEvent;
  operatorSummary: OperatorSummaryV1;
  services: MonitorSnapshot["services"];
  displayTimeZone: string;
  onAddNote: () => void;
  onAcknowledge: () => void;
  onExport: () => void;
  archived?: boolean;
  frame?: SpectrumFrame;
}) {
  const presentation = presentOperatorSummary(operatorSummary);
  const placement = disturbancePlacement(frame);
  const currentIncident = archived ? undefined : operatorSummary.incident;
  const incidentPresent = archived ? Boolean(event) : Boolean(currentIncident);
  const synthetic = archived ? Boolean(event?.syntheticExercise) : operatorSummary.dataMode === "simulation" || Boolean(currentIncident?.synthetic);
  const evidenceStrength = currentIncident?.evidenceStrength ?? event?.evidenceStrength;
  const lifecycle = currentIncident?.lifecycle ?? event?.lifecycle;
  const startedAt = currentIncident?.startedAt ?? event?.startedAt;
  const affected = currentIncident
    ? operatorSummary.affectedTargets.map((target) => target.frequencyLabel ? `${target.label} (${target.frequencyLabel})` : target.label).join(", ")
    : event?.affectedLabel ?? services.find((service) => service.service === event?.service)?.label ?? event?.bandLabel;
  const observation = currentIncident?.observation ?? event?.observed;
  const recommendedAction = currentIncident?.recommendedAction ?? event?.recommendedAction ?? presentation.action;
  const headingTone = operatorSummary.monitoring.state === "normal"
    ? "clear"
    : operatorSummary.monitoring.state === "offline" || operatorSummary.monitoring.state === "data-late"
      ? "unavailable"
      : "active";
  const recordingOk = operatorSummary.recording.state === "recording";
  const recordingCopy = synthetic
    ? "Test data only"
    : recordingOk
      ? "Recording on"
      : `${presentation.recording}. ${presentation.recording === "Error" || presentation.recording === "Stopped" ? "Open Recording." : ""}`.trim();
  const canonicalObservation = operatorObservationForSurface(operatorSummary, "incident");

  return (
    <section className="panel incident-panel" aria-labelledby="incident-title">
      <h2 id="incident-title" className="panel-title">Selected incident details</h2>
      <div className={`incident-heading ${archived && event ? event.status : headingTone}`}>
        {incidentPresent ? <RadioTower size={29} /> : operatorSummary.monitoring.state === "normal" ? <ShieldCheck size={29} /> : <TriangleAlert size={29} />}
        <strong>{archived && event ? "Incident record" : currentIncident?.verdict ?? (operatorSummary.monitoring.state === "normal" ? "No active incident" : presentation.monitoring)}</strong>
      </div>
      {incidentPresent ? (
        <div className="incident-facts">
          {synthetic ? <IncidentRow label="Source" value="Simulation" emphasis /> : null}
          {archived && event ? <IncidentRow label="Alert level" value={event.severity.toUpperCase()} emphasis /> : null}
          {evidenceStrength ? <IncidentRow label="Evidence" value={evidenceStrength} /> : null}
          {lifecycle ? <IncidentRow label="Status" value={lifecycle === "active" ? "Alert" : lifecycle === "recovering" ? "Recovering" : event?.acknowledgedAt ? "Reviewed" : "Ended"} /> : null}
          {startedAt ? <IncidentRow label="Start time" value={dateTime(startedAt, displayTimeZone)} /> : null}
          {!archived && canonicalObservation.at ? <IncidentRow label="Last observation" value={`${dateTime(canonicalObservation.at, displayTimeZone)} · ${canonicalObservation.ageLabel}`} /> : null}
          {event ? <IncidentRow label="Duration" value={formatDuration(event.startedAt, event.clearedAt ?? event.lastSeenAt)} /> : null}
          {affected ? <IncidentRow label="Affected signal" value={affected} /> : null}
          {event ? <IncidentRow label="Checked span" value={formatRange(...event.affectedRangeHz)} /> : null}
          {placement ? <IncidentRow label="Disturbance" value={disturbancePlacementCopy(placement)} /> : null}
          {observation ? <IncidentRow label="Observed" value={observation} /> : null}
        </div>
      ) : <div className="incident-empty">{presentation.observation}</div>}
      <div className="incident-section">
        <strong>Action</strong>
        <p><span className={`action-dot ${incidentPresent || operatorSummary.monitoring.actionCode !== "none" ? "alert" : "clear"}`} />{recommendedAction}</p>
      </div>
      <div className="incident-section">
        <strong>Recording</strong>
        <p><span className={`action-dot ${synthetic || !recordingOk ? "alert" : "clear"}`} />{recordingCopy}</p>
      </div>
      <button className="button primary export-button" type="button" onClick={onExport} disabled={!event || !recordingOk || synthetic}>
        <Download size={19} /> {synthetic ? "Test record only" : "Download incident files"}
      </button>
      <div className="incident-actions">
        <button className="button secondary" type="button" onClick={onAddNote} disabled={!event || archived || synthetic}><FileText size={17} /> {synthetic ? "Test record" : archived ? "Archived record" : "Add note"}</button>
        <button className="button secondary" type="button" onClick={onAcknowledge} disabled={!event || archived || Boolean(event.acknowledgedAt) || synthetic}><Check size={18} /> {synthetic ? "Test only" : event?.acknowledgedAt ? "Acknowledged" : archived ? "Read only" : "Acknowledge"}</button>
      </div>
    </section>
  );
}

function IncidentRow({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return <div className="incident-row"><span>{label}</span><strong className={emphasis ? "severity-value" : ""}>{value}</strong></div>;
}
