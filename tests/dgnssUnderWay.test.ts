import { describe, expect, it } from "vitest";
import { analysePositioning, type PositioningAnalysis } from "../src/server/positioning/analysis";
import { buildPositioningReportModel } from "../src/server/positioning/reportModel";
import { parseSbs } from "../src/server/positioning/sbs";
import { DEFAULT_THRESHOLDS, type PositioningSystemConfig, type RfEvidence } from "../src/server/positioning/types";
import { referenceTrack, timingProfile } from "../src/server/positioning/underWay";

const KNOT = 0.514444;
const START = Date.parse("2026-11-10T08:00:00Z");

const SYSTEMS: PositioningSystemConfig[] = [
  { id: "DGPS1", output: "G4 SPEL", receiver: "Starpack A", antenna: "Tualcom", beam: "EASAT" },
  { id: "DGPS2", output: "G4", receiver: "Starpack A", antenna: "Tualcom", beam: "EASAT" },
  { id: "DGPS3", output: "XP3", receiver: "Starpack B", antenna: "Calian", beam: "EASAT" },
  { id: "DGPS4", output: "G4+", receiver: "Starpack B", antenna: "Calian", beam: "EASAT" },
  { id: "DGPS5", output: "G4", receiver: "AsteRx-U3", antenna: "Calian", beam: "ERSAT" },
  { id: "DGPS6", output: "G4", receiver: "Multifix", antenna: "Calian", beam: "ERSAT" },
];

/** Deterministic noise in [-1, 1). */
function noise(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return (value - Math.floor(value)) * 2 - 1;
}

/**
 * A survey vessel at a steady speed: a straight line, a 180° turn of 400 m
 * radius, and a straight line back. Returns the true CRP at t seconds.
 */
function track(knots: number): (seconds: number) => [number, number] {
  const speed = knots * KNOT;
  const radius = 400;
  const straight = 1_800 * speed;
  const turn = Math.PI * radius;
  return (seconds) => {
    const distance = seconds * speed;
    if (distance <= straight) return [500_000 + distance, 3_830_000];
    if (distance <= straight + turn) {
      const angle = (distance - straight) / radius;
      return [500_000 + straight + radius * Math.sin(angle), 3_830_000 + radius - radius * Math.cos(angle)];
    }
    return [500_000 + straight - (distance - straight - turn), 3_830_000 + 2 * radius];
  };
}

interface Scenario {
  knots: number;
  shots: number;
  /** Seconds before the shot that a system's position was really taken (shot timing). */
  age?: (system: number, shot: number) => number;
  /** Extra metres to port of the track for one system over a shot range. */
  crossOffset?: { system: number; from: number; to: number; metres: number };
  static?: boolean;
}

/** Gator SBS text for six systems of a vessel under way, positions taken `age` seconds before each shot. */
function underWaySbs(scenario: Scenario): string {
  const position = track(scenario.knots);
  const lines: string[] = [];
  for (let page = 1; page <= 6; page += 1) {
    const qc = `SSTDG${page}_QC`;
    lines.push("# Line name\t314-08.00.00", `Page ${page}\tDGPS${page}_QC\tAll Shots`);
    const fields = [
      `${qc} SST Latitude`, `${qc} SST Longitude`, `${qc} SST Height`, `${qc} SST Easting`, `${qc} SST Northing`,
      `${qc} SSTDG${page} Latitude`, `${qc} SSTDG${page} Longitude`, `${qc} SSTDG${page} Height`, `${qc} SSTDG${page} Easting`, `${qc} SSTDG${page} Northing`,
      `Raw: SST_DGPS${page} PDOP`, `Raw: SST_DGPS${page} HDOP`, `Raw: SST_DGPS${page} PCALC`, `Raw: SST_DGPS${page} Unit Variance`, `Raw: SST_DGPS${page} NSats Tracked`, `Raw: SST_DGPS${page} Age Correction`,
    ];
    lines.push(["Shot", "Raw Time", "Time", "Date", ...fields.flatMap((field) => [field, "Quality"])].join("\t"), "");
    for (let shot = 1; shot <= scenario.shots; shot += 1) {
      const seconds = (shot - 1) * 5;
      const age = scenario.static ? 0 : scenario.age?.(page, shot) ?? 0;
      let [east, north] = position(scenario.static ? 0 : seconds - age);
      if (scenario.crossOffset && scenario.crossOffset.system === page && shot >= scenario.crossOffset.from && shot <= scenario.crossOffset.to) {
        const [aheadE, aheadN] = position(seconds + 1);
        const [backE, backN] = position(seconds - 1);
        const length = Math.hypot(aheadE - backE, aheadN - backN) || 1;
        east += (-(aheadN - backN) / length) * scenario.crossOffset.metres;
        north += ((aheadE - backE) / length) * scenario.crossOffset.metres;
      }
      east += noise(page * 10_000 + shot) * 0.03 + page * 0.01;
      north += noise(page * 20_000 + shot) * 0.03;
      const values = [34.6, 33.0, 0, east, north, 34.6, 33.0, 25.9, east + 1, north + 1, 1.2, 0.7, 5, 0, 20 + page, 6];
      lines.push([String(shot), (START / 1000 + seconds + 0.999).toFixed(6), "08:00:00", "10 Nov 2026", ...values.flatMap((value) => [String(value), "[OK]"])].join("\t"));
    }
  }
  return `${lines.join("\n")}\n`;
}

