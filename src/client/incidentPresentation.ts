/**
 * Plain-language presentation of one incident: what was disturbed, why the
 * alert was raised, and how it unfolded. Pure functions so the copy is tested.
 */
import { detailKindLabel, legacyDetailKind } from "../shared/alertPolicy";
import type { AlertDetailKind, AlertRuleComparison, AlertTrigger, DetectionEvent, IncidentTimelineEntry } from "../shared/types";

export type IncidentStatusLabel = "Alert" | "Recovering" | "Cleared" | "Ended";

export function incidentStatusLabel(event: Pick<DetectionEvent, "lifecycle" | "clearedAt" | "endedAt">): IncidentStatusLabel {
  if (event.lifecycle === "recovering") return "Recovering";
  if (event.lifecycle === "cleared" || (event.clearedAt && event.lifecycle !== "active")) return "Cleared";
  if (event.lifecycle === "ended-unknown" || event.endedAt) return "Ended";
  return "Alert";
}

export const EVIDENCE_MEANING: Record<"Low" | "Medium", string> = {
  Low: "Compared with a local reference that is not yet approved.",
  Medium: "Compared with an approved baseline for this exact receiver setup.",
};

function mhz(hz: number, decimals = 3): string {
  return (hz / 1e6).toFixed(decimals);
}

/** Same style as Settings: MHz with one decimal from 0.1 MHz, otherwise kHz. */
export function bandwidthLabel(hz: number): string {
  if (hz >= 100_000) return `${(hz / 1e6).toFixed(1)} MHz`;
  return `${Math.max(1, Math.round(hz / 1e3))} kHz`;
}

function decimalsForResolution(binWidthHz?: number): number {
  if (!binWidthHz || !Number.isFinite(binWidthHz)) return 3;
  return binWidthHz >= 100_000 ? 1 : binWidthHz >= 10_000 ? 2 : 3;
}

/** Where the disturbance was, never the whole checked window when the detector knows better. */
export function disturbedSummary(event: Pick<DetectionEvent, "disturbedRangesHz" | "affectedRangeHz" | "trigger">): string {
  const ranges = event.disturbedRangesHz?.length ? event.disturbedRangesHz : event.trigger?.disturbedRangesHz;
  const decimals = decimalsForResolution(event.trigger?.binWidthHz);
  if (!ranges?.length) return `Within ${mhz(event.affectedRangeHz[0], decimals)}–${mhz(event.affectedRangeHz[1], decimals)} MHz`;
  const width = ranges.reduce((total, [start, end]) => total + (end - start), 0);
  const first = ranges[0];
  if (ranges.length === 1) return `${mhz(first[0], decimals)}–${mhz(first[1], decimals)} MHz (${bandwidthLabel(width)} wide)`;
  return `${ranges.length} parts, ${mhz(first[0], decimals)}–${mhz(ranges.at(-1)![1], decimals)} MHz (${bandwidthLabel(width)} in total)`;
}

export function incidentDetailKind(event: Pick<DetectionEvent, "detailKind" | "kind" | "trigger">): AlertDetailKind | undefined {
  return event.detailKind ?? event.trigger?.detailKind ?? legacyDetailKind(event.kind);
}

function multiple(value: number): string {
  if (!Number.isFinite(value)) return "–";
  return `${value >= 10 ? Math.round(value) : Number(value.toFixed(1))}×`;
}

function ratioPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export interface TriggerBar {
  id: string;
  label: string;
  measured: string;
  limit: string;
  /** measured / threshold, for the bar fill (1 = exactly at the alert level). */
  fill: number;
  met: boolean;
  /** "rule": a comparison that raised the alert (red when met). "context": shape of the signal, drawn neutral. */
  emphasis: "rule" | "context";
}

/** Bar geometry: the alert-level marker moves left as the measurement goes further past it. */
export function triggerBarScale(fill: number): { width: number; marker: number } {
  const value = Number.isFinite(fill) ? Math.max(0, fill) : 0;
  const scale = Math.min(4, Math.max(1.5, value * 1.25));
  return { width: Math.max(3, Math.min(100, (value / scale) * 100)), marker: 100 / scale };
}

function comparison(trigger: AlertTrigger, rule: AlertRuleComparison["rule"]): AlertRuleComparison | undefined {
  return trigger.rules.find((candidate) => candidate.rule === rule);
}

