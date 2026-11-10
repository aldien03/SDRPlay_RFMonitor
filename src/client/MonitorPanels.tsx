import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Download,
  FileText,
  LineChart,
  Maximize2,
  Pause,
  Play,
  RadioTower,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
  X,
} from "lucide-react";
import { presentOperatorSummary, type OperatorSummaryV1 } from "../shared/operatorSummary";
import { rfVerdictFor } from "../shared/productContract";
import { alertPresetLabel } from "../shared/alertPolicy";
import { incidentReference } from "../shared/incidentNaming";
import type { DetectionEvent, EvidenceArchiveSession, EvidenceReplayBatch, MonitorSnapshot, SpectrumFrame } from "../shared/types";
import { DialogShell } from "./DialogShell";
import { EvidenceReplay } from "./BottomPanels";
import { operatorObservationForSurface } from "./operatorViewModel";
import { disturbancePlacement, disturbancePlacementCopy } from "./detectorPresentation";
import {
  checkedSpanLabel,
  disturbedSummary,
  endReasonLabel,
  EVIDENCE_MEANING,
  incidentActionCopy,
  incidentClock,
  incidentEndAt,
  incidentStatusLabel,
  incidentTimeline,
  needsReview,
  recentIncidentStatus,
  ruleLabel,
  shortDuration,
  timelineLabel,
  triggerBars,
  triggerBarScale,
  whyAlertSentence,
} from "./incidentPresentation";

export interface PackageDownloadInfo {
  eventId: string;
  files: Array<{ filename: string; sha256?: string }>;
}

export interface RecentIncidentsView {
  incidents?: DetectionEvent[];
  error?: string;
  liveIds: ReadonlySet<string>;
  /** Field incidents from the last `reviewWindowHours` nobody has marked reviewed. */
  toReview?: number;
  reviewWindowHours?: number;
}

export interface IncidentStepper {
  position: number;
  total: number;
  onNewer?: () => void;
  onOlder?: () => void;
}

export interface IncidentReplaySource {
  session: Pick<EvidenceArchiveSession, "id" | "lifecycle" | "incompleteReasons">;
  getBatch: (sessionId: string, cursor?: string, limit?: number, from?: string, focus?: { targetId?: string; bandId?: string }) => Promise<EvidenceReplayBatch>;
  signalLabel: (bandId: string) => string;
}

