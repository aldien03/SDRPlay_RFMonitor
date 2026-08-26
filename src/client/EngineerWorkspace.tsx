import { Download, RadioTower, ShieldAlert } from "lucide-react";
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
