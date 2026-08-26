import type {
  CollectorAvailability,
  DiagnosticAction,
  DiagnosticCounter,
  DiagnosticIssue as HealthDiagnosticIssue,
  DiagnosticSubsystem,
  HealthSnapshotV2,
  MetricWindow,
  MonitorSnapshot,
  RecoveryOperationHealth,
  TargetTimingHealth,
} from "../shared/types";
import { formatCompactBytes, formatCompactPercent, formatCompactRate } from "./format";
import { currentBaselinesByTarget } from "./settingsPresentation";

export type DiagnosticsHealth = HealthSnapshotV2;
export type DiagnosticStatus = "healthy" | "warning" | "critical" | "unknown" | "not-tested";
export type DiagnosticCardId = "receiver" | "continuity" | "software" | "network" | "evidence" | "schedule";

export interface DiagnosticsTrendSample {
  at: number;
  cpuPercent?: number;
  rssBytes?: number;
  bandwidthBytesPerSecond?: number;
  lossPercent?: number;
  writerDelayMs?: number;
}

export interface DiagnosticRow {
  id: string;
  label: string;
  value: string;
  status?: DiagnosticStatus;
  detail?: string;
}

export interface DiagnosticCard {
  id: DiagnosticCardId;
  title: string;
  summary: string;
  status: DiagnosticStatus;
  rows: DiagnosticRow[];
}

export interface DiagnosticIssue {
  id: string;
  family: DiagnosticIssueFamily;
  codes: string[];
  cardId: DiagnosticCardId;
  severity: "warning" | "critical";
  title: string;
  action: string;
  actionKind: OperatorDiagnosticAction;
  detail?: string;
  count: number;
  lastOccurredAt: string;
  guidance: DiagnosticGuidance;
}

export type DiagnosticIssueFamily = "receiver" | "data-late" | "recording" | "coverage" | "overload" | "learning" | "network" | "system";
export type OperatorDiagnosticAction = DiagnosticAction | "reload-dashboard" | "open-advanced";

export interface DiagnosticGuidance {
  steps: string[];
  success: string;
  stop: string;
}

export type DiagnosticCheckId = "receiver" | "confirmed-input" | "rf-data" | "recording" | "coverage" | "learning";

export interface DiagnosticCheck {
  id: DiagnosticCheckId;
  label: string;
  value: string;
  status: DiagnosticStatus;
}

export interface DiagnosticsViewModel {
  status: DiagnosticStatus;
  label: string;
  headline: string;
  action: string;
  simulation: boolean;
  issues: DiagnosticIssue[];
  checks: DiagnosticCheck[];
  cards: DiagnosticCard[];
  recovery?: DiagnosticRecoveryNotice;
}

export interface DiagnosticRecoveryNotice {
  kind: "receiver" | "software";
  state: "progress" | "verified" | "attention";
  label: string;
  detail: string;
}

export const DIAGNOSTICS_TREND_LIMIT = 300;
export const DIAGNOSTICS_TREND_WINDOW_MS = 10 * 60_000;

const MIB = 1024 * 1024;
const SUBSYSTEM_CARD: Record<DiagnosticSubsystem, DiagnosticCardId> = {
  receiver: "receiver",
  data: "continuity",
  software: "software",
  network: "network",
  evidence: "evidence",
  schedule: "schedule",
};
const ACTION_COPY: Record<DiagnosticAction, string> = {
  "retry-receiver": "Retry the receiver.",
  "open-monitoring": "Review Monitoring.",
  "open-recording": "Review Recording.",
  "open-system-health": "Open Engineer details.",
  "download-diagnostics": "Download diagnostics for support.",
  "copy-doctor-command": "Run the doctor check on the host.",
  "check-host-network": "Check the host network.",
  "check-switch-counters": "Check the managed switch.",
};

const CLIENT_ACTION_COPY: Record<Exclude<OperatorDiagnosticAction, DiagnosticAction>, string> = {
  "reload-dashboard": "Reload this dashboard.",
  "open-advanced": "Open Signal learning.",
};

const ISSUE_TITLES: Record<string, string> = {
  "browser-delivery-loss": "Dashboard data was dropped",
  "disk-reserve-breached": "Disk space is below reserve",
  "evidence-frame-loss": "Recorded RF data was lost",
  "evidence-archive-needs-attention": "A saved recording needs attention",
  "evidence-unavailable": "Recording is unavailable",
  "host-cpu-event-loop-critical": "Computer is overloaded",
  "host-cpu-high": "Computer CPU is high",
  "host-memory-pressure": "Computer memory is low",
  "host-memory-critical": "Computer memory is low",
  "multiple-dashboards": "Multiple dashboards open",
  "host-network-interface-unavailable": "Network connection is unavailable",
  "network-interface-errors-or-drops": "Network data was dropped",
  "receiver-path-unavailable": "Receiver data stopped",
  "receiver-recovery-failed": "Receiver did not recover",
  "resource-critical": "System resources are exhausted",
  "rf-monitor-cpu-high": "RF Monitor CPU is high",
  "sample-rate-mismatch": "Receiver sample rate changed",
  "schedule-objective-missed": "A scan was late",
  "tune-or-frame-fault": "RF data was incomplete",
  "receiver-overload": "Receiver is overloaded",
  "signal-learning-paused": "Signal learning is paused",
  "live-data-late": "Dashboard data is late",
};

const OPERATOR_ACTION_OVERRIDES: Partial<Record<string, OperatorDiagnosticAction>> = {
  "browser-delivery-loss": "reload-dashboard",
  "live-data-late": "reload-dashboard",
  "signal-learning-paused": "open-advanced",
};

const EMPTY_CHECKS: readonly DiagnosticCheck[] = [
  { id: "receiver", label: "Receiver", value: "Unknown", status: "unknown" },
  { id: "rf-data", label: "RF data", value: "Unknown", status: "unknown" },
  { id: "recording", label: "Recording", value: "Unknown", status: "unknown" },
  { id: "coverage", label: "Scan coverage", value: "Unknown", status: "unknown" },
  { id: "learning", label: "Signal learning", value: "Unknown", status: "unknown" },
];

const ISSUE_FAMILY: Record<string, DiagnosticIssueFamily> = {
  "receiver-path-unavailable": "receiver",
  "receiver-recovery-failed": "receiver",
  "sample-rate-mismatch": "receiver",
  "browser-delivery-loss": "data-late",
  "live-data-late": "data-late",
  "tune-or-frame-fault": "data-late",
  "disk-reserve-breached": "recording",
  "evidence-frame-loss": "recording",
  "evidence-archive-needs-attention": "recording",
  "evidence-unavailable": "recording",
  "schedule-objective-missed": "coverage",
  "receiver-overload": "overload",
  "host-cpu-event-loop-critical": "system",
  "host-cpu-high": "system",
  "host-memory-pressure": "system",
  "host-memory-critical": "system",
  "multiple-dashboards": "system",
  "resource-critical": "system",
  "rf-monitor-cpu-high": "system",
  "signal-learning-paused": "learning",
  "host-network-interface-unavailable": "network",
  "network-interface-errors-or-drops": "network",
};

