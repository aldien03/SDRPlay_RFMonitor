import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { alertPresetValues } from "../src/shared/alertPolicy";
import { incidentPackageBaseName, incidentReference } from "../src/shared/incidentNaming";
import type { AlertTrigger, DetectionEvent } from "../src/shared/types";
import { buildIncidentReportModel } from "../src/server/report/reportModel";
import { renderIncidentReportHtml } from "../src/server/report/reportHtml";
import { renderIncidentReportPdf } from "../src/server/report/reportPdf";
import { pdfSafe, frequencyRange } from "../src/server/report/format";
import { chartToSvg } from "../src/server/report/svgChart";
import { disturbedSummary, incidentStatusLabel, incidentTimeline, triggerBars, whyAlertSentence } from "../src/client/incidentPresentation";
import { appliedToastCopy, applyImpactCopy } from "../src/client/SettingsPage";
import { IncidentPanel } from "../src/client/MonitorPanels";
import { resolveOperatorSummary } from "../src/shared/operatorSummary";

const trigger: AlertTrigger = {
  schemaVersion: 1,
  classifierVersion: "rf-alert-segments-1",
  detailKind: "partial-band",
  firedAt: "2026-11-09T10:05:06.000Z",
  observationId: "o",
  policy: { choice: "standard", source: "default", values: alertPresetValues("standard"), hash: "a".repeat(64) },
  reference: { lifecycle: "protected", kind: "approved", fingerprintId: "f".repeat(64), generationId: "5" },
  measured: { peakZ: 18.4, medianZ: 0.4, occupancyRatio: 0.147, widestSegmentRatio: 0.147, widestSegmentMedianZ: 17.9, peakFrequencyHz: 1_575_520_000, peakLevel: 85, usualLevelAtPeak: 25, levelAboveUsual: 60 },
  rules: [
    { rule: "wideband", label: "Raised share of window", measured: 0.147, threshold: 0.35, unit: "ratio", met: false },
    { rule: "partial-band", label: "Wider-signal strength", measured: 17.9, threshold: 6, unit: "x", met: true },
    { rule: "persistence", label: "Raised checks", measured: 3, threshold: 3, unit: "checks", met: true },
  ],
  persistence: { votes: 3, window: 5, required: 3, exposureMs: 1_500, requiredExposureMs: 1_000 },
  disturbedRangesHz: [[1_574_940_000, 1_576_110_000]],
  analyzedRangeHz: [1_571_420_000, 1_579_420_000],
  binWidthHz: 19_560,
};

function incident(overrides: Partial<DetectionEvent> = {}): DetectionEvent {
  return {
    id: "c0eded38-7ce0-472c-8763-e8fe4a4cc5ac",
    dataDomain: "field",
    sessionId: "s",
    kind: "gnss-energy-anomaly",
    detailKind: "partial-band",
    status: "interference-likely",
    severity: "medium",
    evidenceStrength: "Medium",
    evidenceBasis: "Repeated relative RF anomaly against an approved exact-configuration baseline.",
    baselineFingerprintId: "f".repeat(64),
    ruleSetId: "rf-relative-mad-v1",
    observationId: "o",
    service: "gnss",
    bandId: "gps-l1",
    targetId: "gnss-l1-e1-b1c-sbas",
    bandLabel: "GPS L1",
    affectedLabel: "GPS L1 / Galileo E1",
    affectedRangeHz: [1_571_420_000, 1_579_420_000],
    disturbedRangesHz: [[1_574_940_000, 1_576_110_000]],
    trigger,
    observed: "Raised RF energy over 1.2 MHz. RF data can show interference, not intent.",
    recommendedAction: "Check position and time on an independent receiver. Keep recording.",
    startedAt: "2026-11-09T10:05:00.000Z",
    lastSeenAt: "2026-11-09T10:09:00.000Z",
    clearedAt: "2026-11-09T10:09:00.000Z",
    lifecycle: "cleared",
    notes: [{ id: "n", timestamp: "2026-11-09T10:06:30.000Z", text: "Bridge saw a position jump." }],
    timeline: [{ at: "2026-11-09T10:05:06.000Z", code: "alert", detail: "Wider signal · Standard sensitivity" }],
    metrics: { timestamp: "2026-11-09T10:09:00.000Z", bandId: "gps-l1", meanLevel: 30, peakLevel: 85, baselineLevel: 25, baselineDelta: 5, occupiedRatio: 0.15, overload: false },
    ...overrides,
  };
}