/**
 * The comparisons that explain this alert, in operator terms: how strong the
 * raised energy was against its usual variation, how wide it was, and how often
 * it repeated, each against the alert level that was in force.
 */
export function triggerBars(trigger: AlertTrigger): TriggerBar[] {
  const bars: TriggerBar[] = [];
  const values = trigger.policy.values;
  const span = trigger.analyzedRangeHz[1] - trigger.analyzedRangeHz[0];
  const kind = trigger.detailKind;
  if (kind === "narrowband") {
    const rule = comparison(trigger, "narrowband");
    if (rule) bars.push({ id: "strength", label: "Strength above usual", measured: `${multiple(rule.measured)} normal variation`, limit: `alert at ${multiple(rule.threshold)}`, fill: rule.measured / rule.threshold, met: rule.met, emphasis: "rule" });
    const widthHz = trigger.measured.widestSegmentRatio * span || trigger.binWidthHz;
    const maxWidthHz = values.narrowbandMaxWidthRatio * span;
    bars.push({ id: "width", label: "Width", measured: bandwidthLabel(widthHz), limit: `narrow up to ${bandwidthLabel(maxWidthHz)}`, fill: maxWidthHz > 0 ? widthHz / maxWidthHz : 0, met: widthHz <= maxWidthHz, emphasis: "context" });
  } else if (kind === "partial-band") {
    const rule = comparison(trigger, "partial-band");
    if (rule) bars.push({ id: "strength", label: "Strength above usual", measured: `${multiple(rule.measured)} normal variation`, limit: `alert at ${multiple(rule.threshold)}`, fill: rule.measured / rule.threshold, met: rule.met, emphasis: "rule" });
    bars.push({ id: "width", label: "Width", measured: bandwidthLabel(trigger.measured.widestSegmentRatio * span), limit: `wider than ${bandwidthLabel(values.narrowbandMaxWidthRatio * span)}`, fill: trigger.measured.widestSegmentRatio / Math.max(1e-6, values.narrowbandMaxWidthRatio), met: true, emphasis: "context" });
  } else if (kind === "wideband") {
    const rule = comparison(trigger, "wideband");
    if (rule) bars.push({ id: "share", label: "Share of window raised", measured: ratioPercent(rule.measured), limit: `alert at ${ratioPercent(rule.threshold)}`, fill: rule.measured / rule.threshold, met: rule.met, emphasis: "rule" });
    bars.push({ id: "strength", label: "Raised level", measured: `${multiple(trigger.measured.peakZ)} normal variation at peak`, limit: `counted from ${multiple(values.segmentSigma)}`, fill: trigger.measured.peakZ / values.segmentSigma, met: true, emphasis: "context" });
  } else if (kind === "noise-floor") {
    const rule = comparison(trigger, "noise-floor");
    if (rule) bars.push({ id: "floor", label: "Whole-window rise", measured: `${multiple(rule.measured)} normal variation`, limit: `alert at ${multiple(rule.threshold)}`, fill: rule.measured / rule.threshold, met: rule.met, emphasis: "rule" });
  } else if (kind === "burst") {
    const rule = comparison(trigger, "burst");
    if (rule) bars.push({ id: "burst", label: "Short-burst strength", measured: `${multiple(rule.measured)} normal variation`, limit: `alert at ${multiple(rule.threshold)}`, fill: rule.measured / rule.threshold, met: rule.met, emphasis: "rule" });
  }
  if (kind === "noise-floor") {
    const observedMs = Math.max(trigger.persistence.exposureMs ?? 0, values.noiseFloorExposureMs);
    bars.push({ id: "repeat", label: "Lasted", measured: `${Math.round(observedMs / 1_000)} s observed`, limit: `needs ${Math.round(values.noiseFloorExposureMs / 1_000)} s`, fill: values.noiseFloorExposureMs > 0 ? observedMs / values.noiseFloorExposureMs : 1, met: true, emphasis: "rule" });
  } else if (kind !== "overload") {
    bars.push({
      id: "repeat",
      label: "Repeated",
      measured: `${trigger.persistence.votes} of last ${trigger.persistence.window} checks`,
      limit: `needs ${trigger.persistence.required}`,
      fill: trigger.persistence.votes / Math.max(1, trigger.persistence.required),
      met: trigger.persistence.votes >= trigger.persistence.required,
      emphasis: "rule",
    });
  }
  return bars;
}

