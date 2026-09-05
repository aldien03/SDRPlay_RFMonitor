import { CalendarDays, Database, Flag, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Header } from "./client/Header";
import { EvidenceArchive, OptionsPanel, type DisplayOptions } from "./client/BottomPanels";
import { IncidentPanel } from "./client/MonitorPanels";
import { NoteModal } from "./client/Modals";
import { SettingsPage, type SettingsSection, type SettingsTab } from "./client/SettingsPage";
import { EngineerWorkspace } from "./client/EngineerWorkspace";
import { SystemHealth, SystemHealthIndicator } from "./client/SystemHealth";
import { useDiagnostics } from "./client/useDiagnostics";
import { FeedManagerModal, PinnedShelf, SignalWall } from "./client/SignalWall";
import {
  DEFAULT_SIGNAL_WALL_PREFERENCES,
  LEGACY_SIGNAL_WALL_STORAGE_KEY,
  OLDEST_SIGNAL_WALL_STORAGE_KEY,
  parseSignalWallPreferences,
  reconcileSignalWallPreferences,
  SIGNAL_WALL_STORAGE_KEY,
  type SignalWallPreferences,
} from "./client/signalWallPreferences";
import { formatRange } from "./client/format";
import { surfacedVisibleFeedIds } from "./client/feedVisibility";
import { currentOperatorEvent, isRealOperatorAlert, operatorAffectedTargetIds, operatorAnnouncement, operatorObservationForSurface } from "./client/operatorViewModel";
import { useMonitor } from "./client/useMonitor";
import { DialogShell } from "./client/DialogShell";
import { HelpPage } from "./client/HelpPage";
import { presentOperatorSummary } from "./shared/operatorSummary";
import type { DetectionEvent, EvidenceArchiveSession, MonitorFeed } from "./shared/types";

type DetailsView = "incident" | "evidence";
type ActiveDrawer = DetailsView | "engineer";

function retainedQaSearch(search = location.search): string {
  const qa = new URLSearchParams(search).get("qa");
  return qa === "v3" || qa === "accessibility" ? `?qa=${qa}` : "";
}

function downloadText(contents: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([contents], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function copyText(contents: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(contents);
    return;
  }
  const field = document.createElement("textarea");
  field.value = contents;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  const copied = document.execCommand("copy");
  field.remove();
  if (!copied) throw new Error("Copy failed");
}

function EngineerHealthIndicator({ onOpen }: { onOpen: () => void }) {
  const diagnostics = useDiagnostics();
  return <SystemHealthIndicator model={diagnostics.model} error={diagnostics.error} onOpen={onOpen} />;
}

const defaultOptions: DisplayOptions = {
  waterfall: true,
  baseline: true,
  markers: true,
  traceMode: "current",
  engineer: false,
  audioAlerts: false,
  popupAlerts: false,
};

function loadOptions(): DisplayOptions {
  try {
    return { ...defaultOptions, ...JSON.parse(localStorage.getItem("rf-monitor-display-v1") ?? "{}"), engineer: false };
  } catch {
    return defaultOptions;
  }
}

function storePreference(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A browser with storage disabled or full still monitors normally.
  }
}

function loadSignalWallPreferences(): SignalWallPreferences {
  try {
    const legacy = localStorage.getItem(LEGACY_SIGNAL_WALL_STORAGE_KEY) ?? localStorage.getItem(OLDEST_SIGNAL_WALL_STORAGE_KEY);
    return parseSignalWallPreferences(localStorage.getItem(SIGNAL_WALL_STORAGE_KEY), legacy);
  } catch {
    return DEFAULT_SIGNAL_WALL_PREFERENCES;
  }
}