const NO_RF: RfEvidence = { source: "rf-monitor", lanes: [], incidents: [] };

function analyse(scenario: Scenario): PositioningAnalysis {
  const dataset = parseSbs(underWaySbs(scenario));
  return analysePositioning({
    dataset,
    systems: SYSTEMS,
    thresholds: { ...DEFAULT_THRESHOLDS, agreementM: 0.5, movingKnots: 0.5 },
    window: { mode: "sbs", startMs: dataset.startMs, endMs: dataset.endMs + dataset.intervalMs },
    rf: NO_RF,
    controlId: "DGPS1",
  });
}

function model(analysis: PositioningAnalysis) {
  return buildPositioningReportModel({ analysis, identity: { vesselName: "Test vessel" }, files: [{ name: "line.sbs", bytes: 1, sha256: "0".repeat(64) }], generatedAt: new Date(START) });
}

/**
 * As in the field export of 2026-11-10: the Starpack outputs (DGPS1–4) and the
 * other receivers (DGPS5–6) each hand Gator their latest 1 Hz position, so at
 * every shot a group's position is 0–1 s old, independently.
 */
const sampleAndHold = (system: number, shot: number) => ((noise((system <= 4 ? 1 : 2) * 7_919 + shot * 31) + 1) / 2) * 0.999;

