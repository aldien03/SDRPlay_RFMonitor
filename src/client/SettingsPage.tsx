import {
  Activity,
  ChevronDown,
  ChevronRight,
  Clock3,
  Database,
  LockKeyhole,
  RadioTower,
  RotateCcw,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  UnlockKeyhole,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { estimateRevisitMs } from "../shared/bands";
import { captureWindowNaming } from "../shared/monitorGroups";
import { presentOperatorSummary } from "../shared/operatorSummary";
import { applyMonitoringMission, changedFieldPaths, classifySettingsChange, compileEffectiveBands, continuousWatchTargetId, evaluateSettingsFeasibility, incidentFigurePolicy, monitoringMissionForSettings, ROBUST_DETECTION_DEFAULTS, selectedMonitoringTargetIds } from "../shared/settings";
import { AlertRulesEditor, AlertSensitivitySection, ReportIdentitySection } from "./AlertSensitivitySettings";
import { scheduleCapacityCopy, windowSchedule, windowScheduleCopy } from "./schedulePresentation";
import type { AlertPreview, BandCatalog, BandPreset, BaselineApprovalEligibility, BaselineDescriptor, ChannelMonitorState, MonitorSnapshot, MonitoringMission, OperationalSettings, PhysicalCaptureTarget, ReportLogo, SettingsApplyMode, SettingsRevision } from "../shared/types";
import { formatBytes, formatFrequency, formatRange } from "./format";
import {
  buildSignalLearningPresentation,
  restartBlockedReason,
  SIGNAL_LEARNING_REQUIRED_HOURS,
  signalLearningProgressLabel,
  signalLearningStateLabel,
  type SignalLearningState,
} from "./settingsPresentation";
import {
  ApiError,
  baselineRestartRequiresRecovery,
  type BaselineApprovalResponse,
  type BaselineRestartResponse,
  type ClearTestDataResponse,
  type DeleteRecordingsResponse,
  type SoftwareRestartResponse,
} from "./useMonitor";
import { DialogShell } from "./DialogShell";
import { SurfaceAlertBanner } from "./SurfaceAlertBanner";

export type SettingsTab = "monitoring" | "health" | "recording" | "site" | "advanced" | "learning";

type ServiceDisplayState = "Monitoring" | "Paused" | "Will monitor" | "Off";

interface SettingsPageProps {
  initialTab?: SettingsTab;
  snapshot: MonitorSnapshot;
  onClose: () => void;
  onToast: (message: string) => void;
  getSettings: () => Promise<SettingsRevision>;
  unlockSettings: (password: string) => Promise<SettingsRevision>;
  lockSettings: () => Promise<unknown>;
  applySettings: (settings: OperationalSettings, expectedRevision: number, options?: { confirmSignalLearningRestart?: boolean }) => Promise<SettingsRevision>;
  getAlertPreview?: () => Promise<AlertPreview>;
  uploadReportLogo?: (file: File) => Promise<ReportLogo>;
  approveBaseline: (baseline: BaselineDescriptor, expectedRevision: number) => Promise<BaselineApprovalResponse>;
  restartBaseline: (baseline: BaselineDescriptor, expectedRevision: number, options?: { endActiveObservation?: boolean }) => Promise<BaselineRestartResponse>;
  clearTestData: (expectedRevision: number) => Promise<ClearTestDataResponse>;
  deleteRecordings: (expectedRevision: number, dataDomain: MonitorSnapshot["dataDomain"]) => Promise<DeleteRecordingsResponse>;
  restartSoftware: (expectedRevision: number) => Promise<SoftwareRestartResponse>;
  startFocus: (bandId: string, centerHz: number | undefined, durationMs: number) => Promise<unknown>;
  stopFocus: () => Promise<unknown>;
  renderSystemHealth?: (controls: { openTab: (tab: SettingsTab) => void }) => React.ReactNode;
}

export type MaintenanceAction = "clear-test-data" | "restart-learning" | "delete-recordings" | "restart-software";

export const MAINTENANCE_CONFIRMATION: Record<MaintenanceAction, string> = {
  "clear-test-data": "CLEAR TEST DATA",
  "restart-learning": "RESTART LEARNING",
  "delete-recordings": "DELETE RECORDINGS",
  "restart-software": "RESTART SOFTWARE",
};

export function maintenancePresentation(
  action: MaintenanceAction,
  dataDomain: MonitorSnapshot["dataDomain"],
  /** Labels of frequencies with an alert or running check that the restart will end. */
  activeWindows: readonly string[] = [],
): { title: string; changes: string; retained: string; button: string } {
  if (action === "clear-test-data") return {
    title: "Clear test data?",
    changes: "Deletes test recordings, test incidents and test signal learning.",
    retained: "Field data and settings are kept.",
    button: "Clear test data",
  };
  if (action === "restart-learning") return {
    title: "Restart signal learning?",
    changes: `Starts a new learning period for every active ${dataDomain === "field" ? "Field" : "Test"} frequency that has learned data. Alerts are Low evidence until learning is approved.${activeWindows.length ? ` Active alerts on ${activeWindows.join(", ")} will be ended.` : ""}`,
    retained: `Recordings, saved learning records and settings are kept.${activeWindows.length ? " Ended incidents stay in Evidence History." : " Incidents are kept."}`,
    button: "Restart learning",
  };
  if (action === "delete-recordings") return {
    title: "Delete recordings?",
    changes: `Deletes finalized ${dataDomain === "field" ? "Field" : "Test"} recordings.`,
    retained: "Active, finalizing and in-use recordings, exports, signal learning and settings are kept.",
    button: "Delete recordings",
  };
  return {
    title: "Restart software?",
    changes: "Restarts RF Monitor. Monitoring and this dashboard will disconnect briefly.",
    retained: "Recordings, signal learning and settings are kept.",
    button: "Restart software",
  };
}

/** What Apply will do, said before the operator commits. */
export function applyImpactCopy(mode: SettingsApplyMode): string {
  switch (mode) {
    case "live": return "Applies now. Recording and open incidents continue.";
    case "rf-restart": return "Retunes the receiver. Open incidents end and a new recording session starts.";
    case "learning-restart": return "Restarts signal learning for every window. Open incidents end.";
    default: return "";
  }
}

export function appliedToastCopy(mode: SettingsApplyMode | undefined): string {
  switch (mode) {
    case "live": return "Saved and applied. Recording and open incidents continue.";
    case "rf-restart": return "Saved. The receiver was retuned and a new recording session started.";
    case "learning-restart": return "Saved. Signal learning restarted for every window.";
    default: return "Saved.";
  }
}

const TAB_ITEMS: Array<{ id: SettingsTab; label: string; icon: React.ReactNode }> = [
  { id: "monitoring", label: "Monitoring", icon: <RadioTower size={18} aria-hidden="true" /> },
  { id: "health", label: "System health", icon: <Activity size={18} aria-hidden="true" /> },
  { id: "recording", label: "Recording", icon: <Database size={18} aria-hidden="true" /> },
  { id: "learning", label: "Signal learning", icon: <RotateCcw size={18} aria-hidden="true" /> },
  { id: "site", label: "Site", icon: <Clock3 size={18} aria-hidden="true" /> },
  { id: "advanced", label: "Advanced", icon: <SlidersHorizontal size={18} aria-hidden="true" /> },
];

function timeZones(current: string): string[] {
  const values = (Intl as typeof Intl & { supportedValuesOf?: (key: "timeZone") => string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"];
  return [...new Set(["UTC", current, ...values])];
}

function channelCount(band: BandPreset): number {
  if (band.channelCount) return band.channelCount;
  if (!band.channelSpacingHz) return 1;
  return Math.floor((band.endHz - band.startHz) / band.channelSpacingHz) + 1;
}

function formatChannelSpacing(spacingHz: number): string {
  return spacingHz >= 1_000_000 ? `${spacingHz / 1_000_000} MHz` : `${spacingHz / 1_000} kHz`;
}

function orbitalLongitude(value: number): string {
  return `${Math.abs(value).toFixed(Number.isInteger(value) ? 0 : 1)}°${value < 0 ? "W" : "E"}`;
}

function cloneSettings(settings: OperationalSettings): OperationalSettings {
  return structuredClone(settings);
}

function serviceBand(response: SettingsRevision, service: "startrack" | "4dx"): BandPreset {
  return response.catalog.bands.find((band) => band.service === service)!;
}

function minutes(milliseconds: number): number {
  return Math.round(milliseconds / 60_000);
}

function hours(milliseconds: number): number {
  return Math.round(milliseconds / 3_600_000);
}

function days(milliseconds: number): number {
  return Math.round(milliseconds / 86_400_000);
}

function gib(bytes: number): number {
  return Number((bytes / 1_073_741_824).toFixed(1));
}

function baselineApprovalKey(baseline: Pick<BaselineDescriptor, "targetId" | "fingerprintId" | "learningGenerationId">): string {
  return `${baseline.targetId}:${baseline.fingerprintId}:${baseline.learningGenerationId}`;
}

function approvalDetail(approval: BaselineApprovalEligibility): string | undefined {
  if (approval.remainingMs !== undefined && approval.remainingMs > 0) {
    const minutesRemaining = Math.max(1, Math.ceil(approval.remainingMs / 60_000));
    if (minutesRemaining < 60) return `${minutesRemaining} min remaining`;
    const hoursRemaining = Math.ceil(minutesRemaining / 60);
    return `${hoursRemaining} h remaining`;
  }
  return approval.detail;
}

export function SettingsPage(props: SettingsPageProps) {
  const operator = presentOperatorSummary(props.snapshot.operatorSummary);
  const [response, setResponse] = useState<SettingsRevision>();
  const [draft, setDraft] = useState<OperationalSettings>();
  const [tab, setTab] = useState<SettingsTab>(props.initialTab ?? "monitoring");
  const [password, setPassword] = useState("");
  const [adminDialogOpen, setAdminDialogOpen] = useState(false);
  const [adminError, setAdminError] = useState<string>();
  const [unlocking, setUnlocking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [conflict, setConflict] = useState<SettingsRevision>();
  const [pendingBaselineRestart, setPendingBaselineRestart] = useState<BaselineDescriptor>();
  const [pendingMaintenance, setPendingMaintenance] = useState<MaintenanceAction>();
  const [maintenanceConfirmation, setMaintenanceConfirmation] = useState("");
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [learningConfirmOpen, setLearningConfirmOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void props.getSettings()
      .then((next) => {
        if (!active) return;
        setResponse(next);
        setDraft(cloneSettings(next.settings));
      })
      .catch((reason) => active && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { active = false; };
  }, [props.getSettings]);

  const dirty = Boolean(response && draft && JSON.stringify(response.settings) !== JSON.stringify(draft));
  const unlocked = Boolean(response?.admin.unlocked);
  const applyMode: SettingsApplyMode = response && draft && dirty ? classifySettingsChange(changedFieldPaths(response.settings, draft)) : "none";

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (!adminDialogOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !unlocking) setAdminDialogOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [adminDialogOpen, unlocking]);

  useEffect(() => {
    if (!closeDialogOpen && !pendingBaselineRestart && !pendingMaintenance) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (maintenanceBusy) return;
      if (pendingMaintenance) setPendingMaintenance(undefined);
      else if (pendingBaselineRestart) setPendingBaselineRestart(undefined);
      else setCloseDialogOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [closeDialogOpen, maintenanceBusy, pendingBaselineRestart, pendingMaintenance]);

  const apply = async (confirmSignalLearningRestart = false) => {
    if (!response || !draft) return;
    if (applyMode === "learning-restart" && !confirmSignalLearningRestart) {
      setLearningConfirmOpen(true);
      return;
    }
    setLearningConfirmOpen(false);
    setSaving(true);
    setError(undefined);
    setFieldErrors({});
    try {
      const next = await props.applySettings(draft, response.settings.revision, confirmSignalLearningRestart ? { confirmSignalLearningRestart: true } : undefined);
      setResponse(next);
      setDraft(cloneSettings(next.settings));
      setConflict(undefined);
      props.onToast(appliedToastCopy(next.applied));
    } catch (reason) {
      if (reason instanceof ApiError) {
        setFieldErrors(reason.fields ?? {});
        if (reason.status === 428) {
          setLearningConfirmOpen(true);
          setError(undefined);
        } else if (reason.status === 409) {
          try {
            const latest = await props.getSettings();
            setConflict(latest);
            setError(undefined);
          } catch (refreshReason) {
            setError(refreshReason instanceof Error ? refreshReason.message : String(refreshReason));
          }
        } else setError(reason.message);
      } else setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const unlock = async () => {
    setUnlocking(true);
    setAdminError(undefined);
    try {
      const next = await props.unlockSettings(password);
      setResponse(next);
      if (!dirty) setDraft(cloneSettings(next.settings));
      setPassword("");
      setAdminDialogOpen(false);
    } catch (reason) {
      setAdminError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setUnlocking(false);
    }
  };

  const lock = async () => {
    await props.lockSettings();
    setResponse((current) => current ? { ...current, admin: { ...current.admin, unlocked: false, expiresAt: undefined } } : current);
    setAdminDialogOpen(false);
  };

  const openAdminDialog = () => {
    setPassword("");
    setAdminError(undefined);
    setAdminDialogOpen(true);
  };

  // One presentation for every surface that names a frequency window, so the
  // learning list, the restart dialog and the batch action cannot drift apart.
  const learningTargets = useMemo(() => {
    if (!response) return [];
    return buildSignalLearningPresentation({
      catalog: response.catalog,
      effectiveBands: response.effectiveBands,
      sampleRateHz: response.infrastructure.sampleRateHz,
      baselines: response.baselineStates,
    }).activeTargets;
  }, [response]);

  // Every active frequency that already has learned data, in display order, so a
  // single protected action can restart the whole set one target at a time.
  const restartableBaselines = useMemo<BaselineDescriptor[]>(
    () => learningTargets.flatMap((target) => target.baseline ? [target.baseline] : []),
    [learningTargets],
  );

  const updateBaseline = async (action: "approve" | "restart", baseline: BaselineDescriptor) => {
    if (!response) return;
    setError(undefined);
    try {
      const restartResult = action === "restart"
        ? await props.restartBaseline(baseline, response.settings.revision, {
          endActiveObservation: Boolean(restartBlockedReason(props.snapshot.targetStates.find((state) => state.targetId === baseline.targetId))),
        })
        : undefined;
      if (action === "approve") await props.approveBaseline(baseline, response.settings.revision);
      const recoveryRequired = restartResult ? baselineRestartRequiresRecovery(restartResult) : false;
      if (recoveryRequired) setTab("health");
      const next = await props.getSettings();
      setResponse(next);
      if (!dirty) setDraft(cloneSettings(next.settings));
      if (recoveryRequired) {
        setError("Learning generation changed. Recovery is required.");
        props.onToast("Learning generation changed. Check System health.");
      } else {
        props.onToast(action === "approve" ? "Learned level approved." : "Signal learning restarted.");
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const openMaintenance = (action: MaintenanceAction) => {
    setMaintenanceConfirmation("");
    setPendingMaintenance(action);
  };

  const runMaintenance = async () => {
    if (!response || !pendingMaintenance) return;
    setMaintenanceBusy(true);
    setError(undefined);
    try {
      if (pendingMaintenance === "clear-test-data") {
        const result = await props.clearTestData(response.settings.revision);
        if (result.result.state !== "complete" || result.result.runtimeState !== "active" || !result.result.auditDurable) {
          throw new Error(result.result.recoveryReason ?? "Test data was cleared, but recovery still needs attention.");
        }
        const next = await props.getSettings();
        setResponse(next);
        if (!dirty) setDraft(cloneSettings(next.settings));
        props.onToast(result.result.previousDataPresent ? "Test data cleared." : "No test data to clear.");
      } else if (pendingMaintenance === "restart-learning") {
        if (!restartableBaselines.length) throw new Error("No learned data to restart yet.");
        const total = restartableBaselines.length;
        const windowLabel = (targetId: string) => learningTargets.find((target) => target.targetId === targetId)?.label ?? friendlyTargetId(targetId);
        // The server allows one journalled restart at a time, so walk the
        // targets in order and report exactly how far the batch got.
        let current = response;
        let restarted = 0;
        const failures: string[] = [];
        for (const baseline of restartableBaselines) {
          let result: BaselineRestartResponse;
          try {
            // The dialog listed every frequency with an active alert; confirming it
            // authorises ending exactly those observations.
            result = await props.restartBaseline(baseline, current.settings.revision, {
              endActiveObservation: Boolean(restartBlockedReason(props.snapshot.targetStates.find((state) => state.targetId === baseline.targetId))),
            });
          } catch (reason) {
            // Any other individual failure is recorded, and the loop carries on.
            failures.push(`${windowLabel(baseline.targetId)} — ${reason instanceof Error ? reason.message : String(reason)}`);
            current = await props.getSettings();
            continue;
          }
          if (baselineRestartRequiresRecovery(result)) {
            // Dangerous condition: unlike every failure above, this one still
            // stops the batch immediately.
            setResponse(await props.getSettings());
            setTab("health");
            throw new Error(`Restarted ${restarted} of ${total}. Learning generation changed; recovery is required. Check System health.`);
          }
          restarted += 1;
          current = await props.getSettings();
        }
        setResponse(current);
        if (!dirty) setDraft(cloneSettings(current.settings));
        if (restarted === total && !failures.length) {
          props.onToast(`Signal learning restarted for ${restarted} ${restarted === 1 ? "frequency" : "frequencies"}.`);
        } else {
          const parts = [`Restarted ${restarted} of ${total}.`];
          if (failures.length) parts.push(`Failed: ${failures.join("; ")}.`);
          throw new Error(parts.join(" "));
        }
      } else if (pendingMaintenance === "delete-recordings") {
        const result = await props.deleteRecordings(response.settings.revision, props.snapshot.dataDomain);
        if (result.result.state !== "complete" || !result.result.auditDurable) {
          throw new Error(result.result.recoveryReason ?? "Recordings were not deleted.");
        }
        props.onToast(`${result.result.deletedSessions} recording${result.result.deletedSessions === 1 ? "" : "s"} deleted.`);
      } else {
        const result = await props.restartSoftware(response.settings.revision);
        if (result.recovery.outcome !== "request-accepted" && result.recovery.outcome !== "helper-pending" && result.recovery.outcome !== "verified-recovery") {
          throw new Error(result.recovery.outcome === "lockout" ? "Software restart is locked. Open System health." : result.recovery.outcome === "cooldown" ? "Software restart is cooling down. Try later." : "Software restart is unavailable.");
        }
        setTab("health");
        props.onToast(result.recovery.outcome === "verified-recovery" ? "Software restart verified." : "Software restart requested. Waiting for health checks.");
      }
      setPendingMaintenance(undefined);
      setMaintenanceConfirmation("");
    } catch (reason) {
      setPendingMaintenance(undefined);
      setMaintenanceConfirmation("");
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMaintenanceBusy(false);
    }
  };

  const requestClose = () => {
    if (dirty) setCloseDialogOpen(true);
    else props.onClose();
  };

  const keepDraftAfterConflict = () => {
    if (!conflict) return;
    setResponse(conflict);
    setConflict(undefined);
    setError(undefined);
  };

  const loadServerSettings = () => {
    if (!conflict) return;
    setResponse(conflict);
    setDraft(cloneSettings(conflict.settings));
    setConflict(undefined);
    setFieldErrors({});
    setError(undefined);
  };

  const moveTabFocus = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = TAB_ITEMS.length - 1;
    const nextIndex = event.key === "ArrowDown" || event.key === "ArrowRight"
      ? (index + 1) % TAB_ITEMS.length
      : event.key === "ArrowUp" || event.key === "ArrowLeft"
        ? (index - 1 + TAB_ITEMS.length) % TAB_ITEMS.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? last
            : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const nextTab = TAB_ITEMS[nextIndex].id;
    setTab(nextTab);
    window.requestAnimationFrame(() => document.getElementById(`settings-tab-${nextTab}`)?.focus());
  };

  const windowLabelFor = (targetId: string) => learningTargets.find((target) => target.targetId === targetId)?.label
    ?? response?.catalog.captureTargets.find((target) => target.id === targetId)?.label
    ?? friendlyTargetId(targetId);
  const isRestartBlocked = (targetId: string) => Boolean(restartBlockedReason(props.snapshot.targetStates.find((state) => state.targetId === targetId)));
  const activeRestartWindows = restartableBaselines.filter((baseline) => isRestartBlocked(baseline.targetId)).map((baseline) => windowLabelFor(baseline.targetId));
  const maintenanceCopy = pendingMaintenance ? maintenancePresentation(pendingMaintenance, props.snapshot.dataDomain, activeRestartWindows) : undefined;

  return (
    <div
      className="settings-page"
      data-rf-monitor-surface="settings"
      data-rf-data-mode={props.snapshot.dataDomain}
    >
      <header className="settings-header">
        <div className="settings-header-copy">
          <strong>Settings</strong>
        </div>
        <div className="settings-header-actions">
          <div className={`settings-runtime-context mode-${props.snapshot.operatorSummary.dataMode}`} role="group" aria-label={`Data: ${operator.mode}. Qualification: ${operator.productionQualification}`}><span>Data <strong>{operator.mode}</strong></span><span>Qualification <strong>{operator.productionQualification}</strong></span></div>
          {response && unlocked ? <div className="settings-header-meta"><span>Revision {response.settings.revision}</span><span>Catalog {response.catalog.catalogVersion}</span></div> : null}
          {unlocked ? (
            <>
              <span className="admin-mode-active"><ShieldCheck size={16} aria-hidden="true" /> Editing unlocked</span>
              <button className="button secondary compact" type="button" onClick={() => void lock()}><LockKeyhole size={16} aria-hidden="true" /> Lock editing</button>
            </>
          ) : (
            <button className="button settings-admin-button compact" type="button" onClick={openAdminDialog}><UnlockKeyhole size={16} aria-hidden="true" /> Unlock to change</button>
          )}
          <button className="icon-button" type="button" onClick={requestClose} aria-label="Close settings"><X size={23} aria-hidden="true" /></button>
        </div>
      </header>
      <SurfaceAlertBanner summary={props.snapshot.operatorSummary} onOpenDashboard={props.onClose} />

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-tabs" role="tablist" aria-label="Settings sections">
            {TAB_ITEMS.map((item, index) => (
              <button key={item.id} id={`settings-tab-${item.id}`} className={tab === item.id ? "selected" : ""} type="button" role="tab" aria-selected={tab === item.id} aria-controls={`settings-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onKeyDown={(event) => moveTabFocus(event, index)} onClick={() => setTab(item.id)} aria-label={item.label} title={item.label}>
                {item.icon}<span>{item.label}</span>
              </button>
            ))}
          </div>
        </nav>

        <main className="settings-content">
          {!response || !draft ? <div className="settings-loading">Loading settings...</div> : (
            <>
              {error ? <div className="settings-error" role="alert">{error}</div> : null}
              <div id={`settings-panel-${tab}`} role="tabpanel" aria-labelledby={`settings-tab-${tab}`} tabIndex={0}>
                {tab === "monitoring" ? <MonitoringSettings response={response} draft={draft} current={response.settings} setDraft={setDraft} errors={fieldErrors} disabled={!unlocked} getAlertPreview={props.getAlertPreview} /> : null}
                {tab === "health" ? (props.renderSystemHealth?.({ openTab: setTab }) ?? <SystemHealthPlaceholder />) : null}
                {tab === "recording" ? <EvidenceSettings draft={draft} setDraft={setDraft} response={response} errors={fieldErrors} disabled={!unlocked} dataDomain={props.snapshot.dataDomain} onMaintenance={openMaintenance} /> : null}
                {tab === "learning" ? <SignalLearningSettings response={response} unlocked={unlocked} targetStates={props.snapshot.targetStates} onMaintenance={openMaintenance} onBaselineAction={async (action, baseline) => { if (action === "restart") setPendingBaselineRestart(baseline); else await updateBaseline(action, baseline); }} onOpenTab={setTab} /> : null}
                {tab === "site" ? <SiteSettings draft={draft} setDraft={setDraft} response={response} errors={fieldErrors} disabled={!unlocked} uploadLogo={props.uploadReportLogo} onToast={props.onToast} /> : null}
                {tab === "advanced" ? <AdvancedSettings response={response} draft={draft} setDraft={setDraft} errors={fieldErrors} unlocked={unlocked} onMaintenance={openMaintenance} /> : null}
              </div>
            </>
          )}
        </main>
      </div>

      {response && draft && (unlocked || dirty) && (tab !== "health" || dirty) ? (
        <footer className="settings-footer">
          <span>{dirty ? "Unsaved changes" : unlocked ? "No changes" : "View only"}{dirty && applyImpactCopy(applyMode) ? <small className="apply-impact"> · {applyImpactCopy(applyMode)}</small> : null}</span>
          <div>
            <button className="button secondary" type="button" disabled={!dirty || saving} onClick={() => { setDraft(cloneSettings(response.settings)); setFieldErrors({}); }}><RotateCcw size={17} /> Discard</button>
            <button className="button primary" type="button" disabled={!dirty || !unlocked || saving} onClick={() => void apply()}><Save size={17} /> {saving ? "Applying..." : "Apply changes"}</button>
          </div>
        </footer>
      ) : null}

      {learningConfirmOpen ? (
        <DialogShell backdropClassName="settings-admin-backdrop" dialogClassName="settings-admin-dialog" labelledBy="learning-confirm-title" describedBy="learning-confirm-description" onClose={() => setLearningConfirmOpen(false)}>
          <header><strong id="learning-confirm-title">Restart signal learning?</strong><button type="button" onClick={() => setLearningConfirmOpen(false)} aria-label="Close"><X size={19} /></button></header>
          <p id="learning-confirm-description">Signal-learning rules are part of every learned baseline. Saving restarts learning for every window: alerts stay Low evidence until a new baseline is approved, and open incidents end.</p>
          <p className="protected-action-hint">To change how easily alerts are raised without restarting learning, use Monitoring › Alert sensitivity instead.</p>
          <div className="settings-admin-actions"><button className="button secondary" type="button" onClick={() => setLearningConfirmOpen(false)}>Cancel</button><button className="button danger" type="button" disabled={saving} onClick={() => void apply(true)}>Restart learning and save</button></div>
        </DialogShell>
      ) : null}

      {adminDialogOpen && response ? (
        <DialogShell backdropClassName="settings-admin-backdrop" dialogClassName="settings-admin-dialog" labelledBy="admin-dialog-title" describedBy="admin-dialog-description" onClose={() => { if (!unlocking) setAdminDialogOpen(false); }} closeOnBackdrop={!unlocking} closeOnEscape={!unlocking}>
          <header>
            <div><LockKeyhole size={20} aria-hidden="true" /><strong id="admin-dialog-title">{response.admin.available ? "Unlock editing" : "Editing unavailable"}</strong></div>
            <button className="icon-button" type="button" onClick={() => setAdminDialogOpen(false)} disabled={unlocking} aria-label="Close unlock dialog"><X size={20} aria-hidden="true" /></button>
          </header>
          {response.admin.available ? (
            <form onSubmit={(event) => { event.preventDefault(); void unlock(); }}>
              <p id="admin-dialog-description">Enter the settings password.</p>
              <label className="form-field" htmlFor="settings-password"><span>Settings password</span><input id="settings-password" type="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} /></label>
              {adminError ? <div className="settings-admin-error" role="alert">{adminError}</div> : null}
              <div className="settings-admin-actions">
                <button className="button secondary" type="button" onClick={() => setAdminDialogOpen(false)} disabled={unlocking}>Cancel</button>
                <button className="button settings-admin-button" type="submit" disabled={unlocking || !password}><UnlockKeyhole size={17} aria-hidden="true" /> {unlocking ? "Checking..." : "Unlock"}</button>
              </div>
            </form>
          ) : (
            <div className="settings-admin-setup">
              <p id="admin-dialog-description">Ask the system administrator to create a settings password.</p>
              <details>
                <summary>Show administrator command</summary>
                <span>Run this on the RF Monitor server:</span>
                <code>sudo rf-monitor reset-admin-password</code>
              </details>
              <div className="settings-admin-actions"><button className="button secondary" type="button" onClick={() => setAdminDialogOpen(false)}>Close</button></div>
            </div>
          )}
        </DialogShell>
      ) : null}

      {closeDialogOpen ? (
        <DialogShell backdropClassName="settings-admin-backdrop" dialogClassName="settings-admin-dialog settings-confirm-dialog" labelledBy="close-settings-title" describedBy="close-settings-description" onClose={() => setCloseDialogOpen(false)}>
          <header><div><RotateCcw size={20} aria-hidden="true" /><strong id="close-settings-title">Discard changes?</strong></div><button className="icon-button" type="button" onClick={() => setCloseDialogOpen(false)} aria-label="Keep editing"><X size={20} aria-hidden="true" /></button></header>
          <div className="settings-dialog-body"><p id="close-settings-description">Your changes have not been applied.</p><div className="settings-admin-actions"><button className="button secondary" type="button" autoFocus onClick={() => setCloseDialogOpen(false)}>Keep editing</button><button className="button danger" type="button" onClick={props.onClose}>Discard and close</button></div></div>
        </DialogShell>
      ) : null}

      {conflict && response && draft ? (
        <DialogShell backdropClassName="settings-admin-backdrop" dialogClassName="settings-admin-dialog settings-conflict-dialog" labelledBy="settings-conflict-title" describedBy="settings-conflict-description" onClose={() => undefined} closeOnBackdrop={false} closeOnEscape={false}>
          <header><div><Activity size={20} aria-hidden="true" /><strong id="settings-conflict-title">Settings changed on the server</strong></div></header>
          <div className="settings-dialog-body">
            <p id="settings-conflict-description">Your draft is safe. Review the server changes before applying again.</p>
            <details><summary>Compare revisions {response.settings.revision} and {conflict.settings.revision}</summary><ul>{settingsChangedPaths(response.settings, conflict.settings).map((path) => <li key={path}>{path}</li>)}</ul></details>
            <div className="settings-admin-actions"><button className="button secondary" type="button" onClick={loadServerSettings}>Load server settings</button><button className="button primary" type="button" onClick={keepDraftAfterConflict}>Keep my draft</button></div>
          </div>
        </DialogShell>
      ) : null}

      {pendingBaselineRestart && response ? (
        <DialogShell backdropClassName="settings-admin-backdrop" dialogClassName="settings-admin-dialog settings-confirm-dialog" labelledBy="restart-baseline-title" describedBy="restart-baseline-description" onClose={() => setPendingBaselineRestart(undefined)}>
          <header><div><RotateCcw size={20} aria-hidden="true" /><strong id="restart-baseline-title">Start learning again?</strong></div><button className="icon-button" type="button" onClick={() => setPendingBaselineRestart(undefined)} aria-label="Cancel signal learning restart"><X size={20} aria-hidden="true" /></button></header>
          <div className="settings-dialog-body"><p id="restart-baseline-description">Start a new learning period for {learningTargets.find((target) => target.targetId === pendingBaselineRestart.targetId)?.label ?? response.catalog.captureTargets.find((target) => target.id === pendingBaselineRestart.targetId)?.label ?? friendlyTargetId(pendingBaselineRestart.targetId)}. The approved normal level and recorded evidence are kept. Alerts are Low evidence until learning is approved.</p>{isRestartBlocked(pendingBaselineRestart.targetId) ? <p role="note"><strong>Alert active.</strong> Starting again ends it. The incident stays in Evidence History.</p> : null}<div className="settings-admin-actions"><button className="button secondary" type="button" autoFocus onClick={() => setPendingBaselineRestart(undefined)}>Cancel</button><button className="button danger" type="button" onClick={() => { const baseline = pendingBaselineRestart; setPendingBaselineRestart(undefined); void updateBaseline("restart", baseline); }}>Start learning</button></div></div>
        </DialogShell>
      ) : null}

      {pendingMaintenance && maintenanceCopy ? (
        <DialogShell backdropClassName="settings-admin-backdrop" dialogClassName="settings-admin-dialog settings-confirm-dialog" labelledBy="maintenance-action-title" describedBy="maintenance-action-description" onClose={() => { if (!maintenanceBusy) setPendingMaintenance(undefined); }} closeOnBackdrop={!maintenanceBusy} closeOnEscape={!maintenanceBusy}>
          <header><div><RotateCcw size={20} aria-hidden="true" /><strong id="maintenance-action-title">{maintenanceCopy.title}</strong></div><button className="icon-button" type="button" disabled={maintenanceBusy} onClick={() => setPendingMaintenance(undefined)} aria-label="Cancel protected action"><X size={20} aria-hidden="true" /></button></header>
          <div className="settings-dialog-body">
            <p id="maintenance-action-description">{maintenanceCopy.changes}</p>
            <p><strong>Kept:</strong> {maintenanceCopy.retained}</p>
            <label className="form-field" htmlFor="maintenance-confirmation"><span>Type {MAINTENANCE_CONFIRMATION[pendingMaintenance]}</span><input id="maintenance-confirmation" autoFocus autoComplete="off" value={maintenanceConfirmation} onChange={(event) => setMaintenanceConfirmation(event.target.value)} /></label>
            <div className="settings-admin-actions"><button className="button secondary" type="button" disabled={maintenanceBusy} onClick={() => setPendingMaintenance(undefined)}>Cancel</button><button className="button danger" type="button" disabled={maintenanceBusy || maintenanceConfirmation !== MAINTENANCE_CONFIRMATION[pendingMaintenance]} onClick={() => void runMaintenance()}>{maintenanceBusy ? "Working…" : maintenanceCopy.button}</button></div>
          </div>
        </DialogShell>
      ) : null}
    </div>
  );
}

function SystemHealthPlaceholder() {
  return (
    <section className="settings-section" aria-labelledby="system-health-title">
      <h1 id="system-health-title">System health</h1>
      <p>Live diagnostics are not available yet.</p>
      <div className="settings-health-placeholder"><Activity size={22} aria-hidden="true" /><div><strong>Waiting for diagnostics</strong><span>Monitoring and evidence recording continue.</span></div></div>
    </section>
  );
}

function MonitoringSettings({ response, draft, current, setDraft, errors, disabled, getAlertPreview }: {
  response: SettingsRevision;
  draft: OperationalSettings;
  current: OperationalSettings;
  setDraft: (value: OperationalSettings) => void;
  errors: Record<string, string>;
  disabled: boolean;
  getAlertPreview?: () => Promise<AlertPreview>;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ startrack: true, "4dx": false });
  const [previewMission, setPreviewMission] = useState<Exclude<MonitoringMission, "custom">>();
  const startrack = serviceBand(response, "startrack");
  const fourDx = serviceBand(response, "4dx");
  const fourDxChannelCount = channelCount(fourDx);
  const services = new Map(response.catalog.services.map((service) => [service.id, service]));
  const configuredMission = monitoringMissionForSettings(draft, response.catalog);
  const viewSettings = useMemo(() => {
    if (!disabled || !previewMission || previewMission === configuredMission) return draft;
    try {
      return applyMonitoringMission(draft, response.catalog, previewMission);
    } catch {
      return draft;
    }
  }, [configuredMission, disabled, draft, previewMission, response.catalog]);
  const mission = disabled && previewMission ? previewMission : configuredMission;
  const currentMission = monitoringMissionForSettings(current, response.catalog);
  const monitoringTargets = response.catalog.captureTargets.filter((target) => target.service === "gnss" || target.service === "fugro");
  const continuousTarget = monitoringTargets.find((target) => target.id === continuousWatchTargetId(viewSettings, response.catalog));
  const currentContinuousTargetId = continuousWatchTargetId(current, response.catalog);
  const selectedTargetIds = selectedMonitoringTargetIds(viewSettings, response.catalog);
  const fugroBeams = response.catalog.bands.filter((band) => band.service === "fugro" && band.correctionBeam);
  const draftState = useMemo(() => {
    try {
      const bands = compileEffectiveBands(response.catalog, viewSettings);
      const evaluated = evaluateSettingsFeasibility({
        settings: viewSettings,
        catalog: response.catalog,
        sampleRateHz: response.infrastructure.sampleRateHz,
        measurementAvailable: !response.commissioning.simulation,
      });
      const feasibility = JSON.stringify(viewSettings) === JSON.stringify(current)
        ? { ...evaluated, ...response.feasibility }
        : evaluated;
      return {
        bands,
        estimatedRevisitMs: estimateRevisitMs(bands, response.infrastructure.sampleRateHz),
        feasibility,
      };
    } catch {
      return undefined;
    }
  }, [current, response.catalog, response.commissioning.simulation, response.feasibility, response.infrastructure.sampleRateHz, viewSettings]);
  const update = (mutate: (next: OperationalSettings) => void) => {
    const next = cloneSettings(draft);
    mutate(next);
    setDraft(next);
  };
  const chooseMission = (nextMission: Exclude<MonitoringMission, "custom">) => {
    if (disabled) {
      setPreviewMission(nextMission);
      if (nextMission === "radio-survey") setExpanded({ startrack: true, "4dx": false });
      return;
    }
    setPreviewMission(undefined);
    setDraft(applyMonitoringMission(draft, response.catalog, nextMission));
    if (nextMission === "radio-survey") setExpanded({ startrack: true, "4dx": false });
  };
  const serviceState = (service: "startrack" | "4dx"): ServiceDisplayState => {
    const enabled = service === "startrack" ? viewSettings.monitoring.startrack.enabled : viewSettings.monitoring["4dx"].enabled;
    if (!enabled) return "Off";
    if (!draftState?.feasibility.optionalWorkAdmitted) return "Paused";
    const currentEnabled = service === "startrack" ? current.monitoring.startrack.enabled : current.monitoring["4dx"].enabled;
    return currentMission !== "radio-survey" || !currentEnabled ? "Will monitor" : "Monitoring";
  };
  const measuredRevisit = draftState?.feasibility.revisitObjective === "meeting"
    ? "Meeting"
    : draftState?.feasibility.revisitObjective === "missed"
      ? "Misses"
      : "Not verified";
  const capacity = draftState ? scheduleCapacityCopy(draftState.feasibility) : undefined;
  return (
    <section className="settings-section" aria-labelledby="monitoring-settings-title">
      <div className="settings-title-row">
        <div><h1 id="monitoring-settings-title">Monitoring</h1><p>{disabled ? "Review tasks. Unlock to change." : "Choose one task."}</p></div>
        <div className="coverage-estimate"><span>Estimated schedule</span><strong>{draftState ? formatRevisit(draftState.estimatedRevisitMs) : "Check selection"}</strong><small>Measured: {measuredRevisit}</small></div>
      </div>
      {errors.monitoring ? <FieldError text={errors.monitoring} /> : null}

      <MissionChoiceGroup value={mission} disabled={false} onChange={chooseMission} />
      {mission === "custom" ? <div className="mission-custom-state"><strong>Current setup</strong><span>Choose a task to replace it.</span></div> : null}

      {mission === "continuous-watch" ? (
        <div className="mission-panel">
          <div className="mission-panel-heading"><strong>Frequency window</strong><span>Watched continuously</span></div>
          <FrequencyWindowPicker
            mode="single"
            targets={monitoringTargets}
            catalog={response.catalog}
            settings={viewSettings}
            selectedIds={continuousTarget ? [continuousTarget.id] : []}
            disabled={disabled}
            onToggle={(targetId) => setDraft(applyMonitoringMission(draft, response.catalog, "continuous-watch", targetId))}
          />
          {continuousTarget ? <div className="mission-target-summary"><span>{currentMission === "continuous-watch" && currentContinuousTargetId === continuousTarget.id ? "Monitoring" : "Will monitor"}</span><strong>{captureWindowNaming({ serviceLabel: services.get(continuousTarget.service)?.label ?? continuousTarget.service, fallbackLabel: continuousTarget.label, centerHz: continuousTarget.centerHz, signals: continuousTarget.relatedBandIds.flatMap((bandId) => { const band = response.catalog.bands.find((candidate) => candidate.id === bandId); return band ? [{ label: band.label, centerHz: band.centerHz }] : []; }) }).label}</strong><small>{formatFrequency(continuousTarget.nominalDisplayHz ?? continuousTarget.centerHz, 3)}</small></div> : null}
          {continuousTarget?.service === "fugro" ? <FugroBeamPicker beams={fugroBeams} selectedIds={viewSettings.monitoring.fugro.selectedBeamIds} disabled={disabled} error={errors["monitoring.fugro.selectedBeamIds"]} onChange={(selectedBeamIds) => update((next) => { next.monitoring.fugro.selectedBeamIds = selectedBeamIds; })} /> : null}
        </div>
      ) : null}

      {mission === "gnss-survey" || mission === "gnss-fugro-survey" ? (
        <div className="mission-panel">
          <div className="mission-panel-heading"><strong>Frequency windows</strong><span>{mission === "gnss-fugro-survey" ? "Navigation and corrections on one receiver" : `${selectedTargetIds.length} checked in turn`}</span></div>
          <p className="correction-watch-note">One receiver checks the selected windows in turn.</p>
          {draftState && capacity ? (
            <div className={`schedule-capacity ${capacity.state === "available" ? "" : "attention"}`} role={capacity.state === "overloaded" ? "alert" : "status"}>
              <strong>{capacity.headline}</strong>
              <span>{capacity.detail}</span>
            </div>
          ) : null}
          <FrequencyWindowPicker
            mode="multiple"
            targets={monitoringTargets}
            catalog={response.catalog}
            settings={viewSettings}
            selectedIds={selectedTargetIds}
            disabled={disabled}
            onToggle={(targetId) => {
              const checked = selectedTargetIds.includes(targetId);
              const nextIds = checked ? selectedTargetIds.filter((id) => id !== targetId) : [...selectedTargetIds, targetId];
              if (nextIds.length >= 2) setDraft(applyMonitoringMission(draft, response.catalog, mission === "gnss-fugro-survey" ? "gnss-fugro-survey" : "gnss-survey", nextIds));
            }}
          />
          {viewSettings.monitoring.fugro.enabled ? <FugroBeamPicker beams={fugroBeams} selectedIds={viewSettings.monitoring.fugro.selectedBeamIds} disabled={disabled} error={errors["monitoring.fugro.selectedBeamIds"]} onChange={(selectedBeamIds) => update((next) => { next.monitoring.fugro.selectedBeamIds = selectedBeamIds; })} /> : null}
        </div>
      ) : null}

      {mission === "radio-survey" ? (
        <div className="radio-mission-services">
          <div className="mission-panel-heading"><strong>Radio services</strong><span>Choose one or both</span></div>
          <ServiceEditor
            label={services.get("startrack")!.label}
            description={services.get("startrack")?.description ?? ""}
            enabled={viewSettings.monitoring.startrack.enabled}
            state={serviceState("startrack")}
            disabled={disabled}
            toggleDisabled={viewSettings.monitoring.startrack.enabled && !viewSettings.monitoring["4dx"].enabled}
            expanded={expanded.startrack}
            icon={<RadioTower size={22} />}
            summary={viewSettings.monitoring.startrack.channels.mode === "all" ? formatRange(startrack.startHz, startrack.endHz) : `${viewSettings.monitoring.startrack.channels.frequenciesHz.length} selected frequencies`}
            onToggle={() => update((next) => { next.monitoring.startrack.enabled = !next.monitoring.startrack.enabled; })}
            onExpand={() => setExpanded((currentExpanded) => ({ ...currentExpanded, startrack: !currentExpanded.startrack }))}
          >
            <SegmentedControl ariaLabel={`${services.get("startrack")!.label} frequency selection`} disabled={disabled} value={viewSettings.monitoring.startrack.channels.mode} options={[{ value: "all", label: "All frequencies" }, { value: "frequencies", label: "Selected frequencies" }]} onChange={(value) => update((next) => { next.monitoring.startrack.channels.mode = value as "all" | "frequencies"; })} />
            {viewSettings.monitoring.startrack.channels.mode === "frequencies" ? <StarTrackFrequencies disabled={disabled} band={startrack} values={viewSettings.monitoring.startrack.channels.frequenciesHz} error={errors["monitoring.startrack.frequenciesHz"]} onChange={(values) => update((next) => { next.monitoring.startrack.channels.frequenciesHz = values; })} /> : <div className="selection-summary"><ShieldCheck size={17} /> {formatRange(startrack.startHz, startrack.endHz)} · {formatChannelSpacing(startrack.channelSpacingHz!)} steps</div>}
          </ServiceEditor>

          <ServiceEditor
            label={services.get("4dx")!.label}
            description={services.get("4dx")?.description ?? ""}
            enabled={viewSettings.monitoring["4dx"].enabled}
            state={serviceState("4dx")}
            disabled={disabled}
            toggleDisabled={viewSettings.monitoring["4dx"].enabled && !viewSettings.monitoring.startrack.enabled}
            expanded={expanded["4dx"]}
            icon={<RadioTower size={22} />}
            summary={viewSettings.monitoring["4dx"].channels.mode === "all" ? `All ${fourDxChannelCount} channels` : `Channels ${viewSettings.monitoring["4dx"].channels.startChannel}-${viewSettings.monitoring["4dx"].channels.endChannel}`}
            onToggle={() => update((next) => { next.monitoring["4dx"].enabled = !next.monitoring["4dx"].enabled; })}
            onExpand={() => setExpanded((currentExpanded) => ({ ...currentExpanded, "4dx": !currentExpanded["4dx"] }))}
          >
            <SegmentedControl ariaLabel={`${services.get("4dx")!.label} channel selection`} disabled={disabled} value={viewSettings.monitoring["4dx"].channels.mode} options={[{ value: "all", label: `All ${fourDxChannelCount} channels` }, { value: "range", label: "Selected channels" }]} onChange={(value) => update((next) => { next.monitoring["4dx"].channels.mode = value as "all" | "range"; })} />
            {viewSettings.monitoring["4dx"].channels.mode === "range" ? <div className="inline-fields channel-range-fields"><NumberField disabled={disabled} label="Start channel" min={1} max={fourDxChannelCount} value={viewSettings.monitoring["4dx"].channels.startChannel ?? 1} onChange={(value) => update((next) => { next.monitoring["4dx"].channels.startChannel = value; })} /><NumberField disabled={disabled} label="End channel" min={1} max={fourDxChannelCount} value={viewSettings.monitoring["4dx"].channels.endChannel ?? fourDxChannelCount} onChange={(value) => update((next) => { next.monitoring["4dx"].channels.endChannel = value; })} /><div className="calculated-field"><span>Frequency range</span><strong>{fourDxRange(fourDx, viewSettings.monitoring["4dx"].channels.startChannel ?? 1, viewSettings.monitoring["4dx"].channels.endChannel ?? fourDxChannelCount)}</strong></div></div> : <div className="selection-summary"><ShieldCheck size={17} /> Channels 1-{fourDxChannelCount} · {formatFrequency(fourDx.startHz, 3)} to {formatFrequency(fourDx.endHz, 3)}</div>}
            {errors["monitoring.4dx.range"] ? <FieldError text={errors["monitoring.4dx.range"]} /> : null}
          </ServiceEditor>
        </div>
      ) : null}
      <AlertSensitivitySection response={response} draft={draft} setDraft={setDraft} disabled={disabled} errors={errors} getAlertPreview={getAlertPreview} />
    </section>
  );
}

const MISSION_OPTIONS: Array<{ value: Exclude<MonitoringMission, "custom">; label: string; detail: string }> = [
  { value: "continuous-watch", label: "Continuous Watch", detail: "One frequency window" },
  { value: "gnss-survey", label: "GNSS", detail: "Priority navigation windows" },
  { value: "gnss-fugro-survey", label: "GNSS + Fugro", detail: "Navigation windows and corrections" },
  { value: "radio-survey", label: "Radio Survey", detail: "StarTrack and 4DX" },
];

function FrequencyWindowPicker({ mode, targets, catalog, settings, selectedIds, disabled, onToggle }: {
  mode: "single" | "multiple";
  targets: PhysicalCaptureTarget[];
  catalog: BandCatalog;
  settings: OperationalSettings;
  selectedIds: string[];
  disabled: boolean;
  onToggle: (targetId: string) => void;
}) {
  const bandsById = new Map(catalog.bands.map((band) => [band.id, band]));
  const serviceLabels = new Map(catalog.services.map((service) => [service.id, service.label]));
  return <div className="frequency-window-list" role={mode === "single" ? "radiogroup" : "group"} aria-label="Frequency windows">{targets.map((target) => {
    const checked = selectedIds.includes(target.id);
    const naming = captureWindowNaming({
      serviceLabel: serviceLabels.get(target.service) ?? target.service,
      fallbackLabel: target.label,
      centerHz: target.centerHz,
      signals: target.relatedBandIds.flatMap((bandId) => {
        const band = bandsById.get(bandId);
        return band ? [{ label: band.label, centerHz: band.centerHz }] : [];
      }),
    });
    return <label key={target.id} className={checked ? "selected" : ""}>
      <input type={mode === "single" ? "radio" : "checkbox"} name={mode === "single" ? "continuous-frequency-window" : undefined} checked={checked} disabled={disabled || (mode === "multiple" && checked && selectedIds.length <= 2)} onChange={() => onToggle(target.id)} />
      <span><strong>{naming.label}</strong><small>{naming.signalsLabel ?? (target.service === "fugro" ? "Fugro corrections" : "GNSS")} · {windowScheduleCopy(windowSchedule({ target, settings, catalog }))}</small></span>
      <b>{formatFrequency(target.nominalDisplayHz ?? target.centerHz, 3)}</b>
    </label>;
  })}</div>;
}

function FugroBeamPicker({ beams, selectedIds, disabled, error, onChange }: { beams: BandPreset[]; selectedIds: string[]; disabled: boolean; error?: string; onChange: (ids: string[]) => void }) {
  return <div className="fugro-beam-picker">
    <div className="mission-panel-heading"><strong>Fugro satellites</strong><a href="https://fsp.support/beams/" target="_blank" rel="noreferrer">View coverage map</a></div>
    <p className="correction-watch-note">Choose the expected beams. They share one frequency window.</p>
    <div className="correction-beam-list" role="group" aria-label="Expected Fugro correction beams">{beams.map((beam) => {
      const metadata = beam.correctionBeam!;
      const checked = selectedIds.includes(beam.id);
      return <label key={beam.id} className={checked ? "selected" : ""}>
        <input type="checkbox" checked={checked} disabled={disabled || (checked && selectedIds.length === 1)} onChange={() => onChange(checked ? selectedIds.filter((id) => id !== beam.id) : [...selectedIds, beam.id])} />
        <span><strong>{beam.label}</strong><small>{orbitalLongitude(metadata.orbitalLongitudeDeg)} · Link {metadata.linkId}</small></span>
        <span><b>{formatFrequency(beam.centerHz, 3)}</b><small>{metadata.symbolRateHz.toLocaleString()} symbols/s · {metadata.bitRateBps.toLocaleString()} bps</small></span>
      </label>;
    })}</div>
    {error ? <FieldError text={error} /> : null}
  </div>;
}

function MissionChoiceGroup({ value, disabled, onChange }: { value: MonitoringMission; disabled: boolean; onChange: (value: Exclude<MonitoringMission, "custom">) => void }) {
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? (index + 1) % MISSION_OPTIONS.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? (index - 1 + MISSION_OPTIONS.length) % MISSION_OPTIONS.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? MISSION_OPTIONS.length - 1
            : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const group = event.currentTarget.parentElement;
    onChange(MISSION_OPTIONS[nextIndex].value);
    window.requestAnimationFrame(() => group?.querySelectorAll<HTMLButtonElement>("[role=radio]")[nextIndex]?.focus());
  };
  return <div className="mission-choice-grid" role="radiogroup" aria-label="Monitoring task">{MISSION_OPTIONS.map((option, index) => <button key={option.value} type="button" role="radio" aria-checked={value === option.value} tabIndex={value === option.value || (value === "custom" && index === 0) ? 0 : -1} className={value === option.value ? "selected" : ""} disabled={disabled} onKeyDown={(event) => move(event, index)} onClick={() => onChange(option.value)}><strong>{option.label}</strong><span>{option.detail}</span></button>)}</div>;
}

function ServiceEditor(props: { label: string; description: string; enabled: boolean; state: ServiceDisplayState; disabled: boolean; toggleDisabled?: boolean; expanded: boolean; icon: React.ReactNode; summary: string; onToggle: () => void; onExpand: () => void; children: React.ReactNode }) {
  const stateClass = props.state.toLowerCase().replace(" ", "-");
  return (
    <div className={`service-editor ${props.enabled ? "enabled" : "disabled"} state-${stateClass}`}>
      <div className="service-editor-header">
        <button className="expand-button" type="button" onClick={props.onExpand} aria-expanded={props.expanded} aria-label={`${props.expanded ? "Collapse" : "Expand"} ${props.label}`}>{props.expanded ? <ChevronDown size={19} aria-hidden="true" /> : <ChevronRight size={19} aria-hidden="true" />}</button>
        <div className="service-editor-icon" aria-hidden="true">{props.icon}</div>
        <button className="service-editor-copy" type="button" onClick={props.onExpand} aria-expanded={props.expanded}><strong>{props.label}</strong><span>{props.summary}</span></button>
        <label className="switch-control"><input type="checkbox" role="switch" aria-label={`Monitor ${props.label}`} disabled={props.disabled || props.toggleDisabled} checked={props.enabled} onChange={props.onToggle} /><span aria-hidden="true" /><b className={`service-state ${stateClass}`}>{props.state}</b></label>
      </div>
      {props.expanded ? <div className="service-editor-body">{props.children}</div> : null}
    </div>
  );
}

function SegmentedControl({ value, options, ariaLabel, disabled = false, onChange }: { value: string; options: Array<{ value: string; label: string }>; ariaLabel: string; disabled?: boolean; onChange: (value: string) => void }) {
  const move = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const nextIndex = event.key === "ArrowRight" || event.key === "ArrowDown"
      ? (index + 1) % options.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? (index - 1 + options.length) % options.length
        : event.key === "Home"
          ? 0
          : event.key === "End"
            ? options.length - 1
            : undefined;
    if (nextIndex === undefined) return;
    event.preventDefault();
    const group = event.currentTarget.parentElement;
    onChange(options[nextIndex].value);
    window.requestAnimationFrame(() => group?.querySelectorAll<HTMLButtonElement>("[role=radio]")[nextIndex]?.focus());
  };
  return <div className="segmented-control" role="radiogroup" aria-label={ariaLabel}>{options.map((option, index) => <button key={option.value} className={value === option.value ? "selected" : ""} type="button" role="radio" aria-checked={value === option.value} tabIndex={value === option.value ? 0 : -1} disabled={disabled} onKeyDown={(event) => move(event, index)} onClick={() => onChange(option.value)}>{option.label}</button>)}</div>;
}

function StarTrackFrequencies({ band, values, error, disabled, onChange }: { band: BandPreset; values: number[]; error?: string; disabled: boolean; onChange: (values: number[]) => void }) {
  const [value, setValue] = useState((band.centerHz / 1_000_000).toFixed(3));
  const [localError, setLocalError] = useState<string>();
  const add = () => {
    const frequency = Math.round(Number(value) * 1_000_000);
    if (!Number.isFinite(frequency) || frequency < band.startHz || frequency > band.endHz || (frequency - band.startHz) % band.channelSpacingHz! !== 0) {
      setLocalError(`Enter ${formatFrequency(band.startHz, 3)}-${formatFrequency(band.endHz, 3)} on a ${formatFrequency(band.channelSpacingHz!, 3)} step`);
      return;
    }
    setLocalError(undefined);
    onChange([...new Set([...values, frequency])].sort((left, right) => left - right));
  };
  return (
    <div className="frequency-picker">
      <div className="frequency-add-row">
        <label><span>Frequency</span><div><input type="number" disabled={disabled} min={band.startHz / 1_000_000} max={band.endHz / 1_000_000} step={band.channelSpacingHz! / 1_000_000} value={value} onChange={(event) => setValue(event.target.value)} /><b>MHz</b></div></label>
        <button className="button secondary" type="button" disabled={disabled} onClick={add}>Add frequency</button>
      </div>
      {localError || error ? <FieldError text={localError ?? error!} /> : null}
      <div className="frequency-list">
        {values.length ? values.map((frequency) => <span key={frequency}>{formatFrequency(frequency, 3)}<button type="button" disabled={disabled} onClick={() => onChange(values.filter((candidate) => candidate !== frequency))} aria-label={`Remove ${formatFrequency(frequency, 3)}`}><X size={14} aria-hidden="true" /></button></span>) : <em>No frequencies selected</em>}
      </div>
    </div>
  );
}

function SiteSettings({ draft, setDraft, response, errors, disabled, uploadLogo, onToast }: { draft: OperationalSettings; setDraft: (value: OperationalSettings) => void; response: SettingsRevision; errors: Record<string, string>; disabled: boolean; uploadLogo?: (file: File) => Promise<ReportLogo>; onToast: (message: string) => void }) {
  const update = <K extends keyof OperationalSettings>(key: K, value: OperationalSettings[K]) => setDraft({ ...draft, [key]: value });
  return (
    <section className="settings-section narrow-settings" aria-labelledby="site-settings-title">
      <h1 id="site-settings-title">Site</h1>
      <p>Names used on the dashboard and in evidence.</p>
      <TextField disabled={disabled} label="Site name" value={draft.siteName} maxLength={80} error={errors.siteName} onChange={(value) => update("siteName", value)} />
      <TextField disabled={disabled} label="Deployment ID" value={draft.deploymentId ?? ""} maxLength={80} error={errors.deploymentId} onChange={(value) => update("deploymentId", value || undefined)} />
      <label className="form-field"><span>Display time zone</span><select disabled={disabled} value={draft.displayTimeZone} onChange={(event) => update("displayTimeZone", event.target.value)}>{timeZones(draft.displayTimeZone).map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select>{errors.displayTimeZone ? <FieldError text={errors.displayTimeZone} /> : null}</label>
      <div className="read-only-grid"><span>Evidence timestamp</span><strong>UTC ISO-8601</strong><span>Dashboard endpoint</span><strong>{location.origin}</strong><span>SDRconnect</span><strong>{response.infrastructure.receiverUrls.join(", ")}</strong></div>
      <ReportIdentitySection draft={draft} setDraft={setDraft} disabled={disabled} errors={errors} uploadLogo={uploadLogo} onToast={onToast} />
    </section>
  );
}

function EvidenceSettings({ draft, setDraft, response, errors, disabled, dataDomain, onMaintenance }: { draft: OperationalSettings; setDraft: (value: OperationalSettings) => void; response: SettingsRevision; errors: Record<string, string>; disabled: boolean; dataDomain: MonitorSnapshot["dataDomain"]; onMaintenance: (action: MaintenanceAction) => void }) {
  const update = (key: keyof OperationalSettings["retention"], value: number) => setDraft({ ...draft, retention: { ...draft.retention, [key]: value } });
  return (
    <section className="settings-section narrow-settings" aria-labelledby="evidence-settings-title">
      <h1 id="evidence-settings-title">Recording</h1>
      <p>Evidence retention and disk reserve.</p>
      <div className="settings-form-grid">
        <NumberField disabled={disabled} label="Keep evidence for" suffix="days" min={1} max={3650} value={days(draft.retention.retentionMs)} onChange={(value) => update("retentionMs", value * 86_400_000)} />
        <NumberField disabled={disabled} label="Maximum archive size" suffix="GB" min={1} max={100000} step={0.1} value={gib(draft.retention.storageMaxBytes)} onChange={(value) => update("storageMaxBytes", Math.round(value * 1_073_741_824))} />
        <NumberField disabled={disabled} label="Keep disk space free" suffix="GB" min={0} max={100000} step={0.1} value={gib(draft.retention.minimumFreeBytes)} onChange={(value) => update("minimumFreeBytes", Math.round(value * 1_073_741_824))} />
        <NumberField disabled={disabled} label="Close each session after" suffix="hours" min={1} max={24} value={hours(draft.retention.sessionMaxMs)} onChange={(value) => update("sessionMaxMs", value * 3_600_000)} />
        <NumberField disabled={disabled} label="Maximum session size" suffix="GB" min={0.1} max={2} step={0.1} value={gib(draft.retention.sessionMaxBytes)} onChange={(value) => update("sessionMaxBytes", Math.round(value * 1_073_741_824))} />
      </div>
      <h3 className="settings-subheading">Incident images</h3>
      <div className="settings-form-grid">
<div className="form-field"><span>Save an image of each incident</span>        <label className="switch-control"><input type="checkbox" role="switch" aria-label="Save an image of each incident" disabled={disabled} checked={incidentFigurePolicy(draft.retention).enabled} onChange={(event) => setDraft({ ...draft, retention: { ...draft.retention, incidentFiguresEnabled: event.target.checked } })} /><span aria-hidden="true" /><b className="service-state">{incidentFigurePolicy(draft.retention).enabled ? "Save images" : "Off"}</b></label></div>
        <NumberField disabled={disabled || !incidentFigurePolicy(draft.retention).enabled} label="Delete images after" suffix="days" min={1} max={365} value={days(incidentFigurePolicy(draft.retention).retentionMs)} onChange={(value) => update("incidentFigureRetentionMs", value * 86_400_000)} />
      </div>
      <p className="protected-action-hint">Each image is time stamped and saved when an incident starts, while it lasts, and when it ends. Older images are deleted automatically.</p>
      {Object.entries(errors).filter(([key]) => key.startsWith("retention.")).map(([key, text]) => <FieldError key={key} text={text} />)}
      <div className="read-only-grid"><span>Archive path</span><strong>{response.infrastructure.storageRoot}</strong><span>Current policy</span><strong>{formatBytes(response.settings.retention.storageMaxBytes)} maximum</strong><span>Image share folder</span><strong>{response.infrastructure.shareDirectory ?? "Not set up (sudo rf-monitor share-evidence)"}</strong></div>
      <section className="protected-actions" aria-labelledby="recording-actions-title">
        <header><strong id="recording-actions-title">Protected data actions</strong><span>{disabled ? "Unlock to use" : dataDomain === "field" ? "Field monitoring" : "Simulation / Test"}</span></header>
        <div className="protected-action-row">
          <span><strong>Clear test data</strong><small>Deletes test recordings and test signal learning. Field data is kept.</small></span>
          <button className="button secondary compact" type="button" disabled={disabled} onClick={() => onMaintenance("clear-test-data")}>Clear test data</button>
        </div>
        <div className="protected-action-row danger">
          <span><strong>Delete {dataDomain === "field" ? "Field" : "Test"} recordings</strong><small>Deletes finalized recordings only. Signal learning and settings are kept.</small></span>
          <button className="button danger compact" type="button" disabled={disabled} onClick={() => onMaintenance("delete-recordings")}>Delete recordings</button>
        </div>
      </section>
    </section>
  );
}

function AdvancedSettings({ response, draft, setDraft, errors, unlocked, onMaintenance }: {
  response: SettingsRevision;
  draft: OperationalSettings;
  setDraft: (value: OperationalSettings) => void;
  errors: Record<string, string>;
  unlocked: boolean;
  onMaintenance: (action: MaintenanceAction) => void;
}) {
  const updateDetection = (key: keyof OperationalSettings["detection"], value: number) => setDraft({ ...draft, detection: { ...draft.detection, [key]: value } });
  const updateScan = (kind: "dwellMs" | "priority", service: "startrack" | "4dx" | "gnss" | "fugro", value: number) => setDraft({ ...draft, scan: { ...draft.scan, [kind]: { ...draft.scan[kind], [service]: value } } });
  const detectionDefaults = response.detectionDefaults ?? ROBUST_DETECTION_DEFAULTS;
  const detectionIsDefault = useMemo(
    () => JSON.stringify(draft.detection) === JSON.stringify(detectionDefaults),
    [detectionDefaults, draft.detection],
  );
  return (
    <section className="settings-section" aria-labelledby="advanced-settings-title">
      <h1 id="advanced-settings-title">Advanced</h1>
      <div className="advanced-settings-groups">
        <details className="advanced-settings-group">
          <summary><span><strong>Scan timing</strong></span><ChevronDown size={18} aria-hidden="true" /></summary>
          <div className="advanced-settings-body">
            <div className="read-only-grid"><span>Primary band</span><strong>{response.catalog.priorityWindows.find((window) => window.id === draft.scan.priorityWindowId)?.label ?? response.catalog.captureTargets.find((target) => target.id === draft.scan.priorityWindowId)?.label ?? draft.scan.priorityWindowId}</strong><span>Maximum planned gap</span><strong>{Math.round(draft.scan.maxPriorityGapMs / 1000)} seconds</strong></div>
            <div className="engineer-table">
              <div className="engineer-row header"><span>Service</span><span>Dwell</span><span>Priority</span></div>
              {response.catalog.services.map((service) => (
                <div className="engineer-row" key={service.id}><strong>{service.label}</strong><NumberField disabled={!unlocked} compact suffix="ms" min={250} max={300000} value={draft.scan.dwellMs[service.id]} onChange={(value) => updateScan("dwellMs", service.id, value)} /><NumberField disabled={!unlocked} compact min={0} max={10} value={draft.scan.priority[service.id]} onChange={(value) => updateScan("priority", service.id, value)} /></div>
              ))}
            </div>
            {Object.entries(errors).filter(([key]) => key.startsWith("scan.")).map(([key, text]) => <FieldError key={key} text={text} />)}
          </div>
        </details>

        <details className="advanced-settings-group">
          <summary><span><strong>Alert rules</strong><small>Custom alert sensitivity</small></span><ChevronDown size={18} aria-hidden="true" /></summary>
          <div className="advanced-settings-body">
            <AlertRulesEditor response={response} draft={draft} setDraft={setDraft} disabled={!unlocked} errors={errors} />
          </div>
        </details>

        <details className="advanced-settings-group">
          <summary><span><strong>Signal-learning rules</strong><small>Changing these restarts learning</small></span><ChevronDown size={18} aria-hidden="true" /></summary>
          <div className="advanced-settings-body">
            <div className="schedule-capacity attention"><strong>Restarts learning</strong><span>These rules are part of every learned baseline. Saving a change restarts signal learning for every window and ends open incidents. To change when alerts are raised, use Monitoring › Alert sensitivity.</span></div>
            <div className="settings-form-grid detection-grid">
              <NumberField disabled={!unlocked} label="Scale floor" suffix="relative bin" min={0.1} max={32} step={0.1} value={draft.detection.scaleFloorBins} onChange={(value) => updateDetection("scaleFloorBins", value)} />
              <NumberField disabled={!unlocked} label="Wideband observation" suffix="robust scales" min={0.1} max={50} step={0.1} value={draft.detection.widebandObservationSigma} onChange={(value) => updateDetection("widebandObservationSigma", value)} />
              <NumberField disabled={!unlocked} label="Wideband occupancy" suffix="%" min={0} max={100} step={0.1} value={draft.detection.widebandObservationOccupancy * 100} onChange={(value) => updateDetection("widebandObservationOccupancy", value / 100)} />
              <NumberField disabled={!unlocked} label="Interference threshold" suffix="robust scales" min={0.1} max={50} step={0.1} value={draft.detection.interferenceSigma} onChange={(value) => updateDetection("interferenceSigma", value)} />
              <NumberField disabled={!unlocked} label="Interference occupancy" suffix="%" min={0} max={100} step={0.1} value={draft.detection.interferenceOccupancy * 100} onChange={(value) => updateDetection("interferenceOccupancy", value / 100)} />
              <NumberField disabled={!unlocked} label="Narrowband peak" suffix="robust scales" min={0.1} max={100} step={0.1} value={draft.detection.narrowbandPeakSigma} onChange={(value) => updateDetection("narrowbandPeakSigma", value)} />
              <NumberField disabled={!unlocked} label="Narrowband width maximum" suffix="%" min={0} max={100} step={0.1} value={draft.detection.narrowbandMaxWidthRatio * 100} onChange={(value) => updateDetection("narrowbandMaxWidthRatio", value / 100)} />
              <NumberField disabled={!unlocked} label="Slow drift" suffix="robust scales" min={0.1} max={50} step={0.1} value={draft.detection.driftSigma} onChange={(value) => updateDetection("driftSigma", value)} />
              <NumberField disabled={!unlocked} label="Required visits" min={1} max={draft.detection.interferenceWindow} value={draft.detection.interferenceHits} onChange={(value) => updateDetection("interferenceHits", value)} />
              <NumberField disabled={!unlocked} label="Voting window" suffix="visits" min={1} max={20} value={draft.detection.interferenceWindow} onChange={(value) => updateDetection("interferenceWindow", value)} />
              <NumberField disabled={!unlocked} label="Clear after" suffix="clean visits" min={1} max={100} value={draft.detection.clearObservations} onChange={(value) => updateDetection("clearObservations", value)} />
            </div>
            <div className="protected-action-row">
              <span><strong>Reset signal-learning rules</strong><small>Returns these values to the supplied defaults. Nothing is saved until you select Apply changes.</small></span>
              <button className="button secondary compact" type="button" disabled={!unlocked || detectionIsDefault} onClick={() => setDraft({ ...draft, detection: { ...detectionDefaults } })}>Reset to defaults</button>
            </div>
            {Object.entries(errors).filter(([key]) => key.startsWith("detection.")).map(([key, text]) => <FieldError key={key} text={`${DETECTION_FIELD_LABELS[key.slice("detection.".length)] ?? key}: ${text}`} />)}
          </div>
        </details>

        <details className="advanced-settings-group">
          <summary><span><strong>Receiver</strong></span><ChevronDown size={18} aria-hidden="true" /></summary>
          <div className="advanced-settings-body">
            <div className="read-only-grid"><span>Required sample rate</span><strong>{formatMHz(response.infrastructure.sampleRateHz)}</strong><span>Capture targets</span><strong>{response.catalog.captureTargets.length}</strong><span>Detection rules</span><strong>{draft.detection.ruleSetId}</strong></div>
            <NumberField disabled={!unlocked} label="Single-frequency check maximum" suffix="minutes" min={1} max={60} value={minutes(draft.liveFocusTimeoutMs)} onChange={(value) => setDraft({ ...draft, liveFocusTimeoutMs: value * 60_000 })} />
          </div>
        </details>

        <details className="advanced-settings-group">
          <summary><span><strong>Software recovery</strong></span><ChevronDown size={18} aria-hidden="true" /></summary>
          <div className="advanced-settings-body">
            <div className="protected-action-row">
              <span><strong>Restart RF Monitor</strong><small>Restarts this application. Recordings, signal learning and settings are kept.</small></span>
              <button className="button secondary compact" type="button" disabled={!unlocked} onClick={() => onMaintenance("restart-software")}>Restart software</button>
            </div>
            {!unlocked ? <p className="protected-action-hint">Unlock to use this action.</p> : null}
          </div>
        </details>
      </div>
    </section>
  );
}

function SignalLearningSettings({ response, unlocked, targetStates, onBaselineAction, onMaintenance, onOpenTab }: {
  response: SettingsRevision;
  unlocked: boolean;
  targetStates: ChannelMonitorState[];
  onBaselineAction: (action: "approve" | "restart", baseline: BaselineDescriptor) => Promise<void>;
  onMaintenance: (action: MaintenanceAction) => void;
  onOpenTab: (tab: SettingsTab) => void;
}) {
  const learning = useMemo(() => buildSignalLearningPresentation({
    catalog: response.catalog,
    effectiveBands: response.effectiveBands,
    sampleRateHz: response.infrastructure.sampleRateHz,
    baselines: response.baselineStates,
  }), [response.baselineStates, response.catalog, response.effectiveBands, response.infrastructure.sampleRateHz]);
  const approvalByBaseline = useMemo(() => new Map(
    (response.baselineApprovals ?? []).map((approval) => [baselineApprovalKey(approval), approval]),
  ), [response.baselineApprovals]);
  const restartableCount = learning.activeTargets.filter((target) => target.baseline).length;
  const blockedApproval = useMemo(() => learning.activeTargets.flatMap((target) => {
    if (target.baseline?.lifecycle !== "reviewable") return [];
    const approval = approvalByBaseline.get(baselineApprovalKey(target.baseline));
    return approval && !approval.eligible ? [approval] : [];
  })[0], [approvalByBaseline, learning.activeTargets]);
  return (
    <section className="settings-section" aria-labelledby="signal-learning-title">
      <h1 id="signal-learning-title">Signal learning</h1>
      <div className="baseline-requirement"><span>Minimum learning</span><strong>{SIGNAL_LEARNING_REQUIRED_HOURS} hours</strong></div>
      <div className="baseline-list">
        {learning.activeServices.length ? learning.activeServices.map((service) => (
          <div className="baseline-row" key={service.id}>
            <span><strong>{service.label}</strong><small>{countLabel(service.targets.length, "frequency check")} · {signalLearningProgressLabel(service.representativeHours)}</small></span>
            <span className={`evidence-pill ${signalLearningPillClass(service.state)}`}>{signalLearningStateLabel(service.state)}</span>
          </div>
        )) : <div className="selection-summary">No active services.</div>}
      </div>
      {blockedApproval ? <div className="baseline-approval-status" id="baseline-approval-status" role="status"><strong>{blockedApproval.label}</strong>{approvalDetail(blockedApproval) ? <span>{approvalDetail(blockedApproval)}</span> : null}{blockedApproval.action && blockedApproval.action !== "Wait." ? <span>{blockedApproval.action}</span> : null}</div> : null}

      <h3 className="settings-subheading">Active frequencies</h3>
      <div className="baseline-list">
        {learning.activeTargets.length ? learning.activeTargets.map((target) => {
          const approval = target.baseline ? approvalByBaseline.get(baselineApprovalKey(target.baseline)) : undefined;
          // Mirrors the server's restart guard so the operator sees the block
          // before clicking, not after.
          const blocked = restartBlockedReason(targetStates.find((state) => state.targetId === target.targetId));
          return (
            <div className="baseline-row" key={target.targetId}>
              <span><strong>{target.label}</strong><small>{target.signalsLabel ? `${target.signalsLabel} · ` : ""}{signalLearningProgressLabel(target.representativeHours)}</small></span>
              <span className={`evidence-pill ${signalLearningPillClass(target.state)}`}>{signalLearningStateLabel(target.state)}</span>
              {unlocked && target.baseline?.lifecycle === "reviewable" ? <button className="button secondary compact" type="button" disabled={!approval?.eligible} aria-describedby={!approval?.eligible && blockedApproval ? "baseline-approval-status" : undefined} onClick={() => void onBaselineAction("approve", target.baseline!)}>Approve</button> : null}
              {/* The control stays visible with its blocking reason so a
                  missing baseline never looks like a missing feature. */}
              {unlocked ? <button className="button secondary compact" type="button" disabled={!target.baseline} title={target.baseline ? (blocked ? "An alert is active. Restarting ends it." : undefined) : "No learned data to restart yet."} onClick={() => { if (target.baseline) void onBaselineAction("restart", target.baseline); }}>Restart learning</button> : null}
            </div>
          );
        }) : <div className="selection-summary">No active frequencies.</div>}
      </div>

      <div className="protected-action-row">
        <span><strong>Restart signal learning</strong><small>Starts a new learning period for every active frequency with learned data. Recordings, incidents and saved learning records are kept.</small></span>
        <button className="button danger compact" type="button" disabled={!unlocked || !restartableCount} title={restartableCount ? undefined : "No learned data to restart yet."} onClick={() => onMaintenance("restart-learning")}>Restart learning</button>
      </div>
      {!unlocked ? <p className="protected-action-hint">Unlock to use this action.</p> : null}

      {learning.saved.length ? (
        <details className="advanced-settings-group">
          <summary><span><strong>Saved learning</strong><small>{countLabel(learning.saved.length, "saved record")}</small></span><ChevronDown size={18} aria-hidden="true" /></summary>
          <div className="advanced-settings-body">
            <p className="protected-action-hint">Saved records are kept for reference. Learning can only be restarted for frequencies that are being monitored now.</p>
            <div className="baseline-list">
              {learning.saved.map((saved) => (
                <div className="baseline-row" key={saved.key}>
                  <span>
                    <strong>{saved.label}</strong>
                    <small>{saved.observationCount} observations · {signalLearningProgressLabel(saved.representativeHours)}</small>
                    {saved.targetActive ? null : <small>Not monitored now. Turn this frequency on in Monitoring to restart its learning.</small>}
                  </span>
                  <span className={`evidence-pill ${signalLearningPillClass(saved.state)}`}>{signalLearningStateLabel(saved.state)}</span>
                  {saved.targetActive ? null : <button className="button secondary compact" type="button" onClick={() => onOpenTab("monitoring")}>Open Monitoring</button>}
                </div>
              ))}
            </div>
          </div>
        </details>
      ) : null}
    </section>
  );
}

function TextField({ label, value, maxLength, error, disabled = false, onChange }: { label: string; value: string; maxLength: number; error?: string; disabled?: boolean; onChange: (value: string) => void }) {
  return <label className="form-field"><span>{label}</span><input disabled={disabled} value={value} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} />{error ? <FieldError text={error} /> : null}</label>;
}

function NumberField({ label, value, min, max, step = 1, suffix, compact = false, disabled = false, onChange }: { label?: string; value: number; min: number; max: number; step?: number; suffix?: string; compact?: boolean; disabled?: boolean; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    if (Number(text) !== value || text.trim() === "") setText(String(value));
    // Only follow external value changes; local typing is kept as entered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const invalid = text.trim() === "" || !Number.isFinite(Number(text));
  return <label className={`form-field number-field ${compact ? "compact" : ""}`}>{label ? <span>{label}</span> : null}<div className="input-suffix"><input type="number" disabled={disabled} value={text} min={min} max={max} step={step} aria-invalid={invalid} onChange={(event) => {
    setText(event.target.value);
    const next = event.target.value.trim() === "" ? Number.NaN : Number(event.target.value);
    // An empty or partial entry is never saved as 0.
    if (Number.isFinite(next)) onChange(next);
  }} />{suffix ? <b>{suffix}</b> : null}</div>{invalid ? <span className="field-error" role="alert">Enter a number</span> : null}</label>;
}

const DETECTION_FIELD_LABELS: Record<string, string> = {
  scaleFloorBins: "Scale floor",
  widebandObservationSigma: "Wideband observation",
  widebandObservationOccupancy: "Wideband occupancy",
  interferenceSigma: "Interference threshold",
  interferenceOccupancy: "Interference occupancy",
  narrowbandPeakSigma: "Narrowband peak",
  narrowbandMaxWidthRatio: "Narrowband width maximum",
  driftSigma: "Slow drift",
  interferenceHits: "Required visits",
  interferenceWindow: "Voting window",
  clearObservations: "Clear after",
  interferenceExposureMs: "Interference exposure",
  driftExposureMs: "Drift exposure",
  reservoirSize: "Reservoir size",
  minimumLearningMs: "Minimum learning time",
};

function FieldError({ text }: { text: string }) {
  return <span className="field-error" role="alert">{text}</span>;
}

function fourDxRange(band: BandPreset, startChannel: number, endChannel: number): string {
  const start = band.startHz + (Math.max(1, startChannel) - 1) * band.channelSpacingHz!;
  const end = band.startHz + (Math.max(1, endChannel) - 1) * band.channelSpacingHz!;
  return `${formatFrequency(start, 3)} - ${formatFrequency(end, 3)}`;
}

function formatRevisit(milliseconds: number): string {
  if (milliseconds < 60_000) return `${Math.max(1, Math.round(milliseconds / 1_000))} sec`;
  return `${Math.round(milliseconds / 60_000)} min`;
}

function formatMHz(hz: number): string {
  const value = hz / 1_000_000;
  return `${Number.isInteger(value) ? value : Number(value.toFixed(3))} MHz`;
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function signalLearningPillClass(state: SignalLearningState): string {
  if (state === "approved") return "protected";
  if (state === "ready") return "reviewable";
  return state;
}

function friendlyTargetId(targetId: string): string {
  const match = /^rf-(\d+)-(\d+)$/.exec(targetId);
  if (!match) return "this frequency";
  return formatRange(Number(match[1]), Number(match[2]));
}

function settingsChangedPaths(previous: unknown, next: unknown, prefix = ""): string[] {
  if (Object.is(previous, next)) return [];
  if (!previous || !next || typeof previous !== "object" || typeof next !== "object" || Array.isArray(previous) || Array.isArray(next)) return [prefix || "Settings"];
  const left = previous as Record<string, unknown>;
  const right = next as Record<string, unknown>;
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .flatMap((key) => settingsChangedPaths(left[key], right[key], prefix ? `${prefix}.${key}` : key))
    .filter((path) => path !== "revision" && path !== "updatedAt")
    .slice(0, 20);
}
