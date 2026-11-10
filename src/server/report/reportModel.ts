/**
 * One model for the client incident report. Built once from the recorded
 * evidence, stored as report.json, and rendered to HTML (also shown in the
 * app) and to PDF. Every sentence here describes what the receiver recorded;
 * nothing attributes intent or claims calibrated power.
 */
import { alertPresetLabel, describeAlertPolicy, detailKindLabel, legacyDetailKind } from "../../shared/alertPolicy";
import { incidentReference } from "../../shared/incidentNaming";
import { rfVerdictFor } from "../../shared/productContract";
import type { AlertTriggerSnapshot, DetectionEvent, IncidentTimelineEntry, ReportIdentity } from "../../shared/types";
import type { AnalysisChartSet } from "../incidentAnalysis";
import type { IncidentFigureData, IncidentFigureSummary } from "../incidentFigure";
import { frequencyAxisTicks, levelRange, numericTicks, timeAxisTicks, type ChartPoint, type ChartSpec } from "./chartSpec";
import { bandwidthText, durationText, frequencyMHz, frequencyRange, localDateTime, multiple, percent, utcDateTime } from "./format";
import { REPORT_COLORS } from "./theme";
import { triggerSnapshotChart } from "./triggerChart";

export const REPORT_SCHEMA_VERSION = 1 as const;

export interface ReportFact {
  label: string;
  value: string;
  note?: string;
}

export interface ReportRuleRow {
  label: string;
  measured: string;
  threshold: string;
  met: boolean;
}

export interface ReportTimelineRow {
  at: string;
  atText: string;
  label: string;
  detail?: string;
}

export interface IncidentReportModel {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  kind: "rf-incident-report";
  generatedAt: string;
  generatedAtText: string;
  scope: "evidence-package" | "live-snapshot";
  reference: string;
  dataDomain: "field" | "test";
  title: string;
  identity: {
    companyName?: string;
    clientName?: string;
    vesselName?: string;
    projectReference?: string;
    siteName: string;
    deploymentId?: string;
    logo?: { sha256: string; mediaType: "image/png" | "image/jpeg"; dataUri?: string };
  };
  software: ReportFact[];
  incident: {
    id: string;
    verdict: string;
    status: string;
    ruleLabel?: string;
    affected: string;
    evidenceStrength: "Low" | "Medium";
    evidenceMeaning: string;
    startedAt: string;
    endedAt?: string;
    disturbed: string;
    checkedWindow: string;
    observed: string;
    recommendedAction: string;
    endReason?: string;
  };
  summary: { paragraph: string; facts: ReportFact[] };
  why?: {
    sentence: string;
    rules: ReportRuleRow[];
    persistence: string;
    sensitivity: { label: string; source: string; rules: ReportFact[] };
    reference: ReportFact[];
  };
  timeline: ReportTimelineRow[];
  findings: string[];
  keyNumbers: ReportFact[];
  receiver: ReportFact[];
  notes: Array<{ atText: string; text: string }>;
  charts: ChartSpec[];
  completeness: { complete: boolean; statements: string[] };
  integrity: {
    files: Array<{ path: string; bytes: number; sha256: string }>;
    statements: string[];
    verify: Array<{ platform: string; command: string }>;
  };
  limitations: string[];
  glossary: ReportFact[];
}

