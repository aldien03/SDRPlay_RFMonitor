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
    if (rule) bars.push({ id: "strength", label: "Strength above usual", measured: `${multiple(rule.measured)} normal variation`, limit: `alert at ${multiple(rule.threshold)}`, fill: rule.measured / rule.threshold, met: rule.met });
    bars.push({ id: "width", label: "Width", measured: bandwidthLabel(trigger.measured.widestSegmentRatio * span || trigger.binWidthHz), limit: `narrow up to ${bandwidthLabel(values.narrowbandMaxWidthRatio * span)}`, fill: 1, met: true });
  } else if (kind === "partial-band") {
    const rule = comparison(trigger, "partial-band");
    if (rule) bars.push({ id: "strength", label: "Strength above usual", measured: `${multiple(rule.measured)} normal variation`, limit: `alert at ${multiple(rule.threshold)}`, fill: rule.measured / rule.threshold, met: rule.met });
    bars.push({ id: "width", label: "Width", measured: bandwidthLabel(trigger.measured.widestSegmentRatio * span), limit: `wider than ${bandwidthLabel(values.narrowbandMaxWidthRatio * span)}`, fill: trigger.measured.widestSegmentRatio / Math.max(1e-6, values.narrowbandMaxWidthRatio), met: true });
  } else if (kind === "wideband") {
    const rule = comparison(trigger, "wideband");
    if (rule) bars.push({ id: "share", label: "Share of window raised", measured: ratioPercent(rule.measured), limit: `alert at ${ratioPercent(rule.threshold)}`, fill: rule.measured / rule.threshold, met: rule.met });
    bars.push({ id: "strength", label: "Raised level", measured: `${multiple(trigger.measured.peakZ)} normal variation at peak`, limit: `counted from ${multiple(values.segmentSigma)}`, fill: trigger.measured.peakZ / values.segmentSigma, met: true });
  } else if (kind === "noise-floor") {
    const rule = comparison(trigger, "noise-floor");
    if (rule) bars.push({ id: "floor", label: "Whole-window rise", measured: `${multiple(rule.measured)} normal variation`, limit: `alert at ${multiple(rule.threshold)}`, fill: rule.measured / rule.threshold, met: rule.met });
  } else if (kind === "burst") {
    const rule = comparison(trigger, "burst");
    if (rule) bars.push({ id: "burst", label: "Short-burst strength", measured: `${multiple(rule.measured)} normal variation`, limit: `alert at ${multiple(rule.threshold)}`, fill: rule.measured / rule.threshold, met: rule.met });
  }
  if (kind === "noise-floor") {
    bars.push({ id: "repeat", label: "Lasted", measured: `${Math.round(values.noiseFloorExposureMs / 1_000)} s observed`, limit: `needs ${Math.round(values.noiseFloorExposureMs / 1_000)} s`, fill: 1, met: true });
  } else if (kind !== "overload") {
    bars.push({
      id: "repeat",
      label: "Repeated",
      measured: `${trigger.persistence.votes} of last ${trigger.persistence.window} checks`,
      limit: `needs ${trigger.persistence.required}`,
      fill: trigger.persistence.votes / Math.max(1, trigger.persistence.required),
      met: trigger.persistence.votes >= trigger.persistence.required,
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