describe("incident presentation (operator copy)", () => {
  it("names where the disturbance was and why the alert fired, in plain words", () => {
    const event = incident();
    expect(disturbedSummary(event)).toBe("1574.94–1576.11 MHz (1.2 MHz wide)");
    expect(whyAlertSentence(event)).toMatch(/^A 1\.2 MHz wide signal at 1574\.94–1576\.11 MHz stayed above the alert level, repeated in 3 of 5 checks\.$/);
    expect(incidentStatusLabel(event)).toBe("Cleared");
    const bars = triggerBars(trigger);
    expect(bars.map((bar) => bar.id)).toEqual(["strength", "width", "repeat"]);
    expect(bars[0]).toMatchObject({ measured: "18× normal variation", limit: "alert at 6×", met: true });
    expect(bars[1]).toMatchObject({ measured: "1.2 MHz", limit: "wider than 0.8 MHz" });
  });

  it("falls back for older records without a stored trigger", () => {
    const legacy = incident({ trigger: undefined, detailKind: undefined, disturbedRangesHz: undefined, timeline: undefined, kind: "narrowband-spike" });
    expect(disturbedSummary(legacy)).toBe("Within 1571.420–1579.420 MHz");
    expect(whyAlertSentence(legacy)).toMatch(/older record has no stored trigger/);
    expect(incidentTimeline(legacy).map((entry) => entry.code)).toEqual(["alert", "note", "cleared"]);
  });

  it("renders the drawer sections in operator order and shows notes", () => {
    const generatedAt = "2026-11-09T10:10:00.000Z";
    const summary = resolveOperatorSummary({
      generatedAt,
      serverBuildId: "release-a",
      dataDomain: "field",
      monitoring: { receiverOnline: true, dataFresh: true, paused: false, alertActive: false, recovering: false, candidateActive: false, detectingActive: false, checking: false, since: generatedAt },
      recording: { state: "recording" },
      currentHealth: { state: "normal" },
      productionQualification: { state: "pending", ready: false },
      affectedTargets: [],
      observation: { at: generatedAt, coverage: "observed", targetId: "gnss-l1-e1-b1c-sbas" },
    });
    const markup = renderToStaticMarkup(createElement(IncidentPanel, {
      event: incident(),
      operatorSummary: summary,
      services: [],
      displayTimeZone: "UTC",
      onAddNote: () => undefined,
      onAcknowledge: () => undefined,
      onExport: () => undefined,
      archived: true,
      onBack: () => undefined,
      onOpenAnalysis: () => undefined,
    }));
    const order = ["Evidence history", "Suspected RF interference", "Disturbed", "Why this alert", "Timeline", "Notes", "Bridge saw a position jump.", "Evidence", "Download evidence package", "Incident report", "Technical details"];
    let cursor = -1;
    for (const label of order) {
      const index = markup.indexOf(label, cursor + 1);
      expect(index, label).toBeGreaterThan(cursor);
      cursor = index;
    }
    expect(markup).toContain("Medium evidence");
    expect(markup).not.toMatch(/spoof|jamm|dbm/i);
  });

  it("says what Apply will do before saving", () => {
    expect(applyImpactCopy("live")).toMatch(/Applies now/);
    expect(applyImpactCopy("rf-restart")).toMatch(/Open incidents end/);
    expect(applyImpactCopy("learning-restart")).toMatch(/Restarts signal learning/);
    expect(appliedToastCopy("live")).toMatch(/open incidents continue/);
  });
});