const FAMILY_PRIORITY: Record<DiagnosticIssueFamily, number> = {
  recording: 80,
  receiver: 70,
  "data-late": 60,
  overload: 50,
  coverage: 40,
  learning: 30,
  network: 20,
  system: 10,
};

const GUIDANCE: Record<DiagnosticIssueFamily, DiagnosticGuidance> = {
  receiver: {
    steps: ["Check receiver power and USB.", "Select Retry receiver once."],
    success: "Receiver, SDRconnect and RF data show Live.",
    stop: "Stop after one retry if hardware is absent, recovery fails, or lockout starts.",
  },
  "data-late": {
    steps: ["Check this browser's network connection.", "Reload this dashboard."],
    success: "RF data returns to Live and its update time advances.",
    stop: "Stop if other dashboards are also late or System health cannot refresh.",
  },
  recording: {
    steps: ["Open Recording.", "Check free space and the current recording state."],
    success: "Recording returns to On with no new evidence loss.",
    stop: "Stop if disk is below reserve, read-only, missing, or data loss continues.",
  },
  coverage: {
    steps: ["Open Monitoring.", "End any single-frequency check or optional radio survey."],
    success: "Scan coverage returns to On time.",
    stop: "Stop if primary GNSS scans remain late.",
  },
  overload: {
    steps: ["Keep recording.", "Check the approved antenna and gain setup."],
    success: "Valid RF observations resume without overload.",
    stop: "Stop if overload persists or an RF setting must change.",
  },
  learning: {
    steps: ["Open Signal learning.", "Resolve the named receiver or configuration issue."],
    success: "Representative-time progress starts advancing again.",
    stop: "Restart learning only when the saved fingerprint no longer matches.",
  },
  network: {
    steps: ["Check the host network cable and link.", "Check managed-switch counters."],
    success: "Network errors stop increasing and RF data stays Live.",
    stop: "Stop if the link remains down or switch drops continue.",
  },
  system: {
    steps: ["Open Engineer details.", "Stop unnecessary dashboards or exports."],
    success: "Computer load falls and System health returns to Normal.",
    stop: "Stop if the fault remains Critical or monitoring/recording is affected.",
  },
};

function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return "Not reported";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < MIB) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 * MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
  return `${(bytes / (1024 * MIB)).toFixed(1)} GiB`;
}

function formatRate(bytes: number | undefined): string {
  return bytes === undefined ? "Not reported" : `${formatBytes(bytes)}/s`;
}

function formatDuration(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "Not reported";
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)} s`;
  return `${(milliseconds / 60_000).toFixed(1)} min`;
}

function humanize(value: string): string {
  const sentence = value.replaceAll("_", " ").replaceAll("-", " ").replace(/\s+/g, " ").trim();
  return sentence ? sentence[0].toUpperCase() + sentence.slice(1) : "System issue";
}

function counterValue(counter: DiagnosticCounter): string {
  return `${counter.total.toLocaleString()} total · +${counter.delta10s.toLocaleString()} / 10 s · +${counter.delta60s.toLocaleString()} / 60 s`;
}

function metricValue(metric: MetricWindow): string {
  const render = metric.unit === "percent"
    ? (value: number) => `${value.toFixed(1)}%`
    : metric.unit === "bytes" || metric.unit === "bytes-per-second"
      ? (value: number) => metric.unit === "bytes" ? formatBytes(value) : formatRate(value)
      : metric.unit === "milliseconds"
        ? (value: number) => formatDuration(value)
        : (value: number) => value.toFixed(2);
  return `${render(metric.current)} now · ${render(metric.average10s)} / 10 s · ${render(metric.average60s)} / 60 s`;
}

function availabilityStatus(availability: CollectorAvailability): DiagnosticStatus {
  if (availability.state === "available") return "healthy";
  if (availability.state === "not-tested" || availability.state === "not-applicable") return "not-tested";
  return "unknown";
}

function availabilityValue(availability: CollectorAvailability): string {
  if (availability.state === "available") return "Available";
  if (availability.state === "not-tested") return "Not tested";
  if (availability.state === "not-applicable") return "Not applicable";
  return availability.reasonCode ? `Unavailable · ${humanize(availability.reasonCode)}` : "Unavailable";
}

function issueStatus(issues: readonly DiagnosticIssue[], cardId: DiagnosticCardId, fallback: DiagnosticStatus): DiagnosticStatus {
  const matching = issues.filter((issue) => issue.cardId === cardId);
  if (matching.some((issue) => issue.severity === "critical")) return "critical";
  if (matching.length) return "warning";
  return fallback;
}

function issueDetail(issue: HealthDiagnosticIssue): string | undefined {
  if (issue.code === "host-memory-pressure" || issue.code === "host-memory-critical") return "Close unused browser tabs.";
  if (issue.code === "multiple-dashboards") return `${issue.value ?? 0} dashboards open. Close unused tabs.`;
  const parts: string[] = [];
  const render = (value: number): string => {
    if (issue.code === "sample-rate-mismatch") return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")} MHz`;
    if (issue.unit === "percent") return formatCompactPercent(value);
    if (issue.unit === "bytes") return formatCompactBytes(value);
    if (issue.unit === "bytes-per-second") return formatCompactRate(value);
    if (issue.unit === "milliseconds") return formatDuration(value);
    if (issue.unit === "hertz" || issue.unit === "Hz") return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")} MHz`;
    return value.toLocaleString();
  };
  if (issue.unit === "count" && issue.code !== "sample-rate-mismatch" && issue.value !== undefined) {
    parts.push(`${render(issue.value)} in the last minute`);
    if (issue.threshold !== undefined) parts.push(`limit ${render(issue.threshold)}`);
  } else {
    if (issue.value !== undefined) parts.push(render(issue.value));
    if (issue.threshold !== undefined) parts.push(`limit ${render(issue.threshold)}`);
  }
  return parts.join(" · ");
}

function operatorActionCopy(action: OperatorDiagnosticAction): string {
  return action in CLIENT_ACTION_COPY
    ? CLIENT_ACTION_COPY[action as keyof typeof CLIENT_ACTION_COPY]
    : ACTION_COPY[action as DiagnosticAction];
}

