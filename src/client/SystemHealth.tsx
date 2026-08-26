import { useMemo, useState } from "react";
import {
  buildDiagnosticsModel,
  redactedDiagnosticsJson,
  type DiagnosticCard,
  type DiagnosticStatus,
  type DiagnosticsHealth,
  type DiagnosticsTrendSample,
  type DiagnosticsViewModel,
  type OperatorDiagnosticAction,
} from "./diagnosticsModel";
import { useDiagnostics, type UseDiagnosticsResult } from "./useDiagnostics";
import type { HealthSnapshotV2, MonitorSnapshot } from "../shared/types";

type DiagnosticsAction = (contents: string, filename: string) => void | Promise<void>;
export type SystemHealthSettingsTab = "monitoring" | "health" | "recording" | "advanced";

export interface SystemHealthActions {
  onDownloadDiagnostics?: DiagnosticsAction;
  onRetryReceiver?: () => void | Promise<void>;
  onReloadDashboard?: () => void | Promise<void>;
  onOpenSettingsTab?: (tab: SystemHealthSettingsTab) => void | Promise<void>;
  onCopyCommand?: (command: string) => void | Promise<void>;
}

export interface SystemHealthProps extends SystemHealthActions {
  endpoint?: string;
  className?: string;
  snapshot?: MonitorSnapshot;
}

export interface SystemHealthPanelProps extends SystemHealthActions {
  diagnostics: UseDiagnosticsResult;
  className?: string;
  snapshot?: MonitorSnapshot;
}

export interface SystemHealthIndicatorProps {
  model?: DiagnosticsViewModel;
  health?: DiagnosticsHealth;
  error?: string;
  onOpen?: () => void;
  className?: string;
}

export interface LiveSystemHealthIndicatorProps {
  endpoint?: string;
  onOpen?: () => void;
  className?: string;
}

interface TrendDefinition {
  id: string;
  label: string;
  value: (sample: DiagnosticsTrendSample) => number | undefined;
  format: (value: number | undefined) => string;
}

const MIB = 1024 * 1024;
const TREND_DEFINITIONS: readonly TrendDefinition[] = [
  { id: "cpu", label: "CPU", value: (sample) => sample.cpuPercent, format: (value) => value === undefined ? "--" : `${value.toFixed(0)}%` },
  { id: "rss", label: "RSS", value: (sample) => sample.rssBytes, format: (value) => value === undefined ? "--" : `${(value / MIB).toFixed(0)} MiB` },
  { id: "bandwidth", label: "Egress", value: (sample) => sample.bandwidthBytesPerSecond, format: (value) => value === undefined ? "--" : `${(value / 1024).toFixed(0)} KiB/s` },
  { id: "loss", label: "Loss", value: (sample) => sample.lossPercent, format: (value) => value === undefined ? "--" : `${value.toFixed(2)}%` },
  { id: "writer", label: "Writer", value: (sample) => sample.writerDelayMs, format: (value) => value === undefined ? "--" : `${value.toFixed(0)} ms` },
];
const DOCTOR_COMMAND = "sudo rf-monitor doctor";
const SUPPORT_BUNDLE_COMMAND = "sudo rf-monitor support-bundle";

function statusText(status: DiagnosticStatus): string {
  if (status === "healthy") return "Normal";
  if (status === "warning") return "Attention";
  if (status === "critical") return "Critical";
  if (status === "not-tested") return "Not tested";
  return "Unknown";
}