export interface IncidentReportInputs {
  event: DetectionEvent;
  generatedAtMs: number;
  scope: IncidentReportModel["scope"];
  dataDomain: "field" | "test";
  siteName: string;
  deploymentId?: string;
  displayTimeZone: string;
  reportIdentity?: ReportIdentity;
  logoDataUri?: string;
  serviceLabel?: string;
  runtimeIdentity?: unknown;
  figure?: { summary: IncidentFigureSummary; analysis: AnalysisChartSet; data: IncidentFigureData };
  triggerSnapshot?: AlertTriggerSnapshot;
  baselineReference?: unknown;
  sessionConfig?: unknown;
  sdrconnect?: unknown;
  completeness?: { complete: boolean; missingParts: string[] };
  evidenceFiles?: Array<{ path: string; bytes: number; sha256: string }>;
  windowStatements?: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const LIFECYCLE_LABEL: Record<string, string> = {
  learning: "Learning (not used for alerts)",
  provisional: "Provisional local reference",
  reviewable: "Learning complete, not yet approved",
  protected: "Approved baseline",
  stale: "Out of date",
};

const TIMELINE_LABEL: Record<IncidentTimelineEntry["code"], string> = {
  "first-seen": "First raised check",
  alert: "Alert raised",
  "kind-escalated": "Signal changed",
  recovering: "Clean checks started",
  returned: "Raised energy returned",
  cleared: "Alert cleared",
  ended: "Monitoring changed",
  acknowledged: "Acknowledged by an operator",
  note: "Operator note",
  "sensitivity-changed": "Alert sensitivity changed",
};

function statusLabel(event: DetectionEvent): string {
  if (event.lifecycle === "recovering") return "Recovering";
  if (event.lifecycle === "cleared" || event.clearedAt) return "Cleared";
  if (event.lifecycle === "ended-unknown" || event.endedAt) return "Ended before clearing";
  return "Active";
}

function timeWithLocal(iso: string | undefined, timeZone: string): string {
  if (!iso) return "Not recorded";
  const local = localDateTime(iso, timeZone);
  return local ? `${utcDateTime(iso)} (${local})` : utcDateTime(iso);
}

function disturbedText(event: DetectionEvent, resolutionHz: number): string {
  const ranges = event.disturbedRangesHz?.length ? event.disturbedRangesHz : event.trigger?.disturbedRangesHz;
  if (!ranges?.length) return `Within ${frequencyRange(event.affectedRangeHz, resolutionHz)}`;
  const width = ranges.reduce((total, [start, end]) => total + (end - start), 0);
  if (ranges.length === 1) return `${frequencyRange(ranges[0], resolutionHz)} (${bandwidthText(width)} wide)`;
  return `${ranges.length} parts between ${frequencyMHz(ranges[0][0], resolutionHz)} and ${frequencyMHz(ranges.at(-1)![1], resolutionHz)} (${bandwidthText(width)} in total)`;
}

function ruleMeasured(unit: string, value: number): string {
  switch (unit) {
    case "ratio": return percent(value);
    case "checks": return `${value}`;
    case "ms": return `${(value / 1000).toFixed(1)} s`;
    default: return `${multiple(value)} normal variation`;
  }
}

function whySentence(event: DetectionEvent, resolutionHz: number): string {
  const trigger = event.trigger!;
  const reference = trigger.reference.kind === "approved" ? "the approved baseline" : "the local reference learned at this site";
  const where = disturbedText(event, resolutionHz).split(" (")[0];
  const repeat = `in ${trigger.persistence.votes} of the last ${trigger.persistence.window} checks (at least ${trigger.persistence.required} needed)`;
  switch (trigger.detailKind) {
    case "wideband":
      return `Compared with ${reference}, ${percent(trigger.measured.occupancyRatio)} of the checked window was at or above the alert level ${repeat}.`;
    case "partial-band":
      return `A signal ${bandwidthText(trigger.measured.widestSegmentRatio * (trigger.analyzedRangeHz[1] - trigger.analyzedRangeHz[0]))} wide at ${where} stayed above the alert level compared with ${reference}, ${repeat}.`;
    case "narrowband":
      return `A narrow signal at ${where} reached ${multiple(trigger.measured.peakZ)} its normal variation above ${reference}, ${repeat}.`;
    case "noise-floor":
      return `The whole checked window sat ${multiple(trigger.measured.medianZ)} its normal variation above ${reference} for at least ${Math.round(trigger.policy.values.noiseFloorExposureMs / 1000)} s of observation.`;
    case "burst":
      return `Short bursts of energy at ${where} appeared in single frames above the burst level, ${repeat}.`;
    case "overload":
      return "The receiver reported input overload; its readings during that time cannot be trusted.";
  }
}

function spectrumChart(data: IncidentFigureData, alertSigma?: number): ChartSpec {
  const width = Math.max(1, data.widthPx);
  const hzAt = (pixel: number) => data.analysisStartHz + ((pixel + 0.5) / width) * (data.analysisEndHz - data.analysisStartHz);
  const toPoints = (values: Array<number | null> | number[] | undefined): ChartPoint[] => (values ?? []).map((value, pixel) => value === null || value === undefined ? null : [hzAt(pixel), value]);
  const all = [...data.before, ...data.during, ...data.strongest, ...(data.usual ?? []), ...(data.alertLevel ?? [])].filter((value): value is number => typeof value === "number");
  const [yMin, yMax] = levelRange(all);
  return {
    id: "spectrum-overview",
    title: "Spectrum before and during the incident",
    caption: "Typical level before (grey) and during (blue) the incident, and the strongest level during it (red), against the learned usual level (green) and the alert level (amber).",
    ariaLabel: "Spectrum chart comparing levels before and during the incident with the learned usual level and the alert level.",
    width: 960,
    height: 340,
    x: { label: "Frequency (MHz)", min: data.analysisStartHz, max: data.analysisEndHz, ticks: frequencyAxisTicks(data.analysisStartHz, data.analysisEndHz, 8) },
    y: { label: "Relative level (0–255)", min: yMin, max: yMax, ticks: numericTicks(yMin, yMax, 5, (value) => String(Math.round(value))) },
    series: [
      ...(data.usual && data.usualHigh ? [{ kind: "band" as const, name: "Usual range", color: REPORT_COLORS.usual, opacity: 0.1, upper: toPoints(data.usualHigh), lower: toPoints(data.usual) }] : []),
      ...(data.usual ? [{ kind: "line" as const, name: "Usual level", color: REPORT_COLORS.usual, width: 1.4, dash: [5, 3], points: toPoints(data.usual) }] : []),
      ...(data.alertLevel ? [{ kind: "line" as const, name: "Alert level", color: REPORT_COLORS.alertLevel, width: 1.3, dash: [6, 4], points: toPoints(data.alertLevel) }] : []),
      ...(data.framesBefore ? [{ kind: "line" as const, name: "Before", color: REPORT_COLORS.before, width: 1.3, points: toPoints(data.before) }] : []),
      ...(data.framesDuring ? [
        { kind: "line" as const, name: "During", color: REPORT_COLORS.received, width: 1.6, points: toPoints(data.during) },
        { kind: "line" as const, name: "Strongest", color: REPORT_COLORS.anomaly, width: 1.2, points: toPoints(data.strongest) },
      ] : []),
    ],
    legend: [
      { name: "Strongest during", color: REPORT_COLORS.anomaly, style: "line" },
      { name: "Typical during", color: REPORT_COLORS.received, style: "line" },
      { name: "Typical before", color: REPORT_COLORS.before, style: "line" },
      ...(data.usual ? [{ name: "Usual level", color: REPORT_COLORS.usual, style: "dash" as const }] : []),
      ...(data.alertLevel ? [{ name: `Alert level (${alertSigma ?? ""}×)`, color: REPORT_COLORS.alertLevel, style: "dash" as const }] : []),
    ],
    ...(data.framesDuring + data.framesBefore ? {} : { emptyMessage: "No frames were available to draw." }),
  };
}

function waterfallChart(data: IncidentFigureData): ChartSpec {
  return {
    id: "waterfall",
    title: "Waterfall: received energy over time",
    caption: `Each row is a time step (newest at the top); colour shows the relative level from dark blue (level ${data.waterfallLevelRange[0]}) to red (level ${data.waterfallLevelRange[1]}). Red-tinted pixels were flagged by the detector. Grey rows had no frames.`,
    ariaLabel: "Waterfall image of received energy across frequency and time, with the incident start and end marked.",
    width: 960,
    height: 380,
    x: { label: "Frequency (MHz)", min: data.analysisStartHz, max: data.analysisEndHz, ticks: frequencyAxisTicks(data.analysisStartHz, data.analysisEndHz, 8) },
    y: { label: "Time (UTC)", min: data.windowStartMs, max: data.windowEndMs, ticks: timeAxisTicks(data.windowStartMs, data.windowEndMs, 6) },
    series: [],
    image: { pngBase64: data.waterfallPngBase64, widthPx: data.widthPx, heightPx: data.rows },
    hRules: [
      ...(data.incidentStartMs >= data.windowStartMs ? [{ value: data.incidentStartMs, color: "#ffffff", dash: [6, 4], label: "Incident start" }] : []),
      ...(data.incidentEndMs <= data.windowEndMs ? [{ value: data.incidentEndMs, color: "#ffffff", dash: [6, 4], label: "End or last seen" }] : []),
    ],
    legend: [{ name: "Incident start and end", color: REPORT_COLORS.ink, style: "dash" }],
  };
}

function receiverFacts(inputs: IncidentReportInputs): ReportFact[] {
  const facts: ReportFact[] = [];
  const sdr = record(inputs.sdrconnect);
  const receivers = Array.isArray(sdr?.receivers) ? sdr!.receivers as unknown[] : [];
  const receiver = record(receivers.find((candidate) => record(candidate)?.activeWindowId === inputs.event.targetId) ?? receivers[0]);
  const fingerprint = record(record(inputs.baselineReference)?.fingerprint) ?? record(record(record(inputs.baselineReference)?.descriptor)?.fingerprint);
  const device = text(receiver?.deviceName) ?? text(fingerprint?.deviceName);
  const serial = text(receiver?.deviceSerial) ?? text(fingerprint?.deviceSerial);
  if (device) facts.push({ label: "Receiver", value: device });
  if (serial) facts.push({ label: "Serial number", value: serial });
  const antenna = text(fingerprint?.activeAntenna) ?? text(receiver?.activeAntenna);
  if (antenna) facts.push({ label: "Antenna input", value: antenna });
  const lna = text(receiver?.lnaState);
  const gain = text(fingerprint?.gainProfileId) ?? text(receiver?.gainProfileId);
  if (lna || gain) facts.push({ label: "Gain setting", value: lna !== undefined ? `LNA state ${lna}` : gain! });
  const center = number(fingerprint?.centerHz) ?? number(receiver?.confirmedCenterHz);
  if (center) facts.push({ label: "Centre frequency", value: frequencyMHz(center, 1_000) });
  const sampleRate = number(fingerprint?.sampleRateHz) ?? number(receiver?.confirmedSampleRateHz);
  if (sampleRate) facts.push({ label: "Sample rate", value: `${(sampleRate / 1e6).toFixed(1)} MS/s` });
  facts.push({ label: "Checked window", value: frequencyRange(inputs.event.affectedRangeHz, 1_000) });
  const inputBins = number(fingerprint?.inputBinCount);
  const start = number(fingerprint?.analysisStartBin);
  const end = number(fingerprint?.analysisEndBin);
  if (inputBins && start !== undefined && end !== undefined && sampleRate) {
    facts.push({ label: "Frequency resolution", value: `${bandwidthText(sampleRate / inputBins)} per bin (${end - start} bins analysed)` });
  }
  const sdrVersion = text(fingerprint?.sdrconnectVersion) ?? text(receiver?.apiVersion);
  if (sdrVersion) facts.push({ label: "SDRconnect version", value: sdrVersion });
  const catalog = text(fingerprint?.catalogVersion) ?? text(record(inputs.sessionConfig)?.catalogVersion);
  if (catalog) facts.push({ label: "Frequency catalog", value: catalog });
  const settings = record(record(inputs.sessionConfig)?.operationalSettings);
  const scan = record(settings?.scan);
  if (text(scan?.profile)) facts.push({ label: "Scan profile", value: text(scan?.profile)! });
  facts.push({ label: "Levels", value: "Relative and uncalibrated (0–255), as reported by SDRconnect" });
  const captured = text(sdr?.capturedAt);
  if (captured) facts.push({ label: "Receiver snapshot", value: `${utcDateTime(captured)} (${text(sdr?.snapshotReason) ?? "session"})`, note: "Recorded with the session; the receiver may have retuned to other windows between visits." });
  return facts;
}

function referenceFacts(inputs: IncidentReportInputs): ReportFact[] {
  const descriptor = record(record(inputs.baselineReference)?.descriptor);
  const trigger = inputs.event.trigger;
  const facts: ReportFact[] = [];
  const lifecycle = text(descriptor?.lifecycle) ?? trigger?.reference.lifecycle;
  if (lifecycle) facts.push({ label: "Reference", value: LIFECYCLE_LABEL[lifecycle] ?? lifecycle });
  const generation = descriptor?.generation ?? trigger?.reference.generationId;
  if (generation !== undefined) facts.push({ label: "Generation", value: String(generation) });
  const first = text(descriptor?.firstObservationAt);
  const last = text(descriptor?.lastObservationAt);
  if (first) facts.push({ label: "Learned from", value: `${utcDateTime(first)}${last ? ` to ${utcDateTime(last)}` : ""}` });
  const protectedAt = text(descriptor?.protectedAt);
  if (protectedAt) facts.push({ label: "Approved", value: `${utcDateTime(protectedAt)}${text(descriptor?.protectedBy) ? ` by ${text(descriptor?.protectedBy)}` : ""}` });
  const observations = number(descriptor?.totalValidObservations);
  const coverage = number(descriptor?.coverageRatio);
  if (observations !== undefined) facts.push({ label: "Valid checks learned", value: `${observations.toLocaleString("en-GB")}${coverage !== undefined ? ` (${percent(coverage)} of planned visits)` : ""}` });
  const hours = number(descriptor?.representativeUtcHours);
  if (hours !== undefined) facts.push({ label: "Representative hours", value: String(hours) });
  if (!facts.length) facts.push({ label: "Reference", value: "Not included with this record" });
  return facts;
}

export function buildIncidentReportModel(inputs: IncidentReportInputs): IncidentReportModel {
  const { event } = inputs;
  const timeZone = inputs.displayTimeZone || "UTC";
  const trigger = event.trigger;
  const resolutionHz = trigger?.binWidthHz ?? 10_000;
  const verdict = rfVerdictFor(event);
  const detail = event.detailKind ?? trigger?.detailKind ?? legacyDetailKind(event.kind);
  const affected = event.affectedLabel ?? inputs.serviceLabel ?? event.bandLabel;
  const evidenceStrength = event.evidenceStrength === "Medium" ? "Medium" : "Low";
  const endedAt = event.clearedAt ?? event.endedAt;
  const status = statusLabel(event);
  const runtime = record(inputs.runtimeIdentity) ?? record(record(inputs.sessionConfig)?.runtimeIdentity);
  const release = record(runtime?.release);
  const configuration = record(runtime?.configuration);

  const disturbed = disturbedText(event, resolutionHz);
  const duration = durationText(event.startedAt, endedAt ?? event.lastSeenAt);
  const paragraph = [
    `${verdict} on ${affected}.`,
    `Raised RF energy was observed ${event.disturbedRangesHz?.length || trigger?.disturbedRangesHz.length ? `at ${disturbed.split(" (")[0]}` : `in the checked window (${frequencyRange(event.affectedRangeHz, 1_000)})`} from ${utcDateTime(event.startedAt)}${endedAt ? ` until ${utcDateTime(endedAt)}` : ` and was last seen at ${utcDateTime(event.lastSeenAt)}`} (${duration}).`,
    `The status is ${status.toLowerCase()} and the evidence strength is ${evidenceStrength}: ${evidenceStrength === "Medium" ? "the comparison was made against an approved baseline for this exact receiver setup" : "the comparison was made against a local reference that is not yet approved"}.`,
    "These are relative, uncalibrated receiver measurements. They can show interference, not who caused it or why.",
  ].join(" ");

  const charts: ChartSpec[] = [];
  if (inputs.triggerSnapshot) charts.push(triggerSnapshotChart(inputs.triggerSnapshot, event));
  if (inputs.figure) {
    charts.push(spectrumChart(inputs.figure.data, trigger?.policy.values.segmentSigma));
    charts.push(waterfallChart(inputs.figure.data));
    charts.push(...inputs.figure.analysis.specs);
  }

  const stats = inputs.figure?.analysis.stats;
  const keyNumbers: ReportFact[] = [];
  if (stats) {
    keyNumbers.push({ label: "Frames recorded (before / during / after)", value: `${stats.framesBefore} / ${stats.framesDuring} / ${stats.framesAfter}` });
    if (stats.strongestLevel !== undefined) keyNumbers.push({ label: "Strongest level", value: `${stats.strongestLevel} at ${stats.strongestMHz !== undefined ? frequencyMHz(stats.strongestMHz * 1e6, resolutionHz) : "–"}` });
    if (stats.typicalDuring !== undefined) keyNumbers.push({ label: "Typical level during", value: String(stats.typicalDuring) });
    if (stats.typicalBefore !== undefined) keyNumbers.push({ label: "Typical level before", value: `${stats.typicalBefore}${stats.fewFramesBefore ? " (few frames)" : ""}` });
    if (stats.learnedTypical !== undefined) keyNumbers.push({ label: "Learned usual level", value: String(stats.learnedTypical) });
    if (stats.maxExcessSpreads !== undefined) keyNumbers.push({ label: "Largest excess", value: `${multiple(stats.maxExcessSpreads)} normal variation` });
    if (stats.duringFramesAboveAlertPct !== undefined) keyNumbers.push({ label: "Frames with energy above the alert level", value: `${stats.duringFramesAboveAlertPct}%` });
    if (stats.mostFrequentPeakMHz !== undefined) keyNumbers.push({ label: "Most frequent peak", value: frequencyMHz(stats.mostFrequentPeakMHz * 1e6, resolutionHz) });
  }
  if (event.peak) keyNumbers.push({ label: "Strongest check (detector)", value: `${multiple(event.peak.maxPeakZ)} normal variation at ${utcDateTime(event.peak.maxPeakZAt)}` });

  const timeline: ReportTimelineRow[] = (event.timeline?.length ? event.timeline : [
    { at: event.startedAt, code: "alert" as const },
    ...(event.acknowledgedAt ? [{ at: event.acknowledgedAt, code: "acknowledged" as const }] : []),
    ...event.notes.map((note) => ({ at: note.timestamp, code: "note" as const, detail: note.text.slice(0, 160) })),
    ...(event.clearedAt ? [{ at: event.clearedAt, code: "cleared" as const }] : []),
    ...(event.endedAt ? [{ at: event.endedAt, code: "ended" as const, detail: event.endReason }] : []),
  ])
    .slice()
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
    .map((entry) => ({ at: entry.at, atText: timeWithLocal(entry.at, timeZone), label: TIMELINE_LABEL[entry.code] ?? entry.code, ...(entry.detail ? { detail: entry.detail } : {}) }));

  const completenessStatements: string[] = [];
  const complete = inputs.completeness?.complete ?? true;
  if (complete) completenessStatements.push("Every requested recording session for this incident was available and complete.");
  else completenessStatements.push(`Some parts were missing when this record was made: ${inputs.completeness!.missingParts.join(", ") || "see completeness.json"}.`);
  if (stats && stats.framesBefore < 10) completenessStatements.push(`Only ${stats.framesBefore} frame${stats.framesBefore === 1 ? " was" : "s were"} recorded before the incident in this window. A single receiver visits several windows in turn and records quiet periods at a reduced rate.`);
  if (stats && !stats.framesAfter && !event.clearedAt) completenessStatements.push(event.endedAt ? `No frames after the incident are included: monitoring changed at ${utcDateTime(event.endedAt)} (${event.endReason ?? "settings change"}).` : "The incident had not cleared when this record was made, so there are no after-incident frames.");
  completenessStatements.push(...(inputs.windowStatements ?? []));

  const why = trigger ? {
    sentence: whySentence(event, resolutionHz),
    rules: trigger.rules.map((rule) => ({
      label: rule.label,
      measured: ruleMeasured(rule.unit, rule.measured),
      threshold: rule.unit === "checks" ? `${rule.threshold} of ${trigger.persistence.window}` : ruleMeasured(rule.unit, rule.threshold),
      met: rule.met,
    })),
    persistence: `${trigger.persistence.votes} raised checks out of the last ${trigger.persistence.window}, ${(trigger.persistence.exposureMs / 1000).toFixed(1)} s observed (needed ${trigger.persistence.required} and ${(trigger.persistence.requiredExposureMs / 1000).toFixed(1)} s).`,
    sensitivity: {
      label: alertPresetLabel(trigger.policy.choice),
      source: trigger.policy.source === "window" ? "Set for this frequency window" : "Site default",
      rules: describeAlertPolicy(trigger.policy.values, trigger.analyzedRangeHz[1] - trigger.analyzedRangeHz[0]).map((fact) => ({ label: fact.label, value: fact.text })),
    },
    reference: referenceFacts(inputs),
  } : undefined;

  const software: ReportFact[] = [
    ...(release ? [{ label: "RF Monitor release", value: `${text(release.releaseVersion) ?? "1.0"} (build ${text(release.buildId) ?? "unknown"})` }] : []),
    ...(configuration ? [{ label: "Configuration", value: `revision ${String(configuration.configurationRevision ?? "–")}, hash ${String(configuration.configurationHash ?? "").slice(0, 16)}` }] : []),
    { label: "Detector", value: `${event.ruleSetId}${trigger ? ` · alert rules ${trigger.classifierVersion}` : ""}` },
  ];

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: "rf-incident-report",
    generatedAt: new Date(inputs.generatedAtMs).toISOString(),
    generatedAtText: timeWithLocal(new Date(inputs.generatedAtMs).toISOString(), timeZone),
    scope: inputs.scope,
    reference: incidentReference(event),
    dataDomain: inputs.dataDomain,
    title: "RF Incident Report",
    identity: {
      ...(inputs.reportIdentity?.companyName ? { companyName: inputs.reportIdentity.companyName } : {}),
      ...(inputs.reportIdentity?.clientName ? { clientName: inputs.reportIdentity.clientName } : {}),
      ...(inputs.reportIdentity?.vesselName ? { vesselName: inputs.reportIdentity.vesselName } : {}),
      ...(inputs.reportIdentity?.projectReference ? { projectReference: inputs.reportIdentity.projectReference } : {}),
      siteName: inputs.siteName,
      ...(inputs.deploymentId ? { deploymentId: inputs.deploymentId } : {}),
      ...(inputs.reportIdentity?.logo ? { logo: { sha256: inputs.reportIdentity.logo.sha256, mediaType: inputs.reportIdentity.logo.mediaType, ...(inputs.logoDataUri ? { dataUri: inputs.logoDataUri } : {}) } } : {}),
    },
    software,
    incident: {
      id: event.id,
      verdict,
      status,
      ...(detail ? { ruleLabel: detailKindLabel(detail) } : {}),
      affected,
      evidenceStrength,
      evidenceMeaning: evidenceStrength === "Medium"
        ? "Medium: compared with an approved baseline for this exact receiver setup."
        : "Low: compared with a local reference that is not yet approved, or the comparison was limited.",
      startedAt: timeWithLocal(event.startedAt, timeZone),
      ...(endedAt ? { endedAt: timeWithLocal(endedAt, timeZone) } : {}),
      disturbed,
      checkedWindow: frequencyRange(event.affectedRangeHz, 1_000),
      observed: event.observed,
      recommendedAction: event.recommendedAction,
      ...(event.endReason ? { endReason: event.endReason } : {}),
    },
    summary: {
      paragraph,
      facts: [
        { label: "Affected signal", value: affected },
        { label: "Disturbed frequencies", value: disturbed },
        { label: "Started", value: timeWithLocal(event.startedAt, timeZone) },
        { label: endedAt ? "Ended" : "Last seen", value: timeWithLocal(endedAt ?? event.lastSeenAt, timeZone) },
        { label: "Duration", value: duration },
        { label: "Status", value: status },
        ...(detail ? [{ label: "Rule that raised the alert", value: detailKindLabel(detail) }] : []),
        { label: "Evidence strength", value: evidenceStrength },
        { label: "Recommended action", value: event.recommendedAction },
      ],
    },
    ...(why ? { why } : {}),
    timeline,
    findings: inputs.figure?.analysis.findings ?? ["No recorded frames were available to analyse for this record."],
    keyNumbers,
    receiver: receiverFacts(inputs),
    notes: event.notes.map((note) => ({ atText: timeWithLocal(note.timestamp, timeZone), text: note.text })),
    charts,
    completeness: { complete, statements: completenessStatements },
    integrity: {
      files: inputs.evidenceFiles ?? [],
      statements: inputs.scope === "evidence-package"
        ? [
          "Every file in this evidence package, including this report, is listed with its SHA-256 hash in SHA256SUMS.txt and manifest.json.",
          "Recomputing those hashes and comparing them shows whether any file changed after export. The hashes make changes detectable; they are not a digital signature or a certified legal chain of custody.",
          "The recorded spectrum frames (spectrum/frames.jsonl and spectrum/raw) are the evidence. Charts and this report are derived from them.",
        ]
        : [
          "This is a live report generated from the recorded evidence on the RF Monitor host.",
          "Download the evidence package for the recorded frames and SHA-256 hashes of every file.",
        ],
      verify: [
        { platform: "Linux", command: "sha256sum -c SHA256SUMS.txt" },
        { platform: "macOS", command: "shasum -a 256 -c SHA256SUMS.txt" },
        { platform: "Windows PowerShell", command: "Get-FileHash -Algorithm SHA256 <file>  (compare with SHA256SUMS.txt)" },
        { platform: "RF Monitor host", command: "sudo rf-monitor verify-evidence <extracted folder>" },
      ],
    },
    limitations: [
      "RF data can show interference, not intent. This report does not identify a transmitter, its location or its purpose.",
      "Levels are relative values from an uncalibrated receiver display, not calibrated power. Compare only within this record.",
      "Navigation impact (position, timing) is not measured here. Check an independent navigation receiver before drawing conclusions about it.",
      "One receiver visits several frequency windows in turn; gaps between visits are not observed.",
    ],
    glossary: [
      { label: "Normal variation", value: "How much a frequency's level usually moves around its learned level (a robust spread measure). \"6×\" means six times that usual movement." },
      { label: "Usual level", value: "The learned typical level for each frequency at this site, with this receiver setup." },
      { label: "Alert level", value: "The usual level plus the configured number of normal variations. Energy above it is shown in red." },
      { label: "Check", value: "One short look at a frequency window (a few frames). Alerts need raised energy in several checks." },
      { label: "Evidence strength", value: "Low or Medium. Medium needs an approved baseline. RF-only evidence never reaches High." },
      { label: "Approved baseline", value: "A learned usual level that an authorised person reviewed and protected for alerts." },
      { label: "SHA-256", value: "A fingerprint of a file's exact bytes. Any change to the file changes it." },
    ],
  };
}
