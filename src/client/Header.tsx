import { BellOff, BellRing, ChevronDown, CircleHelp, Grid2X2, Pause, Play, Radio, Settings, SlidersHorizontal, Volume2, VolumeX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { presentOperatorSummary } from "../shared/operatorSummary";
import type { MonitorSnapshot } from "../shared/types";
import type { SignalWallLayout } from "./signalWallPreferences";
import { timeOnly, timeZoneShort } from "./format";

const layouts: SignalWallLayout[] = ["1x1", "2x1", "2x2", "3x3"];

function remaining(expiresAt: string | undefined, now: number): string | undefined {
  if (!expiresAt) return undefined;
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - now) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")} left`;
}

export function Header({
  snapshot,
  layout,
  engineer,
  audioAlerts,
  popupAlerts,
  onLayout,
  onEngineer,
  onPause,
  onSettings,
  onHelp,
  onAlertOption,
}: {
  snapshot: MonitorSnapshot;
  layout: SignalWallLayout;
  engineer: boolean;
  audioAlerts: boolean;
  popupAlerts: boolean;
  onLayout: (layout: SignalWallLayout) => void;
  onEngineer: () => void;
  onPause: (paused: boolean) => Promise<void>;
  onSettings: () => void;
  onHelp: () => void;
  onAlertOption: (key: "audioAlerts" | "popupAlerts") => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const operator = presentOperatorSummary(snapshot.operatorSummary);
  const receiver = snapshot.receivers[0];
  const affectedTargetId = snapshot.operatorSummary.affectedTargets[0]?.id;
  const activeTargetId = snapshot.syntheticExercise?.targetId ?? snapshot.activeFocus?.targetId ?? affectedTargetId;
  const activeFeed = useMemo(
    () => snapshot.monitorFeeds.find((feed) => snapshot.syntheticExercise
      ? feed.targetIds.includes(snapshot.syntheticExercise.targetId)
      : snapshot.activeFocus
        ? feed.bandIds.includes(snapshot.activeFocus.bandId)
      : activeTargetId && feed.targetIds.includes(activeTargetId)),
    [activeTargetId, snapshot.activeFocus, snapshot.monitorFeeds, snapshot.syntheticExercise],
  );
  const expiresAt = snapshot.activeFocus?.expiresAt;
  const receiverName = receiver?.connection === "simulated" ? "Simulation" : receiver?.deviceName || "RSPdx";
  const receiverLine = snapshot.syntheticExercise
    ? `Simulation — ${snapshot.syntheticExercise.scenarioName} — ${activeFeed?.shortLabel ?? "L1"}`
    : snapshot.activeFocus
    ? `${receiverName} — ${activeFeed?.shortLabel ?? "Selected window"} live — ${remaining(expiresAt, now) ?? "ending"}`
    : affectedTargetId
      ? `${receiverName} — ${activeFeed?.shortLabel ?? snapshot.operatorSummary.affectedTargets[0]?.label ?? "Affected signal"}`
      : `${receiverName} — ${operator.monitoring}`;
  const statusTone = snapshot.operatorSummary.monitoring.state === "alert"
    ? "alert"
    : snapshot.operatorSummary.monitoring.state === "normal"
      ? "normal"
      : "checking";

  return (
    <header className="mission-header">
      <div className="mission-brand"><Radio size={23} aria-hidden="true" /><h1>RF Monitor</h1></div>
      <div className="mission-site"><span>{snapshot.siteName}</span><ChevronDown size={15} aria-hidden="true" /></div>
      <div className={`mission-overall ${statusTone}`} title={operator.observation}><i aria-hidden="true" /><strong>{operator.monitoring}</strong></div>
      <div className="mission-receiver" title={receiverLine}>{receiverLine}</div>
      <time className="mission-clock" dateTime={new Date(now).toISOString()}>{timeOnly(new Date(now).toISOString(), snapshot.displayTimeZone)} {timeZoneShort(snapshot.displayTimeZone, new Date(now))}</time>
      <label className="mission-layout"><Grid2X2 size={18} aria-hidden="true" /><span>View</span><select value={layout} onChange={(event) => onLayout(event.target.value as SignalWallLayout)} aria-label="Signal wall layout">{layouts.map((item) => <option key={item} value={item}>{item.replace("x", "\u00d7")}</option>)}</select><ChevronDown size={14} aria-hidden="true" /></label>
      <nav className="mission-actions" aria-label="Dashboard actions">
        <button type="button" onClick={() => void onPause(!snapshot.paused)} disabled={!snapshot.monitoringReady} aria-label={snapshot.paused ? "Resume monitoring" : "Pause monitoring"}>{snapshot.paused ? <Play size={19} aria-hidden="true" /> : <Pause size={19} aria-hidden="true" />}<span>{snapshot.paused ? "Resume" : "Pause"}</span></button>
        <button type="button" className={audioAlerts ? "selected" : ""} onClick={() => onAlertOption("audioAlerts")} aria-pressed={audioAlerts} aria-label={audioAlerts ? "Turn off alert sound" : "Turn on alert sound"}>{audioAlerts ? <Volume2 size={19} aria-hidden="true" /> : <VolumeX size={19} aria-hidden="true" />}<span>Sound</span></button>
        <button type="button" className={popupAlerts ? "selected" : ""} onClick={() => onAlertOption("popupAlerts")} aria-pressed={popupAlerts} aria-label={popupAlerts ? "Turn off alert popups" : "Turn on alert popups"}>{popupAlerts ? <BellRing size={19} aria-hidden="true" /> : <BellOff size={19} aria-hidden="true" />}<span>Popup</span></button>
        <button type="button" className={engineer ? "selected" : ""} onClick={onEngineer} aria-label={engineer ? "Close engineer tools" : "Open engineer tools"} aria-pressed={engineer} aria-expanded={engineer}><SlidersHorizontal size={19} aria-hidden="true" /><span>Engineer</span></button>
        <button type="button" onClick={onHelp} aria-label="Open help"><CircleHelp size={20} aria-hidden="true" /><span>Help</span></button>
        <button type="button" onClick={onSettings} aria-label="Open settings"><Settings size={20} aria-hidden="true" /><span>Settings</span></button>
      </nav>
    </header>
  );
}
