import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronDown,
  ChevronUp,
  Maximize2,
  Pin,
  Plus,
  SatelliteDish,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { SIGNAL_STATE_COPY, signalStateForTargets } from "../shared/monitorGroups";
import type {
  ChannelMonitorState,
  GroupSignalState,
  MonitorFeed,
  MonitorSnapshot,
  MonitorTarget,
  SignalMetricSample,
  SpectrumFrame,
  SweepCycle,
} from "../shared/types";
import type { DisplayOptions } from "./BottomPanels";
import type { SweepFrameState, TargetFrameState } from "./useMonitor";
import { formatFrequency } from "./format";
import { SpectrumView, WaterfallView } from "./SpectrumViews";
import { detectorBaselineAvailable } from "./detectorPresentation";
import { SIGNAL_WALL_CAPACITY, type SignalWallLayout } from "./signalWallPreferences";
import { preferencesForWall, surfacedVisibleFeedIds } from "./feedVisibility";
import { operatorObservationForSurface, operatorObservationMatchesTargets } from "./operatorViewModel";
import { authoritativeTargetStates, targetObservationAt } from "./targetPresentation";
import { DialogShell } from "./DialogShell";

function ageLabel(timestamp: string | undefined, now: number): string {
  if (!timestamp) return "Not checked";
  const seconds = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1_000));
  if (seconds < 2) return "<1 s ago";
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.floor(minutes / 60)} h ago`;
}

function countdown(timestamp: string | undefined, now: number): string | undefined {
  if (!timestamp) return undefined;
  const seconds = Math.max(0, Math.ceil((Date.parse(timestamp) - now) / 1_000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function traceFrame(current: SpectrumFrame | undefined, history: SpectrumFrame[], mode: DisplayOptions["traceMode"]): SpectrumFrame | undefined {
  if (!current || mode === "current") return current;
  const aligned = history.filter((frame) => frame.startHz === current.startHz && frame.endHz === current.endHz && frame.bins.length === current.bins.length).slice(-12);
  if (!aligned.length) return current;
  const bins = current.bins.map((_value, index) => {
    const values = aligned.map((frame) => frame.bins[index]);
    return mode === "peak" ? Math.max(...values) : Math.round(values.reduce((total, value) => total + value, 0) / values.length);
  });
  // A composite trace is not one detector observation. Suppress detector
  // presentation metadata instead of painting the current verdict onto it.
  return { ...current, id: `${current.id}-${mode}`, bins, detectorAnalysis: undefined };
}

export function metricsForFrame(frame: SpectrumFrame | undefined, supplied: SignalMetricSample | undefined): SignalMetricSample | undefined {
  if (!frame?.bins.length || !supplied || supplied.bandId !== frame.bandId) return undefined;
  return supplied;
}

export function signalStateForFeed(input: {
  summary: MonitorSnapshot["operatorSummary"];
  targetIds: readonly string[];
  measured: GroupSignalState;
  currentAvailable: boolean;
  unavailable: boolean;
}): GroupSignalState {
  const canonicalAffected = operatorObservationMatchesTargets(input.summary, input.targetIds);
  if (canonicalAffected && (input.summary.monitoring.state === "alert" || input.summary.monitoring.state === "recovering")) {
    return input.summary.monitoring.state;
  }
  return !input.currentAvailable && !input.unavailable ? "checking" : input.measured;
}

export interface FeedMetricReadout {
  /** Short chips rendered left to right under the chart heading. */
  chips: string[];
  /** True when the receiver was saturated, so level chips are not meaningful. */
  overload: boolean;
}

export function feedMetricReadout(input: {
  frame: SpectrumFrame | undefined;
  metrics: SignalMetricSample | undefined;
  baselineAvailable: boolean;
  off: boolean;
  unavailable: boolean;
}): FeedMetricReadout | undefined {
  if (input.off || input.unavailable || !input.frame || !input.metrics) return undefined;
  const metrics = input.metrics;
  if (metrics.overload) return { chips: ["Receiver overloaded"], overload: true };
  const chips = [`Peak ${Math.round(metrics.peakLevel)}/255`];
  if (input.baselineAvailable) chips.push(`${metrics.baselineDelta >= 0 ? "+" : "−"}${Math.abs(Math.round(metrics.baselineDelta))} vs usual`);
  chips.push(`Busy ${Math.round(metrics.occupiedRatio * 100)}%`);
  return { chips, overload: false };
}

function feedTarget(feed: MonitorFeed, targets: MonitorTarget[]): MonitorTarget | undefined {
  return targets.find((target) => target.id === feed.focusTargetId)
    ?? targets.find((target) => feed.targetIds.includes(target.id));
}

export function SignalWall({
  snapshot,
  targetFrames,
  sweepFrames,
  layout,
  pinnedFeedIds,
  selectedFeedId,
  options,
  onManage,
  onSelect,
  onInspect,
  onRequestFocus,
  onStopExercise,
}: {
  snapshot: MonitorSnapshot;
  targetFrames: Record<string, TargetFrameState>;
  sweepFrames: Record<string, SweepFrameState>;
  layout: SignalWallLayout;
  pinnedFeedIds: string[];
  selectedFeedId?: string;
  options: DisplayOptions;
  onManage: () => void;
  onSelect: (feedId: string) => void;
  onInspect: (feedId: string) => void;
  onRequestFocus: (feed: MonitorFeed) => void;
  onStopExercise: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const feedMap = useMemo(() => new Map(snapshot.monitorFeeds.map((feed) => [feed.id, feed])), [snapshot.monitorFeeds]);
  const ids = surfacedVisibleFeedIds({
    preferences: preferencesForWall(layout, pinnedFeedIds, selectedFeedId),
    feeds: snapshot.monitorFeeds,
    affectedTargetIds: snapshot.operatorSummary.affectedTargets.map((target) => target.id),
    syntheticTargetId: snapshot.syntheticExercise?.targetId,
  });
  const slots = Array.from({ length: SIGNAL_WALL_CAPACITY[layout] }, (_, index) => ids[index]);

  return (
    <section className="mission-wall" data-layout={layout} aria-label="Pinned monitoring feeds">
      {slots.map((feedId, index) => {
        const feed = feedId ? feedMap.get(feedId) : undefined;
        return feed ? (
          <SignalFeedCard
            key={feed.id}
            feed={feed}
            snapshot={snapshot}
            targetFrames={targetFrames}
            sweepFrames={sweepFrames}
            options={options}
            now={now}
            selected={feed.id === selectedFeedId}
            compact={layout === "3x3"}
            onSelect={() => onSelect(feed.id)}
            onInspect={() => onInspect(feed.id)}
            onRequestFocus={() => onRequestFocus(feed)}
            onStopExercise={onStopExercise}
          />
        ) : <EmptyFeed key={`empty-${index}`} onAdd={onManage} />;
      })}
    </section>
  );
}

function SignalFeedCard({
  feed,
  snapshot,
  targetFrames,
  sweepFrames,
  options,
  now,
  selected,
  compact,
  onSelect,
  onInspect,
  onRequestFocus,
  onStopExercise,
}: {
  feed: MonitorFeed;
  snapshot: MonitorSnapshot;
  targetFrames: Record<string, TargetFrameState>;
  sweepFrames: Record<string, SweepFrameState>;
  options: DisplayOptions;
  now: number;
  selected: boolean;
  compact: boolean;
  onSelect: () => void;
  onInspect: () => void;
  onRequestFocus: () => void;
  onStopExercise: () => void;
}) {
  const exercise = snapshot.syntheticExercise && feed.targetIds.includes(snapshot.syntheticExercise.targetId)
    ? snapshot.syntheticExercise
    : undefined;
  const target = exercise
    ? snapshot.monitorTargets.find((candidate) => candidate.id === exercise.targetId) ?? feedTarget(feed, snapshot.monitorTargets)
    : feedTarget(feed, snapshot.monitorTargets);
  const targetData = target ? targetFrames[target.id] : undefined;
  const sweep = snapshot.sweepCycles.find((cycle) => cycle.feedId === feed.id);
  const sweepData = sweepFrames[feed.id];
  const states = authoritativeTargetStates(snapshot.targetStates, targetFrames);
  const measuredSignalState = signalStateForTargets(feed.targetIds, states);
  const canonicalAffected = operatorObservationMatchesTargets(snapshot.operatorSummary, feed.targetIds);
  const activeTargetId = snapshot.activeFocus?.targetId;
  const isLive = Boolean(
    exercise
      ? true
      : snapshot.activeFocus
      ? feed.bandIds.includes(snapshot.activeFocus.bandId)
      : activeTargetId && feed.targetIds.includes(activeTargetId),
  );
  const current = feed.kind === "stitched-sweep" && !isLive ? sweepData?.frame : targetData?.frame;
  const history = feed.kind === "stitched-sweep" && !isLive ? sweepData?.waterfall ?? [] : targetData?.waterfall ?? [];
  const frame = traceFrame(current, history, options.traceMode);
  const metrics = metricsForFrame(frame, feed.kind === "stitched-sweep" && !isLive ? sweepData?.metrics : targetData?.metrics);
  // A pinned feed whose service is switched off in Monitoring stays on the wall
  // and says so, rather than silently reporting Scanning over an empty plot.
  const off = !feed.enabled;
  const exclusive = Boolean(snapshot.activeFocus);
  const feedObservedAt = feed.kind === "stitched-sweep" && !isLive
    ? sweep?.lastCompletedAt
    : targetObservationAt(feed.targetIds, states);
  const canonicalObservation = operatorObservationForSurface(snapshot.operatorSummary, "card");
  const lastObservedAt = canonicalAffected ? canonicalObservation.at ?? undefined : feedObservedAt;
  const lastObservedAge = canonicalAffected ? canonicalObservation.ageLabel : ageLabel(feedObservedAt, now);
  const resumeAt = snapshot.activeFocus?.expiresAt;
  const nextDueAt = feed.targetIds
    .map((targetId) => snapshot.monitorTargets.find((candidate) => candidate.id === targetId)?.nextDueAt)
    .filter((value): value is string => Boolean(value))
    .sort()[0];
  const protectingGnss = snapshot.configuration.scanProfile === "fast-gnss"
    && feed.targetIds.length > 0
    && feed.targetIds.every((targetId) => snapshot.monitorTargets.find((item) => item.id === targetId)?.coverageMode === "paused");
  const paused = snapshot.paused || (exclusive && !isLive) || protectingGnss;
  const unavailable = !snapshot.monitoringReady;
  const stale = !paused && !unavailable && feed.targetIds.every((targetId) => snapshot.monitorTargets.find((item) => item.id === targetId)?.coverageMode === "stale");
  const coverageLabel = exercise
    ? "Simulation"
    : off
    ? "Off"
    : unavailable
    ? "Offline"
    : isLive
      ? "Live"
      : paused
        ? protectingGnss ? "Paused — protecting GNSS" : "Paused"
        : stale
          ? "Data late"
          : feed.priority && snapshot.configuration.scanProfile === "gnss-priority"
            ? "Scanning — priority"
            : "Scanning";
  const liveAge = isLive ? lastObservedAge : undefined;
  const resume = paused ? countdown(resumeAt, now) : undefined;
  const nextCheck = !paused && !isLive ? countdown(nextDueAt, now) : undefined;
  const progress = feed.kind === "stitched-sweep" ? sweep?.progress ?? 0 : undefined;
  // The canonical server summary remains authoritative even when dashboard
  // frames are deliberately suppressed under resource pressure. A missing
  // graph must not turn the affected card from Alert/Recovering into Checking.
  const signalState = signalStateForFeed({
    summary: snapshot.operatorSummary,
    targetIds: feed.targetIds,
    measured: measuredSignalState,
    currentAvailable: Boolean(current),
    unavailable,
  });
  const metricReadout = feedMetricReadout({ frame, metrics, baselineAvailable: detectorBaselineAvailable(frame, metrics), off, unavailable });
  const stateCopy = SIGNAL_STATE_COPY[signalState];
  const cardState = off ? "off" : signalState;
  const stateLabel = off ? "Off" : stateCopy.label;
  const displayStartHz = frame ? frame.startHz : feed.startHz;
  const displayEndHz = frame ? frame.endHz : feed.endHz;
  const displayCoverage = isLive && frame ? `${formatFrequency(frame.startHz, 3).replace(" MHz", "")}-${formatFrequency(frame.endHz, 3)}` : feed.coverageLabel;
  const frequencyGuides = useMemo(() => snapshot.bands
    .filter((band) => feed.bandIds.includes(band.id) && band.service === "fugro" && band.correctionBeam)
    .map((band) => ({ frequencyHz: band.centerHz, label: band.label })), [feed.bandIds, snapshot.bands]);

  return (
    <article className={`mission-feed-card ${selected ? "selected" : ""} ${cardState} ${paused ? "paused" : ""} ${exercise ? "simulation" : ""}`}>
      <header className="feed-header">
        <button className="feed-identity" type="button" onClick={onSelect} aria-pressed={selected} aria-label={`Select ${feed.label}`}>
          <span className="feed-icon">{feed.category === "navigation" ? <span className="feed-icon-text">GPS</span> : <SatelliteDish size={23} />}</span>
          <div><h2>{feed.label}</h2><p>{displayCoverage}<span aria-hidden="true"> - </span>{coverageLabel}{liveAge ? ` - ${liveAge}` : ""}<span className={`feed-state-dot ${cardState}`} aria-hidden="true" /><strong>{stateLabel}</strong></p></div>
        </button>
        <div className="feed-freshness">
          {exercise ? <button className="stop-exercise-button" type="button" disabled={Boolean(exercise.stopRequested && exercise.phase !== "complete")} onMouseDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onStopExercise(); }} aria-label={exercise.phase === "complete" ? "Close simulation test" : "Stop simulation test"}>{exercise.phase === "complete" ? "Done" : exercise.stopRequested ? "Stopping…" : "Stop test"}</button> : null}
          {off ? <span>Not monitored</span> : !isLive ? <span>{canonicalAffected ? canonicalObservation.at ? `Checked ${lastObservedAge}` : lastObservedAge : lastObservedAt ? `Checked ${lastObservedAge}` : feed.kind === "stitched-sweep" ? `First sweep ${progress}%` : "Not checked"}</span> : null}
          {!off && resume ? <span>Resumes in {resume}</span> : nextCheck ? <span>Next check {nextCheck}</span> : null}
          {compact ? <button type="button" onClick={(event) => { event.stopPropagation(); onInspect(); }} aria-label={`Expand ${feed.label}`}><Maximize2 size={16} /></button> : null}
        </div>
      </header>
      {!exercise && !off && !isLive && !unavailable && target ? <button className="make-live-button" type="button" onClick={(event) => { event.stopPropagation(); onRequestFocus(); }}>Make live</button> : null}
      <div className="feed-mode-line">
        <span>{exercise ? "SIMULATION" : isLive || feed.kind === "capture-window" ? "One receiver window" : "Stitched sweep"}</span>
        <span>{exercise ? `${exercise.scenarioName} · ${exercise.phase === "waiting-for-target" ? "Starting" : exercise.phase === "alert" ? "Test alert" : exercise.phase === "recovering" ? `Recovering ${exercise.cleanChecks} of ${exercise.requiredCleanChecks}` : exercise.phase === "complete" ? exercise.verdict ?? "Test complete" : exercise.phase === "inconclusive" ? "Test inconclusive" : "Test running"}` : coverageLabel}</span>
      </div>
      <div className="feed-chart-heading"><strong>Relative signal level</strong>{metricReadout ? <span className={`feed-metrics ${metricReadout.overload ? "overload" : ""}`}>{metricReadout.chips.map((chip) => <b key={chip}>{chip}</b>)}</span> : null}<div><span><i className="legend-current" />{feed.kind === "stitched-sweep" && !isLive ? "Last full sweep" : "Current"}</span>{options.baseline && (feed.kind !== "stitched-sweep" || isLive) && detectorBaselineAvailable(frame, metrics) ? <span><i className="legend-usual" />Usual level</span> : null}</div></div>
      <div className="feed-spectrum-grid">
        <div className="plain-level-axis" aria-hidden="true"><span>High</span><span>Usual</span><span>Low</span></div>
        <div className="feed-spectrum"><SpectrumView frame={frame} metrics={metrics} showBaseline={options.baseline && (feed.kind !== "stitched-sweep" || isLive)} showMarkers={options.markers} frequencyGuides={frequencyGuides} />{off ? <p className="feed-off-notice">Off. Turn this window on in Settings, Monitoring.</p> : null}</div>
      </div>
      <FeedFrequencyAxis startHz={displayStartHz} endHz={displayEndHz} />
      <div className="feed-waterfall"><WaterfallView frames={history} frequencyGuides={frequencyGuides} /></div>
      <FeedFrequencyAxis startHz={displayStartHz} endHz={displayEndHz} />
      {feed.kind === "stitched-sweep" ? <div className="sweep-progress"><span>{paused ? `Paused at ${progress}%` : sweep?.status === "complete" && sweep.lastCompletedAt ? `Sweep ready · ${ageLabel(sweep.lastCompletedAt, now)}` : sweep?.lastCompletedAt ? `Scanning ${progress}% · Last sweep ${ageLabel(sweep.lastCompletedAt, now)}` : `First sweep ${progress}%`}</span><div><i style={{ width: `${progress}%` }} /></div></div> : null}
    </article>
  );
}

function FeedFrequencyAxis({ startHz, endHz }: { startHz: number; endHz: number }) {
  const digits = endHz - startHz < 30_000_000 ? 2 : 0;
  const values = Array.from({ length: 7 }, (_, index) => startHz + ((endHz - startHz) * index) / 6);
  return <div className="feed-frequency-axis">{values.map((value, index) => <span key={index}>{formatFrequency(value, digits).replace(" MHz", "")}</span>)}<strong>MHz</strong></div>;
}

function EmptyFeed({ onAdd }: { onAdd: () => void }) {
  return <button className="mission-empty-feed" type="button" onClick={onAdd}><Plus size={22} /><strong>Add signal</strong></button>;
}

export function PinnedShelf({
  feeds,
  targets,
  targetStates,
  targetFrames,
  operatorSummary,
  sweepCycles,
  pinnedFeedIds,
  selectedFeedId,
  now,
  onSelect,
  onManage,
}: {
  feeds: MonitorFeed[];
  targets: MonitorTarget[];
  targetStates: ChannelMonitorState[];
  targetFrames: Record<string, TargetFrameState>;
  operatorSummary: MonitorSnapshot["operatorSummary"];
  sweepCycles: SweepCycle[];
  pinnedFeedIds: string[];
  selectedFeedId?: string;
  now: number;
  onSelect: (feedId: string) => void;
  onManage: () => void;
}) {
  const pinned = pinnedFeedIds.map((id) => feeds.find((feed) => feed.id === id)).filter((feed): feed is MonitorFeed => Boolean(feed));
  const states = authoritativeTargetStates(targetStates, targetFrames);
  const radio = pinned.filter((feed) => feed.category === "radio");
  const navigation = pinned.filter((feed) => feed.category === "navigation");
  return (
    <section className="pinned-shelf" aria-label="Pinned feed shortcuts">
      <div className="pinned-label"><strong>Pinned</strong><span><Pin size={18} /><ArrowLeft size={18} /></span></div>
      <ShelfGroup label="Radio" feeds={radio} targets={targets} targetStates={states} operatorSummary={operatorSummary} sweepCycles={sweepCycles} selectedFeedId={selectedFeedId} now={now} onSelect={onSelect} />
      <ShelfGroup label="Navigation" feeds={navigation} targets={targets} targetStates={states} operatorSummary={operatorSummary} sweepCycles={sweepCycles} selectedFeedId={selectedFeedId} now={now} onSelect={onSelect} />
      <button className="manage-feeds" type="button" onClick={onManage}><SlidersHorizontal size={18} />Manage</button>
    </section>
  );
}

function ShelfGroup({ label, feeds, targets, targetStates, operatorSummary, sweepCycles, selectedFeedId, now, onSelect }: { label: string; feeds: MonitorFeed[]; targets: MonitorTarget[]; targetStates: ChannelMonitorState[]; operatorSummary: MonitorSnapshot["operatorSummary"]; sweepCycles: SweepCycle[]; selectedFeedId?: string; now: number; onSelect: (feedId: string) => void }) {
  if (!feeds.length) return null;
  return <div className="pinned-group"><span className="pinned-group-label">{label}</span><div>{feeds.map((feed) => {
    const observedAt = feed.kind === "stitched-sweep"
      ? sweepCycles.find((cycle) => cycle.feedId === feed.id)?.lastCompletedAt
      : targetObservationAt(feed.targetIds, targetStates);
    const canonicalAffected = operatorObservationMatchesTargets(operatorSummary, feed.targetIds);
    const observedAge = canonicalAffected
      ? operatorObservationForSurface(operatorSummary, "pinned").ageLabel
      : ageLabel(observedAt, now);
    const state = signalStateForTargets(feed.targetIds, targetStates);
    const unavailable = feed.targetIds.some((id) => targets.find((target) => target.id === id)?.coverageMode === "unavailable");
    return <button key={feed.id} type="button" className={selectedFeedId === feed.id ? "selected" : ""} onClick={() => onSelect(feed.id)}><strong>{feed.shortLabel}</strong><span>{feed.coverageLabel}</span><small><i className={unavailable ? "offline" : state} />{observedAge}</small></button>;
  })}</div></div>;
}

/**
 * Only monitored windows produce a feed, so the manager says how many the
 * current Monitoring selection covers rather than leaving a short list
 * looking like a missing frequency.
 */
export function feedManagerScopeCopy(windowCount: number): string {
  return `This list shows the ${windowCount} frequency ${windowCount === 1 ? "window" : "windows"} your Monitoring selection covers. To pin another window, add it in Monitoring first.`;
}

export function FeedManagerModal({
  feeds,
  pinnedFeedIds,
  onChange,
  onOpenMonitoring,
  onClose,
}: {
  feeds: MonitorFeed[];
  pinnedFeedIds: string[];
  onChange: (feedIds: string[]) => void;
  onOpenMonitoring: () => void;
  onClose: () => void;
}) {
  const selected = new Set(pinnedFeedIds);
  const toggle = (feedId: string) => {
    if (selected.has(feedId)) onChange(pinnedFeedIds.filter((id) => id !== feedId));
    else if (pinnedFeedIds.length < 9) onChange([...pinnedFeedIds, feedId]);
  };
  const move = (feedId: string, direction: -1 | 1) => {
    const from = pinnedFeedIds.indexOf(feedId);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= pinnedFeedIds.length) return;
    const next = [...pinnedFeedIds];
    [next[from], next[to]] = [next[to], next[from]];
    onChange(next);
  };
  const sections = [
    { label: "Radio", feeds: feeds.filter((feed) => feed.category === "radio") },
    { label: "Navigation", feeds: feeds.filter((feed) => feed.category === "navigation") },
  ];
  return (
    <DialogShell backdropClassName="feed-manager-backdrop" dialogClassName="feed-manager" labelledBy="feed-manager-title" onClose={onClose}>
      <header><div><span>Signal wall</span><strong id="feed-manager-title">Choose signals</strong></div><button type="button" onClick={onClose} aria-label="Close"><X size={19} /></button></header>
      <div className="feed-manager-count">{pinnedFeedIds.length} of 9 pinned</div>
      <div className="feed-manager-scope">
        <span>{feedManagerScopeCopy(feeds.length)}</span>
        <button type="button" onClick={onOpenMonitoring}>Open Monitoring</button>
      </div>
      <div className="feed-manager-list">{sections.map((section) => <section key={section.label}><h3>{section.label}</h3>{section.feeds.map((feed) => {
        const order = pinnedFeedIds.indexOf(feed.id);
        const isPinned = order >= 0;
        return <div key={feed.id} className={isPinned ? "selected" : ""}><button type="button" onClick={() => toggle(feed.id)} disabled={!isPinned && pinnedFeedIds.length >= 9}><span className="feed-order">{isPinned ? order + 1 : <Plus size={14} />}</span><span><strong>{feed.label}</strong><small>{feed.coverageLabel}</small></span><b>{isPinned ? "Pinned" : "Add"}</b></button>{isPinned ? <div><button type="button" onClick={() => move(feed.id, -1)} disabled={order === 0} aria-label="Move up"><ChevronUp size={15} /></button><button type="button" onClick={() => move(feed.id, 1)} disabled={order === pinnedFeedIds.length - 1} aria-label="Move down"><ChevronDown size={15} /></button></div> : null}</div>;
      })}</section>)}</div>
      <footer><button type="button" onClick={() => onChange([])}>Remove all</button><button type="button" className="primary" onClick={onClose}>Done</button></footer>
    </DialogShell>
  );
}