function mappedIssue(issue: HealthDiagnosticIssue): DiagnosticIssue {
  const actionKind = OPERATOR_ACTION_OVERRIDES[issue.code] ?? issue.action;
  const family = ISSUE_FAMILY[issue.code] ?? "system";
  return {
    id: issue.id,
    family,
    codes: [issue.code],
    cardId: SUBSYSTEM_CARD[issue.subsystem],
    severity: issue.severity === "critical" ? "critical" : "warning",
    title: ISSUE_TITLES[issue.code] ?? humanize(issue.code),
    action: operatorActionCopy(actionKind),
    actionKind,
    detail: issueDetail(issue),
    count: Math.max(1, issue.count),
    lastOccurredAt: issue.lastOccurredAt,
    guidance: GUIDANCE[family],
  };
}

function virtualIssue(input: {
  id: string;
  code: string;
  family: DiagnosticIssueFamily;
  cardId: DiagnosticCardId;
  severity?: "warning" | "critical";
  actionKind: OperatorDiagnosticAction;
  detail?: string;
  at: string;
}): DiagnosticIssue {
  return {
    id: input.id,
    family: input.family,
    codes: [input.code],
    cardId: input.cardId,
    severity: input.severity ?? "warning",
    title: ISSUE_TITLES[input.code] ?? humanize(input.code),
    action: operatorActionCopy(input.actionKind),
    actionKind: input.actionKind,
    detail: input.detail,
    count: 1,
    lastOccurredAt: input.at,
    guidance: GUIDANCE[input.family],
  };
}

function issueSort(left: DiagnosticIssue, right: DiagnosticIssue): number {
  return Number(right.severity === "critical") - Number(left.severity === "critical")
    || FAMILY_PRIORITY[right.family] - FAMILY_PRIORITY[left.family]
    || right.lastOccurredAt.localeCompare(left.lastOccurredAt)
    || left.id.localeCompare(right.id);
}

function deduplicateIssues(issues: readonly DiagnosticIssue[]): DiagnosticIssue[] {
  const grouped = new Map<string, DiagnosticIssue>();
  for (const issue of [...issues].sort(issueSort)) {
    const key = `${issue.family}:${issue.actionKind}`;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, issue);
      continue;
    }
    current.codes = [...new Set([...current.codes, ...issue.codes])];
    current.count += issue.count;
    if (issue.lastOccurredAt > current.lastOccurredAt) current.lastOccurredAt = issue.lastOccurredAt;
  }
  return [...grouped.values()].sort(issueSort);
}

