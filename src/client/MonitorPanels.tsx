import { useEffect, useState } from "react";
import {
  Check,
  Camera,
  ChevronRight,
  Download,
  FileText,
  Pause,
  Play,
  RadioTower,
  RefreshCw,
  Satellite,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { presentOperatorSummary, type OperatorSummaryV1 } from "../shared/operatorSummary";
import type { DetectionEvent, MonitorSnapshot, ServiceCoverageSummary, SpectrumFrame } from "../shared/types";
import { dateTime, formatDuration, formatFrequency, formatRange, timeOnly } from "./format";
import { operatorObservationForSurface } from "./operatorViewModel";
import { disturbancePlacement, disturbancePlacementCopy } from "./detectorPresentation";
import { SpectrumView, WaterfallView } from "./SpectrumViews";

interface DisplayOptions {
  waterfall: boolean;
  baseline: boolean;
  markers: boolean;
  engineer: boolean;
}

export function MonitoringChecklist({ snapshot }: { snapshot: MonitorSnapshot }) {
  return (
    <section className="panel monitoring-panel" aria-labelledby="monitoring-title">
      <h2 id="monitoring-title" className="panel-title">Monitoring checklist</h2>
      <div className="monitoring-mode-summary">
        <span>Monitoring mode</span>
        <strong>{snapshot.mode === "hybrid" ? "Two-receiver hybrid" : "Single-receiver priority scan"}</strong>
        <small>Estimated full revisit: {formatRevisit(snapshot.configuration.estimatedRevisitMs)}</small>
      </div>
      <div className="monitor-card-list">
        {snapshot.services.map((service) => <ServiceMonitorCard key={service.service} snapshot={snapshot} summary={service} />)}
      </div>
    </section>
  );
}

function ServiceMonitorCard({
  snapshot,
  summary,
}: {
  snapshot: MonitorSnapshot;
  summary: ServiceCoverageSummary;
}) {
  const bandIds = new Set(snapshot.bands.filter((band) => band.service === summary.service).map((band) => band.id));
  const active = snapshot.monitoringReady && snapshot.receivers.some((receiver) => receiver.activeBandId && bandIds.has(receiver.activeBandId));
  const dedicatedReceiver = snapshot.monitoringReady && summary.enabled && summary.service === "gnss" && snapshot.mode === "hybrid";
  const isConnected = snapshot.monitoringReady;
  const disabled = !summary.enabled;
  return (
    <article className={`monitor-card ${active || dedicatedReceiver ? "selected" : ""} ${disabled ? "disabled" : ""}`}>
      <div className="monitor-card-main">
        <div className="service-icon">{summary.service === "gnss" ? <Satellite size={27} /> : <RadioTower size={29} />}</div>
        <div className="service-copy"><strong>{summary.label}</strong><span>{summary.coverageLabel}</span></div>
        <span className={`queue-label ${dedicatedReceiver ? "continuous" : active ? "active" : "queued"}`}>
          {disabled ? "Disabled" : !snapshot.monitoringReady ? "No RF data" : dedicatedReceiver ? "Dedicated GNSS scan" : active ? "Scanning now" : "Sweep queued"}
        </span>
      </div>
      <div className="monitor-card-meta">
        <div><span>Status</span><strong>{disabled ? "Not selected" : !snapshot.monitoringReady ? "Not monitored" : active || dedicatedReceiver ? "Monitoring" : "Waiting in queue"}</strong></div>
        <div><span>{active ? "Stream" : "Revisit"}</span><strong className={isConnected && !disabled ? "live-text" : "danger-text"}>{disabled ? "Off" : !snapshot.monitoringReady ? "No RF data" : active ? "● Live" : formatRevisit(summary.estimatedRevisitMs)}</strong></div>
      </div>
    </article>
  );
}

function formatRevisit(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return "Continuous";
  if (milliseconds < 60_000) return `${Math.max(1, Math.round(milliseconds / 1_000))} sec`;
  return `${Math.round(milliseconds / 60_000)} min`;
}

export function StatusBanner({ snapshot }: { snapshot: MonitorSnapshot }) {
  const event = snapshot.activeEvent;
  const clear = !event;
  const unavailable = !snapshot.monitoringReady && !event;
  return (
    <section className={`status-banner ${unavailable ? "unavailable" : clear ? "clear" : event.status}`} aria-live="polite">
      <div className="status-main">
        {clear && !unavailable ? <ShieldCheck size={48} /> : <TriangleAlert size={51} />}
        <div><h1>{unavailable ? "OFFLINE" : clear ? "NORMAL" : event.status === "suspicious" ? "CHECKING" : "ALERT"}</h1><p>{unavailable ? snapshot.monitoringIssue : clear ? "Recent scans look normal" : "Signal above normal"}</p></div>
      </div>
      <StatusFact label="Affected band" value={unavailable ? "Unknown" : event ? formatRange(...event.affectedRangeHz) : "None"} detail={unavailable ? "No live RF data" : event ? event.bandLabel : "All monitored services"} />
      <StatusFact label="Evidence" value={unavailable ? "Unavailable" : event ? event.evidenceStrength : "None"} detail={unavailable ? "No live RF data" : event ? event.evidenceBasis : "No active incident"} />
      <StatusFact label="Since" value={event ? timeOnly(event.startedAt, snapshot.displayTimeZone) : snapshot.lastUpdatedAt ? timeOnly(snapshot.lastUpdatedAt, snapshot.displayTimeZone) : "Waiting"} detail={event ? `(${formatDuration(event.startedAt)})` : unavailable ? "Connect receiver" : "Last spectrum frame"} />
    </section>
  );
}

function StatusFact({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="status-fact"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

export function SpectrumPanel({
  snapshot,
  options,
  onPause,
  onStopFocus,
}: {
  snapshot: MonitorSnapshot;
  options: DisplayOptions;
  onPause: (paused: boolean) => Promise<void>;
  onStopFocus: () => Promise<unknown>;
}) {
  const frame = snapshot.currentFrame;
  const band = snapshot.bands.find((candidate) => candidate.id === frame?.bandId);
  const metrics = snapshot.currentMetrics;
  const event = snapshot.activeEvent;
  const heldIncidentEvidence = Boolean(snapshot.activeEvent && snapshot.receivers.every((receiver) => receiver.activeBandId !== snapshot.activeEvent?.bandId));
  return (
    <section className="panel spectrum-panel" aria-labelledby="spectrum-title">
      {snapshot.activeFocus ? <FocusBanner focus={snapshot.activeFocus} timeZone={snapshot.displayTimeZone} onStop={onStopFocus} /> : null}
      <div className="spectrum-heading">
        <h2 id="spectrum-title" className="panel-title">Live spectrum <span>{band?.label ?? "Waiting for receiver"}{frame ? ` · ${formatRange(frame.startHz, frame.endHz)}` : ""}</span></h2>
        <div className="live-controls">
          <span className={`live-indicator ${!snapshot.monitoringReady ? "unavailable" : frame?.source === "simulation" ? "simulated" : ""}`}>● {heldIncidentEvidence ? "Held evidence" : !snapshot.monitoringReady ? "No RF data" : frame?.source === "simulation" ? "Simulated" : "Live"}</span>
          <button className="button compact secondary" type="button" onClick={() => void onPause(!snapshot.paused)} disabled={!snapshot.monitoringReady}>
            {snapshot.paused ? <Play size={16} /> : <Pause size={16} />}
            {snapshot.paused ? "Resume" : "Pause"}
          </button>
        </div>
      </div>
      <div className="chart-label-row">
        <div><strong>Signal activity</strong><small>Relative level from 0 to 255 · higher means stronger · not calibrated dBm</small></div>
        <span className="chart-current-level">Current peak <strong>{metrics ? `${metrics.peakLevel.toFixed(0)} / 255` : "--"}</strong></span>
      </div>
      <div className="aligned-plot-grid">
        <div className="relative-level-axis" aria-hidden="true"><span>255</span><span>191</span><span>128</span><span>64</span><span>0</span></div>
        <div className="chart-stage">
          {options.markers && snapshot.activeEvent ? <div className="chart-callout spike">Signal above normal</div> : null}
          {options.markers && snapshot.activeEvent?.kind === "wideband-noise-rise" ? <div className="chart-callout noise">Wide area above normal</div> : null}
          <SpectrumView frame={frame} metrics={metrics} showBaseline={options.baseline} showMarkers={options.markers} />
        </div>
        <span aria-hidden="true" />
      </div>
      <FrequencyAxis startHz={frame?.startHz} endHz={frame?.endHz} />
      <div className="spectrum-legend" aria-label="How to read the spectrum">
        <span><i className="legend-line received" aria-hidden="true" />Blue: received activity</span>
        {options.baseline ? <span><i className="legend-line baseline" aria-hidden="true" />Green dashed: usual background</span> : null}
        <span><i className="legend-line unusual" aria-hidden="true" />Red: above normal</span>
      </div>
      {options.waterfall ? (
        <>
          <div className="waterfall-heading"><strong>Signal history</strong><span>Each row is one scan. Newest activity is at the top.</span></div>
          <div className="waterfall-wrap"><span className="waterfall-time">New<br /><small>↓ older</small></span><WaterfallView frames={snapshot.waterfall} /><span aria-hidden="true" /></div>
          <FrequencyAxis startHz={frame?.startHz} endHz={frame?.endHz} />
          <div className="intensity-key"><span>Quiet</span><div className="intensity-ramp" aria-hidden="true" /><span>Strong</span></div>
        </>
      ) : null}
    </section>
  );
}

export function MonitorControlStrip({
  snapshot,
  onPause,
  onSnapshot,
}: {
  snapshot: MonitorSnapshot;
  onPause: (paused: boolean) => Promise<void>;
  onSnapshot: () => void;
}) {
  const frame = snapshot.currentFrame;
  const band = snapshot.bands.find((candidate) => candidate.id === frame?.bandId);
  const metrics = snapshot.currentMetrics;
  return (
    <section className="monitor-control-strip" aria-label="Current scan controls">
      <div className="control-primary"><span>Monitoring</span><strong>{band?.label ?? "Waiting for live RF"}</strong><small>{band ? snapshot.services.find((item) => item.service === band.service)?.label : snapshot.configuration.scanProfile === "gnss-priority" ? "GNSS priority" : "Priority scan"}</small></div>
      <div><span>Frequency span</span><strong>{frame ? formatRange(frame.startHz, frame.endHz) : "Not available"}</strong></div>
      <div><span>Current peak</span><strong>{metrics ? `${metrics.peakLevel.toFixed(0)} / 255 relative` : "—"}</strong></div>
      <div><span>Updates</span><strong>{snapshot.paused ? "Paused" : "Live"}</strong></div>
      <div className="control-actions">
        <button className="button compact secondary" type="button" onClick={() => void onPause(!snapshot.paused)} disabled={!snapshot.monitoringReady}>{snapshot.paused ? <Play size={16} /> : <Pause size={16} />}{snapshot.paused ? "Resume" : "Pause"}</button>
        <button className="button compact secondary" type="button" onClick={onSnapshot} disabled={!snapshot.activeEvent}><Camera size={16} />Snapshot</button>
      </div>
    </section>
  );
}

export function OperationsRail({
  snapshot,
  selectedEventId,
  onSelect,
  onRetry,
}: {
  snapshot: MonitorSnapshot;
  selectedEventId?: string;
  onSelect: (id: string) => void;
  onRetry: () => void;
}) {
  const receiver = snapshot.receivers[0];
  const active = snapshot.activeEvent;
  const interpretation = !snapshot.monitoringReady
    ? { tone: "offline", title: "No live RF data", detail: snapshot.monitoringIssue ?? "The receiver stopped sending data.", action: receiver?.hardwareState === "absent" ? "Reconnect the SDRplay USB cable." : "Press Retry if data does not return within 30 seconds." }
    : active
      ? { tone: "alert", title: "Signal above normal", detail: active.observed, action: active.recommendedAction }
      : { tone: "clear", title: "Normal", detail: "Recent scans look normal.", action: "None." };
  return (
    <aside className="operations-rail" aria-label="Operator status and recent incidents">
      <section className={`rail-card receiver-card ${snapshot.monitoringReady ? "healthy" : "offline"}`}>
        <header><div><span className="rail-eyebrow">Receiver</span><strong>{snapshot.monitoringReady ? "Live RF stream" : "Connection issue"}</strong></div><span className="state-pill">{receiver?.streamState ?? "stopped"}</span></header>
        <div className="receiver-stages"><span className={receiver?.hardwareState === "present" ? "done" : "failed"}>USB hardware</span><span className={receiver?.transportState === "connected" ? "done" : "waiting"}>SDRconnect</span><span className={receiver?.streamState === "live" ? "done" : "waiting"}>RF frames</span></div>
        {!snapshot.monitoringReady ? <button className="button retry-button" type="button" onClick={onRetry} disabled={receiver?.recoveryState === "requested" || receiver?.recoveryState === "recovering"}><RefreshCw size={16} />{receiver?.recoveryState === "requested" || receiver?.recoveryState === "recovering" ? "Recovery started" : "Retry receiver"}</button> : null}
      </section>
      <section className={`rail-card interpretation-card ${interpretation.tone}`} aria-live="polite">
        <span className="rail-eyebrow">Status</span><strong>{interpretation.title}</strong><p>{interpretation.detail}</p><div><b>Action</b><span>{interpretation.action}</span></div>
        <small>RF data can show interference, not intent.</small>
      </section>
      <section className="rail-card rail-incidents">
        <header><div><span className="rail-eyebrow">Recent incidents</span><strong>{snapshot.events.length ? `${snapshot.events.length} recorded` : "No incidents"}</strong></div></header>
        <div className="rail-incident-list">
          {snapshot.events.slice(0, 5).map((item) => <button key={item.id} className={selectedEventId === item.id ? "selected" : ""} type="button" onClick={() => onSelect(item.id)}><i className={`table-status-dot ${item.status}`} /><span><strong>{item.affectedLabel ?? snapshot.services.find((service) => service.service === item.service)?.label ?? item.bandLabel}</strong><small>{timeOnly(item.startedAt, snapshot.displayTimeZone)} / {item.evidenceStrength} evidence</small></span><ChevronRight size={16} /></button>)}
          {!snapshot.events.length ? <p className="rail-empty">No incidents recorded.</p> : null}
        </div>
      </section>
    </aside>
  );
}

function FocusBanner({
  focus,
  timeZone,
  onStop,
}: {
  focus: NonNullable<MonitorSnapshot["activeFocus"]>;
  timeZone: string;
  onStop: () => Promise<unknown>;
}) {
  const [secondsLeft, setSecondsLeft] = useState(() => Math.max(0, Math.ceil((Date.parse(focus.expiresAt) - Date.now()) / 1_000)));
  useEffect(() => {
    const update = () => setSecondsLeft(Math.max(0, Math.ceil((Date.parse(focus.expiresAt) - Date.now()) / 1_000)));
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [focus.expiresAt]);
  const minutes = Math.floor(secondsLeft / 60);
  const seconds = String(secondsLeft % 60).padStart(2, "0");
  return (
    <div className="focus-banner" role="status">
      <div>
        <strong>Checking: {focus.label}</strong>
        <span>Full scanning resumes in {minutes}:{seconds} at {timeOnly(focus.expiresAt, timeZone)}</span>
      </div>
      <button className="button compact secondary" type="button" onClick={() => void onStop()}>Resume monitoring</button>
    </div>
  );
}

function FrequencyAxis({ startHz, endHz }: { startHz?: number; endHz?: number }) {
  const labels = !startHz || !endHz
    ? Array.from({ length: 7 }, () => "--")
    : Array.from({ length: 7 }, (_, index) => formatFrequency(startHz + ((endHz - startHz) * index) / 6, endHz - startHz < 30_000_000 ? 3 : 1).replace(" MHz", ""));
  return (
    <div className="frequency-axis">
      <span aria-hidden="true" />
      <div className="frequency-axis-track">{labels.map((label, index) => <span key={index}>{label}</span>)}</div>
      <strong>MHz</strong>
    </div>
  );
}

function PanoramaView({ snapshot }: { snapshot: MonitorSnapshot }) {
  const segments = snapshot.panorama;
  return (
    <section className="panorama-panel" aria-labelledby="panorama-title">
      <div className="panorama-heading"><div><strong id="panorama-title">Wide scan panorama</strong><span>Latest confirmed window observations — segments are not simultaneous.</span></div><small>{segments.length} observed windows</small></div>
      {segments.length ? <div className="panorama-grid">{segments.map((segment) => {
        const step = Math.max(1, Math.ceil(segment.bins.length / 80));
        const sampled = Array.from(segment.bins).filter((_value, index) => index % step === 0);
        const points = sampled.map((value, index, values) => `${(index / Math.max(1, values.length - 1)) * 100},${32 - (value / 255) * 30}`).join(" ");
        const ageLabel = segment.ageMs < 1_000 ? "now" : segment.ageMs < 60_000 ? `${Math.round(segment.ageMs / 1_000)}s old` : `${Math.round(segment.ageMs / 60_000)}m old`;
        return <article className={`panorama-segment ${segment.stale ? "stale" : ""}`} key={segment.id}><header><strong>{formatRange(segment.startHz, segment.endHz)}</strong><span>{ageLabel}</span></header><svg viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label={`Relative spectrum observed ${ageLabel}`}><polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.2" vectorEffect="non-scaling-stroke" /></svg><footer>{segment.bandId}</footer></article>;
      })}</div> : <div className="panorama-empty">No confirmed scan windows yet.</div>}
    </section>
  );
}

function EngineerDetails({ snapshot }: { snapshot: MonitorSnapshot }) {
  const metrics = snapshot.currentMetrics;
  return (
    <div className="engineer-details" aria-label="Engineer details">
      <Metric label="Mean bin" value={metrics ? metrics.meanLevel.toFixed(1) : "--"} />
      <Metric label="Peak bin" value={metrics ? metrics.peakLevel.toFixed(0) : "--"} />
      <Metric label="Baseline delta" value={metrics ? `${metrics.baselineDelta >= 0 ? "+" : ""}${metrics.baselineDelta.toFixed(1)}` : "--"} />
      <Metric label="Occupied" value={metrics ? `${Math.round(metrics.occupiedRatio * 100)}%` : "--"} />
      <Metric label="SDRconnect reported value" value={metrics?.vendorReportedSignalPower === undefined ? "Not supplied" : `${metrics.vendorReportedSignalPower.toFixed(1)} — uncalibrated`} />
      <Metric label="SNR" value={metrics?.snrDb === undefined ? "Not supplied" : `${metrics.snrDb.toFixed(1)} dB`} />
      <Metric label="Overload" value={metrics?.overload ? "Yes" : "No"} />
      <Metric label="Raw frame" value={snapshot.currentFrame ? snapshot.currentFrame.id.slice(0, 8) : "--"} />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="metric-cell"><span>{label}</span><strong>{value}</strong></div>;
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
