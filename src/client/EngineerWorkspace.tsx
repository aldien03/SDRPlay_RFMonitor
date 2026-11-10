import { Download, Gauge, RadioTower, ShieldAlert } from "lucide-react";
import { alertPresetLabel } from "../shared/alertPolicy";
import type { AlertRuleComparison, ChannelMonitorState } from "../shared/types";
import { useMemo, useState, type ReactNode } from "react";
import type { MonitorFeed, MonitorSnapshot, SettingsRevision, SpectrumFrame } from "../shared/types";
import type { SweepFrameState } from "./useMonitor";
import { EngineerFocus } from "./EngineerFocus";
import { SyntheticValidationPanel } from "./SyntheticValidationPanel";
import { formatFrequency } from "./format";

function downloadCsv(feed: MonitorFeed, frame: SpectrumFrame): void {
  const span = frame.endHz - frame.startHz;
  const lines = ["frequency_hz,relative_level", ...Array.from(frame.bins, (value, index) => {
    const frequency = Math.round(frame.startHz + (index / Math.max(1, frame.bins.length - 1)) * span);
    return `${frequency},${value}`;
  })];
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${feed.id}-${frame.timestamp.replaceAll(":", "-")}.csv`;
  link.click();
  URL.revokeObjectURL(link.href);
}

export function EngineerWorkspace({
  snapshot,
  sweepFrames,
  selectedFeedId,
  onSelectFeed,
  healthIndicator,
  getSettings,
  startFocus,
  stopFocus,
  startSyntheticExercise,
  stopSyntheticExercise,
  onToast,
}: {
  snapshot: MonitorSnapshot;
  sweepFrames: Record<string, SweepFrameState>;
  selectedFeedId?: string;
  onSelectFeed: (feedId: string) => void;
  healthIndicator?: ReactNode;
  getSettings: () => Promise<SettingsRevision>;
  startFocus: (bandId: string, centerHz: number | undefined, durationMs: number) => Promise<unknown>;
  stopFocus: () => Promise<unknown>;
  startSyntheticExercise: (scenarioId: string) => Promise<void>;
  stopSyntheticExercise: () => Promise<void>;
  onToast: (message: string) => void;
}) {
  const wideFeeds = snapshot.monitorFeeds.filter((feed) => feed.kind === "stitched-sweep");
  const fallback = wideFeeds[0];
  const selected = snapshot.monitorFeeds.find((feed) => feed.id === selectedFeedId) ?? fallback;
  const cycle = snapshot.sweepCycles.find((item) => item.feedId === selected?.id);
  const frame = selected?.kind === "stitched-sweep"
    ? sweepFrames[selected.id]?.frame
    : snapshot.currentFrame && selected?.targetIds.includes(snapshot.currentFrame.targetId ?? "") ? snapshot.currentFrame : undefined;
  const binWidth = frame?.bins.length ? (frame.endHz - frame.startHz) / frame.bins.length : undefined;
  const receiver = snapshot.receivers[0];
  const simulation = snapshot.operatorSummary.dataMode === "simulation";
  const physicalStateUnavailable = snapshot.operatorSummary.dataMode !== "field";
  const [marker, setMarker] = useState<number | undefined>();
  const markerLevel = useMemo(() => {
    if (!frame?.bins.length || marker === undefined) return undefined;
    const index = Math.max(0, Math.min(frame.bins.length - 1, Math.round(((marker - frame.startHz) / Math.max(1, frame.endHz - frame.startHz)) * (frame.bins.length - 1))));
    return frame.bins[index];
  }, [frame, marker]);

  return (
    <section className="engineer-workspace" aria-label="Engineer analyzer">
      <header><div><RadioTower size={20} /><div><strong>Wide survey</strong><span>Stitched sweep - not simultaneous</span></div></div>{cycle ? <b>{cycle.status === "paused" ? `Paused at ${cycle.progress}%` : cycle.lastCompletedAt ? "Sweep ready" : `Building ${cycle.progress}%`}</b> : null}</header>
      {healthIndicator}
      <label className="engineer-feed-select"><span>Range</span><select value={selected?.id ?? ""} onChange={(event) => onSelectFeed(event.target.value)}>{snapshot.monitorFeeds.map((feed) => <option key={feed.id} value={feed.id}>{feed.label} - {feed.coverageLabel}</option>)}</select></label>
      {selected ? <div className="engineer-range-grid"><Metric label="Start" value={formatFrequency(selected.startHz, 3)} /><Metric label="End" value={formatFrequency(selected.endHz, 3)} /><Metric label="Span" value={formatFrequency(selected.endHz - selected.startHz, 3)} /><Metric label="Resolution" value={binWidth ? formatFrequency(binWidth, binWidth < 100_000 ? 4 : 3) : "Waiting"} /></div> : null}
      <div className="engineer-marker-row"><label><span>Marker frequency (MHz)</span><input type="number" step="0.001" value={marker === undefined ? "" : marker / 1_000_000} onChange={(event) => setMarker(event.target.value ? Number(event.target.value) * 1_000_000 : undefined)} /></label><div><span>Relative level</span><strong>{markerLevel ?? "--"}</strong></div><button type="button" disabled={!selected || !frame} onClick={() => selected && frame && downloadCsv(selected, frame)}><Download size={16} />CSV</button></div>
      <div className="engineer-health">
        <header><ShieldAlert size={18} /><strong>Receiver path</strong></header>
        <div>
          <Stage label="USB" value={physicalStateUnavailable ? "Not tested" : receiver?.hardwareState === "present" ? "Present" : receiver?.hardwareState === "absent" ? "Absent" : "Unknown"} state={physicalStateUnavailable ? "not-tested" : receiver?.hardwareState === "present" ? "ok" : "bad"} />
          <Stage label="SDRconnect" value={physicalStateUnavailable ? "Not tested" : receiver?.transportState === "connected" ? "Connected" : receiver?.transportState === "reconnecting" ? "Reconnecting" : "Offline"} state={physicalStateUnavailable ? "not-tested" : receiver?.transportState === "connected" ? "ok" : "bad"} />
          <Stage label="RF frames" value={physicalStateUnavailable ? simulation ? "Virtual" : "Unknown" : receiver?.streamState === "live" ? "Live" : receiver?.streamState === "stalled" ? "Stalled" : "Stopped"} state={physicalStateUnavailable ? "not-tested" : receiver?.streamState === "live" ? "ok" : "bad"} />
          <Stage label="Input" value={physicalStateUnavailable ? "Not tested" : receiver?.activeAntenna?.trim() || "Checking"} state={physicalStateUnavailable ? "not-tested" : receiver?.activeAntenna?.trim() ? "ok" : "bad"} />
        </div>
        <small>{simulation ? "Simulation — hardware not tested" : physicalStateUnavailable ? "Mode unknown — hardware state not trusted" : receiver?.deviceName || "Receiver not identified"}{!physicalStateUnavailable && receiver?.apiVersion ? ` - API ${receiver.apiVersion}` : ""}</small>
      </div>
      <DetectorGaugePanel snapshot={snapshot} />
      {simulation ? <SyntheticValidationPanel activeExercise={snapshot.syntheticExercise} onShowOnDashboard={startSyntheticExercise} onStopExercise={stopSyntheticExercise} /> : null}
      <EngineerFocus snapshot={snapshot} getSettings={getSettings} startFocus={startFocus} stopFocus={stopFocus} onToast={onToast} />
      <p className="engineer-limit">RF only · Navigation impact not assessed</p>
    </section>
  );
}

function Stage({ label, value, state }: { label: string; value: string; state: "ok" | "bad" | "not-tested" }) {
  return <span className={state}><b>{label}</b><small>{value}</small></span>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function gaugeValue(rule: AlertRuleComparison, value: number): string {
  switch (rule.unit) {
    case "ratio": return `${(value * 100).toFixed(1)}%`;
    case "ms": return `${(value / 1_000).toFixed(1)} s`;
    case "checks": return String(value);
    default: return `${value.toFixed(1)}σ`;
  }
}

/**
 * Engineer view of the alert track: for each window, the latest check against
 * every alert rule (measured vs threshold) and the persistence progress.
 */
export function DetectorGaugePanel({ snapshot }: { snapshot: MonitorSnapshot }) {
  const states = snapshot.targetStates.filter((state): state is ChannelMonitorState & { gauge: NonNullable<ChannelMonitorState["gauge"]> } => Boolean(state.gauge));
  if (!states.length) return null;
  return (
    <section className="engineer-gauge" aria-labelledby="engineer-gauge-title">
      <header><Gauge size={18} aria-hidden="true" /><strong id="engineer-gauge-title">Alert rules, latest check</strong></header>
      {states.map((state) => {
        const target = snapshot.monitorTargets.find((candidate) => candidate.id === state.targetId);
        return (
          <div key={state.targetId} className="engineer-gauge-target">
            <div className="engineer-gauge-title"><strong>{target?.label ?? state.targetId}</strong><span>{alertPresetLabel(state.gauge.preset)} · {state.gauge.votes} of {state.gauge.required} raised checks{state.gauge.floorExposureMs ? ` · floor ${(state.gauge.floorExposureMs / 1_000).toFixed(1)}/${(state.gauge.floorRequiredMs / 1_000).toFixed(0)} s` : ""}</span></div>
            <table>
              <thead><tr><th scope="col">Rule</th><th scope="col">Now</th><th scope="col">Alert at</th><th scope="col">Margin</th></tr></thead>
              <tbody>
                {state.gauge.rules.map((rule) => (
                  <tr key={rule.rule} className={rule.met ? "met" : undefined}>
                    <th scope="row">{rule.label}</th>
                    <td>{gaugeValue(rule, rule.measured)}</td>
                    <td>{gaugeValue(rule, rule.threshold)}</td>
                    <td><span className="gauge-meter" aria-label={`${Math.round((rule.measured / Math.max(1e-9, rule.threshold)) * 100)}% of the alert level`}><i style={{ width: `${Math.min(100, (rule.measured / Math.max(1e-9, rule.threshold)) * 100)}%` }} /></span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}