export function App() {
  const monitor = useMonitor();
  const { snapshot, targetFrames, sweepFrames, error, reloadRequired, pause, acknowledge, addNote, captureScreenshot, exportIncident, exportSession, getEvidenceArchive, getEvidenceSessionEvents, getEvidenceReplayBatch, setEngineerStream, setVisibleTargets } = monitor;
  const [options, setOptions] = useState<DisplayOptions>(loadOptions);
  const [wallPreferences, setWallPreferences] = useState<SignalWallPreferences>(loadSignalWallPreferences);
  const [feedManagerOpen, setFeedManagerOpen] = useState(false);
  const [focusFeed, setFocusFeed] = useState<MonitorFeed>();
  const [noteOpen, setNoteOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>();
  const [settingsSection, setSettingsSection] = useState<SettingsSection>();
  const [helpOpen, setHelpOpen] = useState(() => location.pathname === "/help");
  const [toast, setToast] = useState<string>();
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const [archivedEvent, setArchivedEvent] = useState<DetectionEvent>();
  const [detailsView, setDetailsView] = useState<DetailsView>();
  const [now, setNow] = useState(() => Date.now());
  const lastAlertId = useRef<string | undefined>(undefined);
  const operator = presentOperatorSummary(snapshot.operatorSummary);
  const operatorIncident = snapshot.operatorSummary.incident;
  const affectedTargetIds = operatorAffectedTargetIds(snapshot.operatorSummary);
  const affectedTargetSignature = affectedTargetIds.join("\u0000");
  const event = currentOperatorEvent(snapshot);
  const selectedEvent = archivedEvent?.id === selectedEventId
    ? archivedEvent
    : event?.id === selectedEventId
      ? event
      : undefined;
  const selectedEventArchived = Boolean(selectedEvent && archivedEvent?.id === selectedEvent.id);
  const activeDrawer: ActiveDrawer | undefined = options.engineer ? "engineer" : detailsView;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const onPopState = () => setHelpOpen(location.pathname === "/help");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    // Preference storage is a convenience. A full or blocked store must never
    // abort this effect, or the live stream subscription below never runs.
    storePreference("rf-monitor-display-v1", options);
    setEngineerStream(options.engineer);
  }, [options, setEngineerStream]);

  useEffect(() => {
    setWallPreferences((current) => {
      const next = reconcileSignalWallPreferences(current, snapshot.monitorFeeds);
      return JSON.stringify(next) === JSON.stringify(current) ? current : next;
    });
  }, [snapshot.monitorFeeds]);

  useEffect(() => {
    storePreference(SIGNAL_WALL_STORAGE_KEY, wallPreferences);
    const displayedFeeds = surfacedVisibleFeedIds({
      preferences: wallPreferences,
      feeds: snapshot.monitorFeeds,
      affectedTargetIds,
      syntheticTargetId: snapshot.syntheticExercise?.targetId,
    })
      .map((feedId) => snapshot.monitorFeeds.find((feed) => feed.id === feedId))
      .filter((feed): feed is MonitorFeed => Boolean(feed));
    const targetIds = displayedFeeds
      .filter((feed) => feed.kind === "capture-window")
      .flatMap((feed) => feed.targetIds);
    if (snapshot.activeFocus?.targetId) targetIds.push(snapshot.activeFocus.targetId);
    if (snapshot.syntheticExercise?.targetId) targetIds.push(snapshot.syntheticExercise.targetId);
    const feedIds = displayedFeeds.filter((feed) => feed.kind === "stitched-sweep").map((feed) => feed.id);
    setVisibleTargets(
      [...new Set(targetIds)],
      [...new Set(targetIds)],
      feedIds,
      feedIds,
    );
  }, [affectedTargetSignature, setVisibleTargets, snapshot.activeFocus?.targetId, snapshot.monitorFeeds, snapshot.syntheticExercise?.targetId, wallPreferences]);

  useEffect(() => {
    if (!operatorIncident || operatorIncident.id === lastAlertId.current) return;
    lastAlertId.current = operatorIncident.id;
    if (options.popupAlerts && "Notification" in window && Notification.permission === "granted") {
      const affected = snapshot.operatorSummary.affectedTargets.map((target) => target.label).join(", ") || "Selected signal";
      new Notification(operatorIncident.synthetic ? "RF Monitor test alert" : "RF Monitor alert", { body: `${affected}: ${operatorIncident.observation}` });
    }
    if (options.audioAlerts) playAlertTone();
  }, [operatorIncident, options.audioAlerts, options.popupAlerts, snapshot.operatorSummary.affectedTargets]);

  useEffect(() => {
    if (archivedEvent) return;
    setSelectedEventId(event?.id);
  }, [archivedEvent, event?.id]);

  const changeOptions = async (next: DisplayOptions) => {
    if (next.popupAlerts && !options.popupAlerts && "Notification" in window && Notification.permission === "default") {
      const permission = await Notification.requestPermission();
      next = { ...next, popupAlerts: permission === "granted" };
    }
    setOptions(next);
  };

  const showTemporaryToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(undefined), 2_500);
  };

  const exportEventPackage = async (target: DetectionEvent, captureLiveScreenshot: boolean) => {
    try {
      if (captureLiveScreenshot) await captureScreenshot(target.id);
      await exportIncident(target.id, target.sessionId);
      showTemporaryToast("Incident package downloaded.");
    } catch (reason) {
      showTemporaryToast(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const handleExport = async () => {
    if (!selectedEvent) return;
    await exportEventPackage(selectedEvent, !selectedEventArchived);
  };

  const handleSessionExport = async (session: EvidenceArchiveSession) => {
    try {
      await exportSession(session.id);
      showTemporaryToast("Session archive downloaded.");
    } catch (reason) {
      showTemporaryToast(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    }
  };

  const openDetails = (view: DetailsView) => {
    setDetailsView(view);
    setOptions((current) => current.engineer ? { ...current, engineer: false } : current);
  };

  const openSettings = (tab: SettingsTab = "monitoring", section?: SettingsSection) => {
    if (location.pathname === "/help") history.replaceState(null, "", `/${retainedQaSearch()}`);
    setHelpOpen(false);
    setDetailsView(undefined);
    setOptions((current) => current.engineer ? { ...current, engineer: false } : current);
    setSettingsSection(section);
    setSettingsTab(tab);
  };

  const openHelp = () => {
    setDetailsView(undefined);
    setOptions((current) => current.engineer ? { ...current, engineer: false } : current);
    if (location.pathname !== "/help") history.pushState(null, "", `/help${retainedQaSearch()}`);
    setHelpOpen(true);
  };

  const closeHelp = () => {
    if (location.pathname === "/help") history.pushState(null, "", `/${retainedQaSearch()}`);
    setHelpOpen(false);
  };

  const closeDetails = () => {
    setDetailsView(undefined);
    setOptions((current) => current.engineer ? { ...current, engineer: false } : current);
  };

  const toggleEngineer = () => {
    setDetailsView(undefined);
    setOptions((current) => ({ ...current, engineer: !current.engineer }));
  };

  const openCurrentIncident = () => {
    setArchivedEvent(undefined);
    setSelectedEventId(event?.id);
    openDetails("incident");
  };

  const openArchivedIncident = (archiveEvent: DetectionEvent) => {
    setArchivedEvent(archiveEvent);
    setSelectedEventId(archiveEvent.id);
    openDetails("incident");
  };

  const startLiveFeed = async () => {
    if (!focusFeed?.focusBandId || focusFeed.focusCenterHz === undefined) return;
    try {
      await monitor.startFocus(focusFeed.focusBandId, focusFeed.focusCenterHz, 120_000);
      setFocusFeed(undefined);
      showTemporaryToast(`${focusFeed.shortLabel} is live for 2 minutes.`);
    } catch (reason) {
      showTemporaryToast(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const stopFocus = async () => {
    try {
      await monitor.stopFocus();
      showTemporaryToast("Survey resumed.");
    } catch (reason) {
      showTemporaryToast(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const startSyntheticExercise = async (scenarioId: string) => {
    const exercise = await monitor.startSyntheticExercise(scenarioId);
    setDetailsView(undefined);
    setOptions((current) => ({ ...current, engineer: false }));
    showTemporaryToast(`${exercise.scenarioName} started on the dashboard.`);
  };

  const stopSyntheticExercise = async () => {
    const exercise = await monitor.stopSyntheticExercise();
    showTemporaryToast(exercise ? "Test condition stopped. Recovery is being checked." : "Simulation test closed.");
  };

  const performOperatorAction = () => {
    switch (snapshot.operatorSummary.monitoring.actionCode) {
      case "retry-receiver":
        void monitor.retryReceiver().then(() => showTemporaryToast("Receiver retry started.")).catch((reason) => showTemporaryToast(reason instanceof Error ? reason.message : String(reason)));
        return;
      case "reload-live-data":
      case "reload-page":
        location.reload();
        return;
      case "resume-monitoring":
        void pause(false);
        return;
      case "open-system-health":
        openSettings("health");
        return;
      case "open-recording":
        openSettings("recording");
        return;
      case "open-signal-learning":
        openSettings("advanced", "signal-learning");
        return;
      case "review-qualification":
        openSettings("health");
        return;
      case "open-incident":
      case "wait-for-check":
      case "none":
      default:
        openCurrentIncident();
    }
  };

  if (helpOpen) {
    return <HelpPage
      snapshot={snapshot}
      onClose={closeHelp}
      onOpenHealth={() => openSettings("health")}
      onOpenRecording={() => openSettings("recording")}
      onOpenEvidence={() => { closeHelp(); openDetails("evidence"); }}
      onOpenEngineer={() => { closeHelp(); setOptions((current) => ({ ...current, engineer: true })); }}
    />;
  }

  if (settingsTab) {
    return (
      <>
        <SettingsPage
          initialTab={settingsTab}
          initialSection={settingsSection}
          snapshot={snapshot}
          onClose={() => { setSettingsTab(undefined); setSettingsSection(undefined); }}
          onToast={showTemporaryToast}
          getSettings={monitor.getSettings}
          unlockSettings={monitor.unlockSettings}
          lockSettings={monitor.lockSettings}
          applySettings={monitor.applySettings}
          approveBaseline={monitor.approveBaseline}
          restartBaseline={monitor.restartBaseline}
          clearTestData={monitor.clearTestData}
          deleteRecordings={monitor.deleteRecordings}
          restartSoftware={monitor.restartSoftware}
          startFocus={monitor.startFocus}
          stopFocus={monitor.stopFocus}
          renderSystemHealth={({ openTab }) => (
            <SystemHealth
              snapshot={snapshot}
              onRetryReceiver={monitor.retryReceiver}
              onReloadDashboard={() => location.reload()}
              onOpenSettingsTab={openTab}
              onDownloadDiagnostics={downloadText}
              onCopyCommand={copyText}
            />
          )}
        />
        {toast ? <div className="toast" role="status">{toast}</div> : null}
      </>
    );
  }

  const activeIncidentCount = operatorIncident ? 1 : 0;
  const affectedLabel = snapshot.operatorSummary.affectedTargets.map((target) => target.label).join(", ");
  const operatorObservation = operatorIncident?.observation ?? operator.observation;
  const operatorAction = operatorIncident?.recommendedAction ?? operator.action;
  const observationClock = operatorObservationForSurface(snapshot.operatorSummary, "footer");
  const observationTimeCopy = observationClock.at ? `Observed ${observationClock.ageLabel}` : observationClock.ageLabel === "Unknown" ? "Observation unknown" : "Not observed";
  const footerDetail = [affectedLabel || undefined, operatorObservation, observationTimeCopy, operatorAction !== "None" ? `Action: ${operatorAction}` : undefined]
    .filter(Boolean)
    .join(" · ");
  const liveAnnouncement = operatorAnnouncement(snapshot.operatorSummary);
  const assertiveAlert = isRealOperatorAlert(snapshot.operatorSummary);
  const activeFeed = snapshot.monitorFeeds.find((feed) => snapshot.activeFocus
    ? feed.bandIds.includes(snapshot.activeFocus.bandId)
    : affectedTargetIds.some((targetId) => feed.targetIds.includes(targetId)));

  return (
    <div
      className="app-shell monitor-app mission-app"
      data-rf-monitor-surface="dashboard"
      data-rf-data-mode={snapshot.dataDomain}
    >
      <Header
        snapshot={snapshot}
        layout={wallPreferences.layout}
        engineer={options.engineer}
        audioAlerts={options.audioAlerts}
        popupAlerts={options.popupAlerts}
        onLayout={(layout) => setWallPreferences((current) => ({ ...current, layout }))}
        onEngineer={toggleEngineer}
        onPause={pause}
        onSettings={() => openSettings("monitoring")}
        onHelp={openHelp}
        onAlertOption={(key) => void changeOptions({ ...options, [key]: !options[key] })}
      />
      {error ? <div className="mission-connection-error" role="status" aria-live="polite"><span>{error}</span>{reloadRequired ? <button type="button" onClick={() => location.reload()}>Reload</button> : null}</div> : null}
      <main className="mission-dashboard">
        <SignalWall
          snapshot={snapshot}
          targetFrames={targetFrames}
          sweepFrames={sweepFrames}
          layout={wallPreferences.layout}
          pinnedFeedIds={wallPreferences.pinnedFeedIds}
          selectedFeedId={wallPreferences.selectedFeedId}
          options={options}
          onManage={() => setFeedManagerOpen(true)}
          onSelect={(selectedFeedId) => setWallPreferences((current) => ({ ...current, selectedFeedId }))}
          onInspect={(selectedFeedId) => setWallPreferences((current) => ({ ...current, selectedFeedId, layout: "1x1" }))}
          onRequestFocus={setFocusFeed}
          onStopExercise={() => void stopSyntheticExercise()}
        />
        <PinnedShelf
          feeds={snapshot.monitorFeeds}
          targets={snapshot.monitorTargets}
          targetStates={snapshot.targetStates}
          targetFrames={targetFrames}
          operatorSummary={snapshot.operatorSummary}
          sweepCycles={snapshot.sweepCycles}
          pinnedFeedIds={wallPreferences.pinnedFeedIds}
          selectedFeedId={wallPreferences.selectedFeedId}
          now={now}
          onSelect={(selectedFeedId) => setWallPreferences((current) => ({ ...current, selectedFeedId }))}
          onManage={() => setFeedManagerOpen(true)}
        />
        {assertiveAlert ? <span className="sr-only" role="alert" aria-live="assertive">{liveAnnouncement}</span> : <span className="sr-only" role="status" aria-live="polite">{liveAnnouncement}</span>}
        <footer className={`mission-footer ${snapshot.operatorSummary.monitoring.state === "alert" ? "alert" : ""} ${snapshot.operatorSummary.dataMode === "simulation" ? "simulation" : ""}`}>
          <button type="button" className="mission-monitoring" onClick={performOperatorAction} aria-label={`Monitoring: ${operator.monitoring}. ${footerDetail}`}><i aria-hidden="true" /><span className="mission-status-copy"><small>Monitoring</small><strong>{operator.monitoring}</strong></span><span className="mission-footer-detail">{footerDetail}</span></button>
          <span className="mission-truth-chip" title={operator.recording === "Recording" ? "Recording on" : `Action: ${snapshot.operatorSummary.recording.actionCode === "open-recording" ? "Open Recording" : "None"}`}><Database size={16} aria-hidden="true" /><span><small>Recording</small><strong>{operator.recording}</strong></span></span>
          <button type="button" onClick={openCurrentIncident}><Flag size={18} aria-hidden="true" />{operatorIncident ? `${operatorIncident.evidenceStrength} evidence` : `Incidents ${activeIncidentCount}`}</button>
          {snapshot.activeFocus ? <button type="button" onClick={() => void stopFocus()}>Resume survey{activeFeed ? ` from ${activeFeed.shortLabel}` : ""}</button> : <button type="button" onClick={() => openDetails("evidence")}><CalendarDays size={18} aria-hidden="true" />Evidence history</button>}
        </footer>
      </main>

      {activeDrawer ? (
        <DialogShell backdropClassName="details-backdrop" dialogClassName={`details-drawer mission-details details-view-${activeDrawer}`} ariaLabel={activeDrawer === "incident" ? "Incident details" : activeDrawer === "evidence" ? "Evidence history" : "Engineer details"} onClose={closeDetails}>
          <div className="details-drawer-header"><div><span>{operator.mode} · {operator.productionQualification}</span><strong>{activeDrawer === "incident" ? "Incident details" : activeDrawer === "evidence" ? "Evidence history" : "Engineer"}</strong></div><button type="button" onClick={closeDetails} aria-label="Close details"><X size={20} /></button></div>
          <div className="details-drawer-scroll">
            {activeDrawer === "engineer" ? <><EngineerWorkspace snapshot={snapshot} sweepFrames={sweepFrames} selectedFeedId={wallPreferences.selectedFeedId} onSelectFeed={(selectedFeedId) => setWallPreferences((current) => ({ ...current, selectedFeedId }))} healthIndicator={<EngineerHealthIndicator onOpen={() => openSettings("health")} />} getSettings={monitor.getSettings} startFocus={monitor.startFocus} stopFocus={monitor.stopFocus} startSyntheticExercise={startSyntheticExercise} stopSyntheticExercise={stopSyntheticExercise} onToast={showTemporaryToast} /><OptionsPanel options={options} onChange={(next) => void changeOptions(next)} /></> : null}
            {activeDrawer === "incident" ? <IncidentPanel archived={selectedEventArchived} event={selectedEvent} operatorSummary={snapshot.operatorSummary} services={snapshot.services} displayTimeZone={snapshot.displayTimeZone} onAddNote={() => setNoteOpen(true)} onAcknowledge={() => selectedEvent && void acknowledge(selectedEvent.id).then(() => showTemporaryToast("Incident marked as reviewed."))} onExport={() => void handleExport()} frame={selectedEventArchived ? undefined : selectedEvent?.targetId ? targetFrames[selectedEvent.targetId]?.frame : undefined} /> : null}
            {activeDrawer === "evidence" ? <EvidenceArchive snapshot={snapshot} getArchive={getEvidenceArchive} getSessionEvents={getEvidenceSessionEvents} getReplayBatch={getEvidenceReplayBatch} onOpenIncident={openArchivedIncident} onExportEvent={(archiveEvent) => exportEventPackage(archiveEvent, false)} onExportSession={handleSessionExport} /> : null}
          </div>
        </DialogShell>
      ) : null}

      {noteOpen && selectedEvent ? <NoteModal onClose={() => setNoteOpen(false)} onSave={async (text) => { await addNote(selectedEvent.id, text); setNoteOpen(false); showTemporaryToast("Note added."); }} /> : null}
      {feedManagerOpen ? <FeedManagerModal feeds={snapshot.monitorFeeds} pinnedFeedIds={wallPreferences.pinnedFeedIds} onOpenMonitoring={() => { setFeedManagerOpen(false); openSettings("monitoring"); }} onChange={(pinnedFeedIds) => setWallPreferences((current) => ({ ...current, pinnedFeedIds, selectedFeedId: pinnedFeedIds.includes(current.selectedFeedId ?? "") ? current.selectedFeedId : pinnedFeedIds[0] }))} onClose={() => setFeedManagerOpen(false)} /> : null}
      {focusFeed ? <FocusConfirmation feed={focusFeed} currentFeed={activeFeed} snapshot={snapshot} onCancel={() => setFocusFeed(undefined)} onConfirm={() => void startLiveFeed()} /> : null}
      {toast ? <div className="toast" role="status">{toast}</div> : null}
    </div>
  );
}

function FocusConfirmation({ feed, currentFeed, snapshot, onCancel, onConfirm }: { feed: MonitorFeed; currentFeed?: MonitorFeed; snapshot: ReturnType<typeof useMonitor>["snapshot"]; onCancel: () => void; onConfirm: () => void }) {
  const target = snapshot.monitorTargets.find((item) => item.id === feed.focusTargetId);
  const range = target ? formatRange(target.startHz, target.endHz) : feed.coverageLabel;
  return (
    <DialogShell backdropClassName="focus-confirm-backdrop" dialogClassName="focus-confirm" labelledBy="focus-title" describedBy="focus-description" onClose={onCancel}>
      <header><strong id="focus-title">Make {feed.shortLabel} live?</strong><button type="button" onClick={onCancel} aria-label="Close"><X size={19} /></button></header>
      <p id="focus-description">{range} will be live for 2 minutes.{currentFeed ? ` ${currentFeed.shortLabel} live view will stop.` : ""} The full survey will pause.</p>
      <footer><button type="button" onClick={onCancel}>Cancel</button><button type="button" className="primary" onClick={onConfirm}>Make live</button></footer>
    </DialogShell>
  );
}

function playAlertTone(): void {
  const AudioContextClass = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 740;
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.22);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.24);
  oscillator.addEventListener("ended", () => void context.close());
}
