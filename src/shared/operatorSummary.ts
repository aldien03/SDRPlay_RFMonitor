export const OPERATOR_SUMMARY_SCHEMA_VERSION = 1 as const;
export const OPERATOR_COPY_VERSION = "operator-copy-v2" as const;
export const MAX_OPERATOR_AFFECTED_TARGETS = 16;

export const OPERATOR_MONITORING_STATES = [
  "offline",
  "data-late",
  "alert",
  "recovering",
  "paused",
  "checking",
  "normal",
] as const;

export type OperatorMonitoringState = typeof OPERATOR_MONITORING_STATES[number];
export type OperatorDataMode = "field" | "simulation" | "unknown";
export type OperatorRecordingState = "recording" | "stopped" | "error";
export type OperatorCurrentHealthState = "normal" | "attention" | "critical" | "simulation";
export type OperatorQualificationState = "qualified" | "pending" | "failed" | "simulation";
export type OperatorIncidentLifecycle = "active" | "recovering" | "unknown";
export type OperatorCoverageState = "observed" | "not-observed" | "unknown";

export const OPERATOR_REASON_CODES = [
  "monitoring-normal",
  "monitoring-checking",
  "signal-learning",
  "candidate-checking",
  "receiver-offline",
  "live-data-late",
  "incident-active",
  "incident-recovering",
  "monitoring-paused",
  "recording-active",
  "recording-stopped",
  "recording-error",
  "health-normal",
  "health-attention",
  "health-critical",
  "health-simulation",
  "qualification-qualified",
  "qualification-pending",
  "qualification-failed",
  "qualification-simulation",
  "state-code-unknown",
] as const;

export type OperatorReasonCode = typeof OPERATOR_REASON_CODES[number];

export const OPERATOR_ACTION_CODES = [
  "none",
  "retry-receiver",
  "reload-live-data",
  "reload-page",
  "open-incident",
  "resume-monitoring",
  "wait-for-check",
  "open-recording",
  "open-system-health",
  "review-qualification",
] as const;

export type OperatorActionCode = typeof OPERATOR_ACTION_CODES[number];

const monitoringStateSet = new Set<string>(OPERATOR_MONITORING_STATES);
const reasonCodeSet = new Set<string>(OPERATOR_REASON_CODES);
const actionCodeSet = new Set<string>(OPERATOR_ACTION_CODES);

export interface OperatorAffectedTarget {
  id: string;
  label: string;
  frequencyLabel?: string;
}

export interface OperatorIncidentSummary {
  id: string;
  lifecycle: OperatorIncidentLifecycle;
  verdict: string;
  observation: string;
  recommendedAction: string;
  evidenceStrength: "Low" | "Medium";
  startedAt: string;
  synthetic: boolean;
}

export interface OperatorObservationSummary {
  /** The only RF-observation timestamp exposed by the operator summary. */
  at: string | null;
  ageMs: number | null;
  coverage: OperatorCoverageState;
  /** Physical target that produced `at`; omitted only for one-release legacy input. */
  targetId?: string;
}

export interface OperatorMonitoringSummary {
  state: OperatorMonitoringState;
  reasonCode: OperatorReasonCode;
  actionCode: OperatorActionCode;
  since: string;
}

export interface OperatorRecordingSummary {
  state: OperatorRecordingState;
  reasonCode: OperatorReasonCode;
  actionCode: OperatorActionCode;
}

export interface OperatorCurrentHealthSummary {
  state: OperatorCurrentHealthState;
  reasonCode: OperatorReasonCode;
  actionCode: OperatorActionCode;
}

export interface OperatorQualificationSummary {
  state: OperatorQualificationState;
  ready: boolean;
  reasonCode: OperatorReasonCode;
  actionCode: OperatorActionCode;
  epochId?: string;
}

export interface OperatorSummaryV1 {
  schemaVersion: typeof OPERATOR_SUMMARY_SCHEMA_VERSION;
  copyVersion: typeof OPERATOR_COPY_VERSION;
  generatedAt: string;
  serverBuildId: string;
  dataMode: OperatorDataMode;
  monitoring: OperatorMonitoringSummary;
  incident?: OperatorIncidentSummary;
  recording: OperatorRecordingSummary;
  currentHealth: OperatorCurrentHealthSummary;
  productionQualification: OperatorQualificationSummary;
  affectedTargets: OperatorAffectedTarget[];
  observation: OperatorObservationSummary;
}