function Sparkline({ samples, definition }: { samples: readonly DiagnosticsTrendSample[]; definition: TrendDefinition }) {
  const values = samples.flatMap((sample) => {
    const value = definition.value(sample);
    return value === undefined || !Number.isFinite(value) ? [] : [{ at: sample.at, value }];
  });
  const latest = values.at(-1)?.value;
  if (values.length < 2) {
    return <div className="system-health-trend-empty"><span>{definition.label}</span><strong>{definition.format(latest)}</strong><small>Waiting for trend</small></div>;
  }
  let maximum = 0;
  for (const point of values) maximum = Math.max(maximum, point.value);
  maximum = Math.max(1, maximum);
  const firstAt = values[0].at;
  const lastAt = values.at(-1)?.at ?? firstAt + 1;
  const duration = Math.max(1, lastAt - firstAt);
  const points = values.map((point) => {
    const x = ((point.at - firstAt) / duration) * 100;
    const y = 28 - (Math.max(0, point.value) / maximum) * 24;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return (
    <div className={`system-health-trend system-health-trend-${definition.id}`}>
      <span>{definition.label}</span><strong>{definition.format(latest)}</strong>
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label={`${definition.label} trend over the last 10 minutes`}>
        <title>{definition.label} trend over the last 10 minutes</title>
        <polyline points={points} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
  );
}

function HealthCard({ card, defaultOpen }: { card: DiagnosticCard; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details className={`system-health-card status-${card.status}`} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary><span><strong>{card.title}</strong><small>{card.summary}</small></span><b>{statusText(card.status)}</b></summary>
      <dl>
        {card.rows.map((row) => (
          <div className={row.status ? `diagnostic-row status-${row.status}` : "diagnostic-row"} key={row.id}>
            <dt>{row.label}</dt><dd><strong>{row.value}</strong>{row.detail ? <small>{row.detail}</small> : null}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function diagnosticsFilename(health: DiagnosticsHealth): string {
  const timestamp = health.generatedAt && !Number.isNaN(Date.parse(health.generatedAt)) ? health.generatedAt : new Date().toISOString();
  return `rf-monitor-diagnostics-${timestamp.replace(/[^0-9TZ]/g, "-")}.json`;
}

function actionLabel(action: OperatorDiagnosticAction): string {
  if (action === "retry-receiver") return "Retry receiver";
  if (action === "reload-dashboard") return "Reload dashboard";
  if (action === "open-advanced") return "Open Signal learning";
  if (action === "open-monitoring") return "Open Monitoring";
  if (action === "open-recording") return "Open Recording";
  if (action === "open-system-health") return "Open Engineer details";
  if (action === "download-diagnostics") return "Download diagnostics";
  if (action === "check-switch-counters") return "Copy support command";
  return "Copy doctor command";
}

function issueOccurrence(lastOccurredAt: string, count: number): string {
  const timestamp = Date.parse(lastOccurredAt);
  const last = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "Time unavailable";
  return `Last: ${last} · ${count.toLocaleString()} occurrence${count === 1 ? "" : "s"}`;
}

function checkClass(status: DiagnosticStatus): string {
  if (status === "healthy") return "normal";
  if (status === "warning" || status === "critical") return "attention";
  return "";
}

export function SystemHealthPanel({
  diagnostics,
  className,
  onDownloadDiagnostics,
  onRetryReceiver,
  onReloadDashboard,
  onOpenSettingsTab,
  onCopyCommand,
  snapshot,
}: SystemHealthPanelProps) {
  const { health, trend, model: diagnosticsModel, loading, refreshing, error, lastSuccessfulAt, refresh } = diagnostics;
  const model = useMemo(() => snapshot ? buildDiagnosticsModel(health, snapshot) : diagnosticsModel, [diagnosticsModel, health, snapshot]);
  const [actionState, setActionState] = useState<"copied" | "downloaded" | "opened" | "reloaded" | "retried" | "error">();
  const [engineerOpen, setEngineerOpen] = useState(false);
  const exportText = useMemo(() => health ? redactedDiagnosticsJson(health) : undefined, [health]);

  const downloadDiagnostics = async () => {
    if (!health || !exportText || !onDownloadDiagnostics) return;
    try {
      await onDownloadDiagnostics(exportText, diagnosticsFilename(health));
      setActionState("downloaded");
    } catch {
      setActionState("error");
    }
  };

  const runIssueAction = async (action: OperatorDiagnosticAction) => {
    try {
      if (action === "retry-receiver") {
        if (!onRetryReceiver) return;
        await onRetryReceiver();
        setActionState("retried");
      } else if (action === "reload-dashboard") {
        if (!onReloadDashboard) return;
        await onReloadDashboard();
        setActionState("reloaded");
      } else if (action === "open-system-health") {
        setEngineerOpen(true);
        setActionState("opened");
      } else if (action === "open-monitoring" || action === "open-recording" || action === "open-advanced") {
        if (!onOpenSettingsTab) return;
        await onOpenSettingsTab(action === "open-monitoring" ? "monitoring" : action === "open-recording" ? "recording" : "advanced");
        setActionState("opened");
      } else if (action === "download-diagnostics") {
        await downloadDiagnostics();
      } else {
        if (!onCopyCommand) return;
        await onCopyCommand(action === "check-switch-counters" ? SUPPORT_BUNDLE_COMMAND : DOCTOR_COMMAND);
        setActionState("copied");
      }
    } catch {
      setActionState("error");
    }
  };

  const copyCommand = async (command: string) => {
    if (!onCopyCommand) return;
    try {
      await onCopyCommand(command);
      setActionState("copied");
    } catch {
      setActionState("error");
    }
  };

  const actionAvailable = (action: OperatorDiagnosticAction): boolean => {
    if (action === "retry-receiver") return Boolean(onRetryReceiver);
    if (action === "reload-dashboard") return Boolean(onReloadDashboard);
    if (action === "open-system-health") return true;
    if (action === "open-monitoring" || action === "open-recording" || action === "open-advanced") return Boolean(onOpenSettingsTab);
    if (action === "download-diagnostics") return Boolean(exportText && onDownloadDiagnostics);
    return Boolean(onCopyCommand);
  };

  return (
    <section className={["system-health", `status-${model.status}`, className].filter(Boolean).join(" ")} aria-labelledby="system-health-title" data-rf-diagnostics-active="true">
      <header className="system-health-heading">
        <div><span>Status</span><h1 id="system-health-title">System health</h1></div>
        <button className="button secondary compact" type="button" onClick={refresh} disabled={loading || refreshing}>{refreshing ? "Checking…" : "Check now"}</button>
      </header>

      <div className="system-health-action-summary">
        <span className={`system-health-status status-${error ? "warning" : model.status}`} aria-hidden="true" />
        <div>
          <strong>{error && health ? "Health data is late." : model.issues.length ? model.label : model.headline}</strong>
          {error && health
            ? <p>{lastSuccessfulAt ? `Last update ${new Date(lastSuccessfulAt).toLocaleTimeString()}.` : "Showing the last update."}</p>
            : model.issues.length ? null : <p>{model.action}</p>}
        </div>
      </div>

      {model.recovery ? <div className={`system-health-recovery ${model.recovery.state}`} role="status"><strong>{model.recovery.label}</strong><span>{model.recovery.detail}</span>{model.recovery.state === "attention" && model.recovery.kind === "software" && onOpenSettingsTab ? <button type="button" onClick={() => void onOpenSettingsTab("advanced")}>Open Software recovery</button> : null}</div> : null}

      {model.issues.length ? (
        <section className="system-health-issues" aria-label="Actions to take">
          <h2>Needs attention</h2>
          <ol>{model.issues.map((issue) => (
            <li className={`status-${issue.severity}`} key={issue.id}>
              <div>
                <strong>{issue.title}</strong>
                {issue.detail ? <span>{issue.detail}</span> : null}
                <small>{issueOccurrence(issue.lastOccurredAt, issue.count)}</small>
                <details className="system-health-guide">
                  <summary>What to do</summary>
                  <ol>{issue.guidance.steps.map((step) => <li key={step}>{step}</li>)}</ol>
                  <p><strong>Fixed when</strong> {issue.guidance.success}</p>
                  <p><strong>Stop when</strong> {issue.guidance.stop}</p>
                </details>
              </div>
              <button type="button" disabled={!actionAvailable(issue.actionKind)} onClick={() => void runIssueAction(issue.actionKind)}>{actionLabel(issue.actionKind)}</button>
            </li>
          ))}</ol>
        </section>
      ) : null}
      {error && !health ? <div className="system-health-error" role="alert"><strong>System health is unavailable.</strong><span>{error}</span></div> : null}

      <div className="settings-fact-grid" role="list" aria-label="System checks">
        {model.checks.map((check) => (
          <div className={["settings-fact", checkClass(check.status)].filter(Boolean).join(" ")} role="listitem" aria-label={`${check.label}: ${check.value}. ${statusText(check.status)}.`} key={check.id}>
            <span>{check.label}</span><strong>{check.value}</strong>
          </div>
        ))}
      </div>

      {actionState ? <div className="system-health-actions"><span role="status">{actionState === "copied" ? "Command copied." : actionState === "downloaded" ? "Diagnostics download requested." : actionState === "opened" ? "Settings opened." : actionState === "reloaded" ? "Dashboard reload requested." : actionState === "retried" ? "Receiver retry requested. Waiting for verified RF data." : "Action failed."}</span></div> : null}

      <details className="advanced-settings-group" open={engineerOpen} onToggle={(event) => setEngineerOpen(event.currentTarget.open)}>
        <summary><span><strong>Engineer details</strong></span><b>{engineerOpen ? "Hide" : "Show"}</b></summary>
        <div className="advanced-settings-body">
          <section className="system-health-trends" aria-label="Ten minute system trends">
            <header><h3>Last 10 minutes</h3><span>{trend.length} / 300 samples</span></header>
            <div>{TREND_DEFINITIONS.map((definition) => <Sparkline definition={definition} samples={trend} key={definition.id} />)}</div>
          </section>

          <div className="system-health-card-grid">
            {model.cards.map((card) => <HealthCard card={card} defaultOpen={card.status === "critical"} key={card.id} />)}
          </div>

          <footer className="system-health-actions">
            <button type="button" disabled={!exportText || !onDownloadDiagnostics} onClick={() => void downloadDiagnostics()}>Download diagnostics</button>
            <button type="button" disabled={!onCopyCommand} onClick={() => void copyCommand(DOCTOR_COMMAND)}>Copy doctor command</button>
            <button type="button" disabled={!onCopyCommand} onClick={() => void copyCommand(SUPPORT_BUNDLE_COMMAND)}>Copy support command</button>
          </footer>
        </div>
      </details>
    </section>
  );
}

export function SystemHealth(props: SystemHealthProps) {
  const diagnostics = useDiagnostics({ endpoint: props.endpoint });
  return <SystemHealthPanel diagnostics={diagnostics} snapshot={props.snapshot} className={props.className} onDownloadDiagnostics={props.onDownloadDiagnostics} onRetryReceiver={props.onRetryReceiver} onReloadDashboard={props.onReloadDashboard} onOpenSettingsTab={props.onOpenSettingsTab} onCopyCommand={props.onCopyCommand} />;
}

export function SystemHealthIndicator({ model, health, error, onOpen, className }: SystemHealthIndicatorProps) {
  const derived = useMemo(() => model ?? buildDiagnosticsModel(health), [health, model]);
  const visibleStatus: DiagnosticStatus = error && derived.status !== "critical" ? "warning" : derived.status;
  return (
    <button className={["system-health-indicator", `status-${visibleStatus}`, className].filter(Boolean).join(" ")} type="button" onClick={onOpen} disabled={!onOpen} aria-label={`System health: ${error ? "data late" : derived.label}`}>
      <span aria-hidden="true" /><strong>{error ? "System data late" : `System ${derived.label}`}</strong><small>{derived.issues[0]?.title ?? derived.action}</small>
    </button>
  );
}

export function LiveSystemHealthIndicator({ endpoint, onOpen, className }: LiveSystemHealthIndicatorProps) {
  const diagnostics = useDiagnostics({ endpoint });
  return <SystemHealthIndicator model={diagnostics.model} error={diagnostics.error} onOpen={onOpen} className={className} />;
}