describe("client incident report", () => {
  const model = () => buildIncidentReportModel({
    event: incident(),
    generatedAtMs: Date.parse("2026-11-09T12:00:00.000Z"),
    scope: "evidence-package",
    dataDomain: "field",
    siteName: "Sanco Star",
    deploymentId: "sanco-sdr-01",
    displayTimeZone: "Europe/Athens",
    reportIdentity: { companyName: "ACME Survey", clientName: "Client Ltd", vesselName: "MV Example", projectReference: "JOB-1" },
    completeness: { complete: true, missingParts: [] },
    evidenceFiles: [{ path: "spectrum/frames.jsonl", bytes: 10, sha256: "b".repeat(64) }],
  });

  it("builds a readable reference and package name", () => {
    expect(incidentReference(incident())).toBe("INC-20261109-100500Z-gnss-l1-e1-b1c-sbas");
    expect(incidentPackageBaseName(incident())).toBe("RF-Incident_20261109-100500Z_gnss-l1-e1-b1c-sbas_c0eded38");
  });

  it("leads with the verdict, summary and why, and quotes local time next to UTC", () => {
    const report = model();
    expect(report).toMatchObject({ kind: "rf-incident-report", reference: "INC-20261109-100500Z-gnss-l1-e1-b1c-sbas", incident: { verdict: "Suspected RF interference", ruleLabel: "Wider signal", evidenceStrength: "Medium" } });
    expect(report.incident.startedAt).toBe("2026-11-09 10:05:00 UTC (2026-11-09 12:05:00 EET)");
    expect(report.why?.rules.find((rule) => rule.label === "Wider-signal strength")).toMatchObject({ measured: "18× normal variation", threshold: "6.0× normal variation", met: true });
    expect(report.why?.sensitivity.label).toBe("Standard");
    expect(report.notes).toHaveLength(1);
    expect(report.limitations[0]).toMatch(/RF data can show interference, not intent/);
  });

  it("renders print-ready HTML with every section and no banned wording", () => {
    const html = renderIncidentReportHtml(model());
    for (const heading of ["Summary", "Why the alert was raised", "What the receiver recorded", "Timeline", "Analysis of the recorded frames", "Receiver and configuration", "Operator notes", "Evidence integrity", "Limitations and terms"]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain("@page{size:A4");
    expect(html).toContain("ACME Survey");
    expect(html).toContain("sha256sum -c SHA256SUMS.txt");
    expect(html).not.toMatch(/<script/i);
    expect(html.replace(/RF data can show interference, not intent/g, "")).not.toMatch(/spoof|jamm|intent|deliberate|dbm/i);
  });

  it("renders a multi-page A4 PDF with metadata", async () => {
    const bytes = await renderIncidentReportPdf(model());
    expect(Buffer.from(bytes.subarray(0, 5)).toString()).toBe("%PDF-");
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(3);
    const [width, height] = [pdf.getPage(0).getWidth(), pdf.getPage(0).getHeight()];
    expect(Math.round(width)).toBe(595);
    expect(Math.round(height)).toBe(842);
    expect(pdf.getTitle()).toContain("INC-20261109-100500Z");
    expect(pdf.getAuthor()).toBe("ACME Survey");
  });

  it("keeps PDF text inside the standard font and formats frequencies to the resolution", () => {
    expect(pdfSafe("≥ 6σ − Ωmega Ελλάδα")).toBe(">= 6sigma - ?mega ??????");
    expect(frequencyRange([1_574_940_000, 1_576_110_000], 19_560)).toBe("1574.94–1576.11 MHz");
  });

  it("draws charts with gaps as gaps and an accessible title", () => {
    const svg = chartToSvg({
      id: "t", title: "Test chart", caption: "c", ariaLabel: "a", width: 400, height: 200,
      x: { label: "x", min: 0, max: 10, ticks: [] }, y: { label: "y", min: 0, max: 10, ticks: [] },
      series: [{ kind: "line", name: "l", color: "#000", points: [[0, 1], [1, 2], null, [5, 5], [6, 6]] }],
      legend: [],
    });
    expect(svg).toContain('role="img"');
    expect(svg).toContain("<title");
    // Two separate runs: two "M" moves in one path.
    expect((svg.match(/d="M[^"]*"/)?.[0].match(/M/g) ?? []).length).toBe(2);
  });
});