export interface OperatorSummaryInput {
  generatedAt: string;
  serverBuildId: string;
  /** Runtime boundary input. `test` and `simulation` both render as Simulation. */
  dataDomain: string;
  monitoring: {
    receiverOnline: boolean;
    dataFresh: boolean;
    paused: boolean;
    alertActive: boolean;
    recovering: boolean;
    candidateActive: boolean;
    detectingActive: boolean;
    checking: boolean;
    since?: string;
    reasonCode?: string;
    actionCode?: string;
  };
  incident?: {
    id: string;
    lifecycle: string;
    verdict: string;
    observation: string;
    recommendedAction: string;
    evidenceStrength: string;
    startedAt: string;
    synthetic?: boolean;
  };
  recording: {
    state: string;
    reasonCode?: string;
    actionCode?: string;
  };
  currentHealth: {
    state: string;
    reasonCode?: string;
    actionCode?: string;
  };
  productionQualification: {
    state: string;
    ready: boolean;
    reasonCode?: string;
    actionCode?: string;
    epochId?: string;
  };
  affectedTargets?: ReadonlyArray<{
    id: string;
    label: string;
    frequencyLabel?: string;
  }>;
  observation: {
    at?: string | null;
    coverage: string;
    targetId?: string;
  };
}

export interface OperatorPresentation {
  mode: string;
  monitoring: string;
  observation: string;
  action: string;
  recording: string;
  currentHealth: string;
  productionQualification: string;
}

export const OPERATOR_REASON_COPY: Readonly<Record<OperatorReasonCode, string>> = {
  "monitoring-normal": "No RF anomaly",
  "monitoring-checking": "Checking signal",
  "signal-learning": "Signal learning",
  "candidate-checking": "Checking repeated signal change",
  "receiver-offline": "Receiver offline",
  "live-data-late": "Data late",
  "incident-active": "RF anomaly detected",
  "incident-recovering": "Signal recovering",
  "monitoring-paused": "Monitoring paused",
  "recording-active": "Recording on",
  "recording-stopped": "Recording stopped",
  "recording-error": "Recording error",
  "health-normal": "System normal",
  "health-attention": "Needs attention",
  "health-critical": "Critical",
  "health-simulation": "Simulation",
  "qualification-qualified": "Qualified",
  "qualification-pending": "Not qualified",
  "qualification-failed": "Qualification failed",
  "qualification-simulation": "Test only",
  "state-code-unknown": "Needs attention",
};

export const OPERATOR_ACTION_COPY: Readonly<Record<OperatorActionCode, string>> = {
  none: "None",
  "retry-receiver": "Retry receiver",
  "reload-live-data": "Reload connection",
  "reload-page": "Reload page",
  "open-incident": "Open incident",
  "resume-monitoring": "Resume monitoring",
  "wait-for-check": "Wait for the next scan",
  "open-recording": "Open Recording",
  "open-system-health": "Open System health",
  "review-qualification": "Review qualification",
};

const MONITORING_LABELS: Readonly<Record<OperatorMonitoringState, string>> = {
  offline: "Offline",
  "data-late": "Data late",
  alert: "Alert",
  recovering: "Recovering",
  paused: "Paused",
  checking: "Checking",
  normal: "Normal",
};

const RECORDING_LABELS: Readonly<Record<OperatorRecordingState, string>> = {
  recording: "Recording",
  stopped: "Stopped",
  error: "Error",
};

const HEALTH_LABELS: Readonly<Record<OperatorCurrentHealthState, string>> = {
  normal: "Normal",
  attention: "Attention",
  critical: "Critical",
  simulation: "Simulation",
};

const QUALIFICATION_LABELS: Readonly<Record<OperatorQualificationState, string>> = {
  qualified: "Qualified",
  pending: "Not qualified",
  failed: "Failed",
  simulation: "Test only",
};