describe("DGNSS verification under way", () => {
  it("builds a smooth reference track with speed and direction through a turn", () => {
    const position = track(4);
    const samples = Array.from({ length: 900 }, (_, index) => {
      const [east, north] = position(index * 5);
      return [START + index * 5_000, east, north] as [number, number, number];
    });
    const reference = referenceTrack(samples, 5_000);
    const speeds = [...reference.values()].map((point) => point.knots);
    expect(Math.min(...speeds)).toBeGreaterThan(3.9);
    expect(Math.max(...speeds)).toBeLessThan(4.1);
    const inTurn = reference.get(START + 450 * 5_000)!;
    expect(Math.hypot(inTurn.e - samples[450][1], inTurn.n - samples[450][2])).toBeLessThan(0.05);
  });

  it("measures timing from each series' own steady offset", () => {
    const profile = timingProfile(
      Array.from({ length: 100 }, (_, index) => ({ timeMs: index, along: 0.3 + (index % 10 === 0 ? 2.06 : 0), cross: 0.01, knots: 4 })),
      { minM: 0.2, maxCrossM: 0.25, maxSeconds: 3 },
    );
    expect(profile.steadyAlong).toBeCloseTo(0.3, 5);
    expect(profile.excursions).toHaveLength(10);
    expect(profile.excursions[0].seconds).toBeCloseTo(1, 1);
  });

  for (const knots of [3, 4, 5]) {
    it(`passes agreement and reports shot timing for a vessel always under way at ${knots} kn`, () => {
      const analysis = analyse({ knots, shots: 1_000, age: sampleAndHold });
      expect(analysis.motion.shots.static.n).toBe(0);
      expect(analysis.agreementFailures).toEqual([]);
      for (const system of analysis.systems.filter((entry) => entry.vsControl)) {
        expect(system.vsControl!.underWay!.crossMax).toBeLessThan(0.2);
        expect(Math.abs(system.vsControl!.underWay!.alongSteadyM)).toBeLessThan(0.5);
        expect(system.vsControl!.agreementMax).toBeLessThan(0.2);
      }
      expect(analysis.commonTiming!.p95Seconds).toBeGreaterThan(0.3);
      expect(analysis.events.filter((event) => event.kind === "position-timing")).toHaveLength(1);
      expect(analysis.events.some((event) => /degradation/i.test(event.title))).toBe(false);
      const report = model(analysis);
      expect(report.verdictStatus).toBe("CHECK");
      const rows = report.tables.result.rows;
      expect(rows.map((row) => row[0])).not.toContain("CRP agreement, static");
      expect(rows.find((row) => row[0] === "CRP agreement under way")?.[3]).toBe("PASS");
      expect(rows.find((row) => row[0] === "Position timing under way")?.[3]).toBe("CHECK");
      expect(report.verdict).toMatch(/^All within 0\.5 m of DGPS1 · Shot positions up to \d\.\d s off the shot time under way/);
      expect(report.pages.some((page) => page.title.startsWith("Under Way Agreement"))).toBe(true);
    });
  }

  it("passes cleanly when positions are time-aligned", () => {
    const analysis = analyse({ knots: 4, shots: 600 });
    expect(analysis.agreementFailures).toEqual([]);
    expect(analysis.events).toEqual([]);
    expect(model(analysis).verdictStatus).toBe("PASS");
  });

  it("fails a system that is steadily late, even at a constant speed", () => {
    // DGPS5 always 0.5 s behind: 1.0 m along track at 4 kn, every shot.
    const analysis = analyse({ knots: 4, shots: 600, age: (system) => (system === 5 ? 0.5 : 0) });
    expect(analysis.agreementFailures).toEqual(["DGPS5"]);
    expect(analysis.systems.find((system) => system.id === "DGPS5")!.vsControl!.underWay!.alongSteadyM).toBeCloseTo(-1.03, 1);
    const report = model(analysis);
    expect(report.verdictStatus).toBe("FAIL");
    expect(report.tables.result.rows.find((row) => row[0] === "CRP agreement under way")?.[3]).toBe("FAIL");
  });

  it("fails a real across-track offset under way and calls it degradation, not timing", () => {
    const analysis = analyse({ knots: 4, shots: 600, age: sampleAndHold, crossOffset: { system: 6, from: 200, to: 260, metres: 0.8 } });
    expect(analysis.agreementFailures).toEqual(["DGPS6"]);
    expect(analysis.systems.find((system) => system.id === "DGPS6")!.vsControl!.underWay!.crossMax).toBeGreaterThan(0.7);
    expect(analysis.events.some((event) => event.systems.includes("DGPS6") && event.kind !== "position-timing")).toBe(true);
    expect(model(analysis).verdictStatus).toBe("FAIL");
  });

  it("keeps a long report under way within a bounded chart size", () => {
    // 11 h at 5 s with timing flags on most shots: lanes are merged to the
    // drawable resolution, so the PDF stays inside the worker's memory cap.
    const analysis = analyse({ knots: 4, shots: 8_000, age: sampleAndHold });
    const report = model(analysis);
    const points = (id: string) => (report.charts.find((chart) => chart.id === id)?.series ?? [])
      .reduce((sum, series) => sum + ("points" in series ? series.points.length : 0) + ("upper" in series ? series.upper.length + series.lower.length : 0), 0);
    expect(points("evidence-timeline")).toBeLessThan(25_000);
    expect(points("sys-DGPS5-rf")).toBeLessThan(10_000);
    expect(points("uw-along")).toBeLessThan(4_000);
    const total = report.charts.reduce((sum, chart) => sum + points(chart.id), 0);
    expect(total).toBeLessThan(150_000);
  });

  it("keeps the 2D check while static", () => {
    const analysis = analyse({ knots: 4, shots: 400, static: true });
    expect(analysis.motion.shots.underWay.n).toBe(0);
    expect(analysis.systems.every((system) => !system.vsControl?.underWay)).toBe(true);
    const report = model(analysis);
    expect(report.tables.result.rows[0][0]).toBe("CRP agreement with control");
    expect(report.verdictStatus).toBe("PASS");
  });
});