/** One plain sentence: why the alert was raised. */
export function whyAlertSentence(event: Pick<DetectionEvent, "trigger" | "kind" | "detailKind" | "disturbedRangesHz" | "affectedRangeHz">): string {
  const trigger = event.trigger;
  const kind = incidentDetailKind(event);
  if (kind === "overload") return "The receiver reported overload, so its readings cannot be trusted.";
  if (!trigger) return "Repeated RF energy above its usual level. This older record has no stored trigger details.";
  const reference = trigger.reference.kind === "approved" ? "the approved baseline" : "the local reference";
  const where = disturbedSummary(event);
  switch (kind) {
    case "wideband":
      return `Raised energy covered ${ratioPercent(trigger.measured.occupancyRatio)} of the window compared with ${reference}, repeated in ${trigger.persistence.votes} of ${trigger.persistence.window} checks.`;
    case "partial-band":
      return `A ${bandwidthLabel(trigger.measured.widestSegmentRatio * (trigger.analyzedRangeHz[1] - trigger.analyzedRangeHz[0]))} wide signal at ${where.split(" (")[0]} stayed above the alert level, repeated in ${trigger.persistence.votes} of ${trigger.persistence.window} checks.`;
    case "narrowband":
      return `A narrow signal at ${where.split(" (")[0]} reached ${multiple(trigger.measured.peakZ)} its normal variation, repeated in ${trigger.persistence.votes} of ${trigger.persistence.window} checks.`;
    case "noise-floor":
      return `The whole window sat ${multiple(trigger.measured.medianZ)} its normal variation above ${reference} for ${Math.round(trigger.policy.values.noiseFloorExposureMs / 1_000)} s of observation.`;
    case "burst":
      return `Short bursts over ${where.split(" (")[0]} appeared in single frames, repeated in ${trigger.persistence.votes} of ${trigger.persistence.window} checks.`;
    default:
      return "Repeated RF energy above its usual level.";
  }
}

export function ruleLabel(event: Pick<DetectionEvent, "trigger" | "kind" | "detailKind">): string | undefined {
  const kind = incidentDetailKind(event);
  return kind ? detailKindLabel(kind) : undefined;
}

const TIMELINE_LABELS: Record<IncidentTimelineEntry["code"], string> = {
  "first-seen": "First raised check",
  alert: "Alert raised",
  "kind-escalated": "Signal changed",
  recovering: "Clean checks started",
  returned: "Raised energy returned",
  cleared: "Alert cleared",
  ended: "Monitoring changed",
  acknowledged: "Acknowledged",
  note: "Note added",
  "sensitivity-changed": "Sensitivity changed",
};

export function timelineLabel(code: IncidentTimelineEntry["code"]): string {
  return TIMELINE_LABELS[code] ?? code;
}