function validIso(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

function normalizedIso(value: string): string {
  return new Date(value).toISOString();
}

function knownReason(value: string | undefined): value is OperatorReasonCode {
  return value === undefined || reasonCodeSet.has(value);
}

function knownAction(value: string | undefined): value is OperatorActionCode {
  return value === undefined || actionCodeSet.has(value);
}

function defaultMonitoringCodes(
  state: OperatorMonitoringState,
  checkingMode: "candidate" | "learning" | "generic",
): [OperatorReasonCode, OperatorActionCode] {
  if (state === "offline") return ["receiver-offline", "retry-receiver"];
  if (state === "data-late") return ["live-data-late", "reload-live-data"];
  if (state === "alert") return ["incident-active", "open-incident"];
  if (state === "recovering") return ["incident-recovering", "open-incident"];
  if (state === "paused") return ["monitoring-paused", "resume-monitoring"];
  if (state === "checking") {
    if (checkingMode === "candidate") return ["candidate-checking", "wait-for-check"];
    if (checkingMode === "learning") return ["signal-learning", "wait-for-check"];
    return ["monitoring-checking", "wait-for-check"];
  }
  return ["monitoring-normal", "none"];
}

function monitoringState(input: OperatorSummaryInput, contractIssue: boolean, coverage: OperatorCoverageState): OperatorMonitoringState {
  const { monitoring, incident } = input;
  if (!monitoring.receiverOnline) return "offline";
  if (!monitoring.dataFresh) return "data-late";
  if (monitoring.alertActive || incident?.lifecycle === "active") return "alert";
  if (monitoring.recovering || incident?.lifecycle === "recovering") return "recovering";
  if (monitoring.paused) return "paused";
  if (
    contractIssue
    || monitoring.checking
    || monitoring.candidateActive
    || monitoring.detectingActive
    || coverage !== "observed"
  ) return "checking";
  return "normal";
}

function normalizeMode(value: string): OperatorDataMode {
  if (value === "field") return "field";
  if (value === "test" || value === "simulation") return "simulation";
  return "unknown";
}

function normalizeCoverage(value: string): OperatorCoverageState {
  if (value === "observed" || value === "not-observed" || value === "unknown") return value;
  return "unknown";
}

function normalizeIncident(input: OperatorSummaryInput["incident"]): OperatorIncidentSummary | undefined {
  if (!input) return undefined;
  const lifecycle: OperatorIncidentLifecycle = input.lifecycle === "active" || input.lifecycle === "recovering"
    ? input.lifecycle
    : "unknown";
  return {
    id: input.id.slice(0, 160),
    lifecycle,
    verdict: input.verdict.slice(0, 160),
    observation: input.observation.slice(0, 240),
    recommendedAction: input.recommendedAction.slice(0, 240),
    evidenceStrength: input.evidenceStrength === "Medium" ? "Medium" : "Low",
    startedAt: validIso(input.startedAt) ? normalizedIso(input.startedAt) : new Date(0).toISOString(),
    synthetic: Boolean(input.synthetic),
  };
}

function normalizeTargets(values: OperatorSummaryInput["affectedTargets"]): OperatorAffectedTarget[] {
  const seen = new Set<string>();
  const targets: OperatorAffectedTarget[] = [];
  for (const value of values ?? []) {
    const id = value.id.trim().slice(0, 160);
    const label = value.label.trim().slice(0, 160);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    targets.push({
      id,
      label,
      ...(value.frequencyLabel?.trim() ? { frequencyLabel: value.frequencyLabel.trim().slice(0, 80) } : {}),
    });
    if (targets.length >= MAX_OPERATOR_AFFECTED_TARGETS) break;
  }
  return targets;
}

/**
 * Resolves one server-owned operator truth. The order below is safety-critical:
 * Offline > Data late > Alert > Recovering > Paused > Checking > Normal.
 */
export function resolveOperatorSummary(input: OperatorSummaryInput): OperatorSummaryV1 {
  const dataMode = normalizeMode(input.dataDomain);
  const coverage = normalizeCoverage(input.observation.coverage);
  const generatedAtValid = validIso(input.generatedAt);
  const observationAtValid = input.observation.at == null || validIso(input.observation.at);
  const reasonCodesKnown = [
    input.monitoring.reasonCode,
    input.recording.reasonCode,
    input.currentHealth.reasonCode,
    input.productionQualification.reasonCode,
  ].every(knownReason);
  const actionCodesKnown = [
    input.monitoring.actionCode,
    input.recording.actionCode,
    input.currentHealth.actionCode,
    input.productionQualification.actionCode,
  ].every(knownAction);
  const recordingKnown = ["recording", "stopped", "error"].includes(input.recording.state);
  const healthKnown = ["normal", "attention", "critical", "simulation"].includes(input.currentHealth.state);
  const qualificationKnown = ["qualified", "pending", "failed", "simulation"].includes(input.productionQualification.state);
  const incidentKnown = !input.incident
    || (["active", "recovering"].includes(input.incident.lifecycle)
      && ["Low", "Medium"].includes(input.incident.evidenceStrength)
      && validIso(input.incident.startedAt));
  const contractIssue = dataMode === "unknown"
    || !generatedAtValid
    || !observationAtValid
    || coverage !== input.observation.coverage
    || !reasonCodesKnown
    || !actionCodesKnown
    || !recordingKnown
    || !healthKnown
    || !qualificationKnown
    || !incidentKnown;

  const generatedAt = generatedAtValid ? normalizedIso(input.generatedAt) : new Date(0).toISOString();
  const at = observationAtValid && input.observation.at ? normalizedIso(input.observation.at) : null;
  const state = monitoringState(input, contractIssue, at ? coverage : "unknown");
  const checkingMode = input.monitoring.candidateActive
    ? "candidate" as const
    : input.monitoring.detectingActive
      ? "learning" as const
      : "generic" as const;
  const [defaultReason, defaultAction] = defaultMonitoringCodes(state, checkingMode);
  const monitoringReason = contractIssue && state === "checking"
    ? "state-code-unknown"
    : knownReason(input.monitoring.reasonCode) && input.monitoring.reasonCode
      ? input.monitoring.reasonCode
      : defaultReason;
  const monitoringAction = contractIssue && state === "checking"
    ? "open-system-health"
    : knownAction(input.monitoring.actionCode) && input.monitoring.actionCode
      ? input.monitoring.actionCode
      : defaultAction;

  let currentHealthState: OperatorCurrentHealthState = healthKnown
    ? input.currentHealth.state as OperatorCurrentHealthState
    : "attention";
  if (dataMode === "simulation" && currentHealthState === "normal") currentHealthState = "simulation";
  if (contractIssue && currentHealthState !== "critical") currentHealthState = "attention";
  const defaultHealthReason: OperatorReasonCode = currentHealthState === "normal"
    ? "health-normal"
    : currentHealthState === "critical"
      ? "health-critical"
      : currentHealthState === "simulation"
        ? "health-simulation"
        : "health-attention";

  const recordingState: OperatorRecordingState = recordingKnown
    ? input.recording.state as OperatorRecordingState
    : "error";
  const defaultRecordingReason: OperatorReasonCode = recordingState === "recording"
    ? "recording-active"
    : recordingState === "stopped"
      ? "recording-stopped"
      : "recording-error";
  const defaultRecordingAction: OperatorActionCode = recordingState === "recording" ? "none" : "open-recording";

  let qualificationState: OperatorQualificationState = qualificationKnown
    ? input.productionQualification.state as OperatorQualificationState
    : "failed";
  if (dataMode !== "field") qualificationState = dataMode === "simulation" ? "simulation" : "failed";
  const qualificationReady = !contractIssue
    && dataMode === "field"
    && qualificationState === "qualified"
    && input.productionQualification.ready;
  const defaultQualificationReason: OperatorReasonCode = qualificationState === "qualified"
    ? "qualification-qualified"
    : qualificationState === "pending"
      ? "qualification-pending"
      : qualificationState === "simulation"
        ? "qualification-simulation"
        : "qualification-failed";

  return {
    schemaVersion: OPERATOR_SUMMARY_SCHEMA_VERSION,
    copyVersion: OPERATOR_COPY_VERSION,
    generatedAt,
    serverBuildId: input.serverBuildId.trim().slice(0, 160),
    dataMode,
    monitoring: {
      state,
      reasonCode: monitoringReason,
      actionCode: monitoringAction,
      since: validIso(input.monitoring.since) ? normalizedIso(input.monitoring.since) : generatedAt,
    },
    ...(input.incident ? { incident: normalizeIncident(input.incident) } : {}),
    recording: {
      state: recordingState,
      reasonCode: contractIssue && (!recordingKnown || !knownReason(input.recording.reasonCode))
        ? "state-code-unknown"
        : input.recording.reasonCode as OperatorReasonCode | undefined ?? defaultRecordingReason,
      actionCode: contractIssue && (!recordingKnown || !knownAction(input.recording.actionCode))
        ? "open-recording"
        : input.recording.actionCode as OperatorActionCode | undefined ?? defaultRecordingAction,
    },
    currentHealth: {
      state: currentHealthState,
      reasonCode: contractIssue
        ? "state-code-unknown"
        : input.currentHealth.reasonCode as OperatorReasonCode | undefined ?? defaultHealthReason,
      actionCode: contractIssue
        ? "open-system-health"
        : input.currentHealth.actionCode as OperatorActionCode | undefined
          ?? (currentHealthState === "normal" || currentHealthState === "simulation" ? "none" : "open-system-health"),
    },
    productionQualification: {
      state: qualificationState,
      ready: qualificationReady,
      reasonCode: contractIssue && (!qualificationKnown || !knownReason(input.productionQualification.reasonCode))
        ? "state-code-unknown"
        : input.productionQualification.reasonCode as OperatorReasonCode | undefined ?? defaultQualificationReason,
      actionCode: contractIssue && (!qualificationKnown || !knownAction(input.productionQualification.actionCode))
        ? "open-system-health"
        : input.productionQualification.actionCode as OperatorActionCode | undefined
          ?? (qualificationReady || qualificationState === "simulation" ? "none" : "review-qualification"),
      ...(input.productionQualification.epochId?.trim()
        ? { epochId: input.productionQualification.epochId.trim().slice(0, 160) }
        : {}),
    },
    affectedTargets: normalizeTargets(input.affectedTargets),
    observation: {
      at,
      ageMs: at ? Math.max(0, Date.parse(generatedAt) - Date.parse(at)) : null,
      coverage: at ? coverage : "unknown",
      ...(at && input.observation.targetId?.trim()
        ? { targetId: input.observation.targetId.trim().slice(0, 160) }
        : {}),
    },
  };
}

export function isOperatorSummary(value: unknown): value is OperatorSummaryV1 {
  if (!value || typeof value !== "object") return false;
  const summary = value as Partial<OperatorSummaryV1>;
  return summary.schemaVersion === OPERATOR_SUMMARY_SCHEMA_VERSION
    && summary.copyVersion === OPERATOR_COPY_VERSION
    && summary.dataMode !== undefined
    && ["field", "simulation", "unknown"].includes(summary.dataMode)
    && Boolean(summary.monitoring && monitoringStateSet.has(summary.monitoring.state))
    && Boolean(summary.recording && ["recording", "stopped", "error"].includes(summary.recording.state))
    && Boolean(summary.currentHealth && ["normal", "attention", "critical", "simulation"].includes(summary.currentHealth.state))
    && Boolean(summary.productionQualification && ["qualified", "pending", "failed", "simulation"].includes(summary.productionQualification.state));
}

export function presentOperatorSummary(summary: OperatorSummaryV1): OperatorPresentation {
  return {
    mode: summary.dataMode === "field" ? "Live field data" : summary.dataMode === "simulation" ? "Simulation" : "Mode unknown",
    monitoring: MONITORING_LABELS[summary.monitoring.state],
    observation: OPERATOR_REASON_COPY[summary.monitoring.reasonCode] ?? OPERATOR_REASON_COPY["state-code-unknown"],
    action: OPERATOR_ACTION_COPY[summary.monitoring.actionCode] ?? OPERATOR_ACTION_COPY["open-system-health"],
    recording: RECORDING_LABELS[summary.recording.state],
    currentHealth: HEALTH_LABELS[summary.currentHealth.state],
    productionQualification: QUALIFICATION_LABELS[summary.productionQualification.state],
  };
}