function currentCoverageDetail(health: HealthSnapshotV2, snapshot?: MonitorSnapshot): string | undefined {
  const coverage = health.schedule.health.currentCoverage;
  if (!coverage || coverage.state !== "late") return undefined;
  const target = coverage.targetId
    ? snapshot?.monitorTargets?.find((candidate) => candidate.id === coverage.targetId)?.label ?? humanize(coverage.targetId)
    : "Scheduled signal";
  const reason = coverage.cause === "current-gap-overdue"
    ? "has not returned on time"
    : coverage.cause === "recent-objective-miss"
      ? "returned later than planned"
      : "was not observed on time";
  const timing = [
    coverage.objectiveMs !== undefined ? `objective ${formatDuration(coverage.objectiveMs)}` : undefined,
    coverage.measuredRevisitMs !== undefined ? `measured ${formatDuration(coverage.measuredRevisitMs)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return `${target} ${reason}${timing.length ? ` · ${timing.join(" · ")}` : ""}`;
}

function mapIssues(health: HealthSnapshotV2, snapshot?: MonitorSnapshot): DiagnosticIssue[] {
  const issues = health.summary.issues
    .filter((issue) => issue.active)
    .map(mappedIssue);
  const at = snapshot?.generatedAt ?? health.generatedAt;
  if (snapshot?.operatorSummary.monitoring.state === "data-late" && !issues.some((issue) => issue.family === "data-late")) {
    issues.push(virtualIssue({ id: "operator-live-data-late", code: "live-data-late", family: "data-late", cardId: "continuity", actionKind: "reload-dashboard", at }));
  }
  if (snapshot?.currentMetrics?.overload && !issues.some((issue) => issue.family === "overload")) {
    issues.push(virtualIssue({ id: "operator-receiver-overload", code: "receiver-overload", family: "overload", cardId: "receiver", actionKind: "open-system-health", at }));
  }
  const coverageDetail = currentCoverageDetail(health, snapshot);
  if (coverageDetail) {
    const existingCoverage = issues.find((issue) => issue.family === "coverage");
    if (existingCoverage) existingCoverage.detail = coverageDetail;
    else issues.push(virtualIssue({
      id: "operator-current-coverage-late",
      code: "schedule-objective-missed",
      family: "coverage",
      cardId: "schedule",
      actionKind: "open-monitoring",
      detail: coverageDetail,
      at,
    }));
  }
  const stale = health.schedule.baselines.filter((baseline) => baseline.lifecycle === "stale");
  if (stale.length && !issues.some((issue) => issue.family === "learning")) {
    issues.push(virtualIssue({
      id: "operator-signal-learning-paused",
      code: "signal-learning-paused",
      family: "learning",
      cardId: "schedule",
      actionKind: "open-advanced",
      detail: `${stale.length} signal${stale.length === 1 ? "" : "s"} need new learning`,
      at,
    }));
  }
  return deduplicateIssues(issues);
}

function buildOperatorChecks(health: HealthSnapshotV2, simulation: boolean, snapshot?: MonitorSnapshot): DiagnosticCheck[] {
  const receivers = health.receiverPath.receivers;
  const receiverUnavailable = health.receiverPath.availability.state === "unavailable" || receivers.some((receiver) => receiver.usb === "absent" || receiver.transport === "offline");
  const receiverUncertain = health.receiverPath.availability.state !== "available" || !receivers.length || receivers.some((receiver) => receiver.usb === "unknown" || receiver.transport === "reconnecting");
  const framesStopped = receivers.some((receiver) => receiver.frames === "stopped");
  const framesLate = !receivers.length || receivers.some((receiver) => receiver.frames === "stalled") || snapshot?.operatorSummary.monitoring.state === "data-late";
  const overloaded = Boolean(snapshot?.currentMetrics?.overload);

  const receiver: DiagnosticCheck = simulation
    ? { id: "receiver", label: "Receiver", value: "Not tested", status: "not-tested" }
    : receiverUnavailable
      ? { id: "receiver", label: "Receiver", value: "Offline", status: "critical" }
      : overloaded
        ? { id: "receiver", label: "Receiver", value: "Overloaded", status: "warning" }
      : receiverUncertain
        ? { id: "receiver", label: "Receiver", value: "Checking", status: "warning" }
        : { id: "receiver", label: "Receiver", value: "Connected", status: "healthy" };

  const confirmedInputs = [...new Set(receivers.map((receiver) => receiver.activeAntenna?.trim()).filter((value): value is string => Boolean(value)))];
  const allInputsConfirmed = receivers.length > 0 && receivers.every((receiver) => Boolean(receiver.activeAntenna?.trim()));
  const confirmedInput: DiagnosticCheck = simulation
    ? { id: "confirmed-input", label: "Confirmed input", value: "Not tested", status: "not-tested" }
    : receiverUnavailable || !allInputsConfirmed
      ? { id: "confirmed-input", label: "Confirmed input", value: "Checking", status: "unknown" }
      : { id: "confirmed-input", label: "Confirmed input", value: confirmedInputs.join(" / "), status: "healthy" };

  const rfData: DiagnosticCheck = simulation
    ? { id: "rf-data", label: "RF data", value: "Not tested", status: "not-tested" }
    : framesStopped || receiverUnavailable
      ? { id: "rf-data", label: "RF data", value: "Stopped", status: "critical" }
      : framesLate
        ? { id: "rf-data", label: "RF data", value: "Data late", status: "warning" }
        : { id: "rf-data", label: "RF data", value: "Live", status: "healthy" };

  const continuity = health.dataContinuity;
  const nonEvidenceLossLastMinute = continuity.invalidOrStaleFrames.delta60s
    + continuity.browserFramesDropped.delta60s
    + health.network.drops.delta60s;
  if (!simulation && rfData.status === "healthy" && nonEvidenceLossLastMinute > 0) {
    rfData.value = "Check data";
    rfData.status = "warning";
  }
  const diskBelowReserve = health.evidence.diskFreeBytes !== undefined && health.evidence.diskFreeBytes < health.evidence.diskReserveBytes;
  const recording: DiagnosticCheck = !health.evidence.healthy
    ? { id: "recording", label: "Recording", value: "Error", status: "critical" }
    : diskBelowReserve
      ? { id: "recording", label: "Recording", value: "Disk full", status: "critical" }
    : continuity.evidenceFramesLost.delta60s > 0
      ? { id: "recording", label: "Recording", value: "Data lost", status: "critical" }
      : health.evidence.diskPressure
        ? { id: "recording", label: "Recording", value: "Check disk", status: "warning" }
        : { id: "recording", label: "Recording", value: "On", status: "healthy" };

  const currentCoverage = health.schedule.health.currentCoverage;
  const objective = health.schedule.health.tier1MeetingObjective;
  const recentMisses = health.dataContinuity.missedObjectives.delta60s;
  const recentUnknownVisits = health.dataContinuity.unknownVisits.delta60s;
  const coverage: DiagnosticCheck = simulation
    ? { id: "coverage", label: "Scan coverage", value: "Not tested", status: "not-tested" }
    : currentCoverage?.state === "late"
      ? { id: "coverage", label: "Scan coverage", value: "Late", status: "warning" }
      : currentCoverage?.state === "checking"
        ? { id: "coverage", label: "Scan coverage", value: "Checking", status: "unknown" }
        : currentCoverage?.state === "on-time"
          ? { id: "coverage", label: "Scan coverage", value: "On time", status: "healthy" }
          : recentMisses > 0
            ? { id: "coverage", label: "Scan coverage", value: "Late", status: "warning" }
            : recentUnknownVisits > 0 || objective === undefined
              ? { id: "coverage", label: "Scan coverage", value: "Checking", status: "unknown" }
              : { id: "coverage", label: "Scan coverage", value: "On time", status: "healthy" };

  const currentBaselines = currentBaselinesByTarget(health.schedule.baselines);
  const activeTargetIds = [...new Set(health.schedule.targets.map((target) => target.targetId))];
  const baselines = activeTargetIds.flatMap((targetId) => {
    const baseline = currentBaselines.get(targetId);
    return baseline ? [baseline] : [];
  });
  const minimumHours = activeTargetIds.length
    ? Math.min(...activeTargetIds.map((targetId) => currentBaselines.get(targetId)?.representativeHours ?? 0))
    : 0;
  const learning: DiagnosticCheck = simulation
    ? { id: "learning", label: "Signal learning", value: "Test data", status: "not-tested" }
    : baselines.some((baseline) => baseline.lifecycle === "stale")
      ? { id: "learning", label: "Signal learning", value: "Paused", status: "warning" }
      : activeTargetIds.length > 0 && baselines.length === activeTargetIds.length && baselines.every((baseline) => baseline.lifecycle === "protected")
        ? { id: "learning", label: "Signal learning", value: "Approved", status: "healthy" }
        : minimumHours >= 24
          ? { id: "learning", label: "Signal learning", value: "Complete", status: "healthy" }
          : { id: "learning", label: "Signal learning", value: `${minimumHours} of 24 hours`, status: "unknown" };

  return [receiver, confirmedInput, rfData, recording, coverage, learning];
}

function counterStatus(counter: DiagnosticCounter, critical = false): DiagnosticStatus {
  if (counter.delta60s <= 0) return "healthy";
  return critical ? "critical" : "warning";
}

function receiverCard(health: HealthSnapshotV2, issues: readonly DiagnosticIssue[], simulation: boolean): DiagnosticCard {
  const rows: DiagnosticRow[] = [{ id: "collector", label: "Receiver collector", value: availabilityValue(health.receiverPath.availability), status: simulation ? "not-tested" : availabilityStatus(health.receiverPath.availability) }];
  for (const receiver of health.receiverPath.receivers) {
    const prefix = health.receiverPath.receivers.length > 1 ? `Receiver ${receiver.id}: ` : "";
    const usbStatus: DiagnosticStatus = simulation || receiver.usb === "not-tested" ? "not-tested" : receiver.usb === "present" ? "healthy" : receiver.usb === "absent" ? "critical" : "unknown";
    const transportStatus: DiagnosticStatus = simulation || receiver.transport === "not-tested" ? "not-tested" : receiver.transport === "connected" ? "healthy" : receiver.transport === "reconnecting" ? "warning" : "critical";
    const frameStatus: DiagnosticStatus = simulation || receiver.frames === "not-tested" ? "not-tested" : receiver.frames === "live" ? "healthy" : receiver.frames === "stalled" ? "warning" : "critical";
    rows.push(
      { id: `${receiver.id}-usb`, label: `${prefix}USB hardware`, value: simulation ? "Not tested" : humanize(receiver.usb), status: usbStatus },
      { id: `${receiver.id}-transport`, label: `${prefix}SDRconnect`, value: simulation ? "Not tested" : humanize(receiver.transport), status: transportStatus },
      { id: `${receiver.id}-frames`, label: `${prefix}RF frames`, value: simulation ? "Not tested" : humanize(receiver.frames), status: frameStatus },
      { id: `${receiver.id}-input`, label: `${prefix}Confirmed input`, value: simulation ? "Not tested" : receiver.activeAntenna?.trim() || "Checking", status: simulation ? "not-tested" : receiver.activeAntenna?.trim() ? "healthy" : "unknown" },
      { id: `${receiver.id}-sample-rate`, label: `${prefix}Sample rate`, value: receiver.confirmedSampleRateHz === undefined ? "Not reported" : `${(receiver.confirmedSampleRateHz / 1_000_000).toFixed(3)} MS/s`, status: simulation ? "not-tested" : receiver.sampleRateMatches === undefined ? "unknown" : receiver.sampleRateMatches ? "healthy" : "warning", detail: `Expected ${(health.receiverPath.expectedSampleRateHz / 1_000_000).toFixed(3)} MS/s` },
      { id: `${receiver.id}-age`, label: `${prefix}Latest frame age`, value: simulation ? "Not tested" : formatDuration(receiver.lastFrameAgeMs), status: simulation ? "not-tested" : undefined },
      { id: `${receiver.id}-reconnects`, label: `${prefix}Reconnect attempts`, value: receiver.reconnectAttempts.toLocaleString() },
    );
    if (receiver.lastHardwareError) rows.push({ id: `${receiver.id}-error`, label: `${prefix}Latest hardware issue`, value: receiver.lastHardwareError, status: simulation ? "not-tested" : "warning" });
  }
  const fallback = simulation ? "not-tested" : availabilityStatus(health.receiverPath.availability);
  return { id: "receiver", title: "Receiver path", summary: simulation ? "Physical receiver stages are not tested in simulation." : "USB, SDRconnect, tuning, and live RF flow.", status: issueStatus(issues, "receiver", fallback), rows };
}

function continuityCard(health: HealthSnapshotV2, issues: readonly DiagnosticIssue[]): DiagnosticCard {
  const data = health.dataContinuity;
  const rows: DiagnosticRow[] = [
    { id: "received", label: "Frames received", value: counterValue(data.receivedFrames) },
    { id: "analyzed", label: "Observations analyzed", value: counterValue(data.analyzedObservations) },
    { id: "tune-gate", label: "Intentional tune-gate ignores", value: counterValue(data.intentionalTuneGateFrames), detail: "Expected while a new target is being confirmed." },
    { id: "tune-discard", label: "Intentional settling discards", value: counterValue(data.intentionalTuneDiscards), detail: "Expected after a confirmed tune." },
    { id: "rate-coalescing", label: "Intentional rate coalescing", value: counterValue(data.intentionalRateCoalescing), detail: "Bounded processing, not RF loss." },
    { id: "invalid", label: "Invalid or stale frames", value: counterValue(data.invalidOrStaleFrames), status: counterStatus(data.invalidOrStaleFrames) },
    { id: "iq", label: "Unexpected IQ payloads", value: counterValue(data.unexpectedIqPayloads), status: counterStatus(data.unexpectedIqPayloads) },
    { id: "unknown", label: "Unknown visits", value: counterValue(data.unknownVisits), status: counterStatus(data.unknownVisits) },
    { id: "missed", label: "Missed objectives", value: counterValue(data.missedObjectives), status: counterStatus(data.missedObjectives) },
    { id: "evidence-recorded", label: "Evidence frames recorded", value: counterValue(data.evidenceFramesRecorded) },
    { id: "evidence-lost", label: "Evidence frames lost", value: counterValue(data.evidenceFramesLost), status: counterStatus(data.evidenceFramesLost, true) },
    { id: "browser-coalesced", label: "Browser frames coalesced", value: counterValue(data.browserFramesCoalesced), detail: "Intentional latest-only delivery." },
    { id: "browser-dropped", label: "Browser frames dropped", value: counterValue(data.browserFramesDropped), status: counterStatus(data.browserFramesDropped) },
  ];
  return { id: "continuity", title: "Data continuity", summary: "Ten-second, sixty-second, and lifetime counters distinguish intentional skips from loss.", status: issueStatus(issues, "continuity", "healthy"), rows };
}

function softwareCard(health: HealthSnapshotV2, issues: readonly DiagnosticIssue[], simulation: boolean): DiagnosticCard {
  const data = health.software;
  const rows: DiagnosticRow[] = [
    { id: "process-collector", label: "Process collector", value: availabilityValue(data.processCollector), status: availabilityStatus(data.processCollector) },
    { id: "host-collector", label: "Host collector", value: availabilityValue(data.hostCollector), status: availabilityStatus(data.hostCollector) },
    { id: "rf-cpu-host", label: "RF Monitor CPU (host normalized)", value: metricValue(data.rfMonitorCpuHostNormalized) },
    { id: "rf-cpu-core", label: "RF Monitor CPU (core equivalent)", value: metricValue(data.rfMonitorCpuCoreEquivalent) },
    { id: "host-cpu", label: "Host CPU", value: metricValue(data.hostCpu) },
    { id: "host-load", label: "Host load (1 min)", value: metricValue(data.hostLoad1m) },
    { id: "rss", label: "Resident memory", value: formatBytes(data.rssBytes) },
    { id: "heap", label: "JavaScript heap", value: `${formatBytes(data.heapUsedBytes)} / ${formatBytes(data.heapLimitBytes)}` },
    { id: "external", label: "External / array buffers", value: `${formatBytes(data.externalBytes)} / ${formatBytes(data.arrayBufferBytes)}` },
    { id: "event-loop", label: "Event loop p50 / p99", value: `${formatDuration(data.eventLoopDelayP50Ms)} / ${formatDuration(data.eventLoopDelayP99Ms)}` },
    { id: "sdr-collector", label: "SDRconnect collector", value: simulation ? "Not tested" : availabilityValue(data.sdrconnect.availability), status: simulation ? "not-tested" : availabilityStatus(data.sdrconnect.availability) },
    { id: "sdr-resources", label: "SDRconnect CPU / memory", value: simulation ? "Not tested" : data.sdrconnect.cpuCoreEquivalent ? `${metricValue(data.sdrconnect.cpuCoreEquivalent)} · ${formatBytes(data.sdrconnect.memoryBytes)}` : formatBytes(data.sdrconnect.memoryBytes), status: simulation ? "not-tested" : undefined },
  ];
  if (data.hostMemory) rows.push(
    { id: "host-memory-state", label: "Host memory", value: humanize(data.hostMemory.state), status: data.hostMemory.state === "critical" ? "critical" : data.hostMemory.state === "pressure" ? "warning" : data.hostMemory.state === "normal" ? "healthy" : "unknown", detail: `${formatBytes(data.hostMemory.availableBytes)} available · swap ${formatBytes(data.hostMemory.swapFreeBytes)} free` },
    { id: "host-memory-psi", label: "Memory pressure (10 s)", value: `some ${data.hostMemory.psiSomeAvg10?.toFixed(2) ?? "--"}% · full ${data.hostMemory.psiFullAvg10?.toFixed(2) ?? "--"}%`, detail: data.hostMemory.reasonCodes.join(", ") || "No pressure reason" },
  );
  for (const incident of data.stabilityIncidents ?? []) rows.push({
    id: `stability-${incident.id}`,
    label: `Stability: ${humanize(incident.kind)}`,
    value: humanize(incident.state),
    status: incident.state === "active" ? incident.severity === "critical" ? "critical" : "warning" : "healthy",
    detail: `${new Date(incident.updatedAt).toLocaleString()} · ${incident.reasonCodes.join(", ") || "resolved"}`,
  });
  return { id: "software", title: "Software and memory", summary: "RF Monitor, host, event loop, and SDRconnect resource use.", status: issueStatus(issues, "software", "healthy"), rows };
}

function networkCard(health: HealthSnapshotV2, issues: readonly DiagnosticIssue[]): DiagnosticCard {
  const data = health.network;
  const rows: DiagnosticRow[] = [
    { id: "collector", label: "Host network collector", value: availabilityValue(data.hostCollector), status: availabilityStatus(data.hostCollector) },
    { id: "switch", label: "Managed-switch counters", value: data.managedSwitch.availability.state === "not-applicable" ? "External — not connected" : availabilityValue(data.managedSwitch.availability), status: availabilityStatus(data.managedSwitch.availability), detail: data.managedSwitch.availability.state === "available" ? "Use the switch as the authority for port drops, discards, and pause events." : "Host counters cannot prove that the switch is clear." },
    { id: "application", label: "Application egress", value: `${formatRate(data.applicationBytesPerSecond10s)} / 10 s · ${formatRate(data.applicationBytesPerSecond60s)} / 60 s` },
    { id: "live", label: "Live dashboard payload", value: `${formatRate(data.liveBytesPerSecond10s)} / 10 s · ${formatRate(data.liveBytesPerSecond60s)} / 60 s` },
    { id: "dashboards", label: "Dashboards / queued data", value: `${data.dashboards} / 8 · ${formatBytes(data.queuedBytes)}` },
    { id: "drops", label: "Application network drops", value: counterValue(data.drops), status: counterStatus(data.drops) },
  ];
  for (const nic of data.interfaces) {
    const nicStatus: DiagnosticStatus = nic.state === "up" ? "healthy" : nic.state === "down" ? "critical" : "unknown";
    rows.push(
      { id: `${nic.id}-state`, label: `NIC ${nic.id}`, value: humanize(nic.state), status: nicStatus, detail: `${metricValue(nic.receivedBytesPerSecond)} received · ${metricValue(nic.transmittedBytesPerSecond)} transmitted` },
      { id: `${nic.id}-traffic`, label: `NIC ${nic.id} byte counters`, value: `RX ${counterValue(nic.receivedBytes)} · TX ${counterValue(nic.transmittedBytes)}` },
      { id: `${nic.id}-errors`, label: `NIC ${nic.id} errors`, value: `RX ${counterValue(nic.receiveErrors)} · TX ${counterValue(nic.transmitErrors)}`, status: nic.receiveErrors.delta60s > 0 || nic.transmitErrors.delta60s > 0 ? "warning" : "healthy" },
      { id: `${nic.id}-drops`, label: `NIC ${nic.id} drops`, value: `RX ${counterValue(nic.receiveDrops)} · TX ${counterValue(nic.transmitDrops)}`, status: nic.receiveDrops.delta60s > 0 || nic.transmitDrops.delta60s > 0 ? "warning" : "healthy" },
    );
  }
  for (const client of data.clients ?? []) rows.push({
    id: `dashboard-${client.id}`,
    label: client.id,
    value: `${humanize(client.visibility)} · ${client.rateHz} Hz · ${client.targetCount} feeds`,
    detail: `${formatDuration(client.ageMs)} open · ${formatBytes(client.queuedBytes)} queued${client.lastDeliveredFrameAt ? ` · last frame ${new Date(client.lastDeliveredFrameAt).toLocaleTimeString()}` : ""}`,
  });
  if (!data.interfaces.length) rows.push({ id: "no-interfaces", label: "Host interfaces", value: "No interface sample", status: availabilityStatus(data.hostCollector) });
  return { id: "network", title: "Network and NIC", summary: "Application egress, client pressure, host NICs, and managed-switch availability.", status: issueStatus(issues, "network", availabilityStatus(data.hostCollector)), rows };
}

function evidenceCard(health: HealthSnapshotV2, issues: readonly DiagnosticIssue[]): DiagnosticCard {
  const data = health.evidence;
  const diskStatus: DiagnosticStatus = data.diskFreeBytes === undefined ? "unknown" : data.diskFreeBytes < data.diskReserveBytes ? "critical" : data.diskPressure ? "warning" : "healthy";
  const archiveStatus: DiagnosticStatus = data.archive.state === "attention" ? "warning" : "healthy";
  const verification = data.archive.lastVerification;
  const rows: DiagnosticRow[] = [
    { id: "recording", label: "Evidence recording", value: data.healthy ? "Ready" : "Error", status: data.healthy ? "healthy" : "critical" },
    { id: "disk", label: "Disk free / reserve", value: `${formatBytes(data.diskFreeBytes)} / ${formatBytes(data.diskReserveBytes)}`, status: diskStatus },
    { id: "writer", label: "Writer queue", value: `${data.writerQueueItems} items · ${formatBytes(data.writerQueueBytes)} · oldest ${formatDuration(data.writerOldestAgeMs)}` },
    { id: "write-rate", label: "Evidence write rate (10 s)", value: formatRate(data.writeBytesPerSecond10s) },
    { id: "exports", label: "Exports", value: `${data.exportsActive} active · ${data.exportsQueued} queued` },
    { id: "archive", label: "Saved recordings", value: `${data.archive.incompleteSessions} incomplete · ${data.archive.corruptSessions} corrupt`, status: archiveStatus },
    { id: "finalizer", label: "Finalizer", value: `${data.archive.finalizer.queueItems} / ${data.archive.finalizer.queueLimit} queued · oldest ${formatDuration(data.archive.finalizer.oldestAgeMs)}`, status: data.archive.finalizer.lastFailure ? "warning" : "healthy" },
    { id: "verification", label: "Last full verification", value: verification ? `${humanize(verification.outcome)} · ${verification.verifiedAt ?? "time not recorded"}` : "Not run", detail: `${data.archive.verificationNotRunSessions} saved recordings not verified` },
    { id: "allocations", label: "Baseline / RF ring memory", value: `${formatBytes(data.baselineBytes)} / ${formatBytes(data.ringBytes)}` },
  ];
  return { id: "evidence", title: "Evidence and disk", summary: "Writer latency, disk reserve, exports, and bounded evidence allocations.", status: issueStatus(issues, "evidence", data.healthy ? diskStatus : "critical"), rows };
}

function distribution(label: string, target: TargetTimingHealth): DiagnosticRow[] {
  const revisit = target.revisitMs;
  const gap = target.unobservedGapMs;
  const missCauses = Object.entries(target.missesByCause).filter(([, count]) => count > 0).map(([cause, count]) => `${humanize(cause)} ${count}`).join(", ");
  return [
    { id: `${target.targetId}-revisit`, label: `${label} revisit`, value: `objective ${formatDuration(target.objectiveMs)} · p50 ${formatDuration(revisit.p50)} · p95 ${formatDuration(revisit.p95)} · p99 ${formatDuration(revisit.p99)} · max ${formatDuration(revisit.maximum)}`, status: target.missedObjectives > 0 ? "warning" : revisit.samples ? "healthy" : "unknown" },
    { id: `${target.targetId}-gap`, label: `${label} unobserved gap`, value: `p50 ${formatDuration(gap.p50)} · p95 ${formatDuration(gap.p95)} · p99 ${formatDuration(gap.p99)} · max ${formatDuration(gap.maximum)}`, detail: `${target.completedVisits} complete · ${target.unknownVisits} unknown · ${target.missedObjectives} missed${missCauses ? ` · ${missCauses}` : ""}` },
  ];
}

function scheduleCard(health: HealthSnapshotV2, issues: readonly DiagnosticIssue[], simulation: boolean): DiagnosticCard {
  const data = health.schedule;
  const scheduler = data.health;
  const commissioning = data.commissioning;
  const lifecycleCounts = new Map<string, number>();
  const rejectedReasons = new Map<string, number>();
  const disqualifiedReasons = new Map<string, number>();
  let rejectedVisits = 0;
  let disqualifiedHours = 0;
  for (const baseline of data.baselines) lifecycleCounts.set(baseline.lifecycle, (lifecycleCounts.get(baseline.lifecycle) ?? 0) + 1);
  for (const baseline of data.baselines) {
    const exclusions = baseline.learningExclusions;
    if (!exclusions) continue;
    rejectedVisits += exclusions.rejectedVisits;
    disqualifiedHours += exclusions.disqualifiedHours;
    for (const [reason, count] of Object.entries(exclusions.rejectedByReason)) {
      rejectedReasons.set(reason, (rejectedReasons.get(reason) ?? 0) + count);
    }
    for (const [reason, count] of Object.entries(exclusions.disqualifiedByReason)) {
      disqualifiedReasons.set(reason, (disqualifiedReasons.get(reason) ?? 0) + count);
    }
  }
  const rows: DiagnosticRow[] = [
    { id: "profile", label: "Scan profile", value: scheduler.profile },
    { id: "current-coverage", label: "Current scan coverage", value: simulation ? "Not tested" : scheduler.currentCoverage ? humanize(scheduler.currentCoverage.state) : "Not reported", status: simulation ? "not-tested" : scheduler.currentCoverage?.state === "on-time" ? "healthy" : scheduler.currentCoverage?.state === "late" ? "warning" : "unknown", detail: scheduler.currentCoverage?.targetId ? `${scheduler.currentCoverage.targetId}${scheduler.currentCoverage.cause ? ` · ${humanize(scheduler.currentCoverage.cause)}` : ""}${scheduler.currentCoverage.objectiveMs !== undefined ? ` · objective ${formatDuration(scheduler.currentCoverage.objectiveMs)}` : ""}${scheduler.currentCoverage.measuredRevisitMs !== undefined ? ` · measured ${formatDuration(scheduler.currentCoverage.measuredRevisitMs)}` : ""}` : undefined },
    { id: "objective", label: "Tier-1 objective", value: simulation ? "Not tested" : scheduler.tier1MeetingObjective === undefined ? "Not enough observations" : scheduler.tier1MeetingObjective ? "Meeting objective" : "Misses observed", status: simulation ? "not-tested" : scheduler.tier1MeetingObjective === undefined ? "unknown" : scheduler.tier1MeetingObjective ? "healthy" : "warning" },
    { id: "visits", label: "Completed / unknown / missed", value: `${scheduler.completedVisits} / ${scheduler.unknownVisits} / ${scheduler.missedObjectives}` },
    { id: "commissioning", label: "Commissioning", value: simulation ? "Not tested" : humanize(commissioning.state), status: simulation ? "not-tested" : commissioning.ready ? "healthy" : "warning", detail: `${formatDuration(commissioning.soakElapsedMs)} of ${formatDuration(commissioning.soakRequiredMs)}` },
    { id: "production-qualification", label: "Production qualification", value: simulation ? "Not tested" : health.productionQualification.ready ? "Qualified" : "Not qualified", status: simulation ? "not-tested" : health.productionQualification.ready ? "healthy" : "warning", detail: health.productionQualification.blockers.join(", ") || "No blocker codes" },
    { id: "baselines", label: "Baselines", value: `${data.baselines.length} tracked`, detail: [...lifecycleCounts].map(([state, count]) => `${humanize(state)} ${count}`).join(" · ") || "None" },
  ];
  if (rejectedVisits > 0 || disqualifiedHours > 0) rows.push({
    id: "learning-exclusions",
    label: "Learning exclusions",
    value: `${rejectedVisits} rejected visit${rejectedVisits === 1 ? "" : "s"} · ${disqualifiedHours} excluded hour${disqualifiedHours === 1 ? "" : "s"}`,
    detail: [
      ...[...rejectedReasons].map(([reason, count]) => `${humanize(reason)} ${count}`),
      ...[...disqualifiedReasons].map(([reason, count]) => `${humanize(reason)} hours ${count}`),
    ].join(" · ") || undefined,
  });
  for (const target of data.targets) rows.push(...distribution(target.targetId, target));
  const fallback: DiagnosticStatus = simulation ? "not-tested" : commissioning.ready && scheduler.tier1MeetingObjective ? "healthy" : "warning";
  return { id: "schedule", title: "Schedule and commissioning", summary: "Per-target revisit and unobserved-gap distributions, misses, commissioning, and baselines.", status: issueStatus(issues, "schedule", fallback), rows };
}

function lossPercent(health: HealthSnapshotV2): number {
  const data = health.dataContinuity;
  const rfDenominator = Math.max(1, data.receivedFrames.delta10s);
  const evidenceDenominator = Math.max(1, data.evidenceFramesRecorded.delta10s + data.evidenceFramesLost.delta10s);
  const browserDenominator = Math.max(1, data.browserFramesCoalesced.delta10s + data.browserFramesDropped.delta10s);
  return Math.max((data.invalidOrStaleFrames.delta10s / rfDenominator) * 100, (data.evidenceFramesLost.delta10s / evidenceDenominator) * 100, (data.browserFramesDropped.delta10s / browserDenominator) * 100);
}

function recoveryNotice(health: HealthSnapshotV2): DiagnosticRecoveryNotice | undefined {
  if (!health.recovery) return undefined;
  const candidates = ([
    ["receiver", health.recovery.receiver],
    ["software", health.recovery.application],
  ] as const).filter(([, operation]) => operation.requestId || operation.requestedAt || operation.outcome === "suppressed" || operation.outcome === "lockout");
  const selected = [...candidates].sort((left, right) => (right[1].requestedAt ?? "").localeCompare(left[1].requestedAt ?? ""))[0];
  if (!selected) return undefined;
  const [kind, operation] = selected;
  if (operation.outcome === "request-accepted" || operation.outcome === "helper-pending") return {
    kind,
    state: "progress",
    label: kind === "receiver" ? "Receiver retry in progress" : "Software restart in progress",
    detail: "Waiting for the external health check.",
  };
  if (operation.outcome === "verified-recovery") return {
    kind,
    state: "verified",
    label: kind === "receiver" ? "Receiver retry verified" : "Software restart verified",
    detail: kind === "receiver" ? "Fresh RF data confirmed recovery." : "New service boot confirmed. Check RF data and Recording before closing.",
  };
  if (operation.outcome === "suppressed") return {
    kind,
    state: "attention",
    label: operation.reasonCode === "host-memory-pressure" ? "Recovery paused" : kind === "receiver" ? "Receiver starting" : "Recovery paused",
    detail: operation.reasonCode === "host-memory-pressure" ? "Waiting for computer memory." : "Wait.",
  };
  return {
    kind,
    state: "attention",
    label: kind === "receiver" ? "Receiver retry needs attention" : "Software restart needs attention",
    detail: recoveryProblem(operation),
  };
}

function recoveryProblem(operation: RecoveryOperationHealth): string {
  if (operation.outcome === "lockout") return "Recovery is locked after repeated attempts. Stop and review System health.";
  if (operation.outcome === "cooldown") return "Recovery is cooling down. Do not retry yet.";
  return "The recovery helper is unavailable. Do not keep retrying.";
}

export function diagnosticsTrendSample(health: HealthSnapshotV2, at = Date.now()): DiagnosticsTrendSample {
  return { at, cpuPercent: health.software.rfMonitorCpuHostNormalized.current, rssBytes: health.software.rssBytes, bandwidthBytesPerSecond: health.network.applicationBytesPerSecond10s, lossPercent: lossPercent(health), writerDelayMs: health.evidence.writerOldestAgeMs };
}

export function appendDiagnosticsTrend(samples: readonly DiagnosticsTrendSample[], sample: DiagnosticsTrendSample): DiagnosticsTrendSample[] {
  const earliest = sample.at - DIAGNOSTICS_TREND_WINDOW_MS;
  return [...samples.filter((entry) => entry.at >= earliest && entry.at <= sample.at), sample].slice(-DIAGNOSTICS_TREND_LIMIT);
}

export function isHealthSnapshotV2(value: unknown): value is HealthSnapshotV2 {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HealthSnapshotV2>;
  return candidate.schemaVersion === 2 && typeof candidate.generatedAt === "string" && Boolean(candidate.summary && candidate.receiverPath && candidate.dataContinuity && candidate.software && candidate.network && candidate.evidence && candidate.schedule);
}

export function buildDiagnosticsModel(health: HealthSnapshotV2 | undefined, snapshot?: MonitorSnapshot): DiagnosticsViewModel {
  if (!health) return { status: "unknown", label: "No data", headline: "System status is unavailable.", action: "Check the service connection.", simulation: false, issues: [], checks: EMPTY_CHECKS.map((check) => ({ ...check })), cards: [] };
  const simulation = health.summary.state === "simulation" || health.schedule.commissioning.simulation;
  const issues = mapIssues(health, snapshot);
  const checks = buildOperatorChecks(health, simulation, snapshot);
  const cards = [receiverCard(health, issues, simulation), continuityCard(health, issues), softwareCard(health, issues, simulation), networkCard(health, issues), evidenceCard(health, issues), scheduleCard(health, issues, simulation)];
  const recovery = recoveryNotice(health);
  const critical = issues.filter((issue) => issue.severity === "critical").length;
  const warning = issues.length - critical;
  if (health.summary.state === "critical" || critical > 0) return { status: "critical", label: "Critical", headline: `${Math.max(1, critical)} critical item${critical === 1 ? " needs" : "s need"} action.`, action: "Follow the first action below.", simulation, issues, checks, cards, recovery };
  if (health.summary.state === "attention" || warning > 0 || recovery?.state === "attention") return { status: "warning", label: "Attention", headline: `${Math.max(1, warning)} item${warning === 1 ? " needs" : "s need"} attention.`, action: "Follow the first action below.", simulation, issues, checks, cards, recovery };
  if (health.summary.state === "simulation") return { status: "not-tested", label: "Simulation", headline: "Simulation is running.", action: "Receiver hardware is not tested.", simulation, issues, checks, cards, recovery };
  return { status: "healthy", label: "Normal", headline: "Monitoring is working.", action: "No action needed.", simulation, issues, checks, cards, recovery };
}

const SECRET_KEY = /(password|passwd|secret|token|cookie|authorization|credential|csrf|private.?key)/i;
const PRIVATE_ID_KEY = /^(siteName|hostname|hostName|serial|serialNumber|deviceSerial|mac|macAddress)$/i;
const PATH_KEY = /(path|directory|storageRoot|certificateFile|keyFile)$/i;
const ADDRESS_KEY = /^(address|ip|ipAddress|url|origin|host)$/i;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const MAC = /\b(?:[0-9a-f]{2}:){5}[0-9a-f]{2}\b/gi;
const EMBEDDED_PATH = /(^|[\s(])\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+/g;

function redactString(value: string, key: string): string {
  if (PRIVATE_ID_KEY.test(key)) return "[redacted-identity]";
  if (PATH_KEY.test(key) || value.startsWith("/")) return "[redacted-path]";
  if (ADDRESS_KEY.test(key) || /^(?:https?|wss?):\/\//i.test(value)) return "[redacted-address]";
  return value
    .replace(IPV4, "[redacted-ip]")
    .replace(MAC, "[redacted-mac]")
    .replace(EMBEDDED_PATH, (_match, prefix: string) => `${prefix}[redacted-path]`);
}

export function redactDiagnostics(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") return redactString(value, key);
  if (Array.isArray(value)) return value.map((entry) => redactDiagnostics(entry, key));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, redactDiagnostics(entry, entryKey)]));
}

export function redactedDiagnosticsJson(health: HealthSnapshotV2): string {
  return `${JSON.stringify(redactDiagnostics(health), null, 2)}\n`;
}