/** Timeline for display: stored entries, else a minimal one from the record's timestamps. */
export function incidentTimeline(event: DetectionEvent): IncidentTimelineEntry[] {
  if (event.timeline?.length) return [...event.timeline].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
  const entries: IncidentTimelineEntry[] = [{ at: event.startedAt, code: "alert" }];
  if (event.acknowledgedAt) entries.push({ at: event.acknowledgedAt, code: "acknowledged" });
  for (const note of event.notes) entries.push({ at: note.timestamp, code: "note", detail: note.text.slice(0, 120) });
  if (event.clearedAt) entries.push({ at: event.clearedAt, code: "cleared" });
  if (event.endedAt) entries.push({ at: event.endedAt, code: "ended", detail: event.endReason });
  return entries.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

/**
 * Newest incidents for the Incidents drawer when nothing is active. This
 * run's live records win over stored copies of the same incident.
 */
export function recentIncidents(live: readonly DetectionEvent[], stored: readonly DetectionEvent[], limit = 6): DetectionEvent[] {
  const byId = new Map<string, DetectionEvent>();
  for (const event of stored) if (!byId.has(event.id)) byId.set(event.id, event);
  for (const event of live) byId.set(event.id, event);
  return [...byId.values()]
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
    .slice(0, limit);
}

/** When an incident stopped, or `now` while it is still open in this run. */
export function incidentEndAt(event: Pick<DetectionEvent, "lifecycle" | "clearedAt" | "endedAt" | "lastSeenAt">, live: boolean, now = new Date().toISOString()): string {
  if (event.clearedAt) return event.clearedAt;
  if (event.endedAt) return event.endedAt;
  return live && (event.lifecycle === "active" || event.lifecycle === "recovering") ? now : event.lastSeenAt;
}

/** One duration format for the drawer and the list: "Under 1 s", "42 s", "4 min 10 s", "2 h 05 min", "3 d 4 h". */
export function shortDuration(fromIso: string, toIso: string): string {
  const seconds = Math.floor((Date.parse(toIso) - Date.parse(fromIso)) / 1_000);
  if (!Number.isFinite(seconds)) return "–";
  if (seconds < 1) return "Under 1 s";
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min${seconds % 60 ? ` ${seconds % 60} s` : ""}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
  return `${Math.floor(hours / 24)} d ${hours % 24} h`;
}

function zonedParts(date: Date, timeZone: string): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-GB", {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone, timeZoneName: "short",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/**
 * Control-room clock: "07:37:02 UTC", with the day when it is not today
 * ("09 Nov 07:37:02 UTC") and the year when it is not this year.
 */
export function incidentClock(iso: string, timeZone = "UTC", now: Date = new Date()): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "–";
  let parts: Record<string, string>;
  let today: Record<string, string>;
  try {
    parts = zonedParts(date, timeZone);
    today = zonedParts(now, timeZone);
  } catch {
    parts = zonedParts(date, "UTC");
    today = zonedParts(now, "UTC");
  }
  const zone = parts.timeZoneName === "GMT" && timeZone === "UTC" ? "UTC" : parts.timeZoneName;
  const clock = `${parts.hour}:${parts.minute}:${parts.second} ${zone}`;
  if (parts.year === today.year && parts.month === today.month && parts.day === today.day) return clock;
  return `${parts.day} ${parts.month}${parts.year === today.year ? "" : ` ${parts.year}`} ${clock}`;
}

/** The whole window that was checked, in the same style as the disturbed range. */
export function checkedSpanLabel(event: Pick<DetectionEvent, "affectedRangeHz" | "trigger">): string {
  const decimals = decimalsForResolution(event.trigger?.binWidthHz);
  return `${mhz(event.affectedRangeHz[0], decimals)}–${mhz(event.affectedRangeHz[1], decimals)} MHz`;
}

const END_REASONS: Record<string, string> = {
  "service-restart": "RF Monitor restarted before it cleared",
  "Record not closed; end time is the last observation": "RF Monitor restarted before it cleared; end is the last observation",
};

/** Why an incident ended without clearing, in operator words (older records stored a code). */
export function endReasonLabel(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  return END_REASONS[reason] ?? reason;
}

export interface IncidentActionCopy {
  text: string;
  tone: "alert" | "review" | "clear";
  /** The action given while the alert was active, kept for reference once it has ended. */
  during?: string;
}

/** What the operator should do now: the live action while open, a review step once it has ended. */
export function incidentActionCopy(input: {
  live: boolean;
  status: IncidentStatusLabel;
  synthetic: boolean;
  acknowledgedAt?: string;
  recommendedAction: string;
  timeZone?: string;
  now?: Date;
}): IncidentActionCopy {
  if (input.synthetic) return { text: input.live ? input.recommendedAction : "Test record. No action needed.", tone: input.live ? "alert" : "clear" };
  if (input.live) return { text: input.recommendedAction, tone: "alert" };
  const during = input.recommendedAction && input.recommendedAction !== "None" ? input.recommendedAction : undefined;
  if (input.acknowledgedAt) return { text: `Reviewed ${incidentClock(input.acknowledgedAt, input.timeZone, input.now)}. No action needed.`, tone: "clear", during };
  return { text: `${input.status === "Cleared" ? "Alert cleared" : "Alert ended"}. Add what you checked, then mark it reviewed.`, tone: "review", during };
}

/** Status for a list row: a stored copy that still says open has ended. */
export function recentIncidentStatus(event: DetectionEvent, live: boolean): IncidentStatusLabel {
  const open = (event.lifecycle === "active" || event.lifecycle === "recovering") && !event.clearedAt && !event.endedAt;
  return !live && open ? "Ended" : incidentStatusLabel(event);
}

/** Field incidents not yet marked reviewed. Test records never need review. */
export function needsReview(event: Pick<DetectionEvent, "acknowledgedAt" | "syntheticExercise">): boolean {
  return !event.acknowledgedAt && !event.syntheticExercise;
}