/** Replay starts a little before the alert: the recorded index is only roughly time-ordered. */
const REPLAY_LEAD_IN_MS = 60_000;

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
  recent,
  onOpenRecent,
  onOpenHistory,
  backLabel = "Evidence history",
  otherActive = [],
  onSelectIncident,
  stepper,
  replay,
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
  /** Shown when there is no incident to display: newest incidents, live ones from this run first in priority. */
  recent?: RecentIncidentsView;
  onOpenRecent?: (event: DetectionEvent) => void;
  onOpenHistory?: () => void;
  backLabel?: string;
  /** Other open incidents in this run, so the operator can switch without the drawer jumping. */
  otherActive?: DetectionEvent[];
  onSelectIncident?: (event: DetectionEvent) => void;
  /** Newer/older stepping through the recent list the incident was opened from. */
  stepper?: IncidentStepper;
  /** Present when the incident's session can be replayed (finalized, same host). */
  replay?: IncidentReplaySource;
}) {
  const full = useFullIncident(event, getEvent);
  const record = full ?? event;
  const presentation = presentOperatorSummary(operatorSummary);
  const placement = disturbancePlacement(frame);
  const currentIncident = archived || (event && operatorSummary.incident?.id !== event.id) ? undefined : operatorSummary.incident;
  const incidentPresent = Boolean(record) || Boolean(currentIncident);
  const synthetic = record ? Boolean(record.syntheticExercise) : operatorSummary.dataMode === "simulation" || Boolean(currentIncident?.synthetic);
  const evidenceStrength = record?.evidenceStrength ?? currentIncident?.evidenceStrength;
  const recordOpen = Boolean(record && (record.lifecycle === "active" || record.lifecycle === "recovering") && !record.clearedAt && !record.endedAt);
  // A stored copy that still says open is not being watched any more: it has ended.
  const status = record ? (archived && recordOpen ? "Ended" : incidentStatusLabel(record)) : currentIncident?.lifecycle === "recovering" ? "Recovering" : "Alert";
  const verdict = record ? rfVerdictFor(record) : currentIncident?.verdict;
  const affected = currentIncident
    ? operatorSummary.affectedTargets.map((target) => target.label).join(", ")
    : record?.affectedLabel ?? services.find((service) => service.service === record?.service)?.label ?? record?.bandLabel;
  const recommendedAction = record?.recommendedAction ?? currentIncident?.recommendedAction ?? presentation.action;
  const live = record ? !archived && recordOpen : Boolean(currentIncident);
  const monitoringState = operatorSummary.monitoring.state;
  const tone = !incidentPresent
    ? monitoringState === "normal" ? "clear"
      : monitoringState === "offline" || monitoringState === "data-late" ? "unavailable"
        : monitoringState === "alert" ? "active"
          : monitoringState === "paused" ? "closed"
            : "checking"
    : status === "Alert" ? (record?.status === "suspicious" ? "suspicious" : "active") : status === "Recovering" ? "recovering" : "closed";
  const recordingOk = operatorSummary.recording.state === "recording";
  const canonicalObservation = operatorObservationForSurface(operatorSummary, "incident");
  const trigger = record?.trigger;
  const bars = trigger ? triggerBars(trigger) : [];
  const timeline = record ? incidentTimeline(record) : [];
  const now = new Date();
  const clock = (iso: string) => incidentClock(iso, displayTimeZone, now);
  // The trigger picture is written just after the alert; retry a few times instead of hiding it until reopened.
  const [snapshotAttempt, setSnapshotAttempt] = useState(0);
  const [snapshotAvailable, setSnapshotAvailable] = useState(true);
  const [figureOpen, setFigureOpen] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const snapshotRetry = useRef<number | undefined>(undefined);
  useEffect(() => {
    setSnapshotAvailable(true);
    setSnapshotAttempt(0);
    setFigureOpen(false);
    setReplayOpen(false);
    return () => window.clearTimeout(snapshotRetry.current);
  }, [record?.id]);
  const onSnapshotError = () => {
    setSnapshotAvailable(false);
    if (snapshotAttempt >= 3 || !live) return;
    window.clearTimeout(snapshotRetry.current);
    snapshotRetry.current = window.setTimeout(() => {
      setSnapshotAttempt((attempt) => attempt + 1);
      setSnapshotAvailable(true);
    }, 4_000);
  };
  const downloadFiles = packageDownload && record && packageDownload.eventId === record.id ? packageDownload.files : undefined;
  const endAt = record ? incidentEndAt(record, live) : undefined;
  // Archived and closed records are judged by their own evidence, not today's recording state.
  const canDownload = Boolean(record) && !synthetic && (archived || !live || recordingOk);
  const reviewed = Boolean(record?.acknowledgedAt);
  const action = incidentActionCopy({ live, status, synthetic, acknowledgedAt: record?.acknowledgedAt, recommendedAction, timeZone: displayTimeZone, now });
  const endReason = endReasonLabel(record?.endReason);
  const reviewLabel = synthetic ? "Test only" : reviewed ? (live ? "Acknowledged" : "Reviewed") : live ? "Acknowledge" : "Mark reviewed";
  const snapshotBase = record ? `/api/events/${encodeURIComponent(record.id)}/trigger.svg` : "";

  return (
    <section className="panel incident-panel incident-detail" aria-labelledby="incident-title">
      {onBack || (stepper && stepper.total > 1) ? (
        <div className="incident-nav">
          {onBack ? <button type="button" className="incident-back" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /> {backLabel}</button> : <span />}
          {stepper && stepper.total > 1 ? (
            <div className="incident-stepper" role="group" aria-label="Step through recent incidents">
              <button type="button" onClick={stepper.onNewer} disabled={!stepper.onNewer} aria-label="Newer incident"><ChevronLeft size={14} aria-hidden="true" /> Newer</button>
              <span>{stepper.position} of {stepper.total}</span>
              <button type="button" onClick={stepper.onOlder} disabled={!stepper.onOlder} aria-label="Older incident">Older <ChevronRight size={14} aria-hidden="true" /></button>
            </div>
          ) : null}
        </div>
      ) : null}
      {otherActive.length && onSelectIncident ? (
        <div className="incident-others" aria-label="Other open incidents">
          <span>Also open</span>
          {otherActive.map((other) => <button key={other.id} type="button" onClick={() => onSelectIncident(other)}>{other.affectedLabel ?? other.bandLabel} · {incidentStatusLabel(other)}</button>)}
        </div>
      ) : null}
      <div className={`incident-heading ${tone}`}>
        {incidentPresent ? <RadioTower size={29} aria-hidden="true" />
          : tone === "clear" ? <ShieldCheck size={29} aria-hidden="true" />
            : tone === "checking" ? <Activity size={29} aria-hidden="true" />
              : tone === "closed" ? <Pause size={29} aria-hidden="true" />
                : <TriangleAlert size={29} aria-hidden="true" />}
        <div className="incident-heading-copy">
          <small>{incidentPresent ? status : "Monitoring"}</small>
          <strong id="incident-title" tabIndex={-1}>{incidentPresent ? verdict ?? "Incident" : monitoringState === "normal" ? "No active incident" : presentation.monitoring}</strong>
        </div>
        {incidentPresent ? (
          <div className="incident-chips">
            {synthetic ? <span className="incident-chip simulation">Simulation</span> : null}
            {evidenceStrength ? <span className="incident-chip" title={EVIDENCE_MEANING[evidenceStrength]}>{evidenceStrength} evidence</span> : null}
            {reviewed && !synthetic ? <span className="incident-chip reviewed" title={record?.acknowledgedAt ? `Reviewed ${clock(record.acknowledgedAt)}` : undefined}><Check size={11} aria-hidden="true" /> Reviewed</span> : null}
          </div>
        ) : null}
      </div>

      {!incidentPresent ? (
        <>
          <p className="incident-status-line">{presentation.observation}</p>
          {recent ? <RecentIncidentList recent={recent} displayTimeZone={displayTimeZone} onOpen={onOpenRecent} onOpenHistory={onOpenHistory} /> : null}
        </>
      ) : (
        <>
          <dl className="incident-facts">
            {affected ? <IncidentFact label="Affected signal" value={affected} /> : null}
            {record ? <IncidentFact label="Disturbed" value={disturbedSummary(record)} strong /> : null}
            {record?.startedAt ? <IncidentFact label="Started" value={clock(record.startedAt)} /> : null}
            {record && endAt ? <IncidentFact label="Duration" value={`${shortDuration(record.startedAt, endAt)}${live ? " so far" : ""}`} /> : null}
            {!archived && live && canonicalObservation.at ? <IncidentFact label="Last observation" value={`${clock(canonicalObservation.at)} · ${canonicalObservation.ageLabel}`} /> : null}
            {placement && live ? <IncidentFact label="Now" value={disturbancePlacementCopy(placement)} /> : null}
            {endReason ? <IncidentFact label="Ended" value={endReason} /> : null}
            {record ? <IncidentFact label="Checked span" value={checkedSpanLabel(record)} /> : null}
            {record ? <IncidentFact label="Reference" value={incidentReference(record)} /> : null}
          </dl>
          <div className="incident-section incident-action">
            <strong>Action</strong>
            <p><span className={`action-dot ${action.tone}`} />{action.text}</p>
            {action.during ? <p className="incident-muted">During the alert: {action.during}</p> : null}
          </div>

          {record ? (
            <section className="incident-section" aria-labelledby="incident-why">
              <h3 id="incident-why">Why this alert</h3>
              <p className="incident-why-sentence">{whyAlertSentence(record)}</p>
              {bars.length ? (
                <ul className="trigger-bars">
                  {bars.map((bar) => {
                    const scale = triggerBarScale(bar.fill);
                    return (
                      <li key={bar.id} className={bar.emphasis}>
                        <div className="trigger-bar-label"><span>{bar.label}</span><strong>{bar.measured}<small> · {bar.limit}</small></strong></div>
                        <div className="trigger-bar-track" aria-hidden="true">
                          <i style={{ width: `${scale.width}%` }} className={bar.emphasis === "rule" && bar.met ? "met" : ""} />
                          <b style={{ left: `${scale.marker}%` }} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
              <p className="incident-policy">
                <span>{ruleLabel(record) ?? "Alert"}{trigger ? ` · ${alertPresetLabel(trigger.policy.choice)} sensitivity${trigger.policy.source === "window" ? " for this window" : ""}` : ""}</span>
                {onOpenSensitivity && !synthetic ? <button type="button" className="link-button" onClick={onOpenSensitivity}><SlidersHorizontal size={13} aria-hidden="true" /> Sensitivity</button> : null}
              </p>
            </section>
          ) : null}

          {record && trigger && !synthetic && snapshotAvailable ? (
            <figure className="incident-section trigger-figure">
              <div className="incident-section-heading">
                <h3>At the alert</h3>
                <span className="incident-section-links">
                  {replay ? <button type="button" className="link-button" onClick={() => setReplayOpen((open) => !open)} aria-expanded={replayOpen}><Play size={13} aria-hidden="true" /> {replayOpen ? "Hide replay" : "Replay"}</button> : null}
                  <button type="button" className="link-button" onClick={() => setFigureOpen(true)}><Maximize2 size={13} aria-hidden="true" /> Enlarge</button>
                </span>
              </div>
              <button type="button" className="trigger-figure-open" onClick={() => setFigureOpen(true)} aria-label="Enlarge the picture at the alert">
                <img
                  src={`${snapshotBase}?size=compact${snapshotAttempt ? `&attempt=${snapshotAttempt}` : ""}`}
                  alt={`Spectrum when the alert was raised: ${whyAlertSentence(record)}`}
                  loading="lazy"
                  onError={onSnapshotError}
                />
              </button>
              <figcaption>Relative levels, not calibrated power.</figcaption>
            </figure>
          ) : null}
          {record && replay && replayOpen ? (
            <EvidenceReplay
              session={replay.session}
              displayTimeZone={displayTimeZone}
              getBatch={replay.getBatch}
              signalLabel={(bandId) => bandId === record.bandId ? record.affectedLabel ?? record.bandLabel : replay.signalLabel(bandId)}
              startAt={new Date(Date.parse(record.startedAt) - REPLAY_LEAD_IN_MS).toISOString()}
              focusTargetId={record.targetId}
              focusBandId={record.targetId ? undefined : record.bandId}
              onClose={() => setReplayOpen(false)}
            />
          ) : null}

          {record ? (
            <section className="incident-section" aria-labelledby="incident-timeline">
              <h3 id="incident-timeline">Timeline</h3>
              <ol className="incident-timeline">
                {timeline.map((entry, index) => (
                  <li key={`${entry.code}-${entry.at}-${index}`} className={`timeline-${entry.code}`}>
                    <time dateTime={entry.at}>{clock(entry.at)}</time>
                    <strong>{timelineLabel(entry.code)}</strong>
                    {entry.detail ? <span>{entry.detail}</span> : null}
                  </li>
                ))}
              </ol>
            </section>
          ) : null}

          {record ? (
            <section className="incident-section" aria-labelledby="incident-notes">
              <h3 id="incident-notes">Notes</h3>
              {record.notes.length ? (
                <ul className="incident-notes">
                  {record.notes.map((note) => <li key={note.id}><time dateTime={note.timestamp}>{clock(note.timestamp)}</time><p>{note.text}</p></li>)}
                </ul>
              ) : <p className="incident-muted">{synthetic ? "Test records take no notes." : "No notes yet. Add what you checked and what you saw."}</p>}
            </section>
          ) : null}

          <div className="incident-section">
            <strong>Evidence</strong>
            <p><span className={`action-dot ${synthetic || (!archived && live && !recordingOk) ? "alert" : "clear"}`} />{synthetic ? "Test data only. Not part of field evidence." : archived || !live ? "Recorded spectrum, trigger snapshot, timeline, notes and report, with SHA-256 checks." : recordingOk ? "Recording on." : `${presentation.recording}. Open Recording before downloading.`}</p>
            {downloadFiles?.length ? (
              <div className="package-hash">
                {downloadFiles.map((file) => (
                  <div key={file.filename}>
                    <span>{file.filename}</span>
                    {file.sha256 ? <code title="SHA-256 of the downloaded file">SHA-256 {file.sha256}</code> : null}
                    {file.sha256 && onCopy ? <button type="button" className="link-button" onClick={() => void onCopy(file.sha256!)}><ClipboardCopy size={13} aria-hidden="true" /> Copy</button> : null}
                  </div>
                ))}
              </div>
            ) : null}
          </div>

          <div className="incident-action-bar" role="group" aria-label="Incident actions">
            <button className="button secondary" type="button" onClick={onAddNote} disabled={!record || synthetic}><FileText size={15} aria-hidden="true" /> Add note</button>
            <button className="button secondary" type="button" onClick={onOpenAnalysis} disabled={!onOpenAnalysis || !record || synthetic} aria-label="Incident report" title="Incident report"><LineChart size={15} aria-hidden="true" /> Report</button>
            <button className="button secondary" type="button" onClick={onExport} disabled={!canDownload || exporting} aria-label={synthetic ? "Test record only" : "Download evidence package"} title="Download evidence package"><Download size={15} aria-hidden="true" /> {exporting ? "Preparing…" : "Package"}</button>
            <button className={`button ${!reviewed && !synthetic && record ? "primary" : "secondary"}`} type="button" onClick={onAcknowledge} disabled={!record || reviewed || synthetic}><Check size={15} aria-hidden="true" /> {reviewLabel}</button>
          </div>

          {record ? (
            <details className="incident-technical">
              <summary>Technical details</summary>
              <dl>
                <IncidentFact label="Incident ID" value={record.id} mono />
                <IncidentFact label="Rule" value={`${record.kind}${record.detailKind ? ` / ${record.detailKind}` : ""}`} mono />
                {trigger ? <IncidentFact label="Measured" value={`peak ${trigger.measured.peakZ}σ, middle ${trigger.measured.medianZ}σ, share ${(trigger.measured.occupancyRatio * 100).toFixed(1)}%, widest ${(trigger.measured.widestSegmentRatio * 100).toFixed(1)}%`} mono /> : null}
                {trigger?.measured.peakFrequencyHz ? <IncidentFact label="Peak" value={`${(trigger.measured.peakFrequencyHz / 1e6).toFixed(4)} MHz, level ${trigger.measured.peakLevel} vs usual ${trigger.measured.usualLevelAtPeak} (relative 0–255)`} mono /> : null}
                {record.peak ? <IncidentFact label="Strongest" value={`${record.peak.maxPeakZ}σ at ${clock(record.peak.maxPeakZAt)}`} mono /> : null}
                {trigger ? <IncidentFact label="Policy" value={`${alertPresetLabel(trigger.policy.choice)} · ${trigger.classifierVersion} · ${trigger.policy.hash.slice(0, 16)}`} mono /> : null}
                {trigger ? <IncidentFact label="Reference" value={`${trigger.reference.lifecycle} · generation ${trigger.reference.generationId}`} mono /> : null}
                {record.endReason && endReason !== record.endReason ? <IncidentFact label="End code" value={record.endReason} mono /> : null}
                <IncidentFact label="Rule set" value={record.ruleSetId} mono />
                <IncidentFact label="Baseline" value={record.baselineId ?? record.baselineFingerprintId.slice(0, 24)} mono />
                <IncidentFact label="Evidence basis" value={record.evidenceBasis} />
              </dl>
            </details>
          ) : null}
          {record && figureOpen ? <TriggerFigureDialog event={record} affected={affected} snapshotBase={snapshotBase} onClose={() => setFigureOpen(false)} /> : null}
        </>
      )}
    </section>
  );
}

/** The trigger picture at full size, whole window or zoomed on the disturbed frequencies. */
function TriggerFigureDialog({ event, affected, snapshotBase, onClose }: { event: DetectionEvent; affected?: string; snapshotBase: string; onClose: () => void }) {
  const [range, setRange] = useState<"window" | "disturbed">("disturbed");
  return (
    <DialogShell backdropClassName="report-backdrop" dialogClassName="report-dialog trigger-dialog" labelledBy="trigger-dialog-title" onClose={onClose}>
      <header className="report-dialog-header">
        <div>
          <span>{incidentReference(event)}</span>
          <strong id="trigger-dialog-title">At the alert · {affected ?? event.bandLabel}</strong>
        </div>
        <div className="report-dialog-actions">
          <div className="trigger-dialog-range" role="group" aria-label="Frequency range">
            <button type="button" aria-pressed={range === "disturbed"} onClick={() => setRange("disturbed")}>Disturbed area</button>
            <button type="button" aria-pressed={range === "window"} onClick={() => setRange("window")}>Whole window</button>
          </div>
          <button type="button" className="report-dialog-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
      </header>
      <div className="trigger-dialog-body">
        <img src={`${snapshotBase}${range === "disturbed" ? "?range=disturbed" : ""}`} alt={`Spectrum when the alert was raised: ${whyAlertSentence(event)}`} />
      </div>
    </DialogShell>
  );
}

/** Keep the full server record in step with the live summary without over-fetching. */
function useFullIncident(event: DetectionEvent | undefined, getEvent?: (eventId: string, sessionId?: string) => Promise<DetectionEvent>): DetectionEvent | undefined {
  const [full, setFull] = useState<DetectionEvent>();
  const lastFetch = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const inFlight = useRef<string | undefined>(undefined);
  const wantedId = useRef<string | undefined>(undefined);
  wantedId.current = event?.id;
  const signature = event ? `${event.id}|${event.lifecycle}|${event.notes.length}|${event.acknowledgedAt ?? ""}|${event.timeline?.at(-1)?.at ?? ""}|${event.lastSeenAt}` : "";
  useEffect(() => {
    if (!event || !getEvent) {
      setFull(undefined);
      return;
    }
    const structural = signature.split("|").slice(0, 5).join("|");
    const now = Date.now();
    // Live updates arrive several times a second. A request already on its way is
    // never cancelled by them (that left the trigger details missing); only a
    // result for an incident no longer shown is ignored.
    if (inFlight.current === structural) return;
    if (lastFetch.current.key === structural && now - lastFetch.current.at < 5_000) return;
    lastFetch.current = { key: structural, at: now };
    inFlight.current = structural;
    const eventId = event.id;
    void getEvent(eventId, event.sessionId)
      .then((record) => { if (wantedId.current === eventId && record?.id === eventId) setFull(record); })
      .catch(() => undefined)
      .finally(() => { if (inFlight.current === structural) inFlight.current = undefined; });
  }, [signature, event?.id, getEvent]);
  if (!event) return undefined;
  if (!full || full.id !== event.id) return undefined;
  // Live fields (last seen, lifecycle, notes, review) come from the newest of the two.
  return Date.parse(event.lastSeenAt) > Date.parse(full.lastSeenAt) || event.notes.length > full.notes.length || (event.acknowledgedAt && !full.acknowledgedAt)
    ? { ...full, ...event, trigger: full.trigger ?? event.trigger, timeline: (full.timeline?.length ?? 0) >= (event.timeline?.length ?? 0) ? full.timeline : event.timeline, notes: event.notes.length >= full.notes.length ? event.notes : full.notes }
    : full;
}

const STATUS_TONE: Record<string, string> = { Alert: "alert", Recovering: "recovering", Cleared: "cleared", Ended: "ended" };

/** Newest incidents, shown when nothing is active, so the Incidents button always leads somewhere. */
function RecentIncidentList({ recent, displayTimeZone, onOpen, onOpenHistory }: {
  recent: RecentIncidentsView;
  displayTimeZone: string;
  onOpen?: (event: DetectionEvent) => void;
  onOpenHistory?: () => void;
}) {
  const { incidents, error, liveIds, toReview, reviewWindowHours = 24 } = recent;
  const now = new Date();
  return (
    <section className="incident-section recent-incidents" aria-labelledby="recent-incidents-title">
      <div className="incident-section-heading">
        <h3 id="recent-incidents-title">Recent incidents</h3>
        {toReview !== undefined ? <span className={`recent-review-count ${toReview ? "pending" : "done"}`}>{toReview ? `${toReview} to review` : "All reviewed"} · last {reviewWindowHours} h</span> : null}
      </div>
      {error ? <p className="incident-muted">{error}</p>
        : !incidents ? <p className="incident-muted">Loading…</p>
          : !incidents.length ? <p className="incident-muted">No incidents recorded.</p>
            : (
              <ul className="recent-incident-list">
                {incidents.map((item) => {
                  const live = liveIds.has(item.id);
                  const status = recentIncidentStatus(item, live);
                  const review = needsReview(item);
                  return (
                    <li key={item.id}>
                      <button type="button" onClick={() => onOpen?.(item)} disabled={!onOpen}>
                        <span className={`recent-incident-status ${STATUS_TONE[status]}`}>{status}</span>
                        <span className="recent-incident-copy">
                          <strong>{item.affectedLabel ?? item.bandLabel}</strong>
                          <small>
                            {rfVerdictFor(item)} · {incidentClock(item.startedAt, displayTimeZone, now)} · {shortDuration(item.startedAt, incidentEndAt(item, live))}
                            {item.evidenceStrength ? ` · ${item.evidenceStrength} evidence` : ""}
                            {item.syntheticExercise ? " · Simulation" : ""}
                          </small>
                          {item.syntheticExercise ? null : review ? <em className="recent-incident-review pending">To review</em> : <em className="recent-incident-review done"><Check size={10} aria-hidden="true" /> Reviewed</em>}
                        </span>
                        <ChevronRight size={15} aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
      {onOpenHistory ? (
        <button type="button" className="link-button recent-incidents-more" onClick={onOpenHistory}><CalendarDays size={13} aria-hidden="true" /> All incidents in Evidence history <ChevronRight size={13} aria-hidden="true" /></button>
      ) : null}
    </section>
  );
}

function IncidentFact({ label, value, strong = false, mono = false }: { label: string; value: string; strong?: boolean; mono?: boolean }) {
  return <div className="incident-fact"><dt>{label}</dt><dd className={`${strong ? "strong" : ""}${mono ? " mono" : ""}`.trim() || undefined}>{value}</dd></div>;
}
