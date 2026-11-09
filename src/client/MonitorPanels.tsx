import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ClipboardCopy,
  Download,
  FileText,
  LineChart,
  RadioTower,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import { presentOperatorSummary, type OperatorSummaryV1 } from "../shared/operatorSummary";
import { rfVerdictFor } from "../shared/productContract";
import { alertPresetLabel } from "../shared/alertPolicy";
import { incidentReference } from "../shared/incidentNaming";
import type { DetectionEvent, MonitorSnapshot, SpectrumFrame } from "../shared/types";
import { dateTime, formatDuration, formatRange } from "./format";
import { operatorObservationForSurface } from "./operatorViewModel";
import { disturbancePlacement, disturbancePlacementCopy } from "./detectorPresentation";
import {
  disturbedSummary,
  EVIDENCE_MEANING,
  incidentStatusLabel,
  incidentTimeline,
  ruleLabel,
  timelineLabel,
  triggerBars,
  whyAlertSentence,
} from "./incidentPresentation";

export interface PackageDownloadInfo {
  eventId: string;
  files: Array<{ filename: string; sha256?: string }>;
}

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
  getEvent,
  onBack,
  onOpenAnalysis,
  onOpenSensitivity,
  packageDownload,
  onCopy,
  exporting = false,
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
  /** Fetch the full record (complete timeline, notes and trigger) from the server. */
  getEvent?: (eventId: string, sessionId?: string) => Promise<DetectionEvent>;
  onBack?: () => void;
  onOpenAnalysis?: () => void;
  onOpenSensitivity?: () => void;
  packageDownload?: PackageDownloadInfo;
  onCopy?: (text: string) => Promise<void>;
  exporting?: boolean;
}) {
  const full = useFullIncident(event, getEvent);
  const record = full ?? event;
  const presentation = presentOperatorSummary(operatorSummary);
  const placement = disturbancePlacement(frame);
  const currentIncident = archived || (event && operatorSummary.incident?.id !== event.id) ? undefined : operatorSummary.incident;
  const incidentPresent = Boolean(record) || Boolean(currentIncident);
  const synthetic = record ? Boolean(record.syntheticExercise) : operatorSummary.dataMode === "simulation" || Boolean(currentIncident?.synthetic);
  const evidenceStrength = record?.evidenceStrength ?? currentIncident?.evidenceStrength;
  const status = record ? incidentStatusLabel(record) : currentIncident?.lifecycle === "recovering" ? "Recovering" : "Alert";
  const verdict = record ? rfVerdictFor(record) : currentIncident?.verdict;
  const affected = currentIncident
    ? operatorSummary.affectedTargets.map((target) => target.label).join(", ")
    : record?.affectedLabel ?? services.find((service) => service.service === record?.service)?.label ?? record?.bandLabel;
  const recommendedAction = record?.recommendedAction ?? currentIncident?.recommendedAction ?? presentation.action;
  const live = record ? record.lifecycle === "active" || record.lifecycle === "recovering" : Boolean(currentIncident);
  const tone = !incidentPresent
    ? operatorSummary.monitoring.state === "normal" ? "clear" : operatorSummary.monitoring.state === "offline" || operatorSummary.monitoring.state === "data-late" ? "unavailable" : "active"
    : status === "Alert" ? (record?.status === "suspicious" ? "suspicious" : "active") : status === "Recovering" ? "recovering" : "closed";
  const recordingOk = operatorSummary.recording.state === "recording";
  const canonicalObservation = operatorObservationForSurface(operatorSummary, "incident");
  const trigger = record?.trigger;
  const bars = trigger ? triggerBars(trigger) : [];
  const timeline = record ? incidentTimeline(record) : [];
  const [snapshotAvailable, setSnapshotAvailable] = useState(true);
  useEffect(() => setSnapshotAvailable(true), [record?.id]);
  const downloadFiles = packageDownload && record && packageDownload.eventId === record.id ? packageDownload.files : undefined;
  const endAt = record ? (record.clearedAt ?? record.endedAt ?? (live ? new Date().toISOString() : record.lastSeenAt)) : undefined;
  // Archived and closed records are judged by their own evidence, not today's recording state.
  const canDownload = Boolean(record) && !synthetic && (archived || !live || recordingOk);

  return (
    <section className="panel incident-panel incident-detail" aria-labelledby="incident-title">
      {onBack ? <button type="button" className="incident-back" onClick={onBack}><ArrowLeft size={16} aria-hidden="true" /> Evidence history</button> : null}
      <header className={`incident-hero tone-${tone}`}>
        {incidentPresent ? <RadioTower size={28} aria-hidden="true" /> : operatorSummary.monitoring.state === "normal" ? <ShieldCheck size={28} aria-hidden="true" /> : <TriangleAlert size={28} aria-hidden="true" />}
        <div className="incident-hero-copy">
          {incidentPresent ? <small>{status}{record ? ` · ${incidentReference(record)}` : ""}</small> : null}
          <h2 id="incident-title">{incidentPresent ? verdict ?? "Incident" : operatorSummary.monitoring.state === "normal" ? "No active incident" : presentation.monitoring}</h2>
          {incidentPresent && affected ? <p>{affected}</p> : null}
        </div>
        {incidentPresent ? (
          <div className="incident-chips">
            {synthetic ? <span className="incident-chip simulation">Simulation</span> : null}
            {evidenceStrength ? <span className={`incident-chip evidence-${evidenceStrength.toLowerCase()}`} title={EVIDENCE_MEANING[evidenceStrength]}>{evidenceStrength} evidence</span> : null}
          </div>
        ) : null}
      </header>

      {!incidentPresent ? <div className="incident-empty">{presentation.observation}</div> : (
        <>
          <dl className="incident-summary">
            {record ? <IncidentFact label="Disturbed" value={disturbedSummary(record)} strong /> : null}
            {record?.startedAt ? <IncidentFact label="Started" value={dateTime(record.startedAt, displayTimeZone)} /> : null}
            {record && endAt ? <IncidentFact label={live ? "Duration" : "Lasted"} value={formatDuration(record.startedAt, endAt)} /> : null}
            {!archived && live && canonicalObservation.at ? <IncidentFact label="Last check" value={`${dateTime(canonicalObservation.at, displayTimeZone)} · ${canonicalObservation.ageLabel}`} /> : null}
            {placement && live ? <IncidentFact label="Now" value={disturbancePlacementCopy(placement)} /> : null}
            {record ? <IncidentFact label="Checked window" value={formatRange(...record.affectedRangeHz)} /> : null}
            {record?.endReason ? <IncidentFact label="Ended because" value={record.endReason} /> : null}
          </dl>
          <div className="incident-action-callout">
            <strong>Action</strong>
            <p>{recommendedAction}</p>
          </div>

          {record ? (
            <section className="incident-block" aria-labelledby="incident-why">
              <h3 id="incident-why">Why this alert</h3>
              <p className="incident-why-sentence">{whyAlertSentence(record)}</p>
              {bars.length ? (
                <ul className="trigger-bars">
                  {bars.map((bar) => (
                    <li key={bar.id}>
                      <div className="trigger-bar-label"><span>{bar.label}</span><strong>{bar.measured}</strong></div>
                      <div className="trigger-bar-track" aria-hidden="true">
                        <i style={{ width: `${Math.min(100, Math.max(4, (bar.fill / 2) * 100))}%` }} className={bar.met ? "met" : ""} />
                        <b style={{ left: "50%" }} />
                      </div>
                      <small>{bar.limit}</small>
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="incident-policy">
                <span>{ruleLabel(record) ?? "Alert"}{trigger ? ` · ${alertPresetLabel(trigger.policy.choice)} sensitivity${trigger.policy.source === "window" ? " for this window" : ""}` : ""}</span>
                {onOpenSensitivity && !synthetic ? <button type="button" className="link-button" onClick={onOpenSensitivity}><SlidersHorizontal size={14} aria-hidden="true" /> Sensitivity</button> : null}
              </p>
            </section>
          ) : null}

          {record && trigger && !synthetic && snapshotAvailable ? (
            <figure className="incident-block trigger-figure">
              <img
                src={`/api/events/${encodeURIComponent(record.id)}/trigger.svg`}
                alt={`Spectrum when the alert was raised: ${whyAlertSentence(record)}`}
                loading="lazy"
                onError={() => setSnapshotAvailable(false)}
              />
              <figcaption>What the detector saw at the alert. Blue: received. Green: usual level. Dashed amber: alert level. Red: above the alert level. Relative levels, not calibrated power.</figcaption>
            </figure>
          ) : null}

          {record ? (
            <section className="incident-block" aria-labelledby="incident-timeline">
              <h3 id="incident-timeline">Timeline</h3>
              <ol className="incident-timeline">
                {timeline.map((entry, index) => (
                  <li key={`${entry.code}-${entry.at}-${index}`} className={`timeline-${entry.code}`}>
                    <time dateTime={entry.at}>{dateTime(entry.at, displayTimeZone)}</time>
                    <strong>{timelineLabel(entry.code)}</strong>
                    {entry.detail ? <span>{entry.detail}</span> : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {record ? (
            <section className="incident-block" aria-labelledby="incident-notes">
              <div className="incident-block-heading">
                <h3 id="incident-notes">Notes</h3>
                <button className="button secondary compact" type="button" onClick={onAddNote} disabled={archived || synthetic}><FileText size={15} aria-hidden="true" /> Add note</button>
              </div>
              {record.notes.length ? (
                <ul className="incident-notes">
                  {record.notes.map((note) => <li key={note.id}><time dateTime={note.timestamp}>{dateTime(note.timestamp, displayTimeZone)}</time><p>{note.text}</p></li>)}
                </ul>
              ) : <p className="incident-muted">{archived ? "No notes were added." : "No notes yet. Add what you checked and what you saw."}</p>}
            </section>
          ) : null}

          <section className="incident-block" aria-labelledby="incident-evidence">
            <h3 id="incident-evidence">Evidence</h3>
            <p className="incident-muted">{synthetic ? "Test data only. Not part of field evidence." : archived || !live ? "Recorded spectrum, trigger snapshot, timeline, notes and report, with SHA-256 checks." : recordingOk ? "Recording on. The package includes the report, spectrum, timeline and notes." : `${presentation.recording}. Open Recording before downloading.`}</p>
            <div className="incident-evidence-actions">
              <button className="button primary" type="button" onClick={onExport} disabled={!canDownload || exporting}>
                <Download size={17} aria-hidden="true" /> {synthetic ? "Test record only" : exporting ? "Preparing package…" : "Download evidence package"}
              </button>
              {onOpenAnalysis && record && !synthetic ? <button className="button secondary" type="button" onClick={onOpenAnalysis}><LineChart size={17} aria-hidden="true" /> Incident report</button> : null}
            </div>
            {downloadFiles?.length ? (
              <div className="package-hash">
                {downloadFiles.map((file) => (
                  <div key={file.filename}>
                    <span>{file.filename}</span>
                    {file.sha256 ? <code title="SHA-256 of the downloaded file">SHA-256 {file.sha256}</code> : null}
                    {file.sha256 && onCopy ? <button type="button" className="link-button" onClick={() => void onCopy(file.sha256!)}><ClipboardCopy size={14} aria-hidden="true" /> Copy</button> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          {record ? (
            <details className="incident-technical">
              <summary>Technical details</summary>
              <dl>
                <IncidentFact label="Incident ID" value={record.id} mono />
                <IncidentFact label="Rule" value={`${record.kind}${record.detailKind ? ` / ${record.detailKind}` : ""}`} mono />
                {trigger ? <IncidentFact label="Measured" value={`peak ${trigger.measured.peakZ}σ, middle ${trigger.measured.medianZ}σ, share ${(trigger.measured.occupancyRatio * 100).toFixed(1)}%, widest ${(trigger.measured.widestSegmentRatio * 100).toFixed(1)}%`} mono /> : null}
                {trigger?.measured.peakFrequencyHz ? <IncidentFact label="Peak" value={`${(trigger.measured.peakFrequencyHz / 1e6).toFixed(4)} MHz, level ${trigger.measured.peakLevel} vs usual ${trigger.measured.usualLevelAtPeak} (relative 0–255)`} mono /> : null}
                {record.peak ? <IncidentFact label="Strongest" value={`${record.peak.maxPeakZ}σ at ${dateTime(record.peak.maxPeakZAt, displayTimeZone)}`} mono /> : null}
                {trigger ? <IncidentFact label="Policy" value={`${alertPresetLabel(trigger.policy.choice)} · ${trigger.classifierVersion} · ${trigger.policy.hash.slice(0, 16)}`} mono /> : null}
                {trigger ? <IncidentFact label="Reference" value={`${trigger.reference.lifecycle} · generation ${trigger.reference.generationId}`} mono /> : null}
                <IncidentFact label="Rule set" value={record.ruleSetId} mono />
                <IncidentFact label="Baseline" value={record.baselineId ?? record.baselineFingerprintId.slice(0, 24)} mono />
                <IncidentFact label="Evidence basis" value={record.evidenceBasis} />
              </dl>
            </details>
          ) : null}

          <div className="incident-actions">
            <button className="button secondary" type="button" onClick={onAcknowledge} disabled={!record || archived || Boolean(record?.acknowledgedAt) || synthetic}><Check size={17} aria-hidden="true" /> {synthetic ? "Test only" : record?.acknowledgedAt ? "Acknowledged" : archived ? "Read only" : "Acknowledge"}</button>
          </div>
        </>
      )}
    </section>
  );
}

/** Keep the full server record in step with the live summary without over-fetching. */
function useFullIncident(event: DetectionEvent | undefined, getEvent?: (eventId: string, sessionId?: string) => Promise<DetectionEvent>): DetectionEvent | undefined {
  const [full, setFull] = useState<DetectionEvent>();
  const lastFetch = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const signature = event ? `${event.id}|${event.lifecycle}|${event.notes.length}|${event.acknowledgedAt ?? ""}|${event.timeline?.at(-1)?.at ?? ""}|${event.lastSeenAt}` : "";
  useEffect(() => {
    if (!event || !getEvent) {
      setFull(undefined);
      return;
    }
    const now = Date.now();
    const structural = signature.split("|").slice(0, 5).join("|");
    if (lastFetch.current.key === structural && now - lastFetch.current.at < 5_000) return;
    lastFetch.current = { key: structural, at: now };
    let cancelled = false;
    void getEvent(event.id, event.sessionId)
      .then((record) => { if (!cancelled && record?.id === event.id) setFull(record); })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [signature, event?.id, getEvent]);
  if (!event) return undefined;
  if (!full || full.id !== event.id) return undefined;
  // Live fields (last seen, lifecycle, notes) come from the newest of the two.
  return Date.parse(event.lastSeenAt) > Date.parse(full.lastSeenAt) || event.notes.length > full.notes.length
    ? { ...full, ...event, trigger: full.trigger ?? event.trigger, timeline: (full.timeline?.length ?? 0) >= (event.timeline?.length ?? 0) ? full.timeline : event.timeline, notes: event.notes.length >= full.notes.length ? event.notes : full.notes }
    : full;
}

function IncidentFact({ label, value, strong = false, mono = false }: { label: string; value: string; strong?: boolean; mono?: boolean }) {
  return <div className="incident-fact"><dt>{label}</dt><dd className={`${strong ? "strong" : ""}${mono ? " mono" : ""}`.trim() || undefined}>{value}</dd></div>;
}
